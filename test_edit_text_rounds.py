"""Tests for repeated text edits (api.py, /edit-text) — the □-boxes regression.

Editing a line, pressing "Áp dụng", then editing another line used to turn the
newly-drawn text into notdef boxes (□) — every character, not just the new ones,
and on lines that had never been touched.

The chain that caused it, and what each test here pins down:

  * Page.insert_font() matches on the RESOURCE name (/vnedit, /loc). When the page
    already carries that name it returns the existing font and silently IGNORES the
    fontfile argument — no error, no warning.
  * /edit-text ends with subset_fonts(), so the round that put /vnedit on the page
    also stripped it down to that round's glyphs. The fonts are Identity-H (text is
    addressed by glyph id), so subsetting drops the unicode cmap entirely.
  * A later round asking for /vnedit therefore got the earlier round's cmap-less
    subset, and every unicode→glyph lookup returned glyph 0 = notdef = □.

Nothing raises anywhere along that path — the API reports success and hands back a
PDF full of boxes — so these tests assert on the drawn output, not on return codes.
A notdef glyph extracts back as \\x00, which is what `_notdef` counts.

Synthetic PDFs only: no fixtures, no network, no OCR.
"""

import asyncio
import base64

import fitz  # PyMuPDF

import api
from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans

# Diacritics on purpose: Vietnamese is what exposes a missing/insufficient font.
LINES = [
    "Dòng số 1 của bản hợp đồng",
    "Dòng số 2 của bản hợp đồng",
    "Dòng số 3 của bản hợp đồng",
    "Dòng số 4 của bản hợp đồng",
]


def _src_pdf(fontfile: str, retag: str | None = None) -> str:
    """A one-page PDF whose lines are drawn in `fontfile`, as base64.

    `retag` renames the embedded font, standing in for the subset-tagged CAD/Revit
    fonts real drawings carry ("QWERTY+CadVnFont"). The name matters: it decides
    whether an edit resolves the family on this machine and embeds under /loc, or
    falls back to the bundled DejaVu under /vnedit — and therefore which round is
    the first to ask for a resource name the page already has.
    """
    doc = fitz.open()
    try:
        page = doc.new_page()
        page.insert_font(fontname="F0", fontfile=fontfile)
        for i, t in enumerate(LINES):
            page.insert_text((60, 90 + i * 30), t, fontname="F0", fontsize=12)
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


def _notdef(pdf_b64: str) -> int:
    """How many glyphs on page 0 are notdef — i.e. render as □."""
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        return sum(line.count("\x00") for line in doc[0].get_text().splitlines())
    finally:
        doc.close()


def _dejavu() -> str:
    p = api._vietnamese_font()
    assert p, "no DejaVu found — _vietnamese_font() returned None"
    return p


def _edit_round(pdf_b64: str, needle: str, new_text: str) -> str:
    """One full round-trip: read spans, edit the span holding `needle`, apply.

    Mirrors the renderer's "giữ font" path (text-edit.js apply()): the span's own
    font name is what gets sent back, which is how a later round ends up asking for
    a font resource an earlier round already created.
    """
    spans = asyncio.run(text_spans(TextSpansRequest(pdf_b64=pdf_b64, page=0))).spans
    # Extraction hands back U+00A0 for the spaces of some fonts (Arial) and plain
    # U+0020 for others (DejaVu) — match on either.
    target = next((s for s in spans if needle in s.text.replace("\xa0", " ")), None)
    assert target is not None, f"no span containing {needle!r}; got {[s.text for s in spans]}"
    edit = TextEdit(
        page=0,
        bbox=target.bbox,
        new_text=new_text,
        origin=target.origin,
        size=target.size,
        color=target.color,
        font=target.font,  # "keep original font"
        bold=bool(target.flags & 16),
        italic=bool(target.flags & 2),
    )
    res = asyncio.run(edit_text(EditTextRequest(pdf_b64=pdf_b64, edits=[edit])))
    assert res.success, f"edit-text failed: {res.error}"
    return res.data_b64


