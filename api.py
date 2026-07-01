"""
FastAPI OCR Server for Nabu PDF.

Exposes a /ocr endpoint that accepts base64 images,
runs RapidViet (RapidOCR ONNX detection + VietOCR recognition) by default,
and returns extracted Vietnamese text.
"""

import base64
import io
import logging
import os
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from PIL import Image

from src.ocr.engine import create_engine, BaseOCREngine
from src.agents.gemini_agent import GeminiAgent, DEFAULT_CONTRACT_FIELDS
from src.agents.field_templates import TEMPLATES
from src.output.writer import JSONWriter, ExcelWriter, CSVWriter
from src.utils.config import GEMINI_MODEL, get_gemini_key, set_gemini_key

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Global OCR engine — loaded once at startup
ocr_engine: BaseOCREngine | None = None
# Gemini agent — created lazily on first /extract (needs an API key).
gemini_agent: GeminiAgent | None = None

# Human-readable labels for the built-in field templates.
TEMPLATE_LABELS = {
    "default": "Hợp đồng (mặc định)",
    "mua_ban": "Hợp đồng mua bán",
    "lao_dong": "Hợp đồng lao động",
    "dich_vu": "Hợp đồng dịch vụ",
    "generic": "Tổng quát",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """No eager work — OCR models load lazily on first use (see _get_ocr).

    Loading the OCR engine + models costs RAM and a few seconds; doing it at
    startup penalised every session even when the user only touched plain PDF
    features. The engine now builds on the first OCR-dependent request instead.
    """
    yield
    logger.info("Shutting down OCR server")


def _get_ocr() -> BaseOCREngine:
    """Lazily build the OCR engine on first use; cache it. Raises 503 on failure.

    Defaults to RapidViet (RapidOCR ONNX detection + VietOCR recognition): fast
    detection without paddlepaddle, and VietOCR — the only local engine with a true
    Vietnamese recognizer — keeps stacked diacritics correct (ộ/ử/ấ/ề/ị). The PP-OCR
    multilingual/latin recognizers in RapidOCR and PaddleOCR 3.x mangle them. A page
    is ~3-4s warm on CPU. Set OCR_ENGINE=hybrid/rapidocr/paddleocr/auto to switch.
    """
    global ocr_engine
    if ocr_engine is None:
        engine_type = os.getenv("OCR_ENGINE", "rapidviet")
        logger.info("Loading OCR engine: %s", engine_type)
        try:
            ocr_engine = create_engine(engine_type)
            logger.info("OCR engine ready")
        except Exception as e:
            logger.warning("%s engine failed, falling back to auto: %s", engine_type, e)
            try:
                ocr_engine = create_engine("auto")
            except Exception as e2:
                raise HTTPException(
                    status_code=503,
                    detail=f"Không khởi tạo được engine OCR: {e2}",
                )
    return ocr_engine


app = FastAPI(
    title="Nabu PDF API",
    description="Vietnamese OCR API (RapidViet: RapidOCR detection + VietOCR recognition)",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Per-launch shared secret. The desktop app (main.js) generates a random token and
# passes it to the sidecar via the SIDECAR_TOKEN env var + to the renderer, which
# echoes it back in the X-Sidecar-Token header. This stops other local processes /
# browser pages from hitting the loopback OCR server (DoS, or running up the user's
# Gemini bill). If SIDECAR_TOKEN is unset (running api.py/app.py directly in dev),
# the check is skipped for backwards compatibility.
_SIDECAR_TOKEN = os.environ.get("SIDECAR_TOKEN") or None

# Reject oversized payloads before decoding to avoid blowing up memory.
# ~200 MB of binary => ~280 MB of base64 text.
_MAX_PDF_B64 = 280_000_000


@app.middleware("http")
async def _require_token(request: Request, call_next):
    """Gate every endpoint (except /health) behind the per-launch token."""
    if _SIDECAR_TOKEN and request.url.path != "/health" and request.method != "OPTIONS":
        if request.headers.get("x-sidecar-token") != _SIDECAR_TOKEN:
            return JSONResponse(status_code=401, content={"detail": "Token không hợp lệ"})
    return await call_next(request)


def _get_gemini() -> GeminiAgent:
    """Lazily build the Gemini agent; raise 503 if no API key is configured."""
    global gemini_agent
    if gemini_agent is None:
        key = get_gemini_key()
        if not key:
            raise HTTPException(
                status_code=503,
                detail="Chưa cấu hình Gemini API key. Mở ⚙ Cài đặt trong app để nhập key.",
            )
        gemini_agent = GeminiAgent(api_key=key, model_name=GEMINI_MODEL)
    return gemini_agent


def _resolve_fields(template: str | None, custom_fields: dict[str, str] | None) -> dict[str, str]:
    """Pick the field mapping: explicit custom_fields > named template > default."""
    if custom_fields:
        return custom_fields
    if template and template != "default":
        return TEMPLATES.get(template, DEFAULT_CONTRACT_FIELDS)
    return DEFAULT_CONTRACT_FIELDS


class OCRRequest(BaseModel):
    """Request body for OCR endpoint."""
    images: list[str]  # base64 encoded images (without data URL prefix)
    page_numbers: list[int] | None = None  # optional page number labels


class OCRPageResult(BaseModel):
    """OCR result for a single page."""
    page_number: int
    text: str


class OCRResponse(BaseModel):
    """Response from OCR endpoint."""
    success: bool
    pages: list[OCRPageResult] = []
    full_text: str = ""
    error: str | None = None


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "loaded" if ocr_engine else "lazy"}


def _mask_key(key: str) -> str:
    """Show only the last 4 chars so the UI can confirm a key without leaking it."""
    key = (key or "").strip()
    if not key:
        return ""
    return ("•" * max(4, len(key) - 4)) + key[-4:]


class ConfigUpdate(BaseModel):
    """Body for POST /config — settings entered in the app's ⚙ UI."""
    gemini_api_key: str | None = None


@app.get("/config")
async def get_config():
    """Report current settings state (key never returned in full — masked only)."""
    key = get_gemini_key()
    return {"gemini_configured": bool(key), "gemini_key_masked": _mask_key(key)}


@app.post("/config")
async def update_config(req: ConfigUpdate):
    """Save the Gemini API key entered by the user, persist it, and rebuild the
    agent so the next /extract uses it — no sidecar restart needed."""
    global gemini_agent
    if req.gemini_api_key is not None:
        set_gemini_key(req.gemini_api_key)
        gemini_agent = None  # force rebuild with the new key on next use
    key = get_gemini_key()
    return {
        "success": True,
        "gemini_configured": bool(key),
        "gemini_key_masked": _mask_key(key),
    }


@app.post("/ocr", response_model=OCRResponse)
async def run_ocr(request: OCRRequest):
    """Run OCR on one or more base64-encoded images.

    Returns extracted text per page and concatenated full text.
    """
    if not request.images:
        raise HTTPException(status_code=400, detail="No images provided")

    if len(request.images) > 50:
        raise HTTPException(status_code=400, detail="Too many images (max 50)")

    engine = _get_ocr()

    try:
        pages: list[OCRPageResult] = []
        all_texts: list[str] = []

        for i, img_base64 in enumerate(request.images):
            page_num = request.page_numbers[i] if request.page_numbers and i < len(request.page_numbers) else i + 1

            # Decode base64 to PIL Image
            try:
                img_bytes = base64.b64decode(img_base64)
                image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            except Exception as e:
                logger.error("Failed to decode image %d: %s", page_num, e)
                pages.append(OCRPageResult(page_number=page_num, text=f"[Lỗi đọc ảnh: {e}]"))
                continue

            # Run OCR
            text = engine.recognize(image)
            pages.append(OCRPageResult(page_number=page_num, text=text))
            all_texts.append(f"=== Trang {page_num} ===\n{text}")

            logger.info("Page %d: %d characters extracted", page_num, len(text))

        full_text = "\n\n".join(all_texts)

        return OCRResponse(
            success=True,
            pages=pages,
            full_text=full_text,
        )

    except Exception as e:
        logger.exception("OCR processing error")
        return OCRResponse(
            success=False,
            error=str(e),
        )


@app.get("/templates")
async def list_templates():
    """Return the available field templates (key -> Vietnamese description)."""
    out = [{"name": "default", "label": TEMPLATE_LABELS["default"], "fields": DEFAULT_CONTRACT_FIELDS}]
    for name, fields in TEMPLATES.items():
        out.append({"name": name, "label": TEMPLATE_LABELS.get(name, name), "fields": fields})
    return {"templates": out}


class ExtractRequest(BaseModel):
    """Request body for the field-extraction endpoint.

    Provide either page images (OCR runs here) or pre-extracted ocr_texts.
    """
    images: list[str] = []  # base64 page images (no data URL prefix)
    ocr_texts: list[str] | None = None  # skip OCR if the text is already known
    template: str | None = None  # named template, e.g. "mua_ban"; None/"default" = default
    custom_fields: dict[str, str] | None = None  # overrides template entirely
    page_numbers: list[int] | None = None


class ExtractResponse(BaseModel):
    success: bool
    fields: dict[str, Any] = {}
    field_labels: dict[str, str] = {}
    classification: dict[str, str] = {}
    pages: list[OCRPageResult] = []
    full_text: str = ""
    error: str | None = None


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest):
    """Full pipeline on one document: images -> OCR -> Gemini -> structured fields.

    All pages are treated as one contract: their text is concatenated and a
    single record of fields is returned.
    """
    fields = _resolve_fields(req.template, req.custom_fields)

    # 1. Gather per-page text (from provided texts, or by running OCR).
    pages: list[OCRPageResult] = []
    if req.ocr_texts:
        for i, text in enumerate(req.ocr_texts):
            pn = req.page_numbers[i] if req.page_numbers and i < len(req.page_numbers) else i + 1
            pages.append(OCRPageResult(page_number=pn, text=text))
    else:
        if not req.images:
            raise HTTPException(status_code=400, detail="No images or ocr_texts provided")
        if len(req.images) > 50:
            raise HTTPException(status_code=400, detail="Too many images (max 50)")
        engine = _get_ocr()
        for i, img_base64 in enumerate(req.images):
            pn = req.page_numbers[i] if req.page_numbers and i < len(req.page_numbers) else i + 1
            try:
                img = Image.open(io.BytesIO(base64.b64decode(img_base64))).convert("RGB")
            except Exception as e:
                logger.error("Failed to decode image %d: %s", pn, e)
                pages.append(OCRPageResult(page_number=pn, text=f"[Lỗi đọc ảnh: {e}]"))
                continue
            # OCR can raise (e.g. paddle/paddlex dependency errors). Catch here so the
            # client gets a JSON error body instead of an unhandled 500 ("Internal
            # Server Error" plaintext, which breaks res.json() in the renderer).
            try:
                pages.append(OCRPageResult(page_number=pn, text=engine.recognize(img)))
            except Exception as e:
                logger.exception("OCR failed on page %d", pn)
                return ExtractResponse(success=False, error=f"OCR lỗi: {e}", pages=pages)

    full_text = "\n\n".join(p.text for p in pages).strip()
    if not full_text:
        return ExtractResponse(success=False, error="OCR không trích được text", pages=pages)

    # 2. Gemini: classify + extract fields.
    try:
        agent = _get_gemini()
    except HTTPException as he:
        return ExtractResponse(success=False, error=he.detail, pages=pages, full_text=full_text)

    try:
        data = agent.extract_fields(full_text, fields)
        classification = agent.classify_document(full_text)
    except Exception as e:
        logger.exception("Extraction error")
        return ExtractResponse(success=False, error=str(e), pages=pages, full_text=full_text)

    return ExtractResponse(
        success=True,
        fields=data,
        field_labels=fields,
        classification=classification,
        pages=pages,
        full_text=full_text,
    )


