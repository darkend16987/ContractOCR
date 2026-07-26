"""Tests for the SIZE of the text /edit-text draws back — reported as "chữ to ra".

A PDF very often draws its text condensed: a `Tz` in the content stream, a text
matrix that is narrower than it is tall, or simply a narrow face whose substitute
on this machine is wider. `insert_text` knows none of that — it always draws at the
font's own natural advances — so the replacement comes out longer than the line it
replaced and runs into whatever sits after it.

Measured on the invoice that prompted this: every span drawn at ~0.84 of Times New
Roman's natural width, so a "keep the font" edit redrew ~24% too long. (Before the
font fix it was worse, ~58%, because the DejaVu fallback is wider still than Times —
which is why this only became the obvious defect once the font was right.)

The correction measures the ORIGINAL string in the font about to be drawn and scales
x by whatever factor puts it back at the width it had. Derived from the old text
only, so a longer replacement grows normally rather than being squeezed into the old
box — this is not "fit to the box".

Fixtures build the condensed case with the same morph mechanism the fix uses, which
is how a squeeze is expressed in a PDF's text matrix.
"""

import asyncio
import base64
from pathlib import Path

import fitz  # PyMuPDF

from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans
from src.pdf.fonts import _vietnamese_font

TEXT = "Tra cứu hóa đơn tại đây"
SIZE = 11.0
ORIGIN = (60.0, 120.0)


def _font() -> str:
    p = _vietnamese_font()
    assert p, "no DejaVu found"
    return p


def _src(squeeze: float, text: str = TEXT) -> str:
    """One line drawn at `squeeze` of its natural width (1.0 = untouched)."""
    doc = fitz.open()
    try:
        page = doc.new_page()
        page.insert_font(fontname="F0", fontfile=_font())
        morph = (
            (fitz.Point(*ORIGIN), fitz.Matrix(squeeze, 0, 0, 1, 0, 0))
            if squeeze != 1.0
            else None
        )
        page.insert_text(ORIGIN, text, fontname="F0", fontsize=SIZE, morph=morph)
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def _span0(pdf_b64: str):
    spans = asyncio.run(text_spans(TextSpansRequest(pdf_b64=pdf_b64, page=0))).spans
    assert spans, "fixture has no text"
    return spans[0]


def _width(pdf_b64: str) -> float:
    """Inked width of everything drawn on page 0."""
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        x0, x1 = None, None
        for b in doc[0].get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                for sp in line.get("spans", []):
                    if not sp["text"].strip():
                        continue
                    x0 = sp["bbox"][0] if x0 is None else min(x0, sp["bbox"][0])
                    x1 = sp["bbox"][2] if x1 is None else max(x1, sp["bbox"][2])
        assert x0 is not None, "nothing drawn"
        return x1 - x0
    finally:
        doc.close()


def _edit(pdf_b64: str, new_text: str, *, send_orig=True, size=None) -> str:
    t = _span0(pdf_b64)
    res = asyncio.run(
        edit_text(
            EditTextRequest(
                pdf_b64=pdf_b64,
                edits=[
                    TextEdit(
                        page=0, bbox=t.bbox, origin=t.origin, new_text=new_text,
                        size=size or t.size, color=t.color, font=t.font,
                        orig_text=t.text if send_orig else None,
                        orig_size=t.size if send_orig else None,
                    )
                ],
            )
        )
    )
    assert res.success, f"edit-text failed: {res.error}"
    return res.data_b64


def _ink(pdf_b64: str, zoom=8.0):
    """(width, height) of the actual dark pixels on page 0 — the only measure that
    survives the difference between a font's declared metrics and its outlines."""
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        pix = doc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        xs, ys = [], []
        for y in range(pix.height):
            for x in range(pix.width):
                r, g, b = pix.pixel(x, y)[:3]
                if r < 200 or g < 200 or b < 200:
                    xs.append(x)
                    ys.append(y)
        assert xs, "nothing drawn"
        return ((max(xs) - min(xs) + 1) / zoom, (max(ys) - min(ys) + 1) / zoom)
    finally:
        doc.close()


def test_condensed_text_is_redrawn_at_the_same_width():
    """The reported bug. Same string back in, so the only thing that can change the
    width is the redraw ignoring the document's horizontal scale."""
    src = _src(0.84)
    before = _width(src)
    out = _edit(src, TEXT)
    after = _width(out)
    ratio = after / before
    assert 0.94 <= ratio <= 1.03, f"redrawn text is {ratio:.3f}x the original width"


