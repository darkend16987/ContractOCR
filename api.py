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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
