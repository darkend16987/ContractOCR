"""
FastAPI OCR Server for ContractOCR.

Exposes a /ocr endpoint that accepts base64 images,
runs PaddleOCR detection + VietOCR recognition,
and returns extracted Vietnamese text.
"""

import base64
import io
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

from src.ocr.engine import create_engine, BaseOCREngine

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Global OCR engine — loaded once at startup
ocr_engine: BaseOCREngine | None = None


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
    allow_methods=["POST"],
    allow_headers=["*"],
)


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
