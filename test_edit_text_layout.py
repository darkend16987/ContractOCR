"""Tests for what /edit-text does to everything AROUND the text it replaces.

Editing a span is "take these glyphs out, put those glyphs in". Everything the old
glyphs were drawn ON — a shaded table cell, the rule under a heading, a scanned
letterhead — belongs to the document, not to the text, and must come through
untouched.

Two separate mechanisms can eat it, and neither raises:

  * the redaction annotation's `fill`, which paints an opaque rectangle over the
    span's own bbox. Invisible on white paper, and a white patch on a shaded cell.
  * `apply_redactions()` defaults: `images=PDF_REDACT_IMAGE_PIXELS` blanks image
    pixels under the box, and the line-art default removes vector art the box
    *covers* — an underline drawn inside the text's bbox, which is exactly how
    Word draws one.

/translate already settled this (see test_translate_layout.py, same two cases);
these tests hold /edit-text to the same bargain. They assert on rendered PIXELS,
not on object counts: line art survived as an object even when the fill made it
invisible, so counting objects would have passed while the page looked wrong.
"""

import asyncio
import base64

import fitz  # PyMuPDF

from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans
from src.pdf.fonts import _vietnamese_font

SHADE = (0.85, 0.90, 1.00)  # the cell background, deliberately not white
CELL = fitz.Rect(50, 80, 320, 110)


def _font() -> str:
    p = _vietnamese_font()
    assert p, "no DejaVu found"
    return p


def _page_pdf(*, shade=True, rule=True, image=False) -> str:
    """One shaded table cell with text in it, optionally a rule under the text
    and a picture behind it."""
    doc = fitz.open()
    try:
        page = doc.new_page()
        if image:
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), False)
            pix.set_rect(pix.irect, (20, 160, 60))  # solid dark blue-green
            page.insert_image(CELL, pixmap=pix)
        elif shade:
            page.draw_rect(CELL, color=(0, 0, 0), fill=SHADE, width=1)
        page.insert_font(fontname="F0", fontfile=_font())
        page.insert_text((56, 100), "Nội dung ô bảng", fontname="F0", fontsize=11)
        if rule:
            # Strictly inside the span's bbox, so it is "covered" — the case the
            # line-art default deletes.
            page.draw_line(fitz.Point(58, 101.5), fitz.Point(120, 101.5),
                           color=(1, 0, 0), width=0.6)
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def _edit(pdf_b64: str, new_text: str, **extra) -> str:
    spans = asyncio.run(text_spans(TextSpansRequest(pdf_b64=pdf_b64, page=0))).spans
    assert spans, "fixture has no text"
    t = spans[0]
    res = asyncio.run(
        edit_text(
            EditTextRequest(
                pdf_b64=pdf_b64,
                edits=[TextEdit(page=0, bbox=t.bbox, origin=t.origin, new_text=new_text,
                                size=t.size, color=t.color, font=t.font, **extra)],
            )
        )
    )
    assert res.success, f"edit-text failed: {res.error}"
    return res.data_b64


def _count_pixels(pdf_b64: str, clip: fitz.Rect, rgb) -> int:
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        pix = doc[0].get_pixmap(dpi=150, clip=clip)
        return sum(
            1
            for y in range(pix.height)
            for x in range(pix.width)
            if pix.pixel(x, y)[:3] == rgb
        )
    finally:
        doc.close()


def _text_of(pdf_b64: str) -> str:
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        return doc[0].get_text()
    finally:
        doc.close()


def test_shaded_cell_keeps_its_background():
    """The white patch, stated as the user sees it: pure white inside a cell that
    has no white in it."""
    src = _page_pdf(rule=False)
    inside = fitz.Rect(CELL.x0 + 2, CELL.y0 + 2, CELL.x1 - 2, CELL.y1 - 2)
    assert _count_pixels(src, inside, (255, 255, 255)) == 0, "fixture already has white"
    out = _edit(src, "Nội dung đã sửa")
    white = _count_pixels(out, inside, (255, 255, 255))
    assert white == 0, f"{white} white pixels punched into the shaded cell"


def test_rule_under_the_text_survives():
    """A rule drawn strictly inside the span's bbox — covered by the redaction box
    on both counts (the fill hides it, the line-art default deletes it)."""
    src = _page_pdf(shade=False)
    band = fitz.Rect(56, 100.5, 122, 102.5)
    assert _count_pixels(src, band, (255, 0, 0)) > 0, "fixture has no rule"
    out = _edit(src, "Nội dung đã sửa")
    red = _count_pixels(out, band, (255, 0, 0))
    assert red > 0, "the rule under the edited text was wiped out"


def test_image_behind_the_text_is_not_blanked():
    """apply_redactions defaults to blanking image PIXELS under the box: editing a
    caption printed over a scanned letterhead would punch a hole in the scan."""
    src = _page_pdf(image=True, rule=False)
    inside = fitz.Rect(CELL.x0 + 2, CELL.y0 + 2, CELL.x1 - 2, CELL.y1 - 2)
    assert _count_pixels(src, inside, (255, 255, 255)) == 0, "fixture already has white"
    out = _edit(src, "Nội dung đã sửa")
    white = _count_pixels(out, inside, (255, 255, 255))
    assert white == 0, f"{white} pixels of the image were blanked"


def test_old_glyphs_really_are_removed():
    """The core job, pinned so no amount of "preserve everything" can quietly turn
    the redaction into a no-op that just draws new text on top of the old."""
    src = _page_pdf()
    out = _edit(src, "Nội dung đã sửa")
    txt = _text_of(out)
    assert "đã sửa" in txt, f"the new text is missing: {txt!r}"
    assert "ô bảng" not in txt, f"the OLD text is still on the page: {txt!r}"


def test_explicit_fill_is_still_honoured():
    """`fill` stays part of the API for callers that really do want the box painted
    (erasing over a busy background). Only the DEFAULT changes."""
    src = _page_pdf(rule=False)
    inside = fitz.Rect(CELL.x0 + 2, CELL.y0 + 2, CELL.x1 - 2, CELL.y1 - 2)
    out = _edit(src, "Nội dung đã sửa", fill=[1, 1, 1])
    white = _count_pixels(out, inside, (255, 255, 255))
    assert white > 0, "an explicitly requested white fill was not painted"


if __name__ == "__main__":
    for fn in (
        test_shaded_cell_keeps_its_background,
        test_rule_under_the_text_survives,
        test_image_behind_the_text_is_not_blanked,
        test_old_glyphs_really_are_removed,
        test_explicit_fill_is_still_honoured,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All edit-text layout tests passed.")
