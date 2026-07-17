"""Characterization tests for endpoints that normally need OCR / Gemini / network.

The real OCR engine (RapidViet) and the Gemini agent are never built here: both
are cached on module globals (``api.ocr_engine`` / ``api.gemini_agent``), so a
test just drops a stub into that global and the endpoint's lazy getter hands the
stub back. Globals are saved and restored around every test so nothing leaks
between them or into a later real run.

Also covers the trivially-pure endpoints (/health, /config GET, /templates,
/fonts). /config POST is intentionally NOT exercised — it persists the user's
real Gemini key to disk.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import contextlib
import io

import fitz  # PyMuPDF
from fastapi import HTTPException
from PIL import Image

import api


# --------------------------------------------------------------------------- #
# stubs + helpers
# --------------------------------------------------------------------------- #
class _StubEngine:
    """Minimal OCR engine: fixed text, one box for layout endpoints."""

    def recognize(self, image):
        return "STUB OCR TEXT"

    def recognize_boxes(self, image):
        return [("hello", (60, 60, 240, 110))]


class _StubGemini:
    def extract_fields(self, text, fields):
        return {k: "v_" + k for k in fields}

    def classify_document(self, text):
        return {"loai": "hop_dong"}


def _run(coro):
    return asyncio.run(coro)


@contextlib.contextmanager
def _ocr(engine):
    saved = api.ocr_engine
    api.ocr_engine = engine
    try:
        yield
    finally:
        api.ocr_engine = saved


@contextlib.contextmanager
def _gemini(agent):
    saved = api.gemini_agent
    api.gemini_agent = agent
    try:
        yield
    finally:
        api.gemini_agent = saved


def _text_pdf(txt: str) -> str:
    doc = fitz.open()
    page = doc.new_page(width=300, height=300)
    page.insert_text((50, 50), txt)
    b = base64.b64encode(doc.tobytes()).decode("ascii")
    doc.close()
    return b


def _png_b64(w=50, h=20) -> str:
    im = Image.new("RGB", (w, h), (255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------- #
# /ocr
# --------------------------------------------------------------------------- #
def test_ocr_returns_engine_text():
    with _ocr(_StubEngine()):
        r = _run(api.run_ocr(api.OCRRequest(images=[_png_b64()])))
    assert r.success and r.pages[0].text == "STUB OCR TEXT"
    assert "STUB OCR TEXT" in r.full_text


def test_ocr_no_images_400():
    try:
        _run(api.run_ocr(api.OCRRequest(images=[])))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


def test_ocr_too_many_images_400():
    try:
        _run(api.run_ocr(api.OCRRequest(images=[_png_b64()] * 51)))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /extract  (skip OCR via ocr_texts, stub Gemini)
# --------------------------------------------------------------------------- #
def test_extract_with_ocr_texts_and_stub_gemini():
    with _gemini(_StubGemini()):
        r = _run(api.extract(api.ExtractRequest(ocr_texts=["some contract text"], template="default")))
    assert r.success
    assert r.full_text == "some contract text"
    assert r.classification == {"loai": "hop_dong"}
    # stub fills one value per resolved field -> keys line up with the labels
    assert r.fields and set(r.fields) == set(r.field_labels)


def test_extract_no_input_400():
    try:
        _run(api.extract(api.ExtractRequest()))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /ocr-span
# --------------------------------------------------------------------------- #
def test_ocr_span_returns_engine_text():
    with _ocr(_StubEngine()):
        r = _run(api.ocr_span(api.OcrSpanRequest(pdf_b64=_text_pdf("x"), page=0, bbox=[40, 40, 200, 80])))
    assert r.success and r.text == "STUB OCR TEXT"


def test_ocr_span_bad_bbox_400():
    try:
        _run(api.ocr_span(api.OcrSpanRequest(pdf_b64=_text_pdf("x"), page=0, bbox=[1, 2, 3])))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /searchable
# --------------------------------------------------------------------------- #
def test_searchable_skips_pages_with_real_text():
    # a page already carrying >= 20 chars of selectable text is skipped, not OCR'd,
    # so no engine is needed at all on a fully-digital PDF.
    long_txt = "This page already has a real selectable text layer here."
    r = _run(api.searchable(api.SearchableRequest(pdf_b64=_text_pdf(long_txt), force_ocr=False)))
    assert r.success and r.skipped_pages == 1 and r.ocr_pages == 0 and r.words == 0


def test_searchable_force_ocr_adds_layer():
    if not api._vietnamese_font():
        print("SKIP test_searchable_force_ocr_adds_layer (no DejaVu on this box)")
        return
    with _ocr(_StubEngine()):
        r = _run(api.searchable(api.SearchableRequest(pdf_b64=_text_pdf("short"), force_ocr=True)))
    assert r.success and r.ocr_pages == 1 and r.words == 1


# --------------------------------------------------------------------------- #
# pure read-only endpoints
# --------------------------------------------------------------------------- #
def test_health_ok():
    assert _run(api.health())["status"] == "ok"


def test_get_config_shape_and_masking():
    cfg = _run(api.get_config())
    for k in ("gemini_configured", "gemini_key_masked", "gemini_model",
              "gemini_model_default", "gemini_model_choices"):
        assert k in cfg
    assert isinstance(cfg["gemini_configured"], bool)


def test_list_templates_default_first():
    tpl = _run(api.list_templates())
    assert tpl["templates"][0]["name"] == "default"


def test_list_fonts_returns_list():
    r = _run(api.list_fonts())
    assert isinstance(r.families, list)


if __name__ == "__main__":
    # No pytest in the project venv - plain runner, same style as test_export.py.
    for fn in (
        test_ocr_returns_engine_text,
        test_ocr_no_images_400,
        test_ocr_too_many_images_400,
        test_extract_with_ocr_texts_and_stub_gemini,
        test_extract_no_input_400,
        test_ocr_span_returns_engine_text,
        test_ocr_span_bad_bbox_400,
        test_searchable_skips_pages_with_real_text,
        test_searchable_force_ocr_adds_layer,
        test_health_ok,
        test_get_config_shape_and_masking,
        test_list_templates_default_first,
        test_list_fonts_returns_list,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All stubbed-endpoint tests passed.")
