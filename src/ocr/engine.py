"""OCR Engine module - supports VietOCR, PaddleOCR, and Hybrid mode for Vietnamese text."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from pathlib import Path
from PIL import Image

logger = logging.getLogger(__name__)

# IMPORTANT (Windows): torch must load its native DLLs *before* paddle. If paddle
# is imported first it shadows torch's MKL/OpenMP dependencies and torch then
# fails with `OSError: [WinError 127] ... shm.dll`. Importing torch at module load
# guarantees the correct order for every entry point, since paddle is only
# imported lazily inside PaddleOCREngine further down.
try:
    import torch  # noqa: F401
except ImportError:
    pass


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

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions: [(text, [x0,y0,x1,y1]), ...].

        Default: not supported (e.g. recognition-only engines that lack layout).
        Overridden by detection-capable engines (Paddle, Hybrid).
        """
        raise NotImplementedError("This engine does not support positional OCR")


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

    # PP-OCRv5 ships "server" (heavy) and "mobile" (light) models. lang="vi"
    # defaults to the SERVER detection model, which dominated CPU runtime in
    # profiling (~42s/page vs ~18s with the mobile detector, same line count).
    # We swap ONLY the detector to mobile: it's the expensive stage and accuracy
    # is unchanged. The recognizer is left at the lang="vi" default — the mobile
    # recognizer mangles Vietnamese diacritics ("Công"->"Cong", "giữa"->"gia")
    # for only ~4s extra, not worth it. Both overridable via env.
    _DEFAULT_DET_MODEL = "PP-OCRv5_mobile_det"
    _DEFAULT_REC_MODEL = None  # None -> PaddleOCR picks the lang-specific recognizer

    def __init__(self, lang: str = "vi", det_model: str | None = None, rec_model: str | None = None):
        import os
        self.lang = lang
        self.det_model = det_model or os.getenv("PADDLE_DET_MODEL") or self._DEFAULT_DET_MODEL
        self.rec_model = rec_model or os.getenv("PADDLE_REC_MODEL") or self._DEFAULT_REC_MODEL
        self._ocr = None

    @property
    def ocr(self):
        if self._ocr is None:
            logger.info("Loading PaddleOCR lang=%s det=%s rec=%s", self.lang, self.det_model, self.rec_model or "default")
            from paddleocr import PaddleOCR
            # PaddleOCR 3.x API: `use_angle_cls`/`show_log` removed. Disable the
            # doc-orientation, unwarping and textline-orientation sub-pipelines we
            # don't need (faster load + inference; profiling showed orientation had
            # negligible accuracy benefit on typed contracts).
            # enable_mkldnn=False avoids a paddlepaddle 3.3 PIR+oneDNN bug
            # (NotImplementedError: ConvertPirAttribute2RuntimeAttribute) on CPU —
            # re-tested with mobile models and PIR disabled, still crashes, so it
            # stays off until paddlepaddle is upgraded.
            kwargs = dict(
                lang=self.lang,
                text_detection_model_name=self.det_model,
                use_textline_orientation=False,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                enable_mkldnn=False,
            )
            if self.rec_model:
                kwargs["text_recognition_model_name"] = self.rec_model
            self._ocr = PaddleOCR(**kwargs)
            logger.info("PaddleOCR loaded successfully")
        return self._ocr

    def recognize(self, image: Image.Image) -> str:
        """Recognize text from image using PaddleOCR.

        Returns all detected text joined by newlines, preserving reading order.
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))

        if not results:
            return ""

        # PaddleOCR 3.x returns a list of OCRResult (dict-like), one per image.
        res = results[0]
        texts = res.get("rec_texts", []) if hasattr(res, "get") else []
        return "\n".join(texts)

    def detect_only(self, image: Image.Image) -> list[list[list[int]]]:
        """Run text detection, returns list of bounding boxes.

        Each bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]].
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))

        if not results:
            return []

        res = results[0]
        polys = res.get("dt_polys", None) if hasattr(res, "get") else None
        if polys is None:
            return []

        # dt_polys is an ndarray of shape (N, 4, 2); normalise to nested lists.
        return [np.asarray(p).tolist() for p in polys]

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions. Returns [(text, [x0,y0,x1,y1]), ...].

        Boxes are axis-aligned in image-pixel coordinates (top-left origin).
        Used to build a searchable PDF text layer.
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))
        if not results:
            return []
        res = results[0]
        texts = res.get("rec_texts", []) if hasattr(res, "get") else []
        polys = res.get("dt_polys", []) if hasattr(res, "get") else []
        out: list[tuple[str, list[float]]] = []
        for text, poly in zip(texts, polys):
            p = np.asarray(poly, dtype=float)
            out.append((text, [float(p[:, 0].min()), float(p[:, 1].min()),
                               float(p[:, 0].max()), float(p[:, 1].max())]))
        return out


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

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions (PaddleOCR detect + VietOCR recognize).

        Returns [(text, [x0,y0,x1,y1]), ...] in image-pixel coords (top-left origin).
        """
        bboxes = self._detector.detect_only(image)
        if not bboxes:
            return []
        bboxes = self._sort_bboxes_reading_order(bboxes)
        crops = [self._crop_text_region(image, b) for b in bboxes]
        texts = self._recognizer.recognize_batch(crops)
        out: list[tuple[str, list[float]]] = []
        for b, t in zip(bboxes, texts):
            xs = [pt[0] for pt in b]
            ys = [pt[1] for pt in b]
            out.append((t, [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]))
        return out


class RapidOCREngine(BaseOCREngine):
    """OCR using RapidOCR (PP-OCR models on ONNX Runtime).

    Same detection + recognition models as PaddleOCR but run through onnxruntime
    instead of paddlepaddle. On CPU this is ~4-7x faster (onnxruntime has stable
    oneDNN/MLAS; paddlepaddle 3.3 crashes with mkldnn enabled), it sidesteps the
    paddle DLL/metadata packaging issues entirely, and the wheel is far smaller.

    WARNING — weak Vietnamese: the bundled recognizers (EN / LATIN PP-OCR) do NOT
    handle stacked Vietnamese diacritics (ộ/ử/ấ/ề/ị become o/u/a/e/i). Use this for
    speed on Latin-script text only; for correct Vietnamese use the Hybrid engine.
    A dedicated Vietnamese ONNX recognizer is planned to fix this. Returns boxes
    for the searchable-PDF layer.
    """

    def __init__(self, lang_rec: str = "EN"):
        self.lang_rec = lang_rec
        self._engine = None

    @property
    def engine(self):
        if self._engine is None:
            logger.info("Loading RapidOCR (onnxruntime) lang_rec=%s", self.lang_rec)
            from rapidocr import RapidOCR, LangRec
            self._engine = RapidOCR(params={"Rec.lang_type": LangRec[self.lang_rec]})
            logger.info("RapidOCR loaded successfully")
        return self._engine

    def recognize(self, image: Image.Image) -> str:
        """Recognize text; returns lines joined in detection (reading) order."""
        import numpy as np
        res = self.engine(np.array(image))
        if res is None or res.txts is None:
            return ""
        return "\n".join(res.txts)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions: [(text, [x0,y0,x1,y1]), ...].

        RapidOCR returns quadrilateral boxes (N,4,2) in image-pixel coords; we
        reduce each to an axis-aligned bbox for the invisible PDF text layer.
        """
        import numpy as np
        res = self.engine(np.array(image))
        if res is None or res.txts is None or res.boxes is None:
            return []
        out: list[tuple[str, list[float]]] = []
        for text, poly in zip(res.txts, res.boxes):
            p = np.asarray(poly, dtype=float)
            out.append((text, [float(p[:, 0].min()), float(p[:, 1].min()),
                               float(p[:, 0].max()), float(p[:, 1].max())]))
        return out


