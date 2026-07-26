"""Tests for "giữ nguyên font" in /edit-text — the silent DejaVu substitution.

Reported as: the text-edit font picker is left on "Giữ nguyên (font gốc)", the edit
is applied, and the line comes back in a different typeface.

Two independent holes caused it, one per half of this file:

  1. Family resolution. A PDF font name often glues its style onto the family with
     no separator — "TimesNewRomanBold" (real invoices do this; so does anything
     printed through some drivers). `_clean_font_name` only splits on "-", so the
     name reached matplotlib as a family nobody has installed, findfont raised, and
     the redraw fell through to the bundled DejaVu Sans. No error anywhere.
  2. Fonts that are not installed at all. Vietnamese/CAD documents ship faces
     (SVN-*, UTM-*, .Vn*, in-house CAD fonts) that exist only inside the PDF. Even
     perfect name handling can't find those on the machine, so the only way to keep
     the look is to re-embed the program the document is already carrying.

The second one is dangerous in exactly the way v0.2.34 was: an embedded font is
normally a SUBSET holding just the glyphs the document used, and PyMuPDF draws
missing glyphs as notdef (□) without raising. So its guard — coverage must be
checked for EVERY character, not only non-Latin-1 ones — gets its own test below.

Assertions are on the drawn output (which font the redrawn span reports, and how
many notdef glyphs the page has), never on return codes: every failure mode here
reports success and hands back a PDF.

Synthetic PDFs only, using fonts that ship with matplotlib (DejaVu Sans/Serif), so
the suite is machine-independent — no C:\\Windows\\Fonts dependency.
"""

import asyncio
import base64
from pathlib import Path

import fitz  # PyMuPDF

from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans
from src.pdf.fonts import (
    _family_candidates,
    _page_font_buffers,
    _resolve_local_font,
    _strip_style_suffix,
    _vietnamese_font,
)

TEXT = "Dòng chữ tiếng Việt có dấu"


def _dejavu_sans() -> str:
    p = _vietnamese_font()
    assert p, "no DejaVu Sans found — _vietnamese_font() returned None"
    return p


def _dejavu_serif() -> str | None:
    """The bundled DejaVu *Serif*, used as a stand-in for "the document's own font".

    Serif on purpose: the fallback this file is about is DejaVu *Sans*, so a redraw
    that lands on Serif proves the original font was kept, while one that lands on
    Sans proves it was substituted. Both ship with matplotlib.
    """
    cand = Path(_dejavu_sans()).with_name("DejaVuSerif.ttf")
    return str(cand) if cand.is_file() else None


def _subset_font(fontfile: str, keep: str) -> bytes | None:
    """`fontfile` cut down to just the characters in `keep` — a real subset program,
    the way a font actually arrives inside a PDF. Returns None without fontTools."""
    try:
        from fontTools import subset as ft_subset
        from fontTools.ttLib import TTFont
    except Exception:
        return None
    import io
    import logging

    # api.py sets the root logger to INFO; the subsetter narrates every table.
    logging.getLogger("fontTools").setLevel(logging.ERROR)

    font = TTFont(fontfile)
    subsetter = ft_subset.Subsetter(options=ft_subset.Options(notdef_outline=True))
    subsetter.populate(text=keep)
    subsetter.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def _src_pdf(
    text: str,
    *,
    fontfile: str | None = None,
    fontbuffer: bytes | None = None,
    retag: str | None = None,
) -> str:
    """A one-page PDF holding a single line drawn in the given font, as base64.

    `retag` renames the embedded font, standing in for the name a real document
    carries. One line only: after the edit redacts it, no glyph on the page uses
    that font any more — the state /edit-text has to cope with.
    """
    doc = fitz.open()
    try:
        page = doc.new_page()
        page.insert_font(fontname="F0", fontfile=fontfile, fontbuffer=fontbuffer)
        page.insert_text((60, 100), text, fontname="F0", fontsize=12)
        if retag:
            for f in page.get_fonts():
                doc.xref_set_key(f[0], "BaseFont", f"/{retag}")
                df = doc.xref_get_key(f[0], "DescendantFonts")
                if df[0] == "array":
                    dxref = int(df[1].strip("[]").replace("0 R", "").strip())
                    doc.xref_set_key(dxref, "BaseFont", f"/{retag}")
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def _keep_font_round(pdf_b64: str, new_text: str) -> tuple[str, str]:
    """One edit round with the font picker on "Giữ nguyên", as text-edit.js sends it.

    Returns (resulting pdf_b64, font name of the redrawn span).
    """
    spans = asyncio.run(text_spans(TextSpansRequest(pdf_b64=pdf_b64, page=0))).spans
    assert spans, "fixture has no text spans"
    target = spans[0]
    edit = TextEdit(
        page=0,
        bbox=target.bbox,
        new_text=new_text,
        origin=target.origin,
        size=target.size,
        color=target.color,
        font=target.font,  # "__keep__" resolves to the span's own font name
        bold=bool(target.flags & 16),
        italic=bool(target.flags & 2),
    )
    res = asyncio.run(edit_text(EditTextRequest(pdf_b64=pdf_b64, edits=[edit])))
    assert res.success, f"edit-text failed: {res.error}"
    out = res.data_b64
    doc = fitz.open(stream=base64.b64decode(out), filetype="pdf")
    try:
        drawn = ""
        for b in doc[0].get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                for sp in line.get("spans", []):
                    if sp["text"].strip():
                        drawn = sp["font"]
        assert drawn, "nothing was drawn back onto the page"
        return out, drawn
    finally:
        doc.close()


