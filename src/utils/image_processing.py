"""Image preprocessing utilities for OCR."""

from pathlib import Path
from PIL import Image
import io


def load_image(file_path: str | Path) -> Image.Image:
    """Load an image from file path, handling common formats."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    return Image.open(path).convert("RGB")


def load_image_from_bytes(data: bytes) -> Image.Image:
    """Load an image from bytes (e.g., uploaded file)."""
    return Image.open(io.BytesIO(data)).convert("RGB")


def preprocess_for_ocr(image: Image.Image) -> Image.Image:
    """Basic preprocessing to improve OCR accuracy on scanned documents.

    For typed text on clean scans, minimal processing is needed.
    """
    # Convert to grayscale for better contrast
    gray = image.convert("L")

    # Simple thresholding - effective for clean typed documents
    threshold = 180
    binary = gray.point(lambda x: 255 if x > threshold else 0, "1")

    return binary.convert("RGB")


def pdf_to_images(pdf_path: str | Path) -> list[Image.Image]:
    """Convert PDF pages to images."""
    try:
        from pdf2image import convert_from_path
        return convert_from_path(str(pdf_path), dpi=300)
    except ImportError:
        raise ImportError(
            "pdf2image is required for PDF support. "
            "Install it with: pip install pdf2image\n"
            "Also requires poppler: apt-get install poppler-utils"
        )