def test_without_the_correction_it_really_does_overflow():
    """Guards the guard: with orig_text withheld (an older renderer), the redraw is
    the wide one — so the test above is measuring the fix, not a no-op.

    The overflow here is 1/sqrt(0.84) = 1.09, not 1/0.84 = 1.19, because PyMuPDF
    reports the GEOMETRIC MEAN of an anisotropic text matrix as the span's size
    (verified: an 11pt line squeezed to 0.84 comes back as size 10.082 = 11*sqrt(0.84)),
    so half the squeeze is already inside the size the redraw uses. A matrix squeeze is
    therefore the MILD version of this bug; the real invoice, where the mismatch comes
    from a substituted face instead, overflowed by 1.24x.
    """
    src = _src(0.84)
    before = _width(src)
    after = _width(_edit(src, TEXT, send_orig=False))
    assert after / before > 1.05, (
        f"uncorrected redraw was only {after / before:.3f}x — the fixture no longer "
        "reproduces the condition this fix is for"
    )


def test_normal_text_is_left_alone():
    """Text drawn at its natural width must not be nudged: the correction has a dead
    band, so ordinary documents are byte-for-byte unaffected by it."""
    src = _src(1.0)
    before = _width(src)
    after = _width(_edit(src, TEXT))
    ratio = after / before
    assert 0.98 <= ratio <= 1.02, f"untouched text was rescaled to {ratio:.3f}x"


def test_longer_replacement_grows_instead_of_being_squeezed():
    """The scale is a property of the TYPE, not a fit-to-box: replacing a line with
    one twice as long must produce roughly twice the width, still condensed."""
    src = _src(0.84)
    one = _width(_edit(src, TEXT))
    two = _width(_edit(src, TEXT + " " + TEXT))
    assert two / one > 1.8, f"longer text only grew {two / one:.2f}x — squeezed to fit?"


def test_width_does_not_drift_over_repeated_edits():
    """Round 2 reads back what round 1 drew. If the correction compounded, each edit
    would shrink (or stretch) the line a little further."""
    pdf = _src(0.84)
    first = None
    for i in range(3):
        pdf = _edit(pdf, TEXT)
        w = _width(pdf)
        if first is None:
            first = w
        else:
            assert 0.97 <= w / first <= 1.03, f"round {i + 1} drifted to {w / first:.3f}x"


def test_substituted_face_keeps_the_original_glyph_height():
    """Width and height are two independent mismatches. A face substituted for one
    that isn't embedded usably has a different line box, so the same point size draws
    visibly taller (measured 1.10x on the invoice) even once the width is right.

    Drawn in DejaVu Serif and then edited: the name resolves nowhere, the embedded
    program has no usable cmap, so /edit-text has to substitute DejaVu Sans — the
    real substitution case, with two faces of genuinely different proportions.
    """
    doc = fitz.open()
    serif = Path(_font()).with_name("DejaVuSerif.ttf")
    if not serif.is_file():
        return
    try:
        page = doc.new_page()
        page.insert_font(fontname="F0", fontfile=str(serif))
        page.insert_text(ORIGIN, TEXT, fontname="F0", fontsize=SIZE)
        for f in page.get_fonts():
            doc.xref_set_key(f[0], "BaseFont", "/ZzNoSuchFaceRegular")
            df = doc.xref_get_key(f[0], "DescendantFonts")
            if df[0] == "array":
                dx = int(df[1].strip("[]").replace("0 R", "").strip())
                doc.xref_set_key(dx, "BaseFont", "/ZzNoSuchFaceRegular")
        src = base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()

    _w0, h0 = _ink(src)
    _w1, h1 = _ink(_edit(src, TEXT))
    assert 0.94 <= h1 / h0 <= 1.06, f"substituted face drew {h1 / h0:.3f}x the height"


def test_single_character_span_is_not_distorted():
    """A one-glyph span is where the bbox-vs-advance measurement is least reliable;
    the credibility clamp must keep it out of the scaling path."""
    src = _src(1.0, text="X")
    before = _width(src)
    after = _width(_edit(src, "X"))
    assert 0.85 <= after / before <= 1.15, f"single glyph distorted to {after / before:.3f}x"


if __name__ == "__main__":
    for fn in (
        test_condensed_text_is_redrawn_at_the_same_width,
        test_without_the_correction_it_really_does_overflow,
        test_normal_text_is_left_alone,
        test_longer_replacement_grows_instead_of_being_squeezed,
        test_width_does_not_drift_over_repeated_edits,
        test_substituted_face_keeps_the_original_glyph_height,
        test_single_character_span_is_not_distorted,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All edit-text metrics tests passed.")