def _notdef(pdf_b64: str) -> int:
    """How many glyphs on page 0 are notdef — i.e. render as □."""
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        return sum(line.count("\x00") for line in doc[0].get_text().splitlines())
    finally:
        doc.close()


# ---- 1. family resolution -------------------------------------------------


def test_strip_style_suffix_keeps_roman():
    """"Roman" is part of the family "Times New Roman", not a style word. Stripping
    it would leave "Times New", which matches nothing — and the bug would be back."""
    assert _strip_style_suffix("TimesNewRomanBold") == "TimesNewRoman"
    assert _strip_style_suffix("TimesNewRoman") == "TimesNewRoman"
    assert _strip_style_suffix("TimesNewRomanBoldItalic") == "TimesNewRoman"
    assert _strip_style_suffix("SVN-Times New Roman Bold") == "SVN-Times New Roman"
    assert _strip_style_suffix("Arial-BoldMT") == "Arial"
    # A name that is nothing but style words must not vanish.
    assert _strip_style_suffix("Bold") == "Bold"


def test_family_candidates_keep_the_historical_name_first():
    """Order is the compatibility guarantee: whatever `_clean_font_name` produced
    before is still tried first, so no name that used to resolve can move."""
    assert _family_candidates("Arial-BoldMT")[0] == "Arial"
    assert _family_candidates("ABCDEF+TimesNewRomanPS-BoldMT")[0] == "TimesNewRoman"
    # …and the new candidates come after it.
    assert "TimesNewRoman" in _family_candidates("TimesNewRomanBold")
    assert "SVN-Times New Roman" in _family_candidates("SVN-Times New Roman Bold")


def test_glued_style_suffix_resolves_to_an_installed_family():
    """The reported case, at the resolver level: "<Family><Style>" with no separator.

    DejaVu Serif stands in for Times New Roman so this runs anywhere.
    """
    if not _dejavu_serif():
        return  # matplotlib without DejaVu Serif — nothing to assert against
    got = _resolve_local_font("DejaVuSerifBold", True, False)
    assert got, "glued style suffix still resolves to nothing"
    assert "dejavuserif" in Path(got).name.lower().replace(" ", ""), got


def test_keep_font_does_not_substitute_dejavu_sans():
    """End to end: a span whose font name has a glued style suffix must come back in
    its own family, not in the Vietnamese fallback."""
    serif = _dejavu_serif()
    if not serif:
        return
    pdf = _src_pdf(TEXT, fontfile=serif, retag="DejaVuSerifBold")
    out, drawn = _keep_font_round(pdf, TEXT + " đã sửa")
    assert "Serif" in drawn, f"font was substituted: redrawn in {drawn!r}"
    assert _notdef(out) == 0, "redraw produced notdef boxes"


