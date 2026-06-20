"""
FastAPI OCR Server for ContractOCR.

Exposes a /ocr endpoint that accepts base64 images,
runs PaddleOCR detection + VietOCR recognition,
and returns extracted Vietnamese text.
"""

import base64
import io
import logging
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

from src.ocr.engine import create_engine, BaseOCREngine
from src.agents.gemini_agent import GeminiAgent, DEFAULT_CONTRACT_FIELDS
from src.agents.field_templates import TEMPLATES
from src.output.writer import JSONWriter, ExcelWriter, CSVWriter
from src.utils.config import GEMINI_API_KEY, GEMINI_MODEL

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
    title="ContractOCR API",
    description="Vietnamese OCR API using PaddleOCR + VietOCR",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_gemini() -> GeminiAgent:
    """Lazily build the Gemini agent; raise 503 if no API key is configured."""
    global gemini_agent
    if gemini_agent is None:
        if not GEMINI_API_KEY:
            raise HTTPException(
                status_code=503,
                detail="GEMINI_API_KEY chưa cấu hình (.env). Bóc tách field cần Gemini.",
            )
        gemini_agent = GeminiAgent(api_key=GEMINI_API_KEY, model_name=GEMINI_MODEL)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
