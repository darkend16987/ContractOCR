"""OCR Engine module - supports VietOCR, PaddleOCR, and Hybrid mode for Vietnamese text."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from pathlib import Path
from PIL import Image

logger = logging.getLogger(__name__)


class BaseOCREngine(ABC):
    """Abstract base class for OCR engines."""

    @abstractmethod
    def recognize(self, image: Image.Image) -> str:
        """Recognize text from a PIL Image. Returns extracted text."""
        ...

    def recognize_file(self, file_path: str | Path) -> str:
        """Recognize text from an image file."""
        from src.utils.image_processing import load_image
        image = load_image(file_path)
        return self.recognize(image)


class VietOCREngine(BaseOCREngine):
    """Vietnamese OCR using VietOCR (Transformer-based, optimized for Vietnamese).

    IMPORTANT: VietOCR is recognition-only — it expects pre-cropped single text line
    images. For full-page documents, use HybridOCREngine or PaddleOCREngine instead.
    """

    def __init__(self, model_name: str = "vgg_transformer"):
        self.model_name = model_name
        self._predictor = None

    @property
    def predictor(self):
        if self._predictor is None:
            logger.info("Loading VietOCR model: %s", self.model_name)
            from vietocr.tool.predictor import Predictor
            from vietocr.tool.config import Cfg
            config = Cfg.load_config_from_name(self.model_name)
            config["cnn"]["pretrained"] = False
            config["device"] = "cpu"
            try:
                import torch
                if torch.cuda.is_available():
                    config["device"] = "cuda:0"
                    logger.info("VietOCR using GPU")
            except ImportError:
                pass
            self._predictor = Predictor(config)
            logger.info("VietOCR model loaded successfully")
        return self._predictor

    def recognize(self, image: Image.Image) -> str:
        """Recognize Vietnamese text from a single-line cropped image."""
        return self.predictor.predict(image)

    def recognize_batch(self, images: list[Image.Image]) -> list[str]:
        """Batch recognize text from multiple cropped line images."""
        return self.predictor.predict_batch(images)


class PaddleOCREngine(BaseOCREngine):
    """OCR using PaddleOCR with Vietnamese language support.

    Handles full document layout: text detection + recognition in one pass.
    """

    def __init__(self, lang: str = "vi"):
        self.lang = lang
        self._ocr = None

    @property
    def ocr(self):
        if self._ocr is None:
            logger.info("Loading PaddleOCR with lang=%s", self.lang)
            from paddleocr import PaddleOCR
            self._ocr = PaddleOCR(
                use_angle_cls=True,
                lang=self.lang,
                show_log=False,
            )
            logger.info("PaddleOCR loaded successfully")
        return self._ocr

    def recognize(self, image: Image.Image) -> str:
        """Recognize text from image using PaddleOCR.

        Returns all detected text joined by newlines, preserving reading order.
        """
        import numpy as np
        img_array = np.array(image)
        results = self.ocr.ocr(img_array, cls=True)

        if not results or not results[0]:
            return ""

        lines = []
        for line in results[0]:
            text = line[1][0]  # (bbox, (text, confidence))
            lines.append(text)

        return "\n".join(lines)

    def detect_only(self, image: Image.Image) -> list[list[list[int]]]:
        """Run text detection only, returns list of bounding boxes.

        Each bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]].
        """
        import numpy as np
        img_array = np.array(image)
        results = self.ocr.ocr(img_array, rec=False)

        if not results or not results[0]:
            return []

        return results[0]


class HybridOCREngine(BaseOCREngine):
    """Hybrid engine: PaddleOCR for text detection + VietOCR for recognition.

    This combines PaddleOCR's robust layout detection with VietOCR's superior
    Vietnamese text recognition accuracy. Best of both worlds for Vietnamese
    documents with clean typed text.
    """

    def __init__(self, vietocr_model: str = "vgg_transformer", paddle_lang: str = "vi"):
        self._detector = PaddleOCREngine(lang=paddle_lang)
        self._recognizer = VietOCREngine(model_name=vietocr_model)

    def _crop_text_region(self, image: Image.Image, bbox: list[list[int]]) -> Image.Image:
        """Crop a text region from the image using its bounding box."""
        import numpy as np

        pts = np.array(bbox, dtype=np.float32)
        x_min = max(0, int(pts[:, 0].min()))
        y_min = max(0, int(pts[:, 1].min()))
        x_max = min(image.width, int(pts[:, 0].max()))
        y_max = min(image.height, int(pts[:, 1].max()))

        return image.crop((x_min, y_min, x_max, y_max))

    def _sort_bboxes_reading_order(self, bboxes: list[list[list[int]]]) -> list[list[list[int]]]:
        """Sort bounding boxes in reading order (top-to-bottom, left-to-right)."""
        if not bboxes:
            return bboxes

        def sort_key(bbox):
            # Use top-left y coordinate as primary, x as secondary
            y = min(pt[1] for pt in bbox)
            x = min(pt[0] for pt in bbox)
            return (y, x)

        return sorted(bboxes, key=sort_key)

    def recognize(self, image: Image.Image) -> str:
        """Detect text regions with PaddleOCR, then recognize with VietOCR."""
        # Step 1: Detect text regions
        bboxes = self._detector.detect_only(image)
        if not bboxes:
            logger.warning("No text regions detected")
            return ""

        # Step 2: Sort in reading order
        bboxes = self._sort_bboxes_reading_order(bboxes)

        # Step 3: Crop and recognize each region with VietOCR
        cropped_images = [self._crop_text_region(image, bbox) for bbox in bboxes]
        texts = self._recognizer.recognize_batch(cropped_images)

        logger.info("Hybrid OCR: detected %d regions, recognized %d texts", len(bboxes), len(texts))
        return "\n".join(texts)


class AutoOCREngine(BaseOCREngine):
    """Automatic engine selection.

    Priority:
    1. HybridOCREngine (PaddleOCR detection + VietOCR recognition) - best accuracy
    2. PaddleOCREngine (full pipeline) - if VietOCR unavailable
    3. VietOCREngine (recognition only) - fallback, limited to single lines
    """

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self.vietocr_model = vietocr_model
        self._engine: BaseOCREngine | None = None

    @property
    def engine(self) -> BaseOCREngine:
        if self._engine is None:
            # Try Hybrid first (best accuracy for Vietnamese)
            try:
                self._engine = HybridOCREngine(vietocr_model=self.vietocr_model)
                # Test if both engines load
                _ = self._engine._detector.ocr
                _ = self._engine._recognizer.predictor
                logger.info("Auto-selected Hybrid engine (PaddleOCR detection + VietOCR recognition)")
                return self._engine
            except Exception as e:
                logger.info("Hybrid engine unavailable: %s", e)

            # Fallback to PaddleOCR only
            try:
                self._engine = PaddleOCREngine()
                _ = self._engine.ocr
                logger.info("Auto-selected PaddleOCR engine")
                return self._engine
            except Exception as e:
                logger.info("PaddleOCR unavailable: %s", e)

            # Last resort: VietOCR only (single line recognition)
            logger.warning("Only VietOCR available - works on single text lines only")
            self._engine = VietOCREngine(self.vietocr_model)

        return self._engine

    def recognize(self, image: Image.Image) -> str:
        return self.engine.recognize(image)


def create_engine(engine_type: str = "auto", **kwargs) -> BaseOCREngine:
    """Factory function to create an OCR engine.

    Args:
        engine_type: "vietocr", "paddleocr", "hybrid", or "auto"
        **kwargs: Additional arguments passed to engine constructor

    Returns:
        An OCR engine instance
    """
    engines = {
        "vietocr": VietOCREngine,
        "paddleocr": PaddleOCREngine,
        "hybrid": HybridOCREngine,
        "auto": AutoOCREngine,
    }
    if engine_type not in engines:
        raise ValueError(f"Unknown engine: {engine_type}. Choose from: {list(engines.keys())}")
    return engines[engine_type](**kwargs)