# ---- 2. re-embedding the document's own font ------------------------------


def test_font_only_present_inside_the_pdf_is_reused():
    """A face that is NOT installed anywhere (in-house CAD font, SVN-*, .Vn*): the
    only copy is inside the document, so /edit-text must re-embed that one."""
    serif = _dejavu_serif()
    if not serif:
        return
    # A name no font index can possibly know, carrying a DejaVu Serif program.
    pdf = _src_pdf(TEXT, fontfile=serif, retag="ZzQuuxCadFontRegular")
    assert not _resolve_local_font("ZzQuuxCadFontRegular", False, False), "fixture name is installed?!"
    out, drawn = _keep_font_round(pdf, TEXT + " đã sửa")
    assert "Serif" in drawn, f"the document's own font was dropped; got {drawn!r}"
    assert _notdef(out) == 0


def test_page_font_buffers_reads_the_untouched_page():
    """`_page_font_buffers` is documented as "call before apply_redactions", and
    /edit-text does. This pins the contract it depends on: on an untouched page the
    program comes out whole, keyed by the family name the span reports.

    (Whether a redaction *also* strips the resource is a PyMuPDF implementation
    detail that has changed between versions — the ordering is what makes the
    result independent of it, so don't reorder on the grounds that it happens to
    survive today.)"""
    serif = _dejavu_serif()
    if not serif:
        return
    pdf = _src_pdf(TEXT, fontfile=serif, retag="ZzQuuxCadFontRegular")
    doc = fitz.open(stream=base64.b64decode(pdf), filetype="pdf")
    try:
        bufs = _page_font_buffers(doc, doc[0])
        assert "zzquuxcadfontregular" in bufs, f"keys were {list(bufs)}"
        assert len(bufs["zzquuxcadfontregular"]) > 1000, "extracted program looks empty"
    finally:
        doc.close()


def test_subset_font_that_cannot_cover_the_new_text_falls_back():
    """The v0.2.34 trap: an embedded subset holds only the glyphs the document used.
    Reusing it for text with other characters draws notdef boxes and reports success,
    so coverage has to be checked for every character — including plain ASCII."""
    serif = _dejavu_serif()
    buf = _subset_font(serif, "AAA") if serif else None
    if not buf:
        return  # no fontTools → can't build a genuine subset here
    pdf = _src_pdf("AAA", fontbuffer=buf, retag="ZzQuuxCadFontRegular")
    out, drawn = _keep_font_round(pdf, "Chữ hoàn toàn khác")
    assert _notdef(out) == 0, f"subset font was reused blindly (redrawn in {drawn!r})"
    assert "Serif" not in drawn, f"expected the DejaVu Sans fallback, got {drawn!r}"


def test_ascii_only_edit_also_checks_coverage():
    """Same trap without a single diacritic — the needs_unicode shortcut must not be
    what decides whether an embedded subset is trusted."""
    serif = _dejavu_serif()
    buf = _subset_font(serif, "AAA") if serif else None
    if not buf:
        return
    pdf = _src_pdf("AAA", fontbuffer=buf, retag="ZzQuuxCadFontRegular")
    out, drawn = _keep_font_round(pdf, "BBB")
    assert _notdef(out) == 0, f"ASCII edit drew notdef boxes from a subset font ({drawn!r})"


if __name__ == "__main__":
    # No pytest in the project venv — plain runner, same style as test_export.py.
    for fn in (
        test_strip_style_suffix_keeps_roman,
        test_family_candidates_keep_the_historical_name_first,
        test_glued_style_suffix_resolves_to_an_installed_family,
        test_keep_font_does_not_substitute_dejavu_sans,
        test_font_only_present_inside_the_pdf_is_reused,
        test_page_font_buffers_reads_the_untouched_page,
        test_subset_font_that_cannot_cover_the_new_text_falls_back,
        test_ascii_only_edit_also_checks_coverage,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All keep-font tests passed.")
