"""
FastAPI OCR Server for Nabu PDF.

Exposes a /ocr endpoint that accepts base64 images,
runs RapidViet (RapidOCR ONNX detection + VietOCR recognition) by default,
and returns extracted Vietnamese text.
"""

import base64
import hashlib
import io
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import re as _re
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from PIL import Image

from src.ocr.engine import create_engine, BaseOCREngine
from src.agents.gemini_agent import GeminiAgent, DEFAULT_CONTRACT_FIELDS
from src.agents.field_templates import TEMPLATES
from src.output.writer import JSONWriter, ExcelWriter, CSVWriter
from src.utils.config import (
    GEMINI_MODEL,
    get_gemini_key,
    get_gemini_model,
    set_gemini_key,
    set_gemini_model,
)
from src.pdf.util import (
    _MAX_PDF_B64,
    _decode_pdf_b64,
    _fmt_page_label,
    _hex_rgb01,
    _open_pdf_stream,
    _parse_ranges,
    _require_fitz,
)
from src.pdf.fonts import (
    _BUILTIN_VARIANTS,
    _DEJAVU_SUFFIX,
    _clean_font_name,
    _dejavu_variant,
    _family_index,
    _font_covers,
    _fresh_fontname,
    _list_local_font_families,
    _norm_fam,
    _page_font_buffers,
    _resolve_local_font,
    _vietnamese_font,
)
from src.pdf.legacy_text import (
    _has_mojibake_chars,
    _is_legacy_font,
    _looks_vietnamese,
    _span_is_suspect,
    _transcode_tcvn3,
)
from src.pdf.layout import (
    _MASK_CLOSE,
    _MASK_OPEN,
    _block_from_spans,
    _cell_layout,
    _cell_of,
    _fit_fontsize,
    _mask_terms,
    _page_text_blocks,
    _run_boxes,
    _split_block_by_cells,
    _split_runs,
    _table_cells,
    _unmask_terms,
    _visual_lines,
)

# Curated Gemini models offered in the app's Settings dropdown. The user can
# still type any other id (free-text override) — this is only a convenience list.
GEMINI_MODEL_CHOICES = [
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
]

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
    # The renderer's origin is file://, so every sidecar call is cross-origin and JS
    # can read ONLY the CORS-safelisted response headers unless they are listed here.
    # Routes whose body is the PDF itself (/edit-text?raw=1, /compress-bin) carry
    # their metadata in X-* headers, and without this line those headers come back
    # as null in the renderer with no error anywhere — a silent, hard-to-place bug.
    expose_headers=["X-Original-Size", "X-Compressed-Size", "X-Filename", "X-Pages-Changed"],
)


# Per-launch shared secret. The desktop app (main.js) generates a random token and
# passes it to the sidecar via the SIDECAR_TOKEN env var + to the renderer, which
# echoes it back in the X-Sidecar-Token header. This stops other local processes /
# browser pages from hitting the loopback OCR server (DoS, or running up the user's
# Gemini bill). If SIDECAR_TOKEN is unset (running api.py/app.py directly in dev),
# the check is skipped for backwards compatibility.
_SIDECAR_TOKEN = os.environ.get("SIDECAR_TOKEN") or None


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
        gemini_agent = GeminiAgent(api_key=key, model_name=get_gemini_model())
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
    gemini_model: str | None = None


@app.get("/config")
async def get_config():
    """Report current settings state (key never returned in full — masked only)."""
    key = get_gemini_key()
    return {
        "gemini_configured": bool(key),
        "gemini_key_masked": _mask_key(key),
        "gemini_model": get_gemini_model(),
        "gemini_model_default": GEMINI_MODEL,
        "gemini_model_choices": GEMINI_MODEL_CHOICES,
    }


