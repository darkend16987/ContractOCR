"""
FastAPI OCR Server for Nabu PDF.

Exposes a /ocr endpoint that accepts base64 images,
runs PaddleOCR detection + VietOCR recognition,
and returns extracted Vietnamese text.
"""

import base64
import io
import logging
import os
import tempfile
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
    """Load OCR engine at startup."""
    global ocr_engine
    logger.info("Loading OCR engine (hybrid: PaddleOCR detect + VietOCR recognize)...")
    try:
        ocr_engine = create_engine("hybrid")
        # Warm up by loading the models
        logger.info("OCR engine ready")
    except Exception as e:
        logger.warning("Hybrid engine failed, falling back to auto: %s", e)
        ocr_engine = create_engine("auto")
    yield
    logger.info("Shutting down OCR server")


app = FastAPI(
    title="Nabu PDF API",
    description="Vietnamese OCR API using PaddleOCR + VietOCR",
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
    return {"status": "ok", "engine": "hybrid" if ocr_engine else "not_loaded"}


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
    if not ocr_engine:
        raise HTTPException(status_code=503, detail="OCR engine not loaded")

    if not request.images:
        raise HTTPException(status_code=400, detail="No images provided")

    if len(request.images) > 50:
        raise HTTPException(status_code=400, detail="Too many images (max 50)")

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
            text = ocr_engine.recognize(image)
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
    if not ocr_engine:
        raise HTTPException(status_code=503, detail="OCR engine not loaded")

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
        for i, img_base64 in enumerate(req.images):
            pn = req.page_numbers[i] if req.page_numbers and i < len(req.page_numbers) else i + 1
            try:
                img = Image.open(io.BytesIO(base64.b64decode(img_base64))).convert("RGB")
            except Exception as e:
                logger.error("Failed to decode image %d: %s", pn, e)
                pages.append(OCRPageResult(page_number=pn, text=f"[Lỗi đọc ảnh: {e}]"))
                continue
            pages.append(OCRPageResult(page_number=pn, text=ocr_engine.recognize(img)))

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


class SearchableRequest(BaseModel):
    """Request body for building a searchable PDF (invisible OCR text layer)."""
    pdf_b64: str  # the source PDF, base64 (no data URL prefix)
    dpi: int = 200  # rasterisation DPI for OCR


class SearchableResponse(BaseModel):
    success: bool
    filename: str = ""
    data_b64: str = ""
    pages: int = 0
    words: int = 0
    error: str | None = None


@app.post("/searchable", response_model=SearchableResponse)
async def searchable(req: SearchableRequest):
    """OCR a (scanned) PDF and return a copy with a selectable, invisible text layer.

    The original page content is preserved; OCR text is laid over each word's box
    with render mode 3 (invisible) so the output looks identical but is searchable.
    """
    if not ocr_engine:
        raise HTTPException(status_code=503, detail="OCR engine not loaded")

    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không tạo được searchable PDF.")

    font_path = _vietnamese_font()
    if not font_path:
        raise HTTPException(status_code=503, detail="Không tìm thấy font Unicode (DejaVu Sans) để nhúng lớp text.")

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

    total_words = 0
    try:
        for page in doc:
            page.insert_font(fontname="vnocr", fontfile=font_path)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            try:
                boxes = ocr_engine.recognize_boxes(image)
            except NotImplementedError:
                doc.close()
                raise HTTPException(status_code=503, detail="Engine OCR hiện tại không hỗ trợ định vị (cần Hybrid/Paddle).")

            for text, (x0, y0, x1, y1) in boxes:
                t = (text or "").strip()
                if not t:
                    continue
                # Box in PDF points; baseline near the box bottom.
                bx0, by1 = x0 * scale, y1 * scale
                box_h = (y1 - y0) * scale
                fontsize = max(2.0, box_h * 0.8)
                try:
                    page.insert_text(
                        (bx0, by1 - box_h * 0.15),
                        t,
                        fontname="vnocr",
                        fontsize=fontsize,
                        render_mode=3,  # invisible
                    )
                    total_words += 1
                except Exception as e:
                    logger.debug("skip text box: %s", e)

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
    color: Any | None = None  # packed int / [r,g,b]; defaults to black
    fill: Any | None = None  # redaction fill (page background); defaults to white


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

            # 2. Redraw the new text in the same box. Embed the Unicode fallback
            #    font once per page (only if we have it).
            have_font = False
            if font_path:
                try:
                    page.insert_font(fontname="vnedit", fontfile=font_path)
                    have_font = True
                except Exception as fe:
                    logger.debug("insert_font failed: %s", fe)

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
                fontname = "vnedit" if have_font else "helv"
                try:
                    page.insert_text(
                        (ox, oy), txt, fontname=fontname, fontsize=size, color=color
                    )
                except Exception as ie:
                    logger.debug("insert_text error: %s", ie)

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
