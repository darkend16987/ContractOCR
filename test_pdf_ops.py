"""Characterization tests for the pure-PDF endpoints in api.py.

These endpoints take a PDF (or images) in and hand a PDF/zip back — no OCR, no
Gemini, no network. Synthetic PyMuPDF documents make every expected outcome
exact (page counts, embedded text, zip members), so the planned refactor can be
checked to change nothing.

Covers: /split, /add-page-numbers, /images-to-pdf, /pdf-to-images,
/extract-images, /encrypt + /decrypt, /compress, /text-spans, /compare.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import io
import zipfile

import fitz  # PyMuPDF
from fastapi import HTTPException
from PIL import Image

import api


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def _run(coro):
    return asyncio.run(coro)


def _b64(doc) -> str:
    return base64.b64encode(doc.tobytes()).decode("ascii")


def _npage_pdf(n: int) -> str:
    """n-page PDF, each page carrying a short ASCII text line."""
    doc = fitz.open()
    for i in range(n):
        page = doc.new_page(width=300, height=300)
        page.insert_text((72, 72), f"Page {i + 1} content")
    b = _b64(doc)
    doc.close()
    return b


def _img_b64(w: int, h: int) -> str:
    im = Image.new("RGB", (w, h), (10, 20, 30))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _pdf_with_image() -> str:
    doc = fitz.open()
    page = doc.new_page(width=300, height=300)
    im = Image.new("RGB", (40, 40), (200, 50, 50))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    page.insert_image(fitz.Rect(10, 10, 90, 90), stream=buf.getvalue())
    b = _b64(doc)
    doc.close()
    return b


def _zip_names(data_b64: str) -> list[str]:
    zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(data_b64)))
    return zf.namelist()


def _open(data_b64: str):
    return fitz.open(stream=base64.b64decode(data_b64), filetype="pdf")


# --------------------------------------------------------------------------- #
# /split
# --------------------------------------------------------------------------- #
def test_split_ranges():
    r = _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(5), mode="ranges", ranges="1-2,4")))
    assert r.success and r.count == 2
    names = _zip_names(r.data_b64)
    assert len(names) == 2
    assert any("p1-2" in n for n in names) and any("p4" in n for n in names)


def test_split_every():
    r = _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(5), mode="every", size=2)))
    assert r.success and r.count == 3  # (1-2)(3-4)(5)


def test_split_bad_ranges_400():
    try:
        _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(3), mode="ranges", ranges="")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /add-page-numbers
# --------------------------------------------------------------------------- #
def test_add_page_numbers_stamps_label():
    r = _run(api.add_page_numbers(api.PageNumberRequest(pdf_b64=_npage_pdf(3), fmt="n_of_n")))
    assert r.success and r.pages == 3
    doc = _open(r.data_b64)
    try:
        assert "1 / 3" in doc[0].get_text()  # label really landed on the page
    finally:
        doc.close()


def test_add_page_numbers_bad_position_400():
    try:
        _run(api.add_page_numbers(api.PageNumberRequest(pdf_b64=_npage_pdf(1), position="middle")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /images-to-pdf
# --------------------------------------------------------------------------- #
def test_images_to_pdf_fit_matches_image_size():
    r = _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_img_b64(100, 50), _img_b64(60, 80)], page_size="fit")))
    assert r.success and r.pages == 2
    doc = _open(r.data_b64)
    try:
        assert round(doc[0].rect.width) == 100 and round(doc[0].rect.height) == 50
    finally:
        doc.close()


def test_images_to_pdf_a4_is_a4_page():
    r = _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_img_b64(100, 50)], page_size="a4")))
    assert r.success
    doc = _open(r.data_b64)
    try:
        assert round(doc[0].rect.width) == 595 and round(doc[0].rect.height) == 842
    finally:
        doc.close()


def test_images_to_pdf_empty_400():
    try:
        _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[])))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /pdf-to-images
# --------------------------------------------------------------------------- #
def test_pdf_to_images_png():
    r = _run(api.pdf_to_images(api.PdfToImagesRequest(pdf_b64=_npage_pdf(2), format="png")))
    assert r.success and r.count == 2
    assert _zip_names(r.data_b64) == ["page_001.png", "page_002.png"]


def test_pdf_to_images_bad_format_400():
    try:
        _run(api.pdf_to_images(api.PdfToImagesRequest(pdf_b64=_npage_pdf(1), format="gif")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /extract-images
# --------------------------------------------------------------------------- #
def test_extract_images_finds_embedded():
    r = _run(api.extract_images(api.ExtractImagesRequest(pdf_b64=_pdf_with_image())))
    assert r.success and r.count == 1


def test_extract_images_text_only_reports_none():
    r = _run(api.extract_images(api.ExtractImagesRequest(pdf_b64=_npage_pdf(1))))
    assert r.success is False and r.error  # no embedded images -> graceful failure


# --------------------------------------------------------------------------- #
# /encrypt + /decrypt  (round-trip)
# --------------------------------------------------------------------------- #
def test_encrypt_decrypt_roundtrip():
    enc = _run(api.encrypt(api.EncryptRequest(pdf_b64=_npage_pdf(3), user_password="secret")))
    assert enc.success and enc.pages == 3
    # wrong password -> 401 so the UI can re-prompt
    try:
        _run(api.decrypt(api.DecryptRequest(pdf_b64=enc.data_b64, password="nope")))
        assert False, "expected 401"
    except HTTPException as e:
        assert e.status_code == 401
    dec = _run(api.decrypt(api.DecryptRequest(pdf_b64=enc.data_b64, password="secret")))
    assert dec.success and dec.pages == 3


def test_encrypt_requires_a_password_400():
    try:
        _run(api.encrypt(api.EncryptRequest(pdf_b64=_npage_pdf(1))))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /compress
# --------------------------------------------------------------------------- #
def test_compress_lossless_returns_valid_pdf():
    r = _run(api.compress(api.CompressRequest(pdf_b64=_npage_pdf(2), preset="lossless")))
    assert r.success and r.original_size > 0 and r.compressed_size > 0
    doc = _open(r.data_b64)
    try:
        assert doc.page_count == 2
    finally:
        doc.close()


def test_compress_bad_preset_400():
    try:
        _run(api.compress(api.CompressRequest(pdf_b64=_npage_pdf(1), preset="ultra")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /text-spans
# --------------------------------------------------------------------------- #
def test_text_spans_reads_page_text():
    r = _run(api.text_spans(api.TextSpansRequest(pdf_b64=_npage_pdf(1), page=0)))
    assert r.success and r.has_text
    assert any("Page 1 content" in s.text for s in r.spans)


def test_text_spans_bad_page_400():
    try:
        _run(api.text_spans(api.TextSpansRequest(pdf_b64=_npage_pdf(1), page=9)))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /compare
# --------------------------------------------------------------------------- #
def _text_pdf(lines: list[str]) -> str:
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for ln in lines:
        page.insert_text((72, y), ln)
        y += 20
    b = _b64(doc)
    doc.close()
    return b


def test_compare_identical_reports_no_changes():
    a = _text_pdf(["Line one", "Line two", "Line three"])
    r = _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=a, mode="text")))
    assert r.success and len(r.changes) == 0 and r.summary.get("identical") is True


def test_compare_diff_reports_changes():
    a = _text_pdf(["Line one", "Line two", "Line three"])
    b = _text_pdf(["Line one", "Line two CHANGED", "Line three"])
    r = _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=b, mode="text")))
    assert r.success and len(r.changes) >= 1 and r.summary.get("identical") is False


def test_compare_bad_mode_400():
    a = _text_pdf(["x"])
    try:
        _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=a, mode="bogus")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


if __name__ == "__main__":
    # No pytest in the project venv - plain runner, same style as test_export.py.
    for fn in (
        test_split_ranges,
        test_split_every,
        test_split_bad_ranges_400,
        test_add_page_numbers_stamps_label,
        test_add_page_numbers_bad_position_400,
        test_images_to_pdf_fit_matches_image_size,
        test_images_to_pdf_a4_is_a4_page,
        test_images_to_pdf_empty_400,
        test_pdf_to_images_png,
        test_pdf_to_images_bad_format_400,
        test_extract_images_finds_embedded,
        test_extract_images_text_only_reports_none,
        test_encrypt_decrypt_roundtrip,
        test_encrypt_requires_a_password_400,
        test_compress_lossless_returns_valid_pdf,
        test_compress_bad_preset_400,
        test_text_spans_reads_page_text,
        test_text_spans_bad_page_400,
        test_compare_identical_reports_no_changes,
        test_compare_diff_reports_changes,
        test_compare_bad_mode_400,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All pdf-op tests passed.")