class ExportRequest(BaseModel):
    """Request body for exporting extracted records to a file."""
    records: list[dict[str, Any]]
    field_labels: dict[str, str] | None = None  # key -> header; column order/labels
    format: str = "excel"  # "excel" | "csv" | "json"
    source_file: str | None = None


class ExportResponse(BaseModel):
    success: bool
    filename: str = ""
    mime: str = ""
    data_b64: str = ""
    error: str | None = None


_EXPORT_SUFFIX = {"excel": ".xlsx", "csv": ".csv", "json": ".json"}
_EXPORT_MIME = {
    "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
    "json": "application/json",
}


@app.post("/export", response_model=ExportResponse)
async def export(req: ExportRequest):
    """Write extracted records to xlsx/csv/json and return the file as base64.

    The desktop app saves the bytes via a native dialog — nothing is persisted
    server-side beyond a short-lived temp file.
    """
    if req.format not in _EXPORT_SUFFIX:
        raise HTTPException(status_code=400, detail="format must be excel|csv|json")
    if not req.records:
        raise HTTPException(status_code=400, detail="No records to export")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    labels = req.field_labels or {}

    # Enrich each record with source metadata (writers add headers for these).
    records: list[dict[str, Any]] = []
    for r in req.records:
        d = dict(r)
        if req.source_file and "_source_file" not in d:
            d["_source_file"] = req.source_file
        d.setdefault("_timestamp", ts)
        records.append(d)

    tmp = Path(tempfile.gettempdir()) / f"contractocr_{ts}{_EXPORT_SUFFIX[req.format]}"
    if tmp.exists():
        tmp.unlink()

    try:
        if req.format == "excel":
            writer = ExcelWriter(fields_mapping=labels)
            for d in records:
                writer.save(d, tmp)
        elif req.format == "csv":
            writer = CSVWriter(fields_mapping=labels)
            for d in records:
                writer.save(d, tmp)
        else:  # json
            JSONWriter().save(records if len(records) != 1 else records[0], tmp)

        data = tmp.read_bytes()
    except Exception as e:
        logger.exception("Export error")
        return ExportResponse(success=False, error=str(e))
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass

    return ExportResponse(
        success=True,
        filename=f"contracts_{ts}{_EXPORT_SUFFIX[req.format]}",
        mime=_EXPORT_MIME[req.format],
        data_b64=base64.b64encode(data).decode("ascii"),
    )