def test_second_edit_round_does_not_draw_boxes():
    """Edit → apply → edit again, as reported. The font name is one that resolves to
    nothing installed, so round 1 already falls back to DejaVu under /vnedit and
    round 2 is the one that asks for that name again — the shortest path to the bug.

    Round 2 edits a line round 1 never touched, which is what made the breakage look
    font-independent ("chọn bất cứ dòng nào ... đều bị thành ô vuông")."""
    pdf = _src_pdf(_dejavu(), retag="QWERTY+CadVnFont")
    assert _notdef(pdf) == 0, "fixture already has notdef glyphs"

    pdf = _edit_round(pdf, "số 1", "Dòng một đã được sửa chữ")
    assert _notdef(pdf) == 0, "round 1 drew boxes"

    pdf = _edit_round(pdf, "số 2", "Dòng hai đã được sửa chữ")
    assert _notdef(pdf) == 0, "round 2 drew boxes — a stale font resource was reused"


def test_many_edit_rounds_stay_clean():
    """Which round first repeats a resource name depends on whether the font name
    resolves locally, so walk every line of each fixture: a resolving name goes
    /loc → /vnedit → /vnedit…, a non-resolving one goes /vnedit from the start."""
    import os

    fixtures = [
        (_dejavu(), None, "DejaVu"),
        (_dejavu(), "QWERTY+CadVnFont", "retagged DejaVu"),
        (r"C:\Windows\Fonts\arial.ttf", None, "Arial"),
    ]
    for fontfile, retag, label in fixtures:
        if not os.path.exists(fontfile):
            continue  # Arial is Windows-only; DejaVu always ships with the app
        pdf = _src_pdf(fontfile, retag=retag)
        for i in range(len(LINES)):
            pdf = _edit_round(pdf, f"số {i + 1}", f"Dòng {i + 1} sửa ở vòng {i + 1} nhé")
            assert _notdef(pdf) == 0, f"{label}: round {i + 1} drew boxes"


def test_edit_never_reuses_a_font_resource_name():
    """The invariant behind the fix, asserted directly: an /edit-text round must not
    embed under a resource name the page already has, because insert_font would drop
    our fontfile and keep the old (subsetted, cmap-less) font."""
    real = fitz.Page.insert_font
    reused: list[str] = []

    def spy(self, fontname="helv", fontfile=None, **kw):
        # Only our own embeds pass a fontfile; insert_text re-calls without one.
        if fontfile and fontname in {f[4] for f in self.get_fonts()}:
            reused.append(fontname)
        return real(self, fontname=fontname, fontfile=fontfile, **kw)

    fitz.Page.insert_font = spy
    try:
        pdf = _src_pdf(_dejavu())
        for i in range(len(LINES)):
            pdf = _edit_round(pdf, f"số {i + 1}", f"Dòng {i + 1} sửa ở vòng {i + 1}")
    finally:
        fitz.Page.insert_font = real
    assert not reused, f"embedded under already-present resource name(s): {reused}"


def test_fresh_fontname_skips_names_the_page_has():
    doc = fitz.open()
    try:
        page = doc.new_page()
        assert api._fresh_fontname(page, "vnedit") == "vnedit"
        page.insert_font(fontname="vnedit", fontfile=_dejavu())
        assert api._fresh_fontname(page, "vnedit") == "vnedit1"
        page.insert_font(fontname="vnedit1", fontfile=_dejavu())
        assert api._fresh_fontname(page, "vnedit") == "vnedit2"
        # An unrelated base name is unaffected by those.
        assert api._fresh_fontname(page, "loc") == "loc"
    finally:
        doc.close()


if __name__ == "__main__":
    # No pytest in the project venv — plain runner, same style as test_export.py.
    for fn in (
        test_fresh_fontname_skips_names_the_page_has,
        test_second_edit_round_does_not_draw_boxes,
        test_many_edit_rounds_stay_clean,
        test_edit_never_reuses_a_font_resource_name,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All edit-text round tests passed.")