class RapidVietHybridOCREngine(BaseOCREngine):
    """Detection via RapidOCR (ONNX) + recognition via VietOCR.

    The fast + accurate combination: RapidOCR's ONNX detector finds text lines in
    ~1s (no paddlepaddle, no mkldnn crash), and VietOCR — the only local engine
    with a true Vietnamese recognizer — reads them with correct stacked diacritics
    (ộ/ử/ấ/ề/ị). VietOCR runs the crops as a batch, so a typical page is ~3-4s warm
    on CPU. This is the default engine and keeps paddlepaddle out of the hot path.

    (The plain HybridOCREngine uses PaddleOCR for detection, which loads slower and
    drags paddlepaddle into the pipeline; this class supersedes it as the default.)
    """

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self._detector = RapidOCREngine()
        self._recognizer = VietOCREngine(model_name=vietocr_model)

    def _detect_boxes(self, image: Image.Image) -> list:
        """Run RapidOCR detection; return quad boxes (Nx4x2) in reading order.

        We run the full RapidOCR pipeline and keep only the boxes — its detector
        returns clean line-level quads. (Detection-only mode over-segments lines
        into words, which hurts VietOCR's per-line recognition.)
        """
        import numpy as np
        res = self._detector.engine(np.array(image))
        if res is None or res.boxes is None:
            return []
        boxes = [np.asarray(b, dtype=float) for b in res.boxes]
        # reading order: top-to-bottom, then left-to-right
        boxes.sort(key=lambda b: (float(b[:, 1].min()), float(b[:, 0].min())))
        return boxes

    @staticmethod
    def _crop(image: Image.Image, box) -> Image.Image:
        x0, y0 = box[:, 0].min(), box[:, 1].min()
        x1, y1 = box[:, 0].max(), box[:, 1].max()
        return image.crop((max(0, int(x0)), max(0, int(y0)), int(x1), int(y1)))

    def recognize(self, image: Image.Image) -> str:
        boxes = self._detect_boxes(image)
        if not boxes:
            return ""
        crops = [self._crop(image, b) for b in boxes]
        texts = self._recognizer.recognize_batch(crops)
        return "\n".join(texts)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize with positions for the searchable-PDF layer.

        Boxes from RapidOCR (image-pixel coords), text from VietOCR.
        """
        boxes = self._detect_boxes(image)
        if not boxes:
            return []
        crops = [self._crop(image, b) for b in boxes]
        texts = self._recognizer.recognize_batch(crops)
        out: list[tuple[str, list[float]]] = []
        for b, t in zip(boxes, texts):
            out.append((t, [float(b[:, 0].min()), float(b[:, 1].min()),
                            float(b[:, 0].max()), float(b[:, 1].max())]))
        return out


class AutoOCREngine(BaseOCREngine):
    """Automatic engine selection.

    Priority favours Vietnamese accuracy over raw speed: the PP-OCR multilingual
    recognizers (RapidOCR, PaddleOCR 3.x) mangle stacked diacritics, so engines
    that recognise with VietOCR are preferred.

    Priority:
    1. RapidVietHybridOCREngine (RapidOCR detect + VietOCR) - fast AND correct
    2. HybridOCREngine (PaddleOCR detect + VietOCR) - correct, slower detect
    3. RapidOCREngine (PP-OCR on ONNX Runtime) - fast full-page, weak diacritics
    4. PaddleOCREngine (full pipeline) - fallback
    5. VietOCREngine (recognition only) - last resort, single lines only
    """

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self.vietocr_model = vietocr_model
        self._engine: BaseOCREngine | None = None

    @property
    def engine(self) -> BaseOCREngine:
        if self._engine is None:
            # Try RapidViet first (RapidOCR ONNX detect + VietOCR recognize):
            # fast detection with no paddle, correct Vietnamese diacritics.
            try:
                self._engine = RapidVietHybridOCREngine(vietocr_model=self.vietocr_model)
                _ = self._engine._detector.engine        # load onnx detector
                _ = self._engine._recognizer.predictor   # load vietocr
                logger.info("Auto-selected RapidViet engine (RapidOCR detect + VietOCR)")
                return self._engine
            except Exception as e:
                logger.info("RapidViet unavailable: %s", e)

            # Fallback: Hybrid (PaddleOCR detect + VietOCR) — still correct dấu.
            try:
                self._engine = HybridOCREngine(vietocr_model=self.vietocr_model)
                _ = self._engine._recognizer.predictor  # force model load
                logger.info("Auto-selected Hybrid engine (PaddleOCR detect + VietOCR)")
                return self._engine
            except Exception as e:
                logger.info("Hybrid unavailable: %s", e)

            # Fallback: RapidOCR (fast onnxruntime PP-OCR, weak Vietnamese)
            try:
                self._engine = RapidOCREngine()
                _ = self._engine.engine
                logger.info("Auto-selected RapidOCR engine (ONNX Runtime)")
                return self._engine
            except Exception as e:
                logger.info("RapidOCR unavailable: %s", e)

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

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        return self.engine.recognize_boxes(image)


def create_engine(engine_type: str = "auto", **kwargs) -> BaseOCREngine:
    """Factory function to create an OCR engine.

    Args:
        engine_type: "rapidocr", "vietocr", "paddleocr", "hybrid", or "auto"
        **kwargs: Additional arguments passed to engine constructor

    Returns:
        An OCR engine instance
    """
    engines = {
        "rapidviet": RapidVietHybridOCREngine,
        "rapidocr": RapidOCREngine,
        "vietocr": VietOCREngine,
        "paddleocr": PaddleOCREngine,
        "hybrid": HybridOCREngine,
        "auto": AutoOCREngine,
    }
    if engine_type not in engines:
        raise ValueError(f"Unknown engine: {engine_type}. Choose from: {list(engines.keys())}")
    return engines[engine_type](**kwargs)