# Cache the resolved Unicode font path (Vietnamese-capable) across requests.
_FONT_PATH: str | None = None


def _vietnamese_font() -> str | None:
    """Find a TTF that covers Vietnamese diacritics for the invisible text layer.

    Prefers DejaVu Sans (full Vietnamese coverage), which ships with matplotlib —
    already a transitive dependency. P5 packaging should bundle this TTF explicitly.
    """
    global _FONT_PATH
    if _FONT_PATH is not None:
        return _FONT_PATH or None
    candidates: list[str] = []
    try:
        # NB: use the data path (a real str), not font_manager.findfont(), which
        # returns a FontPath object that PyMuPDF rejects as "bad fontfile".
        import matplotlib
        candidates.append(str(Path(matplotlib.get_data_path()) / "fonts" / "ttf" / "DejaVuSans.ttf"))
    except Exception:  # pragma: no cover - matplotlib always present via deps
        pass
    try:
        for site in __import__("site").getsitepackages():
            candidates.append(str(Path(site) / "imgaug" / "DejaVuSans.ttf"))
    except Exception:
        pass
    for c in candidates:
        if c and Path(c).is_file():
            _FONT_PATH = c
            return c
    _FONT_PATH = ""  # cache "not found" to avoid re-searching
    return None


# DejaVu ships style variants beside the regular TTF. Using the real bold/oblique
# file renders far cleaner than faux-bold stroking (the old approach blobbed at
# small sizes). Returns None when the variant file is absent → caller faux-styles.
_DEJAVU_SUFFIX = {
    (False, False): "",
    (True, False): "-Bold",
    (False, True): "-Oblique",
    (True, True): "-BoldOblique",
}


def _dejavu_variant(base_path: str, bold: bool, italic: bool) -> str | None:
    if not base_path:
        return None
    suffix = _DEJAVU_SUFFIX[(bold, italic)]
    if not suffix:
        return base_path
    cand = Path(base_path).with_name(f"DejaVuSans{suffix}.ttf")
    return str(cand) if cand.is_file() else None