@app.post("/config")
async def update_config(req: ConfigUpdate):
    """Save the Gemini API key / model entered by the user, persist them, and
    rebuild the agent so the next /extract or /translate uses them — no sidecar
    restart needed."""
    global gemini_agent
    changed = False
    if req.gemini_api_key is not None:
        set_gemini_key(req.gemini_api_key)
        changed = True
    if req.gemini_model is not None:
        set_gemini_model(req.gemini_model)
        changed = True
    if changed:
        gemini_agent = None  # force rebuild with the new key/model on next use
    key = get_gemini_key()
    return {
        "success": True,
        "gemini_configured": bool(key),
        "gemini_key_masked": _mask_key(key),
        "gemini_model": get_gemini_model(),
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


class PdfToOfficeRequest(BaseModel):
    """Body for POST /pdf-to-office — convert a PDF's content to Office files."""
    pdf_b64: str
    format: str = "xlsx"   # "xlsx" | "docx" | "csv"
    scope: Any = "all"     # "all" or a list of 0-based page indices


class PdfToOfficeResponse(BaseModel):
    success: bool
    filename: str = ""
    mime: str = ""
    data_b64: str = ""
    is_scan: bool = False
    error: str | None = None


_OFFICE_MIME = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


@app.post("/pdf-to-office", response_model=PdfToOfficeResponse)
async def pdf_to_office(req: PdfToOfficeRequest):
    """Convert a text-based PDF's content (prose + tables) to xlsx/docx/csv.

    XLSX/CSV keep tables as real rows×columns; DOCX keeps the full text with
    tables. Scans (no text layer) are rejected — run OCR first. Bytes come back
    base64; the desktop app saves them via a native dialog (same as /export).
    """
    fmt = (req.format or "").lower()
    if fmt not in _OFFICE_MIME:
        raise HTTPException(status_code=400, detail="format must be xlsx|docx|csv")
    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    page_indices = None
    if isinstance(req.scope, list):
        page_indices = [p for p in req.scope if isinstance(p, int) and p >= 0]

    try:
        from src.output.pdf_office import convert
        data, had_content = convert(pdf_bytes, fmt, page_indices)
    except ValueError as ve:  # unsupported format (defensive; validated above)
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.exception("pdf-to-office error")
        return PdfToOfficeResponse(success=False, error=str(e))

    if not had_content:
        return PdfToOfficeResponse(
            success=False,
            is_scan=True,
            error="PDF này là bản scan (không có lớp text) — chuyển sang Office cần PDF có text thật. Hãy chạy OCR trước.",
        )

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return PdfToOfficeResponse(
        success=True,
        filename=f"converted_{ts}.{fmt}",
        mime=_OFFICE_MIME[fmt],
        data_b64=base64.b64encode(data).decode("ascii"),
    )


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

    doc = _open_pdf_stream(pdf_bytes)

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

# Page ceiling for compression. Purpose is to bound RUNTIME (rewrite_images walks
# every image on every page), not memory — so it is deliberately generous: a 200 MB
# scan is routinely 600–1500 pages, and the old 500 turned "nén file lớn" into a
# refusal for exactly the documents worth compressing.
_COMPRESS_MAX_PAGES = 3000

# Size ceiling for the BINARY compress route only. The base64/JSON routes stay at
# _MAX_PDF_B64 (~200 MB) because their peak cost is ~5x the file: base64 text in,
# str→bytes decode, fitz copy, base64 text out. /compress-bin carries raw bytes both
# ways, so the same machine survives a much larger file — hence its own, higher cap.
_MAX_PDF_BIN = 1_000_000_000  # 1 GB of actual PDF bytes


def _compress_pdf_bytes(pdf_bytes: bytes, preset: str) -> bytes:
    """Shrink `pdf_bytes` per `preset`; returns the ORIGINAL bytes if that is smaller.

    Shared by /compress (base64 JSON) and /compress-bin (raw binary) so the two
    routes can never drift on what "nén" actually does — they differ only in how the
    document travels. Raises HTTPException for caller errors (bad preset, unopenable
    PDF, too many pages); other failures propagate for the route to report.
    """
    if preset != "lossless" and preset not in _COMPRESS_PRESETS:
        raise HTTPException(status_code=400, detail="preset phải là screen|ebook|printer|lossless")

    doc = _open_pdf_stream(pdf_bytes)

    if doc.page_count > _COMPRESS_MAX_PAGES:
        doc.close()
        raise HTTPException(
            status_code=400, detail=f"PDF quá nhiều trang (tối đa {_COMPRESS_MAX_PAGES})."
        )

    try:
        if preset != "lossless":
            p = _COMPRESS_PRESETS[preset]
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
    finally:
        doc.close()

    # If compression somehow grew the file, hand back the original instead.
    return pdf_bytes if len(out_bytes) >= len(pdf_bytes) else out_bytes


# ---------------------------------------------------------------------------
# Running the compressor OUT OF PROCESS
# ---------------------------------------------------------------------------
#
# WHY A WHOLE PROCESS, AND WHY NOTHING SMALLER WORKS. Every route here is `async
# def`, so a synchronous PyMuPDF call occupies the one event loop, and the app has one
# sidecar shared by every tab and window. Measured on this code: a 30-page compress
# left /health unanswered for 13.1 s, and at the current ceiling (3000 pages, ~0.377
# s/page) that becomes roughly 19 minutes with every other tab's engine call hanging
# behind it.
#
# The obvious fix — hand the work to a worker thread — DOES NOT WORK, and the reason
# is worth writing down so nobody spends the afternoon rediscovering it:
#
#   * `doc.rewrite_images()` is 98.9% of the wall time (measured; subset_fonts and
#     tobytes are ~1% together) and it holds the GIL for its entire duration. With the
#     work on a second thread, an observer thread got 0.1% of the wall time and did not
#     execute a single iteration until the compression had finished. A thread frees
#     nothing.
#   * It is one document-level call with no page-range parameter, so it cannot be
#     sliced into chunks with an `await` between them either.
#   * And PyMuPDF calls `mupdf.reinit_singlethreaded()` at import, which drops MuPDF's
#     internal locking — so running it from two threads at once is not merely
#     unhelpful, it is unsafe.
#
# A child process has its own GIL and its own MuPDF context, and the parent waits on
# it with a plain OS wait (which releases the GIL). That is the only arrangement that
# actually keeps the sidecar answering while a big document is being compressed.
#
# The worker is THIS PROGRAM re-launched with --compress-worker (see sidecar.py), so
# there is no second executable to build, sign or ship, and the frozen binary already
# contains everything the work needs.

_COMPRESS_WORKER_FLAG = "--compress-worker"

# Below this, compress in-process. Starting the worker costs a fresh `import api`
# (measured 2.1 s in dev, more for the frozen exe), while compression itself runs at
# ~0.138 s/MB — so under ~25 MB the worker would be pure overhead on a job the user
# never notices, and over it the startup is amortised many times over.
_COMPRESS_WORKER_MIN_BYTES = 25_000_000

# Exit codes the worker speaks. Kept narrow on purpose: the parent has to tell "your
# request was wrong" (400, message shown to the user) from "we broke" (reported as a
# failure) from "the worker never ran" (fall back and compress in-process).
_WORKER_OK = 0
_WORKER_INTERNAL = 1
_WORKER_BAD_REQUEST = 3


def _compress_worker_cmd(src: str, dst: str, preset: str) -> list[str]:
    """Argv that re-launches this program as a one-shot compressor.

    Frozen: `sys.executable` IS sidecar.exe, so the flag goes straight to it. Dev:
    `sys.executable` is the venv python and the script has to be named explicitly.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, _COMPRESS_WORKER_FLAG, src, dst, preset]
    here = os.path.dirname(os.path.abspath(__file__))
    return [sys.executable, os.path.join(here, "sidecar.py"), _COMPRESS_WORKER_FLAG, src, dst, preset]


def _compress_via_worker_blocking(pdf_bytes: bytes, preset: str) -> bytes:
    """Compress in a child process. Runs on a worker THREAD (see the route).

    The thread is safe here precisely because it does no PyMuPDF work — it writes a
    file, waits on a process, and reads a file. All three release the GIL, so the
    event loop keeps running, and MuPDF stays confined to one process at a time.

    Raises HTTPException for caller errors, RuntimeError for a worker failure, and
    OSError when the worker could not be launched at all (the caller falls back).
    """
    tmp = tempfile.mkdtemp(prefix="nabu-compress-")
    src = os.path.join(tmp, "in.pdf")
    dst = os.path.join(tmp, "out.pdf")
    try:
        with open(src, "wb") as f:
            f.write(pdf_bytes)

        kwargs = {}
        if os.name == "nt":
            # Without this the frozen exe flashes a console window on every compress.
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

        proc = subprocess.run(  # noqa: S603 (argv is built here, never from the request)
            _compress_worker_cmd(src, dst, preset),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **kwargs,
        )
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()

        if proc.returncode == _WORKER_BAD_REQUEST:
            raise HTTPException(status_code=400, detail=err or "Không nén được PDF.")
        if proc.returncode != _WORKER_OK:
            raise RuntimeError(err or f"Tiến trình nén thoát với mã {proc.returncode}.")
        if not os.path.exists(dst):
            raise RuntimeError("Tiến trình nén không tạo ra file kết quả.")
        with open(dst, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/compress", response_model=CompressResponse)
async def compress(req: CompressRequest):
    """Shrink a PDF: downsample/recompress high-DPI images + strip redundant objects.

    Native (no Ghostscript binary) — uses PyMuPDF. Text and vector content are
    preserved; only over-sized embedded images are reduced (per preset). "lossless"
    leaves images untouched and just garbage-collects/deflates the file.

    This is the base64/JSON route, kept for the test grid and any non-desktop caller.
    The desktop app uses /compress-bin — see the note on _MAX_PDF_BIN.
    """
    try:
        import fitz  # noqa: F401  (PyMuPDF; presence check before we promise anything)
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không nén được.")

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    try:
        out_bytes = _compress_pdf_bytes(pdf_bytes, req.preset)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Compress error")
        return CompressResponse(success=False, error=str(e))

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return CompressResponse(
        success=True,
        filename=f"compressed_{ts}.pdf",
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        original_size=len(pdf_bytes),
        compressed_size=len(out_bytes),
    )


@app.post("/compress-bin")
async def compress_bin(request: Request, preset: str = "ebook"):
    """Same compression, carried as RAW BYTES in both directions.

    WHY THIS EXISTS. /compress is base64-in-JSON, so a 200 MB document costs
    ~280 MB of base64 text on the wire, a same-size Python str while json parses it,
    and the decoded bytes on top — before PyMuPDF has seen a single page. That is
    what _MAX_PDF_B64 was protecting against, and why "nén" refused anything over
    ~200 MB, which is precisely the size a user wants to compress.

    Here the request body IS the PDF (Content-Type: application/pdf) and the success
    response body IS the compressed PDF, so neither side ever builds a base64 string.
    Sizes travel in headers because the body is not JSON. Errors still return JSON,
    so the client tells success from failure by response Content-Type — the same
    contract /edit-text?raw=1 already established.
    """
    try:
        import fitz  # noqa: F401  (PyMuPDF)
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không nén được.")

    pdf_bytes = await request.body()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Không nhận được nội dung PDF.")
    if len(pdf_bytes) > _MAX_PDF_BIN:
        raise HTTPException(
            status_code=400, detail=f"PDF quá lớn (tối đa ~{_MAX_PDF_BIN // 1_000_000}MB)."
        )

    original_size = len(pdf_bytes)
    try:
        if len(pdf_bytes) >= _COMPRESS_WORKER_MIN_BYTES:
            # Big enough that blocking the loop would be felt in every other tab —
            # see the note above _COMPRESS_WORKER_FLAG for why this must be a process
            # and not a thread doing the PyMuPDF work.
            try:
                out_bytes = await run_in_threadpool(_compress_via_worker_blocking, pdf_bytes, preset)
            except OSError as e:
                # The worker could not be launched (missing script, no temp space, a
                # locked-down machine). Never lose the FEATURE over that: fall back to
                # compressing here, which is exactly the pre-worker behaviour.
                logger.warning("compress worker unavailable (%s) — compressing in-process", e)
                out_bytes = _compress_pdf_bytes(pdf_bytes, preset)
        else:
            # Small document: in-process is sub-second, and starting a worker would
            # cost more than the compression itself.
            out_bytes = _compress_pdf_bytes(pdf_bytes, preset)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Compress error")
        return JSONResponse(status_code=200, content={"success": False, "error": str(e)})

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return Response(
        content=out_bytes,
        media_type="application/pdf",
        headers={
            "X-Original-Size": str(original_size),
            "X-Compressed-Size": str(len(out_bytes)),
            "X-Filename": f"compressed_{ts}.pdf",
        },
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

    doc = _open_pdf_stream(pdf_bytes)

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
    doc = _open_pdf_stream(pdf_bytes)

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
    doc = _open_pdf_stream(pdf_bytes)

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


# ---- P8: stamp page numbers -----------------------------------------------


class PageNumberRequest(BaseModel):
    pdf_b64: str
    fmt: str = "n"                    # n | n_of_n | page_n | page_n_of_n | dash_n
    position: str = "bottom-center"  # {top,bottom}-{left,center,right}
    start_at: int = 1                # number given to the first numbered page
    skip_first: int = 0              # leave this many leading pages unnumbered (covers)
    font_size: float = 11.0
    color: str = "#000000"
    margin: float = 28.0             # points from the page edge


@app.post("/add-page-numbers", response_model=PdfBytesResponse)
async def add_page_numbers(req: PageNumberRequest):
    """Stamp incrementing page numbers onto every page (except skipped leaders).

    PyMuPDF works in each page's *displayed* coordinate system, so numbers land
    upright and in the right corner even on pages carrying a /Rotate entry (common
    in scans) — no manual rotation math needed. Modifies the document in place;
    the caller applies the result to the open doc with an undo step.
    """
    fitz = _require_fitz()
    valid_pos = {
        "top-left", "top-center", "top-right",
        "bottom-left", "bottom-center", "bottom-right",
    }
    if req.position not in valid_pos:
        raise HTTPException(status_code=400, detail="position không hợp lệ")
    valid_fmt = {"n", "n_of_n", "page_n", "page_n_of_n", "dash_n"}
    if req.fmt not in valid_fmt:
        raise HTTPException(status_code=400, detail="fmt không hợp lệ")

    pdf_bytes = _decode_pdf_b64(req.pdf_b64)
    doc = _open_pdf_stream(pdf_bytes)

    try:
        fs = max(6.0, min(72.0, float(req.font_size)))
        margin = max(2.0, min(300.0, float(req.margin)))
        start = max(1, int(req.start_at))
        skip = max(0, int(req.skip_first))
        col = _hex_rgb01(req.color)
        vpos, hpos = req.position.split("-")
        font = fitz.Font("helv")  # Base-14, ASCII labels — nothing to embed

        n_pages = doc.page_count
        numbered = max(0, n_pages - skip)
        highest = start + numbered - 1  # value shown as "N" in x/N formats
        stamped = 0
        for pno in range(n_pages):
            if pno < skip:
                continue
            page = doc[pno]
            num = start + (pno - skip)
            text = _fmt_page_label(req.fmt, num, highest)
            tw = font.text_length(text, fontsize=fs)
            # Place in the *displayed* rect (rotation-aware), then map the baseline
            # point back to unrotated page space and rotate the glyphs by the page's
            # rotation so they read upright after the viewer re-applies it. This keeps
            # numbers at the right visible corner on /Rotate scans (90/180/270).
            disp = page.rect  # displayed dimensions, origin top-left, y grows down
            if hpos == "left":
                dx = disp.x0 + margin
            elif hpos == "right":
                dx = disp.x1 - margin - tw
            else:
                dx = disp.x0 + (disp.width - tw) / 2
            dy = disp.y0 + margin + fs if vpos == "top" else disp.y1 - margin
            pt = fitz.Point(dx, dy) * page.derotation_matrix
            page.insert_text(pt, text, fontsize=fs, fontname="helv", color=col, rotate=page.rotation)
            stamped += 1

        out_bytes = doc.tobytes(deflate=True, garbage=3)
        pages = doc.page_count
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Add-page-numbers error")
        return PdfBytesResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return PdfBytesResponse(
        success=True,
        filename=f"page_numbers_{ts}.pdf",
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
    doc = _open_pdf_stream(pdf_bytes)

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


class SplitRequest(BaseModel):
    """Request body for splitting one PDF into several files.

    mode="every": consecutive chunks of `size` pages each (size=1 → one file per page).
    mode="ranges": one output file per comma-separated 1-based range, e.g. "1-3,5,8-10".
    """
    pdf_b64: str
    mode: str = "every"           # "every" | "ranges"
    size: int = 1                 # pages per chunk when mode="every"
    ranges: str = ""              # range spec when mode="ranges"


@app.post("/split", response_model=ZipResponse)
async def split_pdf(req: SplitRequest):
    """Split a PDF into multiple PDFs, returned as one .zip.

    Purely additive: reads the source, writes new PDFs, never mutates the input.
    """
    fitz = _require_fitz()
    pdf_bytes = _decode_pdf_b64(req.pdf_b64)
    doc = _open_pdf_stream(pdf_bytes)

    n = doc.page_count
    if n == 0:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF không có trang nào.")

    mode = (req.mode or "every").lower()
    if mode == "ranges":
        pairs = _parse_ranges(req.ranges or "", n)
        if not pairs:
            doc.close()
            raise HTTPException(status_code=400, detail="Khoảng trang không hợp lệ (vd: 1-3,5,8-10).")
    else:
        size = max(1, min(int(req.size or 1), n))
        pairs = [(s, min(s + size - 1, n - 1)) for s in range(0, n, size)]

    if len(pairs) > 1000:
        doc.close()
        raise HTTPException(status_code=400, detail="Quá nhiều file (tối đa 1000). Tăng số trang mỗi file.")

    buf = io.BytesIO()
    count = 0
    src_name = "part"
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for start, end in pairs:
                part = fitz.open()
                part.insert_pdf(doc, from_page=start, to_page=end)
                data = part.tobytes()
                part.close()
                count += 1
                label = f"{start + 1}" if start == end else f"{start + 1}-{end + 1}"
                zf.writestr(f"{src_name}_{count:03d}_p{label}.pdf", data)
    except Exception as e:
        logger.exception("Split error")
        doc.close()
        return ZipResponse(success=False, error=str(e))
    doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return ZipResponse(
        success=True,
        filename=f"split_{ts}.zip",
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
    bbox: list[float]  # [x0, y0, x1, y1] in PDF points, UNROTATED page space (redraw uses this)
    bbox_view: list[float]  # [x0, y0, x1, y1] in DISPLAYED (rotation-applied) space (overlay uses this)
    origin: list[float]  # [x, y] text baseline origin (for faithful re-drawing)
    size: float
    font: str
    color: int  # packed sRGB
    flags: int  # PyMuPDF span flags (bold/italic/etc.)
    suspect: bool = False  # extracted text likely wrong (legacy/broken font) → offer OCR


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

    doc = _open_pdf_stream(pdf_bytes)

    try:
        if req.page < 0 or req.page >= doc.page_count:
            raise HTTPException(status_code=400, detail="Số trang không hợp lệ")
        page = doc[req.page]
        spans: list[TextSpan] = []
        sid = 0
        data = page.get_text("dict")
        # get_text returns bbox in UNROTATED page space, but page.rect and the pdf.js
        # viewport are in DISPLAYED (rotation-applied) space. On a rotated CAD/Revit
        # page (/Rotate 90/270) the raw bbox lands in the wrong place and looks turned
        # 90°, so map each box through rotation_matrix for the overlay. On an unrotated
        # page rotation_matrix is the identity → bbox_view == bbox (no behaviour change).
        rot_mat = page.rotation_matrix
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                for sp in line.get("spans", []):
                    txt = sp.get("text", "")
                    if not txt.strip():
                        continue
                    x0, y0, x1, y1 = sp["bbox"]
                    # Drop degenerate boxes (zero/near-zero area or inverted) — these
                    # are the stray marks that showed up highlighted over non-text.
                    if (x1 - x0) < 0.5 or (y1 - y0) < 0.5:
                        continue
                    ox, oy = sp.get("origin", (x0, y1))
                    vr = fitz.Rect(x0, y0, x1, y1) * rot_mat
                    vr.normalize()  # rotation can flip corners; keep x0<x1, y0<y1
                    font_name = str(sp.get("font", ""))
                    suspect = _span_is_suspect(txt, font_name)
                    # Fast path: a legacy .Vn span whose TCVN3 transcode validates as
                    # clean Vietnamese is recovered here (no OCR needed). Otherwise the
                    # span stays flagged so the UI can OCR its pixels on demand.
                    if suspect and _is_legacy_font(font_name):
                        conv = _transcode_tcvn3(txt)
                        if conv != txt and _looks_vietnamese(conv):
                            txt = conv
                            suspect = False
                    spans.append(
                        TextSpan(
                            id=sid,
                            text=txt,
                            bbox=[x0, y0, x1, y1],
                            bbox_view=[vr.x0, vr.y0, vr.x1, vr.y1],
                            origin=[ox, oy],
                            size=float(sp.get("size", 11.0)),
                            font=font_name,
                            color=int(sp.get("color", 0)),
                            flags=int(sp.get("flags", 0)),
                            suspect=suspect,
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


# ---------------------------------------------------------------------------
# Find across the WHOLE document (the read half of Find & Replace)
# ---------------------------------------------------------------------------
#
# WHY A SEPARATE ENDPOINT AND NOT A LOOP OVER /text-spans. /text-spans reads ONE
# page and every call carries the whole PDF, so scanning a 200-page document would
# upload the file 200 times. This walks the document once per query instead.
#
# It is deliberately READ-ONLY. Applying a replacement reuses /edit-text unchanged:
# the renderer already has everything (span text + match offsets + the span's box,
# font, size and colour) to build exactly the edit the text editor sends by hand. So
# the whole battle-tested redraw path — redaction that takes only glyphs (BI-23),
# "keep the original font" with its glyph-coverage ladder (BI-21), the hscale/vscale
# geometry recovery (BI-25), rotated pages — is inherited rather than reimplemented.


class TextFindRequest(BaseModel):
    """Request body for a whole-document text search."""
    pdf_b64: str
    query: str
    match_case: bool = False
    whole_word: bool = False
    max_hits: int = 5000  # safety valve; a runaway query shouldn't build a 500 MB JSON


class TextFindHit(BaseModel):
    id: int  # position in this response's list; the renderer's cursor rides on it
    page: int
    span: int  # index of the span within its page (grouping only, NOT an identity)
    start: int  # match offset into span_text …
    end: int  # … half-open
    span_text: str  # the span's FULL text — the renderer splices into this
    bbox: list[float]  # UNROTATED span box; this is what /edit-text redraws into
    bbox_view: list[float]  # rotation-applied box; what the highlight is drawn from
    origin: list[float]
    size: float
    font: str
    color: int
    flags: int
    replaceable: bool  # False = the match straddles two spans (see below)


class TextFindResponse(BaseModel):
    success: bool
    has_text: bool = False  # False on a scan → the UI must send the user to OCR
    hits: list[TextFindHit] = []
    crossing: int = 0  # how many hits are replaceable=False
    truncated: bool = False  # hit max_hits and stopped
    truncated_page: int = 0  # 1-based page it stopped on, so the UI can say where
    pages_scanned: int = 0
    cached: bool = False  # the span index was reused, not re-parsed (diagnostic)
    error: str | None = None


def _is_word_char(ch: str) -> bool:
    """Word character for whole-word matching. `isalnum` is Unicode-aware in Python,
    so Vietnamese letters with diacritics count as word characters — which is the
    whole point; a byte/ASCII rule would make "Bên" match inside "Bên_A" wrongly."""
    return ch.isalnum() or ch == "_"


def _find_occurrences(
    hay: str, needle: str, match_case: bool, whole_word: bool
) -> list[tuple[int, int]]:
    """Non-overlapping occurrences of `needle` in `hay` as (start, end) half-open.

    Case-insensitive search folds BOTH sides and then indexes into the ORIGINAL
    string, so the fold must not change any character's width. It usually doesn't
    for Latin/Vietnamese, but a few code points (U+0130 'İ' → 'i̇') lowercase to two
    characters, and one of those anywhere in the span would slide every offset after
    it — silently splicing the replacement into the wrong place in the user's
    document. So: verify the length is unchanged, else fall back to exact matching.
    """
    if not needle:
        return []
    h, n = hay, needle
    if not match_case:
        hl, nl = hay.lower(), needle.lower()
        if len(hl) == len(hay) and len(nl) == len(needle):
            h, n = hl, nl
        # else: keep the original, case-sensitive strings — wrong-case misses beat
        # corrupting the file.

    out: list[tuple[int, int]] = []
    i = 0
    while True:
        j = h.find(n, i)
        if j < 0:
            break
        k = j + len(n)
        if whole_word:
            before_ok = j == 0 or not _is_word_char(h[j - 1])
            after_ok = k >= len(h) or not _is_word_char(h[k])
            if not (before_ok and after_ok):
                i = j + 1
                continue
        out.append((j, k))
        i = k  # non-overlapping
    return out


# ---------------------------------------------------------------------------
# The document, flattened once into the shape the matcher walks
# ---------------------------------------------------------------------------
#
# WHY AN INDEX AND NOT get_text("dict") ON EVERY SEARCH. Parsing is the entire cost
# of a search: reopen the file, walk every block/line/span of every page. On a
# 480-page A1 drawing set that is tens of seconds, and the user searches the SAME
# document several times in a row (find, refine, replace, find again) for an
# identical parse. So the parse is separated from the matching, and cached.
#
# THE CACHE KEY MUST BE A HASH OF ALL THE BYTES. Keying on length plus a couple of
# sampled chunks is tempting and wrong: an edit in the middle would keep the key,
# the stale index would be reused, and every offset in it would point at the wrong
# characters — BI-50's failure mode reached from the other side, and it ends with a
# replacement written over innocent text. blake2b over the whole buffer costs a
# fraction of the parse it saves.
#
# ONE span is flattened to a plain tuple (a big drawing set has hundreds of
# thousands of them, and the cache holds them all):
#   0 text · 1 host · 2 bbox · 3 bbox_view · 4 origin · 5 size · 6 font · 7 color · 8 flags
#
# `host` is False for the whitespace-only spans PyMuPDF synthesises when a line is
# drawn in pieces (a Td/TJ cursor jump between two words becomes a real span holding
# " "). Their text STAYS in the joined line — dropping it is what used to make
# "Hợp đồng" unfindable, because the line joined to "Hợpđồng" — but they never host
# a match, so a replacement is never written into one.

_FIND_CACHE: dict = {"entry": None}  # (key, pages), swapped as ONE tuple so a
# concurrent reader can never pair a new key with an old index.

# Ceiling on what may be cached, so a big file cannot pin hundreds of MB in the
# sidecar for the rest of the session. Above it searches still work — they just
# re-parse every time.
#
# THE NUMBER IS MEASURED, NOT GUESSED. A flattened span costs ~1.5 KB once the two
# box tuples, the origin, the text and the font name are counted: a real 600-page
# text PDF indexed to 27,000 spans for +41 MB of RSS. The first value here was
# 300,000, which permits ~450 MB — i.e. exactly the "hundreds of MB" the ceiling is
# meant to prevent. 80,000 keeps it near 100 MB, and nothing is refused: a document
# past the line simply pays the parse again on its next search.
_FIND_CACHE_MAX_PARTS = 80_000


def _find_build_index(doc) -> tuple[list, int]:
    """Flatten `doc` to per-page lists of (joined, offsets, parts, span_base)."""
    import fitz  # PyMuPDF (cached; the caller already ensured it imports)

    pages: list = []
    total_parts = 0
    for pno in range(doc.page_count):
        page = doc[pno]
        # get_text returns bbox in UNROTATED page space; the overlay draws in
        # displayed space. Identity on an unrotated page, so no behaviour change.
        rot_mat = page.rotation_matrix
        data = page.get_text("dict")
        lines: list = []
        span_idx = 0
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                parts: list = []
                for sp in line.get("spans", []):
                    txt = sp.get("text", "")
                    x0, y0, x1, y1 = sp["bbox"]
                    if (x1 - x0) < 0.5 or (y1 - y0) < 0.5:
                        continue  # degenerate box; same filter /text-spans uses
                    host = bool(txt.strip())
                    font_name = str(sp.get("font", ""))
                    # The same legacy-font ladder /text-spans climbs, so a TCVN3 span
                    # that "Sửa nội dung" displays correctly is also FINDABLE. Without
                    # it the two features disagree about what the page says, and the
                    # user is told a word they can SEE is not there.
                    if host and _span_is_suspect(txt, font_name) and _is_legacy_font(font_name):
                        conv = _transcode_tcvn3(txt)
                        if conv != txt and _looks_vietnamese(conv):
                            txt = conv
                    vr = fitz.Rect(x0, y0, x1, y1) * rot_mat
                    vr.normalize()  # rotation can flip corners; keep x0<x1, y0<y1
                    ox, oy = sp.get("origin", (x0, y1))
                    parts.append(
                        (
                            txt,
                            host,
                            (x0, y0, x1, y1),
                            (vr.x0, vr.y0, vr.x1, vr.y1),
                            (ox, oy),
                            float(sp.get("size", 11.0)),
                            font_name,
                            int(sp.get("color", 0)),
                            int(sp.get("flags", 0)),
                        )
                    )
                if not any(p[1] for p in parts):
                    continue  # blank line — nothing findable on it
                offsets: list[int] = []
                acc = 0
                for p in parts:
                    offsets.append(acc)
                    acc += len(p[0])
                lines.append(("".join(p[0] for p in parts), offsets, parts, span_idx))
                span_idx += len(parts)
                total_parts += len(parts)
        pages.append(lines)
    return pages, total_parts


def _find_index_for(pdf_bytes: bytes) -> tuple[list, bool]:
    """The flattened index for these exact bytes. Returns (pages, came_from_cache)."""
    key = hashlib.blake2b(pdf_bytes, digest_size=16).hexdigest()
    entry = _FIND_CACHE["entry"]
    if entry is not None and entry[0] == key:
        return entry[1], True

    doc = _open_pdf_stream(pdf_bytes)
    try:
        pages, total_parts = _find_build_index(doc)
    finally:
        doc.close()

    _FIND_CACHE["entry"] = (key, pages) if total_parts <= _FIND_CACHE_MAX_PARTS else None
    return pages, False


def _find_scan_index(
    pages: list, query: str, match_case: bool, whole_word: bool, max_hits: int
) -> tuple[list, int, int]:
    """Match `query` against a built index. Returns (hits, crossing, truncated_page).

    ONE pass, over the joined line. The previous version matched twice — once inside
    each span, once over the concatenation — and that is where two silent bugs lived:

    * "Đúng nguyên từ" was judged on the SPAN, so a line drawn as ["AB", "2026"]
      reported `2026` as a whole word (it does start its span) and marked it
      replaceable — and replacing it corrupted `AB2026`. On the joined line the
      character before it is `B`, so it is correctly not a whole word.
    * Whitespace-only spans were dropped before joining, so a query spanning a
      synthesised gap could not be found at all.

    Matching once on the line and mapping the offsets back to spans gives both
    correct boundaries and correct joining, with less code than the two-pass form.
    """
    import fitz  # PyMuPDF

    hits: list[TextFindHit] = []
    crossing = 0
    truncated_page = 0

    for pno, lines in enumerate(pages):
        if truncated_page:
            break
        for joined, offsets, parts, span_base in lines:
            if truncated_page:
                break
            for s, e in _find_occurrences(joined, query, match_case, whole_word):
                if len(hits) >= max_hits:
                    truncated_page = pno + 1
                    break
                touched = [
                    i
                    for i in range(len(parts))
                    if offsets[i] < e and offsets[i] + len(parts[i][0]) > s
                ]
                if not touched:
                    continue

                if len(touched) == 1 and parts[touched[0]][1]:
                    # Wholly inside one real span → /edit-text can rewrite it.
                    i = touched[0]
                    p = parts[i]
                    hits.append(
                        TextFindHit(
                            id=0,
                            page=pno,
                            span=span_base + i,
                            start=s - offsets[i],
                            end=e - offsets[i],
                            span_text=p[0],
                            bbox=list(p[2]),
                            bbox_view=list(p[3]),
                            origin=list(p[4]),
                            size=p[5],
                            font=p[6],
                            color=p[7],
                            flags=p[8],
                            replaceable=True,
                        )
                    )
                    continue

                # Straddles a formatting boundary (or a synthesised gap): counted and
                # highlighted across the union of everything it touches, never
                # rewritten — half a replacement would wreck the run's formatting.
                #
                # TWO unions, not one. `bbox` is contractually the UNROTATED box — it is
                # the rectangle /edit-text would redact — while `bbox_view` is the
                # displayed one, and on a /Rotate page those are different rectangles.
                # Building both from the rotated parts made `bbox` a lie: harmless only
                # for as long as these hits stay replaceable=False, and a silent
                # wrong-rectangle redaction the day anyone lifts that restriction.
                union = None  # unrotated: parts[i][2]
                union_v = None  # displayed: parts[i][3]
                for i in touched:
                    r = fitz.Rect(*parts[i][2])
                    union = r if union is None else (union | r)
                    rv = fitz.Rect(*parts[i][3])
                    union_v = rv if union_v is None else (union_v | rv)
                crossing += 1
                first = parts[touched[0]]
                hits.append(
                    TextFindHit(
                        id=0,
                        page=pno,
                        span=span_base + touched[0],
                        start=0,
                        end=len(joined),
                        span_text=joined,
                        bbox=[union.x0, union.y0, union.x1, union.y1],
                        bbox_view=[union_v.x0, union_v.y0, union_v.x1, union_v.y1],
                        origin=[union.x0, union.y1],
                        size=first[5],
                        font=first[6],
                        color=first[7],
                        flags=first[8],
                        replaceable=False,
                    )
                )

    # Reading order: PyMuPDF yields blocks in the order they were drawn, which is not
    # always top-to-bottom. "Tìm tiếp" must walk the page the way a human reads it.
    hits.sort(key=lambda h: (h.page, round(h.bbox_view[1], 1), round(h.bbox_view[0], 1), h.start))
    for i, h in enumerate(hits):
        h.id = i
    return hits, crossing, truncated_page


def _text_find_core(
    pdf_bytes: bytes, query: str, match_case: bool, whole_word: bool, max_hits: int
) -> TextFindResponse:
    """Shared body of /text-find and /text-find-bin — the two differ only in how the
    document arrives, so neither can drift away from the other's results."""
    try:
        import fitz  # noqa: F401  (PyMuPDF; presence check before we promise anything)
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không tìm được text.")

    if not query:
        raise HTTPException(status_code=400, detail="Chưa nhập từ khoá cần tìm.")

    try:
        pages, cached = _find_index_for(pdf_bytes)
        hits, crossing, truncated_page = _find_scan_index(
            pages, query, match_case, whole_word, max(1, max_hits)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("text-find error")
        return TextFindResponse(success=False, error=str(e))

    return TextFindResponse(
        success=True,
        has_text=any(pages),
        hits=hits,
        crossing=crossing,
        truncated=bool(truncated_page),
        truncated_page=truncated_page,
        pages_scanned=len(pages),
        cached=cached,
    )


@app.post("/text-find", response_model=TextFindResponse)
async def text_find(req: TextFindRequest):
    """Every occurrence of `query` in the document, with the span data needed to edit it.

    Matches are reported per SPAN (a run of same-font/size/colour text on one line),
    because that is the unit /edit-text rewrites. A match that starts in one span and
    ends in the next — which happens when a word changes style mid-way, e.g. "Bên **A**"
    — is still reported (so the count the user sees is the truth) but flagged
    `replaceable: False` rather than replaced wrongly.

    This is the base64/JSON route, kept for the test grid and any non-desktop caller.
    The desktop app uses /text-find-bin — see the note there.
    """
    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")
    return _text_find_core(pdf_bytes, req.query, req.match_case, req.whole_word, req.max_hits)


@app.post("/text-find-bin", response_model=TextFindResponse)
async def text_find_bin(
    request: Request,
    query: str = "",
    match_case: bool = False,
    whole_word: bool = False,
    max_hits: int = 5000,
):
    """The same search, with the document carried as RAW BYTES in the request body.

    WHY THIS EXISTS. /text-find is base64-in-JSON, so a 250 MB drawing set costs
    ~350 MB of base64 text built in the renderer, the same again as a Python str
    while json parses it, and the decoded bytes on top. _MAX_PDF_B64 refused it
    outright at ~200 MB — and a several-hundred-page A1 set, which is exactly the
    document nobody wants to search by hand, is over that line.

    Here the request body IS the PDF (Content-Type: application/pdf) and only the
    small JSON answer comes back, so no base64 string is built on either side. Same
    move /compress-bin made for Nén (BI-49). Errors stay JSON, and so does success —
    unlike /compress-bin the response is not a document, so there is no Content-Type
    contract to read: `success` in the body is the whole answer.
    """
    pdf_bytes = await request.body()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Không nhận được nội dung PDF.")
    if len(pdf_bytes) > _MAX_PDF_BIN:
        raise HTTPException(
            status_code=400, detail=f"PDF quá lớn (tối đa ~{_MAX_PDF_BIN // 1_000_000}MB)."
        )
    return _text_find_core(pdf_bytes, query, match_case, whole_word, max_hits)


class OcrSpanRequest(BaseModel):
    """Recover the real text of one span by OCR-ing its pixels (for legacy/broken
    fonts get_text can't decode). bbox is the span's UNROTATED page-space box."""
    pdf_b64: str
    page: int = 0
    bbox: list[float]  # [x0, y0, x1, y1] in unrotated PDF points
    zoom: float = 4.0  # render scale for the crop (higher = better OCR on small text)


class OcrSpanResponse(BaseModel):
    success: bool
    text: str = ""
    error: str | None = None


@app.post("/ocr-span", response_model=OcrSpanResponse)
async def ocr_span(req: OcrSpanRequest):
    """OCR a single span region and return the recognised text."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không OCR được vùng.")
    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")
    if len(req.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox phải có 4 số")

    doc = _open_pdf_stream(pdf_bytes)
    try:
        if req.page < 0 or req.page >= doc.page_count:
            raise HTTPException(status_code=400, detail="Số trang không hợp lệ")
        page = doc[req.page]
        x0, y0, x1, y1 = req.bbox
        # Pad a little so ascenders/descenders and diacritics aren't clipped, then
        # map the (unrotated) box into displayed space — get_pixmap renders the page
        # rotation-applied, so the crop comes out horizontal and ready for OCR.
        h = max(1.0, y1 - y0)
        padx = h * 0.25
        pady = h * 0.35
        clip = fitz.Rect(x0 - padx, y0 - pady, x1 + padx, y1 + pady) * page.rotation_matrix
        clip.normalize()
        clip = clip & page.rect  # keep inside the page
        z = max(1.0, min(8.0, float(req.zoom or 4.0)))
        pix = page.get_pixmap(matrix=fitz.Matrix(z, z), clip=clip)
        png = pix.tobytes("png")
    except HTTPException:
        raise
    except Exception as e:
        doc.close()
        logger.exception("ocr-span render error")
        return OcrSpanResponse(success=False, error=str(e))
    finally:
        doc.close()

    try:
        image = Image.open(io.BytesIO(png)).convert("RGB")
        engine = _get_ocr()
        text = (engine.recognize(image) or "").strip()
        return OcrSpanResponse(success=True, text=text)
    except Exception as e:
        logger.exception("ocr-span recognize error")
        return OcrSpanResponse(success=False, error=str(e))


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
    # The text and size this span had BEFORE the edit. Used only to recover the
    # geometry the document drew it at (see the hscale/vscale block in edit_text);
    # both optional, so an older renderer keeps working with no scaling applied.
    orig_text: str | None = None
    orig_size: float | None = None


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
async def edit_text(req: EditTextRequest, raw: bool = False):
    """Apply span-level text replacements: remove old glyphs, redraw new text in place.

    With ?raw=1 the successful result is returned as a raw application/pdf body
    (metadata in headers) instead of base64 JSON. The desktop renderer uses this
    to avoid decoding a ~180 MB base64 string (which OOM'd the renderer on large
    documents). Errors still return JSON, so the client tells success from failure
    by response Content-Type. raw defaults False → JSON, keeping other callers/tests
    unchanged."""
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

    doc = _open_pdf_stream(pdf_bytes)

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
            # 0. Lift the page's own font programs out FIRST. apply_redactions can
            #    drop a font resource once its last glyphs are gone, and these
            #    buffers are the only way to keep a face that isn't installed on
            #    this machine (see embed_page_font below).
            page_font_buffers = _page_font_buffers(doc, page)
            # 1. Physically remove the old glyphs under each box — and NOTHING else.
            #    The box is the text's own bbox, so everything it overlaps (a shaded
            #    table cell, the rule under a heading, a scanned letterhead) was
            #    drawn by the document, not by the text we are replacing:
            #      * no `fill`, or an opaque rectangle lands on the page — invisible
            #        on white paper, a white patch on a shaded cell. `fill` stays in
            #        the API for callers that really do want the area painted over.
            #      * IMAGE_NONE, or the pixels of a picture under the box are blanked.
            #      * LINE_ART_NONE, or vector art the box *covers* is deleted, which
            #        is exactly how Word draws an underline.
            #    Same bargain /translate already makes; see test_edit_text_layout.py.
            for e in edits:
                page.add_redact_annot(
                    fitz.Rect(*e.bbox),
                    fill=_norm_color(e.fill) if e.fill is not None else False,
                )
            try:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_NONE,
                    graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                )
            except TypeError:
                # PyMuPDF predating the `graphics` parameter (requirements allow back
                # to 1.24.0). There a covered underline is still dropped — cosmetic;
                # the glyphs go either way, which is the job.
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

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
                fn = _fresh_fontname(page, "vnedit" + ("b" if bold else "") + ("i" if italic else ""))
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

            def embed_local(name: str, bold: bool, italic: bool):
                key = (name, bold, italic)
                if key in local_embedded:
                    return local_embedded[key]
                vp = _resolve_local_font(name, bold, italic)
                if not vp:
                    local_embedded[key] = None
                    return None
                fn = _fresh_fontname(page, "loc")
                try:
                    page.insert_font(fontname=fn, fontfile=vp)
                    local_embedded[key] = (fn, vp)
                except Exception as fe:
                    logger.debug("insert_font local %s failed: %s", name, fe)
                    local_embedded[key] = None
                return local_embedded[key]

            # Re-embed the font program the SOURCE PDF already carries for this
            # family — the last resort before giving up on the original look, and
            # the only one that works for faces nobody has installed (CAD/corporate
            # fonts, SVN-*, .Vn*). Returns (fontname, buffer) or None.
            # Callers MUST have checked glyph coverage first: these buffers are
            # subsets, so an unchecked reuse redraws notdef boxes (□).
            page_embedded: dict[str, tuple[str, bytes] | None] = {}

            def embed_page_font(key: str, buf: bytes):
                if key in page_embedded:
                    return page_embedded[key]
                fn = _fresh_fontname(page, "src")
                try:
                    page.insert_font(fontname=fn, fontbuffer=buf)
                    page_embedded[key] = (fn, buf)
                except Exception as fe:
                    logger.debug("insert_font page-font %s failed: %s", key, fe)
                    page_embedded[key] = None
                return page_embedded[key]

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
                fontbuffer = None  # set when reusing the source PDF's own font program
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

                # Coverage guard for non-Latin-1 text (Vietnamese diacritics, etc.).
                # A mis-resolved local TTF — or the "keep original font" name matching
                # a font without Vietnamese glyphs — makes insert_text draw notdef
                # boxes (□) SILENTLY. Only a real embedded TTF that actually covers
                # the text is trusted: Base-14 builtins report false coverage, so an
                # unset `fontfile` counts as unsafe and we drop to DejaVu below.
                if needs_unicode and not (fontfile and _font_covers(txt, fontfile=fontfile)):
                    fontname = None
                    fontfile = None

                # Nothing installed matched (or it failed the coverage check): try
                # the font program the source PDF itself embeds for this name. This
                # is what keeps a CAD/corporate face that exists nowhere else on the
                # machine. Only for a real font name — "default" means the user
                # explicitly asked for the Vietnamese fallback, and the Base-14
                # builtins have nothing to extract.
                #
                # The coverage check here is UNCONDITIONAL (not just for
                # needs_unicode): these buffers are subsets carrying only the glyphs
                # the document already used, so even plain ASCII can be missing —
                # exactly the shape of the v0.2.34 □ regression.
                if fontname is None and fam != "default" and not builtin:
                    buf = page_font_buffers.get(_norm_fam(_clean_font_name(fam_raw)))
                    if buf and _font_covers(txt, fontbuffer=buf):
                        pe = embed_page_font(_norm_fam(_clean_font_name(fam_raw)), buf)
                        if pe:
                            fontname, fontbuffer = pe

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

                # ---- match the geometry of the face we are replacing --------------
                #
                # The original face is very often unavailable: the PDF carries it as a
                # subset with no usable cmap (see the coverage guard above), so we draw
                # in a substitute. A substitute with the same NAME is not the same
                # DESIGN — measured on the invoice that prompted this, the embedded
                # "TimesNewRomanBold" sits at 0.83 of Windows Times New Roman Bold's
                # width and 0.91 of its height, with per-glyph advances differing in
                # both directions (T narrower, o wider). No single point size can fix
                # that, which is why there are two independent corrections here.
                #
                # Both are no-ops (dead band) when the substitute IS the original face,
                # so ordinary documents are untouched.
                fobj = None
                try:
                    if fontbuffer:
                        fobj = fitz.Font(fontbuffer=fontbuffer)
                    elif fontfile:
                        fobj = fitz.Font(fontfile=fontfile)
                    else:
                        fobj = fitz.Font(fontname=fontname)
                except Exception as fe:
                    logger.debug("metric probe: no font object: %s", fe)

                # 1. HEIGHT. Scale the point size so the substitute's line box
                #    (ascender..descender) matches the line box the PDF declared for
                #    the original font — the same rule a viewer uses when it has to
                #    substitute, and the CSS `font-size-adjust` idea. `bbox` is the
                #    span's box as /text-spans reported it, so bbox_h / orig_size is
                #    the original's line box in em. Applied as a RATIO, so an explicit
                #    size the user typed is corrected the same way and stays consistent
                #    with the text around it.
                if fobj and e.orig_size and e.orig_size > 0:
                    try:
                        line_em = fobj.ascender - fobj.descender
                        if line_em > 0.1:
                            v = ((y1 - y0) / float(e.orig_size)) / line_em
                            if 0.6 <= v <= 1.6 and abs(v - 1.0) > 0.02:
                                size *= v
                    except Exception as ve:
                        logger.debug("vscale probe failed: %s", ve)

                # 2. WIDTH. insert_text always draws at the font's natural advances, so
                #    a wider substitute — or text the document drew CONDENSED via a Tz
                #    in the content stream — comes out longer than the line it replaces
                #    and runs into whatever follows. Measure the ORIGINAL string in the
                #    font we are about to draw with and scale x by whatever factor puts
                #    it back at the width it had. Derived from the OLD text only, so a
                #    longer replacement still grows normally rather than being squeezed
                #    into the old box — this is not fit-to-box.
                #
                #    Must come after the height correction: text_length scales with
                #    size, so the two are independent and compose exactly.
                #
                #    Measure the WHOLE original string, whitespace included: the bbox
                #    being divided by is the box that whole string produced, and a
                #    trailing space carries a real advance. Stripping the probe while
                #    keeping the full bbox mismatches the two and leaves the redraw
                #    measurably wide (median 1.03, worst 1.08 across this page).
                hscale = 1.0
                probe = e.orig_text or ""
                if fobj and probe.strip() and (x1 - x0) > 1:
                    try:
                        natural = fobj.text_length(probe, fontsize=size)
                        if natural > 1:
                            r = (x1 - x0) / natural
                            # Outside this range the measurement is not credible (a
                            # one-glyph span, a rotated matrix, a broken bbox) — leave
                            # the text alone rather than distort it on a bad reading.
                            if 0.5 <= r <= 2.0 and abs(r - 1.0) > 0.02:
                                hscale = r
                    except Exception as he:
                        logger.debug("hscale probe failed: %s", he)

                # Faux-bold via fill+stroke (render_mode 2); faux-italic via a
                # horizontal shear. Only used when no real variant was found.
                render_mode = 2 if faux_bold else 0
                border_width = max(0.3, size * 0.03) if faux_bold else 0
                # One matrix carries both the shear and the squeeze; morphing about the
                # baseline origin keeps the text starting exactly where the old text did.
                morph = None
                if faux_italic or hscale != 1.0:
                    morph = (
                        fitz.Point(ox, oy),
                        fitz.Matrix(hscale, 0, 0.25 if faux_italic else 0, 1, 0, 0),
                    )

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
                        if fontbuffer:
                            tw = fitz.Font(fontbuffer=fontbuffer).text_length(txt, fontsize=size)
                        elif fontfile:
                            tw = fitz.Font(fontfile=fontfile).text_length(txt, fontsize=size)
                        else:
                            tw = fitz.Font(fontname=fontname).text_length(txt, fontsize=size)
                    except Exception:
                        tw = x1 - x0
                    tw *= hscale  # the drawn glyphs were squeezed; the rule must match
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
    if raw:
        # Binary path: hand back the PDF bytes directly — no base64 — so the
        # renderer skips the decode that blew its heap on 100 MB+ files.
        return Response(
            content=out_bytes,
            media_type="application/pdf",
            headers={
                "X-Pages-Changed": str(pages_changed),
                "X-Filename": f"edited_{ts}.pdf",
            },
        )
    return EditTextResponse(
        success=True,
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        filename=f"edited_{ts}.pdf",
        pages_changed=pages_changed,
    )


# ---------------------------------------------------------------------------
# Translate a text-based PDF with Gemini (Phase 1: new file, keep layout)
# ---------------------------------------------------------------------------

# Target language display names for the translation prompt.
_LANG_NAMES = {
    "auto": "the source language",
    "vi": "Vietnamese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "th": "Thai",
    "ru": "Russian",
}


def _translate_blocks(agent, items: list[dict], target: str, source: str) -> dict[int, str] | None:
    """Send block texts to Gemini, return {index: translation}; None on hard fail.

    Partial results are fine — a missing index leaves that block untranslated.
    """
    import json

    system = (
        "You are a professional document translator. "
        f"Translate the 't' field of every item from {source} into {target}. "
        f"Any token shaped like {_MASK_OPEN}N{_MASK_CLOSE} (N a number) is a placeholder "
        "for a number/date/code — copy it through EXACTLY, do not alter or drop it. "
        "Do NOT translate proper nouns, product codes, or measurement units. "
        "Return ONLY a JSON array with the SAME number of items and the SAME 'i' values, "
        'shaped [{"i": <int>, "t": "<translated text>"}]. No markdown, no commentary.'
    )
    prompt = json.dumps(items, ensure_ascii=False)

    for _ in range(2):
        try:
            raw = agent._generate(prompt, system_instruction=system)
            data = json.loads(raw)
            if isinstance(data, dict):  # unwrap {"items":[...]} style replies
                data = next((v for v in data.values() if isinstance(v, list)), None)
            if not isinstance(data, list):
                continue
            result: dict[int, str] = {}
            for e in data:
                if isinstance(e, dict) and "i" in e:
                    result[int(e["i"])] = str(e.get("t", ""))
            if result:
                return result
        except Exception as te:
            logger.debug("translate blocks parse/gen error: %s", te)
    return None


class TranslateRequest(BaseModel):
    """Body for POST /translate-pdf (Phase 1 = new file, keep layout)."""
    pdf_b64: str
    source_lang: str = "auto"
    target_lang: str = "en"
    scope: Any = "all"          # "all" or a list of 0-based page indices
    keep_numbers: bool = True   # mask numbers/dates/emails so they survive verbatim


class TranslateResponse(BaseModel):
    success: bool
    data_b64: str = ""
    filename: str = ""
    pages_changed: int = 0
    blocks_translated: int = 0
    is_scan: bool = False
    error: str | None = None


@app.post("/translate-pdf", response_model=TranslateResponse)
async def translate_pdf(req: TranslateRequest):
    """Translate a text-based PDF block-by-block with Gemini, keep layout, new file.

    Reuses the /edit-text redraw pipeline: redact each text block, re-typeset the
    translation into the same box with the original font/colour, auto-fit the size.
    Scans (no text layer) are rejected — Phase 1 handles real text only.
    """
    fitz = _require_fitz()

    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")

    agent = _get_gemini()  # 503 if no key configured
    target_name = _LANG_NAMES.get((req.target_lang or "en").lower(), req.target_lang)
    source_name = _LANG_NAMES.get((req.source_lang or "auto").lower(), req.source_lang)
    font_path = _vietnamese_font()

    doc = _open_pdf_stream(pdf_bytes)

    # Resolve the page scope.
    if isinstance(req.scope, list):
        pages = [p for p in req.scope if isinstance(p, int) and 0 <= p < doc.page_count]
    else:
        pages = list(range(doc.page_count))
    if not pages:
        doc.close()
        raise HTTPException(status_code=400, detail="Phạm vi trang không hợp lệ")

    total_text_blocks = 0
    blocks_translated = 0
    pages_changed: set[int] = set()

    try:
        for pno in pages:
            page = doc[pno]
            blocks = _page_text_blocks(page)
            if not blocks:
                continue
            total_text_blocks += len(blocks)

            # Mask protected terms, then translate the whole page in one call.
            items: list[dict] = []
            stores: list[list[str]] = []
            for i, b in enumerate(blocks):
                if req.keep_numbers:
                    masked, store = _mask_terms(b["text"])
                else:
                    masked, store = b["text"], []
                items.append({"i": i, "t": masked})
                stores.append(store)

            translations = _translate_blocks(agent, items, target_name, source_name)
            if not translations:
                continue  # leave the whole page untouched on failure

            # Resolve each block's final translated text (skip empties / no-ops).
            finals: dict[int, str] = {}
            for i, b in enumerate(blocks):
                raw = translations.get(i)
                if raw is None:
                    continue
                t = _unmask_terms(raw, stores[i]).strip()
                if t and t != b["text"]:
                    finals[i] = t
            if not finals:
                continue

            # 1. Remove the old glyphs under every translated block (once per
            #    page) and nothing else. The box only hugs the source text, so a
            #    white fill would punch a hole in a shaded table cell or a
            #    banner; the redaction defaults would also drop an underline
            #    sitting under the text (line art the box covers) and blank the
            #    image pixels behind it. Translating replaces words, not what
            #    they are drawn on top of.
            for i in finals:
                page.add_redact_annot(fitz.Rect(*blocks[i]["bbox"]))
            try:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_NONE,
                    graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                )
            except (TypeError, AttributeError):
                # PyMuPDF predating the `graphics` parameter (requirements allow
                # back to 1.24.0). There an underline under the text is still
                # dropped — cosmetic; the glyphs go either way, which is the job.
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

            # 2. Lazily embed fonts (same scheme as /edit-text), then re-typeset.
            embedded: dict[tuple[bool, bool], tuple[str, str] | None] = {}
            local_embedded: dict[tuple[str, bool, bool], tuple[str, str] | None] = {}

            def embed_vn(bold: bool, italic: bool):
                key = (bold, italic)
                if key in embedded:
                    return embedded[key]
                vp = _dejavu_variant(font_path, bold, italic) if font_path else None
                if not vp:
                    embedded[key] = None
                    return None
                # _fresh_fontname: translating an already-translated file would
                # otherwise re-ask for this page's own /trvn — see /edit-text.
                fn = _fresh_fontname(page, "trvn" + ("b" if bold else "") + ("i" if italic else ""))
                try:
                    page.insert_font(fontname=fn, fontfile=vp)
                    embedded[key] = (fn, vp)
                except Exception:
                    embedded[key] = None
                return embedded[key]

            def embed_local(name: str, bold: bool, italic: bool):
                key = (name, bold, italic)
                if key in local_embedded:
                    return local_embedded[key]
                vp = _resolve_local_font(name, bold, italic)
                if not vp:
                    local_embedded[key] = None
                    return None
                fn = _fresh_fontname(page, "trloc")
                try:
                    page.insert_font(fontname=fn, fontfile=vp)
                    local_embedded[key] = (fn, vp)
                except Exception:
                    local_embedded[key] = None
                return local_embedded[key]

            for i, t in finals.items():
                b = blocks[i]
                bold, italic = b["bold"], b["italic"]
                color = _norm_color(b["color"])

                fontname = None
                fontfile = None
                lf = embed_local(b["font"], bold, italic) if b["font"] else None
                if lf:
                    fontname, fontfile = lf

                # Coverage guard (mirrors /edit-text, api.py "needs_unicode" block):
                # b["font"] is the ORIGINAL PDF font. Translating EN→VI, that is an
                # English font, and many Western fonts have no glyphs for the
                # Vietnamese range (Latin Extended Additional, U+1EA0–U+1EFF). A
                # local TTF resolved from such a name makes insert_textbox draw
                # notdef boxes (□) SILENTLY. Trust the local font only when it
                # actually covers the translated text; otherwise drop to the bundled
                # DejaVu below (Vietnamese-safe).
                needs_unicode = any(ord(ch) > 0xFF for ch in t)
                if needs_unicode and not (fontfile and _font_covers(t, fontfile=fontfile)):
                    fontname = None
                    fontfile = None

                if fontname is None:
                    emb = embed_vn(bold, italic) or embed_vn(False, False)
                    if emb:
                        fontname, fontfile = emb
                    else:
                        fontname = "helv"

                try:
                    font_obj = fitz.Font(fontfile=fontfile) if fontfile else fitz.Font(fontname=fontname)
                except Exception:
                    font_obj = fitz.Font(fontname="helv")

                # Typeset into `layout`, not the redacted bbox: inside a table
                # that is the cell (room to grow, original alignment kept);
                # everywhere else the two are the same rect.
                rect = fitz.Rect(*b.get("layout") or b["bbox"])
                fs = _fit_fontsize(font_obj, t, rect.width, rect.height,
                                   start=b["size"], min_size=5.0)
                align = b.get("align", 0)
                try:
                    # The old text is already redacted away, so a refused insert
                    # leaves the block blank. insert_textbox reports that by
                    # returning the height it was short by (drawing nothing, no
                    # exception) — step down until it takes, rather than trust
                    # the estimate and lose the text.
                    while fs >= 5.0:
                        if page.insert_textbox(rect, t, fontname=fontname, fontsize=fs,
                                               color=color, align=align) >= 0:
                            blocks_translated += 1
                            break
                        fs -= 0.5
                except Exception as be:
                    logger.debug("insert_textbox (translate) error: %s", be)

            pages_changed.add(pno)

        if total_text_blocks == 0:
            return TranslateResponse(
                success=False,
                is_scan=True,
                error="PDF này là bản scan (không có lớp text) — bản dịch giữ layout chỉ hỗ trợ PDF có text thật.",
            )
        if not pages_changed:
            return TranslateResponse(
                success=False,
                error="Không dịch được (Gemini không trả kết quả hợp lệ). Thử lại hoặc kiểm tra API key.",
            )

        try:
            doc.subset_fonts()
        except Exception as se:
            logger.debug("subset_fonts (translate) skipped: %s", se)
        out_bytes = doc.tobytes(deflate=True, garbage=3)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("translate-pdf error")
        return TranslateResponse(success=False, error=str(e))
    finally:
        doc.close()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return TranslateResponse(
        success=True,
        data_b64=base64.b64encode(out_bytes).decode("ascii"),
        filename=f"translated_{req.target_lang}_{ts}.pdf",
        pages_changed=len(pages_changed),
        blocks_translated=blocks_translated,
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

    try:
        from src.compare import compare_pdfs

        report = compare_pdfs(pdf_a, pdf_b, mode=req.mode, get_ocr=_get_ocr)
        return CompareResponse(
            success=True,
            a_boxes=report.get("a_boxes", {}),
            b_boxes=report.get("b_boxes", {}),
            changes=report.get("changes", []),
            summary=report.get("summary", {}),
        )
    except HTTPException:
        raise
    except Exception as e:
        # Never let an unexpected error escape as a bare 500 (the renderer then
        # gets non-JSON and can't show a reason). Return it as JSON instead.
        logger.exception("compare error")
        return CompareResponse(success=False, error=str(e))


# ---------------------------------------------------------------------------
# Compare two drawing PDFs (visual raster diff — CAD/Revit exports)
# ---------------------------------------------------------------------------


class CompareDrawingsRequest(BaseModel):
    """Body for POST /compare-drawings — two PDFs and a diff sensitivity."""
    pdf_a_b64: str
    pdf_b_b64: str
    sensitivity: str = "normal"  # "low" | "normal" | "high"


@app.post("/compare-drawings", response_model=CompareResponse)
async def compare_drawings_ep(req: CompareDrawingsRequest):
    """Visual diff of two drawing PDFs (raster compare, Bluebeam-style).

    Pages are matched by perceptual fingerprint (robust to inserted/removed
    sheets), each matched pair is rendered and pixel-diffed, and changed
    regions come back as boxes in the same format as /compare.
    """
    _require_fitz()  # 503 with a clear message if PyMuPDF is missing

    if req.sensitivity not in ("low", "normal", "high"):
        raise HTTPException(status_code=400, detail="sensitivity phải là low | normal | high")

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

    try:
        from src.compare import compare_drawings

        report = compare_drawings(pdf_a, pdf_b, sensitivity=req.sensitivity)
        return CompareResponse(
            success=True,
            a_boxes=report.get("a_boxes", {}),
            b_boxes=report.get("b_boxes", {}),
            changes=report.get("changes", []),
            summary=report.get("summary", {}),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("compare-drawings error")
        return CompareResponse(success=False, error=str(e))


class OverlayDrawingsRequest(BaseModel):
    """Body for POST /overlay-drawings — two drawing PDFs to onion-skin."""
    pdf_a_b64: str
    pdf_b_b64: str


@app.post("/overlay-drawings")
async def overlay_drawings_ep(req: OverlayDrawingsRequest):
    """Match pages of two drawings and return the per-pair alignment offset
    (PDF points) so the frontend can overlay them as aligned layers."""
    _require_fitz()

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

    try:
        from src.compare.drawing import overlay_drawings

        return overlay_drawings(pdf_a, pdf_b)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("overlay-drawings error")
        return {"success": False, "error": str(e)}


class CompareExportRequest(BaseModel):
    """Body for POST /compare-drawings/export — stamp change regions onto a PDF."""
    pdf_b64: str
    boxes: dict[str, Any] = {}
    style: str = "cloud"  # "cloud" | "rect"


class CompareExportResponse(BaseModel):
    success: bool
    data_b64: str | None = None
    filename: str | None = None
    error: str | None = None


@app.post("/compare-drawings/export", response_model=CompareExportResponse)
async def compare_drawings_export(req: CompareExportRequest):
    """Return the PDF with change regions marked as revision-cloud annotations."""
    _require_fitz()

    if req.style not in ("cloud", "rect"):
        raise HTTPException(status_code=400, detail="style phải là cloud | rect")
    if not req.pdf_b64:
        raise HTTPException(status_code=400, detail="Thiếu file PDF")
    if len(req.pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa ~200MB).")

    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Dữ liệu PDF không hợp lệ")

    try:
        from src.compare import annotate_pdf

        out = annotate_pdf(pdf_bytes, req.boxes, style=req.style)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return CompareExportResponse(
            success=True,
            data_b64=base64.b64encode(out).decode("ascii"),
            filename=f"compared_{ts}.pdf",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("compare-drawings export error")
        return CompareExportResponse(success=False, error=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
