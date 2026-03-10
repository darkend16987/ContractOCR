"""OCR Engine module - supports VietOCR and PaddleOCR for Vietnamese text."""

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
    """Vietnamese OCR using VietOCR (Transformer-based, optimized for Vietnamese)."""

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
            config["device"] = "cpu"  # Will auto-detect GPU if available
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
        """Recognize Vietnamese text from image using VietOCR.

        Note: VietOCR works on single text lines. For full documents,
        use PaddleOCR for detection + VietOCR for recognition,
        or use PaddleOCREngine directly.
        """
        return self.predictor.predict(image)


class PaddleOCREngine(BaseOCREngine):
    """OCR using PaddleOCR with Vietnamese language support."""

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

        PaddleOCR handles full document layout: detection + recognition.
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


class AutoOCREngine(BaseOCREngine):
    """Automatic engine selection: tries PaddleOCR (full document) by default,
    falls back to VietOCR if PaddleOCR is unavailable."""

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self.vietocr_model = vietocr_model
        self._engine: BaseOCREngine | None = None

    @property
    def engine(self) -> BaseOCREngine:
        if self._engine is None:
            # Prefer PaddleOCR for full-page document OCR
            try:
                self._engine = PaddleOCREngine()
                _ = self._engine.ocr  # Test if it loads
                logger.info("Auto-selected PaddleOCR engine")
            except Exception:
                logger.info("PaddleOCR unavailable, falling back to VietOCR")
                self._engine = VietOCREngine(self.vietocr_model)
        return self._engine

    def recognize(self, image: Image.Image) -> str:
        return self.engine.recognize(image)


def create_engine(engine_type: str = "auto", **kwargs) -> BaseOCREngine:
    """Factory function to create an OCR engine.

    Args:
        engine_type: "vietocr", "paddleocr", or "auto"
        **kwargs: Additional arguments passed to engine constructor

    Returns:
        An OCR engine instance
    """
    engines = {
        "vietocr": VietOCREngine,
        "paddleocr": PaddleOCREngine,
        "auto": AutoOCREngine,
    }
    if engine_type not in engines:
        raise ValueError(f"Unknown engine: {engine_type}. Choose from: {list(engines.keys())}")
    return engines[engine_type](**kwargs)