# PyMuPDF Base14 names by (bold, italic). Real font variants, no faux needed.
_BUILTIN_VARIANTS = {
    "helv": {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"},
    "tiro": {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"},
    "cour": {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"},
}


# ---- local system fonts (text edit) --------------------------------------
# matplotlib's font_manager already indexes the machine's installed fonts
# (C:\Windows\Fonts on Windows). We reuse it both to list families for the UI
# and to resolve a family + style → an actual TTF the editor can embed, so an
# edited span can keep its original font instead of falling back to DejaVu.
import re as _re

_LOCAL_FONT_CACHE: dict[tuple[str, bool, bool], str] = {}


def _clean_font_name(name: str) -> str:
    """Normalise a PDF/PostScript font name to a plain family for lookup.

    Strips the 6-char subset prefix ("ABCDEF+Arial") and common style suffixes
    ("TimesNewRomanPS-BoldMT" → "TimesNewRoman").
    """
    if "+" in name and len(name.split("+", 1)[0]) == 6:
        name = name.split("+", 1)[1]
    name = name.split(",")[0].split("-")[0]
    name = _re.sub(r"(PSMT|PS|MT)$", "", name)
    return name.strip() or name


# Normalised index of installed families: {alnum-lowercased name: real family}.
# A PDF font name like "TimesNewRomanPSMT" cleans to "TimesNewRoman" (no spaces),
# which matplotlib can't match against the installed "Times New Roman". Normalising
# both sides (drop spaces/case) lets us recover the real family so findfont resolves.
_FAM_INDEX: dict[str, str] | None = None


def _norm_fam(s: str) -> str:
    return _re.sub(r"[^a-z0-9]", "", s.lower())


def _family_index() -> dict[str, str]:
    global _FAM_INDEX
    if _FAM_INDEX is None:
        idx: dict[str, str] = {}
        try:
            from matplotlib import font_manager as fm
            for f in fm.fontManager.ttflist:
                idx.setdefault(_norm_fam(f.name), f.name)
        except Exception as fe:
            logger.debug("build family index failed: %s", fe)
        _FAM_INDEX = idx
    return _FAM_INDEX


def _resolve_local_font(name: str, bold: bool, italic: bool) -> str | None:
    """Resolve a font family name + style to a local TTF path, or None.

    Uses matplotlib.font_manager.findfont with fallback disabled so a missing
    family raises (→ None) instead of silently returning DejaVu — the caller
    then applies its own DejaVu fallback for Vietnamese safety.
    """
    key = (name, bold, italic)
    if key in _LOCAL_FONT_CACHE:
        return _LOCAL_FONT_CACHE[key] or None
    path = ""
    try:
        from matplotlib import font_manager as fm

        cleaned = _clean_font_name(name)
        # Map the cleaned name onto a real installed family when possible (handles
        # space-collapsed PDF names like "TimesNewRoman" -> "Times New Roman").
        family = _family_index().get(_norm_fam(cleaned), cleaned)
        fp = fm.FontProperties(
            family=family,
            weight="bold" if bold else "normal",
            style="italic" if italic else "normal",
        )
        found = fm.findfont(fp, fallback_to_default=False)
        # findfont returns a FontPath (a str subclass carrying a face index) that
        # PyMuPDF's insert_font rejects as "bad fontfile" — coerce to a plain str.
        if found and Path(found).is_file():
            path = str(found)
    except Exception as fe:  # ValueError when no family matches
        logger.debug("resolve local font '%s' failed: %s", name, fe)
        path = ""
    _LOCAL_FONT_CACHE[key] = path
    return path or None


def _list_local_font_families() -> list[str]:
    try:
        from matplotlib import font_manager as fm

        return sorted({f.name for f in fm.fontManager.ttflist})
    except Exception as fe:
        logger.debug("list local fonts failed: %s", fe)
        return []


class SearchableRequest(BaseModel):
    """Request body for building a searchable PDF (invisible OCR text layer)."""
    pdf_b64: str  # the source PDF, base64 (no data URL prefix)
    dpi: int = 200  # rasterisation DPI for OCR
    force_ocr: bool = False  # OCR every page even if it already has a text layer


class SearchableResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    pages: int = 0
    words: int = 0
    ocr_pages: int = 0      # pages actually OCR'd (scanned)
    skipped_pages: int = 0  # pages skipped because they already had real text
    error: str | None = None


@app.post("/searchable", response_model=SearchableResponse)
async def searchable(req: SearchableRequest):
    """OCR a (scanned) PDF and return a copy with a selectable, invisible text layer.

    The original page content is preserved; OCR text is laid over each word's box
    with render mode 3 (invisible) so the output looks identical but is searchable.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không tạo được searchable PDF.")

    # Engine + font are loaded lazily on the first page that actually needs OCR:
    # a fully digital PDF (every page already has a text layer) then returns
    # instantly without paying the engine warm-up cost.
    font_path = _vietnamese_font()
    if not font_path:
        raise HTTPException(status_code=503, detail="Không tìm thấy font Unicode (DejaVu Sans) để nhúng lớp text.")
    engine = None

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    dpi = max(72, min(400, req.dpi))
    scale = 72.0 / dpi  # pixmap pixel -> PDF point

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    if doc.page_count > 100:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF quá nhiều trang (tối đa 100).")

    # One reusable font object for width measurement (text_length) — the same TTF
    # the invisible layer embeds, so measured widths match what gets drawn.
    ocr_font = fitz.Font(fontfile=font_path)

    total_words = 0
    ocr_pages = 0
    skipped_pages = 0
    try:
        for page in doc:
            # Skip pages that already carry a real (selectable) text layer: a
            # mixed text+scan document then only OCRs its scanned pages — far
            # faster — and we avoid stacking a second OCR layer on top of clean
            # text (which garbled copy/search). force_ocr overrides this.
            if not req.force_ocr:
                existing = page.get_text("text") or ""
                if len(existing.strip()) >= 20:
                    skipped_pages += 1
                    continue

            # One bad page must not sink the whole document: isolate per-page so a
            # blank/odd page is skipped instead of failing the entire request.
            try:
                if engine is None:
                    engine = _get_ocr()
                pix = page.get_pixmap(dpi=dpi, alpha=False)
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                try:
                    boxes = engine.recognize_boxes(image)
                except NotImplementedError:
                    doc.close()
                    raise HTTPException(status_code=503, detail="Engine OCR hiện tại không hỗ trợ định vị (cần Hybrid/Paddle).")

                for text, (x0, y0, x1, y1) in boxes:
                    t = (text or "").strip()
                    if not t:
                        continue
                    # Drop degenerate boxes (a thin/zero detection yields a junk
                    # crop and would only add a misplaced invisible glyph).
                    if (x1 - x0) < 3 or (y1 - y0) < 3:
                        continue
                    # Box in PDF points.
                    bx0 = x0 * scale
                    box_w = (x1 - x0) * scale
                    box_h = (y1 - y0) * scale
                    by1 = y1 * scale
                    # Fontsize from box height (correct vertical extent), then scale
                    # the text horizontally so its rendered width fills the box — so
                    # the invisible glyphs line up with the visual word and a viewer's
                    # selection/search highlight sits exactly over it (OCRmyPDF-style).
                    # Height-only sizing (the old way) ignored width, so selection on
                    # an OCR'd page landed off the text.
                    fontsize = max(2.0, box_h * 0.85)
                    natural_w = ocr_font.text_length(t, fontsize=fontsize)
                    if natural_w <= 0:
                        continue
                    sx = box_w / natural_w
                    sx = max(0.05, min(sx, 20.0))  # guard against bad-OCR extremes
                    baseline = fitz.Point(bx0, by1 - box_h * 0.18)
                    try:
                        tw = fitz.TextWriter(page.rect)
                        tw.append(baseline, t, font=ocr_font, fontsize=fontsize)
                        # morph: scale x by sx about the line's left baseline point.
                        tw.write_text(
                            page,
                            morph=(baseline, fitz.Matrix(sx, 1)),
                            render_mode=3,  # invisible
                        )
                        total_words += 1
                    except Exception as e:
                        logger.debug("skip text box: %s", e)
                ocr_pages += 1
            except HTTPException:
                raise
            except Exception as e:
                logger.warning("Searchable: bỏ qua trang %d do lỗi: %s", page.number, e)
                continue

        out_bytes = doc.tobytes(deflate=True, garbage=3)
        page_count = doc.page_count
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Searchable PDF error")
        return SearchableResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return SearchableResponse(
        success=True,
        filename=f"searchable_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        pages=page_count,
        words=total_words,
        ocr_pages=ocr_pages,
        skipped_pages=skipped_pages,
    )


class CompressRequest(BaseModel):
    """Request body for PDF compression."""
    pdf_b64: str  # source PDF, base64 (no data URL prefix)
    preset: str = "ebook"  # screen | ebook | printer | lossless


class CompressResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    original_size: int = 0
    compressed_size: int = 0
    error: str | None = None


# Image downsample/recompress targets per preset (PyMuPDF rewrite_images).
# "lossless" skips image rewriting (only deflate + garbage-collect + font subset).
_COMPRESS_PRESETS = {
    "screen": dict(dpi_threshold=110, dpi_target=96, quality=45),
    "ebook": dict(dpi_threshold=170, dpi_target=150, quality=65),
    "printer": dict(dpi_threshold=320, dpi_target=300, quality=85),
}


@app.post("/compress", response_model=CompressResponse)
async def compress(req: CompressRequest):
    """Shrink a PDF: downsample/recompress high-DPI images + strip redundant objects.

    Native (no Ghostscript binary) — uses PyMuPDF. Text and vector content are
    preserved; only over-sized embedded images are reduced (per preset). "lossless"
    leaves images untouched and just garbage-collects/deflates the file.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không nén được.")

    if req.preset != "lossless" and req.preset not in _COMPRESS_PRESETS:
        raise HTTPException(status_code=400, detail="preset phải là screen|ebook|printer|lossless")

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    if doc.page_count > 500:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF quá nhiều trang (tối đa 500).")

    try:
        if req.preset != "lossless":
            p = _COMPRESS_PRESETS[req.preset]
            doc.rewrite_images(
                dpi_threshold=p["dpi_threshold"],
                dpi_target=p["dpi_target"],
                quality=p["quality"],
                lossy=True,
                lossless=True,
            )
        try:
            doc.subset_fonts()
        except Exception as e:  # font subsetting is best-effort
            logger.debug("subset_fonts skipped: %s", e)
        out_bytes = doc.tobytes(
            deflate=True, garbage=4, clean=True, deflate_images=True, deflate_fonts=True
        )
    except Exception as e:
        logger.exception("Compress error")
        return CompressResponse(success=False, error=str(e))
    finally:
        doc.close()

    # If compression somehow grew the file, hand back the original instead.
    if len(out_bytes) >= len(pdf_bytes):
        out_bytes = pdf_bytes

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return CompressResponse(
        success=True,
        filename=f"compressed_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        original_size=len(pdf_bytes),
        compressed_size=len(out_bytes),
    )


# ---- decrypt a password-protected PDF -------------------------------------


class DecryptRequest(BaseModel):
    """Request body for unlocking a password-protected PDF."""
    pdf_b64: str  # source (encrypted) PDF, base64
    password: str = ""  # the user/open password


class DecryptResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    pages: int = 0
    error: str | None = None


@app.post("/decrypt", response_model=DecryptResponse)
async def decrypt(req: DecryptRequest):
    """Open a password-protected PDF and return a decrypted (unprotected) copy.

    The user supplied the password, so producing an unencrypted working copy is
    the expected behaviour for an editor — pdf-lib/pdf.js can then edit it like any
    other file. Uses PyMuPDF only; the OCR engine is not required. Wrong password
    returns 401 so the UI can re-prompt.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không mở khoá được.")

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    try:
        if doc.needs_pass and not doc.authenticate(req.password or ""):
            raise HTTPException(status_code=401, detail="Sai mật khẩu")
        # Save an unencrypted copy (strip any user/owner password).
        out_bytes = doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE, deflate=True, garbage=3)
        pages = doc.page_count
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return DecryptResponse(
        success=True,
        filename=f"unlocked_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        pages=pages,
    )


# ---- shared PDF helpers (used by the P7 conversion endpoints below) -------
#
# Every PDF endpoint repeats the same three steps: size-check the base64, decode
# it, and open it with fitz. These helpers centralise that for the new endpoints
# (existing endpoints keep their inline version to stay surgical).


def _decode_pdf_b64(pdf_b64: str) -> bytes:
    """Validate size + decode a base64 PDF payload, raising HTTPException on error."""
    if len(pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        return base64.b64decode(pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")


def _require_fitz():
    """Import PyMuPDF or raise a 503 with a Vietnamese message (frozen builds bundle it)."""
    try:
        import fitz  # PyMuPDF

        return fitz
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không xử lý được PDF.")


# ---- P7: lock a PDF (set open/owner password) -----------------------------


class EncryptRequest(BaseModel):
    """Request body for password-protecting a PDF.

    `user_password` is the open password (required to view). `owner_password`
    (optional) controls permissions/editing; if blank we reuse the user password.
    The allow_* flags are honoured only when an owner password differs from the
    user password — otherwise a viewer who can open also holds owner rights.
    """
    pdf_b64: str
    user_password: str = ""
    owner_password: str = ""
    allow_print: bool = True
    allow_copy: bool = True
    allow_modify: bool = True
    allow_annotate: bool = True


class EncryptResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    pages: int = 0
    error: str | None = None


@app.post("/encrypt", response_model=EncryptResponse)
async def encrypt(req: EncryptRequest):
    """Return an AES-256 encrypted copy of the PDF protected by the given password(s).

    Mirror image of /decrypt. At least a user (open) password is required so the
    output is actually protected on open. Permissions are derived from the
    allow_* flags and bound to the owner password.
    """
    fitz = _require_fitz()

    user_pw = req.user_password or ""
    owner_pw = req.owner_password or user_pw
    if not user_pw and not req.owner_password:
        raise HTTPException(status_code=400, detail="Cần ít nhất một mật khẩu để khoá file.")

    pdf_bytes = _decode_pdf_b64(req.pdf_b64)
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    try:
        if doc.needs_pass:
            doc.close()
            raise HTTPException(status_code=400, detail="File đã có mật khẩu. Hãy mở khoá trước khi khoá lại.")
        perm = int(
            fitz.PDF_PERM_ACCESSIBILITY  # screen readers always allowed
            | (fitz.PDF_PERM_PRINT | fitz.PDF_PERM_PRINT_HQ if req.allow_print else 0)
            | (fitz.PDF_PERM_COPY if req.allow_copy else 0)
            | (fitz.PDF_PERM_MODIFY if req.allow_modify else 0)
            | (fitz.PDF_PERM_ANNOTATE if req.allow_annotate else 0)
        )
        out_bytes = doc.tobytes(
            encryption=fitz.PDF_ENCRYPT_AES_256,
            owner_pw=owner_pw,
            user_pw=user_pw,
            permissions=perm,
            deflate=True,
            garbage=3,
        )
        pages = doc.page_count
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Encrypt error")
        return EncryptResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return EncryptResponse(
        success=True,
        filename=f"locked_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        pages=pages,
    )


# ---- P7: extract embedded images out of a PDF -----------------------------


class ExtractImagesRequest(BaseModel):
    pdf_b64: str
    min_size: int = 16  # skip tiny images (icons/lines) below this px on a side


class ZipResponse(BaseModel):
    """Shared response for endpoints that return a .zip bundle of images."""
    success: bool
    filename: str = ""
    data_b64: str = ""  # the .zip, base64
    count: int = 0
    error: str | None = None


@app.post("/extract-images", response_model=ZipResponse)
async def extract_images(req: ExtractImagesRequest):
    """Pull every embedded raster image out of the PDF, returned as one .zip.

    De-duplicates by xref so an image repeated on many pages is saved once. Each
    file is named pNNN_imgMM.<ext> using the image's native encoding (no recompress).
    """
    fitz = _require_fitz()
    pdf_bytes = _decode_pdf_b64(req.pdf_b64)
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    buf = io.BytesIO()
    count = 0
    seen: set[int] = set()
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for pno in range(doc.page_count):
                for img in doc.get_page_images(pno, full=True):
                    xref = img[0]
                    if xref in seen:
                        continue
                    seen.add(xref)
                    try:
                        info = doc.extract_image(xref)
                    except Exception as e:
                        logger.debug("extract_image %d failed: %s", xref, e)
                        continue
                    if not info or not info.get("image"):
                        continue
                    if min(int(info.get("width", 0)), int(info.get("height", 0))) < req.min_size:
                        continue
                    ext = info.get("ext", "png")
                    count += 1
                    zf.writestr(f"p{pno + 1:03d}_img{count:03d}.{ext}", info["image"])
        pages = doc.page_count
    except Exception as e:
        logger.exception("Extract-images error")
        return ZipResponse(success=False, error=str(e))
    finally:
        doc.close()

    if count == 0:
        return ZipResponse(success=False, error="PDF không chứa ảnh nhúng nào (có thể là PDF text thuần).")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return ZipResponse(
        success=True,
        filename=f"images_{ts}.zip",
        data_b64=base64.b64encode(buf.getvalue()).decode("ascii"),
        count=count,
    )


# ---- P7: build a PDF from images ------------------------------------------


class ImagesToPdfRequest(BaseModel):
    images: list[str]  # base64 image bytes (no data URL prefix), in order
    page_size: str = "fit"  # "fit" = page matches each image; "a4" = fit onto A4 portrait


class PdfBytesResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    pages: int = 0
    error: str | None = None


@app.post("/images-to-pdf", response_model=PdfBytesResponse)
async def images_to_pdf(req: ImagesToPdfRequest):
    """Combine images (JPG/PNG/…) into a single PDF, one image per page.

    "fit": each page is sized to its image (no whitespace). "a4": each image is
    centred and scaled to fit an A4 portrait page.
    """
    fitz = _require_fitz()
    if not req.images:
        raise HTTPException(status_code=400, detail="Chưa chọn ảnh nào.")
    if len(req.images) > 500:
        raise HTTPException(status_code=400, detail="Quá nhiều ảnh (tối đa 500).")
    if req.page_size not in ("fit", "a4"):
        raise HTTPException(status_code=400, detail="page_size phải là fit|a4")

    doc = fitz.open()
    try:
        for i, b64 in enumerate(req.images):
            try:
                raw = base64.b64decode(b64)
            except Exception:
                raise HTTPException(status_code=400, detail=f"Ảnh thứ {i + 1} không hợp lệ (base64).")
            try:
                # Normalise via Pillow so odd formats (BMP/TIFF/WebP) become a PDF-safe
                # raster, and we get reliable pixel dimensions.
                pil = Image.open(io.BytesIO(raw))
                pil = pil.convert("RGB") if pil.mode not in ("RGB", "L") else pil
                png = io.BytesIO()
                pil.save(png, format="PNG")
                img_bytes = png.getvalue()
                iw, ih = pil.width, pil.height
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Không đọc được ảnh thứ {i + 1}: {e}")

            if req.page_size == "a4":
                page = doc.new_page(width=595, height=842)  # A4 portrait in points
                rect = page.rect + (28, 28, -28, -28)  # ~10mm margin
                scale = min(rect.width / iw, rect.height / ih)
                w, h = iw * scale, ih * scale
                x0 = rect.x0 + (rect.width - w) / 2
                y0 = rect.y0 + (rect.height - h) / 2
                target = fitz.Rect(x0, y0, x0 + w, y0 + h)
            else:  # fit: page == image size (72 dpi mapping point==pixel)
                page = doc.new_page(width=iw, height=ih)
                target = page.rect
            page.insert_image(target, stream=img_bytes)

        out_bytes = doc.tobytes(deflate=True, garbage=3)
        pages = doc.page_count
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Images-to-pdf error")
        return PdfBytesResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return PdfBytesResponse(
        success=True,
        filename=f"images_to_pdf_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        pages=pages,
    )


# ---- P7: render PDF pages to images ---------------------------------------


class PdfToImagesRequest(BaseModel):
    pdf_b64: str
    dpi: int = 150
    format: str = "png"  # png | jpg


@app.post("/pdf-to-images", response_model=ZipResponse)
async def pdf_to_images(req: PdfToImagesRequest):
    """Render every page to a raster image (PNG/JPG) and return them as one .zip."""
    fitz = _require_fitz()
    fmt = (req.format or "png").lower()
    if fmt not in ("png", "jpg", "jpeg"):
        raise HTTPException(status_code=400, detail="format phải là png|jpg")
    dpi = max(72, min(400, req.dpi))

    pdf_bytes = _decode_pdf_b64(req.pdf_b64)
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    if doc.page_count > 500:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF quá nhiều trang (tối đa 500).")

    buf = io.BytesIO()
    count = 0
    ext = "jpg" if fmt in ("jpg", "jpeg") else "png"
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for pno in range(doc.page_count):
                pix = doc[pno].get_pixmap(dpi=dpi, alpha=False)
                if ext == "jpg":
                    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                    out = io.BytesIO()
                    img.save(out, format="JPEG", quality=85)
                    data = out.getvalue()
                else:
                    data = pix.tobytes("png")
                count += 1
                zf.writestr(f"page_{pno + 1:03d}.{ext}", data)
    except Exception as e:
        logger.exception("Pdf-to-images error")
        doc.close()
        return ZipResponse(success=False, error=str(e))
    doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return ZipResponse(
        success=True,
        filename=f"pages_{ts}.zip",
        data_b64=base64.b64encode(buf.getvalue()).decode("ascii"),
        count=count,
    )


# ---- P6: native text editing (span-level replace via PyMuPDF) -------------
#
# "Edit the real characters" (like Foxit) only works on PDFs that carry an actual
# text layer (exported from Word/Excel/print-to-PDF), not on scans/flattened images.
# We do span-level replace: read each text span's box/font/size, then on edit we
# physically remove the old glyphs (redaction) and re-draw the new text in place.
# No reflow — one span at a time. Vietnamese glyphs the original font can't encode
# fall back to the bundled DejaVu Sans (same font used for the searchable layer).


def _norm_color(c) -> tuple[float, float, float]:
    """Normalise a colour to an (r,g,b) 0..1 tuple.

    Accepts a packed sRGB int (PyMuPDF span colour), a [r,g,b] list/tuple in
    0..1 or 0..255, or None (-> black).
    """
    if c is None:
        return (0.0, 0.0, 0.0)
    if isinstance(c, str):
        s = c.strip().lstrip("#")
        if len(s) == 6:
            try:
                n = int(s, 16)
                return (((n >> 16) & 255) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0)
            except ValueError:
                return (0.0, 0.0, 0.0)
        return (0.0, 0.0, 0.0)
    if isinstance(c, int):
        return (((c >> 16) & 255) / 255.0, ((c >> 8) & 255) / 255.0, (c & 255) / 255.0)
    if isinstance(c, (list, tuple)) and len(c) == 3:
        vals = [float(v) for v in c]
        if any(v > 1.0 for v in vals):
            vals = [v / 255.0 for v in vals]
        return (vals[0], vals[1], vals[2])
    return (0.0, 0.0, 0.0)


class TextSpansRequest(BaseModel):
    """Request body for reading a page's editable text spans."""
    pdf_b64: str
    page: int = 0  # 0-based page index


class TextSpan(BaseModel):
    id: int
    text: str
    bbox: list[float]  # [x0, y0, x1, y1] in PDF points, top-left origin
    origin: list[float]  # [x, y] text baseline origin (for faithful re-drawing)
    size: float
    font: str
    color: int  # packed sRGB
    flags: int  # PyMuPDF span flags (bold/italic/etc.)


class TextSpansResponse(BaseModel):
    success: bool
    has_text: bool = False
    spans: list[TextSpan] = []
    width: float = 0.0
    height: float = 0.0
    rotation: int = 0
    error: str | None = None


class FontsResponse(BaseModel):
    success: bool
    families: list[str] = []
    error: str | None = None


@app.get("/fonts", response_model=FontsResponse)
async def list_fonts():
    """List installed font families on this machine (for the text-edit font picker)."""
    fams = _list_local_font_families()
    return FontsResponse(success=bool(fams), families=fams)


@app.post("/text-spans", response_model=TextSpansResponse)
async def text_spans(req: TextSpansRequest):
    """Return the editable text spans on one page (empty if the page is a scan)."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không đọc được text.")

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    try:
        if req.page < 0 or req.page >= doc.page_count:
            raise HTTPException(status_code=400, detail="Số trang không hợp lệ")
        page = doc[req.page]
        spans: list[TextSpan] = []
        sid = 0
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                for sp in line.get("spans", []):
                    txt = sp.get("text", "")
                    if not txt.strip():
                        continue
                    x0, y0, x1, y1 = sp["bbox"]
                    ox, oy = sp.get("origin", (x0, y1))
                    spans.append(
                        TextSpan(
                            id=sid,
                            text=txt,
                            bbox=[x0, y0, x1, y1],
                            origin=[ox, oy],
                            size=float(sp.get("size", 11.0)),
                            font=str(sp.get("font", "")),
                            color=int(sp.get("color", 0)),
                            flags=int(sp.get("flags", 0)),
                        )
                    )
                    sid += 1
        rect = page.rect
        return TextSpansResponse(
            success=True,
            has_text=bool(spans),
            spans=spans,
            width=rect.width,
            height=rect.height,
            rotation=int(page.rotation),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("text-spans error")
        return TextSpansResponse(success=False, error=str(e))
    finally:
        doc.close()


class TextEdit(BaseModel):
    page: int
    bbox: list[float]  # [x0, y0, x1, y1] in PDF points, top-left origin (the span box)
    new_text: str
    origin: list[float] | None = None  # baseline [x, y]; falls back to bbox bottom-left
    size: float | None = None
    color: Any | None = None  # packed int / [r,g,b] / "#rrggbb"; defaults to black
    fill: Any | None = None  # redaction fill (page background); defaults to white
    # Optional rich-text formatting (P6 formatting controls):
    bg: Any | None = None  # background highlight colour; None = transparent
    bold: bool = False
    italic: bool = False
    underline: bool = False
    font: str | None = None  # family key: "default"(DejaVu/Vietnamese)|"times"|"helv"|"courier"


class EditTextRequest(BaseModel):
    pdf_b64: str
    edits: list[TextEdit]


class EditTextResponse(BaseModel):
    success: bool
    data_b64: str = ""
    filename: str = ""
    pages_changed: int = 0
    error: str | None = None


@app.post("/edit-text", response_model=EditTextResponse)
async def edit_text(req: EditTextRequest):
    """Apply span-level text replacements: remove old glyphs, redraw new text in place."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không sửa được text.")

    if not req.edits:
        raise HTTPException(status_code=400, detail="Không có chỉnh sửa nào")
    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    font_path = _vietnamese_font()  # Unicode fallback for diacritics

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")

    # Group edits per page so redactions are applied once per page.
    by_page: dict[int, list[TextEdit]] = {}
    for e in req.edits:
        if e.page < 0 or e.page >= doc.page_count:
            doc.close()
            raise HTTPException(status_code=400, detail=f"Trang {e.page} không hợp lệ")
        by_page.setdefault(e.page, []).append(e)

    try:
        for pno, edits in by_page.items():
            page = doc[pno]
            # 1. Physically remove the old glyphs under each box.
            for e in edits:
                page.add_redact_annot(fitz.Rect(*e.bbox), fill=_norm_color(e.fill) if e.fill is not None else (1, 1, 1))
            page.apply_redactions()

            # 2. Redraw the new text in the same box. Embed Vietnamese-capable
            #    fonts lazily — one PyMuPDF fontname per style variant we actually
            #    use (regular/bold/italic/bolditalic). Real variant TTFs render far
            #    cleaner than faux-bold stroking.
            embedded: dict[tuple[bool, bool], tuple[str, str] | None] = {}

            def embed_vn(bold: bool, italic: bool):
                key = (bold, italic)
                if key in embedded:
                    return embedded[key]
                vp = _dejavu_variant(font_path, bold, italic) if font_path else None
                if not vp:
                    embedded[key] = None
                    return None
                fn = "vnedit" + ("b" if bold else "") + ("i" if italic else "")
                try:
                    page.insert_font(fontname=fn, fontfile=vp)
                    embedded[key] = (fn, vp)
                except Exception as fe:
                    logger.debug("insert_font %s failed: %s", fn, fe)
                    embedded[key] = None
                return embedded[key]

            # Lazily embed a local system font (resolved by family name + style),
            # one PyMuPDF fontname per (name, bold, italic). Returns (fontname,
            # fontfile) or None when the family can't be resolved on this machine.
            local_embedded: dict[tuple[str, bool, bool], tuple[str, str] | None] = {}
            local_seq = [0]

            def embed_local(name: str, bold: bool, italic: bool):
                key = (name, bold, italic)
                if key in local_embedded:
                    return local_embedded[key]
                vp = _resolve_local_font(name, bold, italic)
                if not vp:
                    local_embedded[key] = None
                    return None
                fn = "loc%d" % local_seq[0]
                local_seq[0] += 1
                try:
                    page.insert_font(fontname=fn, fontfile=vp)
                    local_embedded[key] = (fn, vp)
                except Exception as fe:
                    logger.debug("insert_font local %s failed: %s", name, fe)
                    local_embedded[key] = None
                return local_embedded[key]

            for e in edits:
                txt = e.new_text or ""
                if not txt.strip():
                    continue  # empty edit = delete the span (redaction already did it)
                x0, y0, x1, y1 = e.bbox
                color = _norm_color(e.color)
                size = float(e.size) if e.size else max(6.0, (y1 - y0) * 0.8)
                # Redraw on the original baseline so the new text sits exactly where the
                # old text was. insert_text (point/baseline) is more faithful than
                # insert_textbox for a single span — no box-fit failure if the new text
                # is a bit longer (it flows right, just like the original line did).
                ox, oy = e.origin if e.origin else (x0, y1)

                # Background highlight (drawn before the text so the glyphs sit on top).
                if e.bg is not None:
                    try:
                        page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=None, fill=_norm_color(e.bg))
                    except Exception as be:
                        logger.debug("draw_rect (bg) error: %s", be)

                # Font selection. "default" → bundled DejaVu (Vietnamese-safe);
                # "times"/"helv"/"courier" → Base14 builtin (or matching local TTF
                # when the text needs non-Latin-1 glyphs); any other name → a local
                # system font resolved by family (this is how an edit keeps its
                # original font — the frontend sends the span's own font name).
                fam_raw = e.font or "default"
                fam = fam_raw.lower()
                needs_unicode = any(ord(ch) > 0xFF for ch in txt)
                builtin = {"times": "tiro", "helv": "helv", "courier": "cour"}.get(fam)

                fontname = None
                fontfile = None  # set when using an embedded TTF (for width calc)
                faux_bold = False
                faux_italic = False

                if fam == "default":
                    pass  # → DejaVu fallback below
                elif builtin:
                    if needs_unicode:
                        # Base14 builtins are Latin-1 only; use the matching local
                        # TrueType (covers Vietnamese) to preserve the look.
                        alias = {"times": "Times New Roman", "helv": "Arial", "courier": "Courier New"}[fam]
                        lf = embed_local(alias, bool(e.bold), bool(e.italic))
                        if lf:
                            fontname, fontfile = lf
                    else:
                        fontname = _BUILTIN_VARIANTS[builtin][(bool(e.bold), bool(e.italic))]
                else:
                    lf = embed_local(fam_raw, bool(e.bold), bool(e.italic))
                    if lf:
                        fontname, fontfile = lf

                # Fallback to bundled DejaVu (real bold/italic variant) when nothing
                # above resolved; faux styling only as the final resort.
                if fontname is None:
                    emb = embed_vn(bool(e.bold), bool(e.italic))
                    if emb:
                        fontname, fontfile = emb
                    else:
                        base = embed_vn(False, False)
                        if base:
                            fontname, fontfile = base
                        else:
                            fontname = "helv"  # last resort (Latin-1 only)
                        faux_bold = bool(e.bold)
                        faux_italic = bool(e.italic)

                # Faux-bold via fill+stroke (render_mode 2); faux-italic via a
                # horizontal shear. Only used when no real variant was found.
                render_mode = 2 if faux_bold else 0
                border_width = max(0.3, size * 0.03) if faux_bold else 0
                morph = None
                if faux_italic:
                    morph = (fitz.Point(ox, oy), fitz.Matrix(1, 0, 0.25, 1, 0, 0))

                try:
                    page.insert_text(
                        (ox, oy), txt, fontname=fontname, fontsize=size,
                        color=color, fill=color, render_mode=render_mode,
                        border_width=border_width, morph=morph,
                    )
                except Exception as ie:
                    logger.debug("insert_text error: %s", ie)
                    try:  # retry plain — some morph/render combos fail on odd fonts
                        page.insert_text((ox, oy), txt, fontname=fontname, fontsize=size, color=color)
                    except Exception as ie2:
                        logger.debug("insert_text retry error: %s", ie2)
                        continue

                # Underline: a line just under the baseline, width = drawn-text width.
                if e.underline:
                    try:
                        if fontfile:
                            tw = fitz.Font(fontfile=fontfile).text_length(txt, fontsize=size)
                        else:
                            tw = fitz.Font(fontname=fontname).text_length(txt, fontsize=size)
                    except Exception:
                        tw = x1 - x0
                    uy = oy + size * 0.12
                    try:
                        page.draw_line(fitz.Point(ox, uy), fitz.Point(ox + tw, uy),
                                       color=color, width=max(0.4, size * 0.06))
                    except Exception as ue:
                        logger.debug("draw_line (underline) error: %s", ue)

        # Subset embedded fonts so a full local TTF (Arial/Times/…) doesn't bloat
        # the file — only the glyphs actually used are kept.
        try:
            doc.subset_fonts()
        except Exception as se:
            logger.debug("subset_fonts (edit-text) skipped: %s", se)
        out_bytes = doc.tobytes(deflate=True, garbage=3)
        pages_changed = len(by_page)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("edit-text error")
        return EditTextResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return EditTextResponse(
        success=True,
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        filename=f"edited_{ts}.pdf",
        pages_changed=pages_changed,
    )


# ---------------------------------------------------------------------------
# Compare two PDFs (page + line diff)
# ---------------------------------------------------------------------------


class CompareRequest(BaseModel):
    """Body for POST /compare — two PDFs and a diff mode."""
    pdf_a_b64: str
    pdf_b_b64: str
    mode: str = "auto"  # "text" | "ocr" | "auto"


class CompareResponse(BaseModel):
    success: bool
    a_boxes: dict[str, Any] = {}
    b_boxes: dict[str, Any] = {}
    changes: list[Any] = []
    summary: dict[str, Any] = {}
    error: str | None = None


@app.post("/compare", response_model=CompareResponse)
async def compare(req: CompareRequest):
    """Diff two PDFs page-by-page and line-by-line.

    Text-layer pages use embedded text (fast, exact); scanned pages fall back to
    OCR when mode is "ocr"/"auto". Returns per-page diff ops with line boxes for
    on-screen highlighting.
    """
    _require_fitz()  # 503 with a clear message if PyMuPDF is missing

    if req.mode not in ("text", "ocr", "auto"):
        raise HTTPException(status_code=400, detail="mode phải là text | ocr | auto")

    for label, b64 in (("A", req.pdf_a_b64), ("B", req.pdf_b_b64)):
        if not b64:
            raise HTTPException(status_code=400, detail=f"Thiếu file {label}")
        if len(b64) > _MAX_PDF_B64:
            raise HTTPException(status_code=400, detail=f"File {label} quá lớn (tối đa ~200MB).")

    try:
        pdf_a = base64.b64decode(req.pdf_a_b64)
        pdf_b = base64.b64decode(req.pdf_b_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Dữ liệu PDF không hợp lệ")

    from src.compare import compare_pdfs

    try:
        report = compare_pdfs(pdf_a, pdf_b, mode=req.mode, get_ocr=_get_ocr)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("compare error")
        return CompareResponse(success=False, error=str(e))

    return CompareResponse(
        success=True,
        a_boxes=report["a_boxes"],
        b_boxes=report["b_boxes"],
        changes=report["changes"],
        summary=report["summary"],
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
