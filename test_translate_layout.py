"""Tests for the layout-preserving translation (api.py, /translate-pdf).

Synthetic PDFs are built with PyMuPDF so every expected position is known
exactly — where each cell's text starts, which edge it is aligned to, what it
sits on top of. No fixtures, no golden files, and no network: Gemini is stubbed
with a fixed phrasebook, so a run only exercises our own layout code.

What these lock in is the set of things that quietly broke before, all of which
fail silently in production — the text simply moves, shrinks or vanishes and the
API still reports success:

  * a table row is one MuPDF block, so translating it as a unit collapses the
    columns into one left-aligned paragraph;
  * insert_textbox draws *nothing* and raises nothing when the text does not
    fit, so a bad font-size estimate loses the text outright;
  * a redaction that fills white punches a hole in a shaded cell, and its
    defaults also drop an underline and blank the image behind the words.

Known gap, deliberately not asserted here: a cell too small to hold its
translation at even min_size=5.0 is redacted and then left blank, because the
endpoint commits to the redaction before it knows the insert will be refused.
It takes roughly a 10x expansion in a tiny box to reach that.
"""

import asyncio
import base64
import json

import fitz  # PyMuPDF

import api
from api import TranslateRequest, translate_pdf

W, H = 595, 842  # A4 portrait, points
FS = 9.0         # body size of every fixture — translations must keep it

# The fixture table: 3 columns, a header row, 2 item rows, and a merged
# full-width totals row (no inner verticals) like an invoice's.
COLS = [60, 300, 380, 520]
ROWS = [100, 130, 160, 190, 220]
PAD = 4  # how far the flush-left/right text sits from its gridline

# Translations long enough to need room the source text did not occupy.
VI = {
    "Description": "Mô tả hạng mục",
    "Qty": "SL",
    "Amount": "Thành tiền",
    "Steel bar D16": "Thanh thép gia cường D16",
    "Concrete C30": "Bê tông C30",
    "VAT rate : 8%": "Thuế suất thuế GTGT : 8%",
    "VAT amount : 272.593": "Tiền thuế GTGT : 272.593",
}


class _StubGemini:
    """Stands in for the Gemini agent: looks every block up in a phrasebook.

    The endpoint masks numbers/dates/emails *before* it calls out, so the
    phrasebook is masked the same way — key on the plain text and nothing ever
    matches ("Steel bar D16" reaches the agent as "Steel bar D<0>"). Masking the
    Vietnamese side too keeps the placeholder numbering aligned with the source's
    store, which is what `_unmask_terms` restores against. Anything not in the
    book is echoed back, exactly as an unchanged translation would be.
    """

    def __init__(self, phrasebook: dict[str, str]):
        self.book = {api._mask_terms(k)[0]: api._mask_terms(v)[0]
                     for k, v in phrasebook.items()}
        self.asked: list[str] = []  # every 't' the endpoint sent, in order

    def _generate(self, prompt: str, system_instruction: str = "") -> str:
        items = json.loads(prompt)
        self.asked.extend(it["t"] for it in items)
        return json.dumps(
            [{"i": it["i"], "t": self.book.get(it["t"], it["t"])} for it in items],
            ensure_ascii=False,
        )


def _translate(pdf_bytes: bytes, phrasebook: dict[str, str] = VI, **kw):
    """Run /translate-pdf against a stubbed agent → (response, out doc, stub)."""
    stub = _StubGemini(phrasebook)
    real = api._get_gemini
    api._get_gemini = lambda: stub
    try:
        resp = asyncio.run(translate_pdf(TranslateRequest(
            pdf_b64=base64.b64encode(pdf_bytes).decode("ascii"),
            source_lang="en", target_lang="vi", **kw,
        )))
    finally:
        api._get_gemini = real
    assert resp.success, resp.error
    return resp, fitz.open(stream=base64.b64decode(resp.data_b64), filetype="pdf"), stub


# --- fixture drawing -------------------------------------------------------

_FONT = fitz.Font(fontname="helv")


def _w(s: str) -> float:
    return _FONT.text_length(s, fontsize=FS)


def _put(page, s: str, y: float, *, left=None, right=None, centre=None):
    """Place text by the edge it is aligned to, so the fixture's intent is
    unambiguous — `_cell_layout` has to read that alignment back out."""
    if left is not None:
        x = left
    elif right is not None:
        x = right - _w(s)
    else:
        x = centre - _w(s) / 2
    page.insert_text((x, y), s, fontsize=FS)
    return fitz.Rect(x, y - FS, x + _w(s), y)


def _grid(page):
    """The table's ruling lines — what find_tables actually keys on."""
    for x in COLS:  # verticals stop above the totals row: it is one merged cell
        page.draw_line(fitz.Point(x, ROWS[0]), fitz.Point(x, ROWS[3]), width=0.7)
    for y in ROWS[:4]:
        page.draw_line(fitz.Point(COLS[0], y), fitz.Point(COLS[-1], y), width=0.7)
    for x in (COLS[0], COLS[-1]):
        page.draw_line(fitz.Point(x, ROWS[3]), fitz.Point(x, ROWS[4]), width=0.7)
    page.draw_line(fitz.Point(COLS[0], ROWS[4]), fitz.Point(COLS[-1], ROWS[4]), width=0.7)


def _invoice(shade: bool = False):
    """A one-page invoice-shaped table. `shade` fills the header row grey, the
    case where redacting with a white fill leaves a visible patch."""
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    if shade:
        page.draw_rect(fitz.Rect(COLS[0], ROWS[0], COLS[-1], ROWS[1]),
                       color=None, fill=(0.85, 0.85, 0.85))
    _grid(page)

    mid = [(COLS[i] + COLS[i + 1]) / 2 for i in range(3)]
    _put(page, "Description", ROWS[0] + 21, centre=mid[0])
    _put(page, "Qty", ROWS[0] + 21, centre=mid[1])
    # Right-aligned over the money column it heads, as invoices set it — and the
    # only right-aligned cell here whose text actually changes (the amounts
    # below it are pure numbers and are skipped, see the number test).
    _put(page, "Amount", ROWS[0] + 21, right=COLS[-1] - PAD)

    for row, (name, qty, amount) in enumerate((
        ("Steel bar D16", "23", "3.407.407"),
        ("Concrete C30", "5", "1.234.567"),
    )):
        y = ROWS[1 + row] + 21
        _put(page, name, y, left=COLS[0] + PAD)
        _put(page, qty, y, centre=mid[1])
        _put(page, amount, y, right=COLS[-1] - PAD)

    # Totals row: label hard left, amount hard right, ~280pt of nothing between
    # them — one merged cell holding two independent runs.
    _put(page, "VAT rate : 8%", ROWS[3] + 21, left=COLS[0] + PAD)
    _put(page, "VAT amount : 272.593", ROWS[3] + 21, right=COLS[-1] - PAD)
    return doc.tobytes()


# --- reading the result ----------------------------------------------------


def _rect(page, needle: str):
    """Union rect of `needle` on the page. Fails loudly when it is missing —
    text that vanished is the failure mode most worth catching."""
    hits = page.search_for(needle)
    assert hits, f"{needle!r} is not on the output page"
    r = hits[0]
    for h in hits[1:]:
        r |= h
    return r


def _size(page, needle: str) -> float | None:
    """Font size of the span carrying `needle` — catches a silent shrink."""
    for b in page.get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            for sp in line.get("spans", []):
                if needle in sp.get("text", ""):
                    return round(float(sp["size"]), 1)
    return None


# --- tests -----------------------------------------------------------------


def test_table_cells_keep_column_and_alignment():
    """Each cell is re-typeset in its own column, on its own aligned edge.

    This is the bug the whole cell-splitting path exists for: without it the
    row becomes one paragraph flush against the table's left edge.
    """
    src = _invoice()
    _, doc, _ = _translate(src)
    try:
        page = doc[0]

        # Left-aligned name column: starts exactly where the English did.
        assert abs(_rect(page, "Thanh thép gia cường D16").x0 - (COLS[0] + PAD)) <= 2

        # Right-aligned money column: ends where the English did, and is still
        # inside its own cell rather than dragged left with the row.
        thanh_tien = _rect(page, "Thành tiền")
        assert abs(thanh_tien.x1 - (COLS[-1] - PAD)) <= 2
        assert thanh_tien.x0 > COLS[2]

        # Centred qty header stays centred on its column.
        sl = _rect(page, "SL")
        assert abs((sl.x0 + sl.x1) / 2 - (COLS[1] + COLS[2]) / 2) <= 3

        # Centred header grew to the left *and* right of its old box (the
        # translation is wider than "Description") instead of being shrunk.
        mo_ta = _rect(page, "Mô tả hạng mục")
        assert abs((mo_ta.x0 + mo_ta.x1) / 2 - (COLS[0] + COLS[1]) / 2) <= 3
        assert COLS[0] < mo_ta.x0 and mo_ta.x1 < COLS[1]

        # Nothing was shrunk to make it fit, and nothing left its row.
        for s in ("Mô tả hạng mục", "Thành tiền", "Thanh thép gia cường D16"):
            assert _size(page, s) == FS, f"{s!r} shrank to {_size(page, s)}"
        assert ROWS[1] < _rect(page, "Thanh thép gia cường D16").y1 < ROWS[2]
    finally:
        doc.close()


def test_merged_cell_runs_stay_apart():
    """A merged cell's label and value are laid out independently.

    Joined into one string the ~280pt gap between them collapses and the amount
    is dragged out of its column into mid-page.
    """
    src = _invoice()
    _, doc, stub = _translate(src)
    try:
        page = doc[0]
        # The endpoint asked about the two runs separately — if they had been
        # joined, this would be one item and the gap would already be gone.
        assert "VAT rate : ⟦0⟧%" in stub.asked or any(
            a.startswith("VAT rate") for a in stub.asked), stub.asked
        assert any(a.startswith("VAT amount") for a in stub.asked), stub.asked

        label = _rect(page, "Thuế suất thuế GTGT")
        assert abs(label.x0 - (COLS[0] + PAD)) <= 2, "label left the left margin"

        amount = _rect(page, "Tiền thuế GTGT : 272.593")
        assert abs(amount.x1 - (COLS[-1] - PAD)) <= 2, "amount left its column"
        # Still a gap, not one sentence.
        assert amount.x0 - label.x1 > 100
    finally:
        doc.close()


def test_number_only_cells_are_left_alone():
    """A pure-number cell translates to itself, so it is never redrawn.

    Masking turns "3.407.407" into a lone placeholder, which comes back
    identical; the endpoint skips it, meaning the digits are never redacted and
    cannot drift. Position must be identical to the source, not merely close.
    """
    src = _invoice()
    before = fitz.open(stream=src, filetype="pdf")
    _, doc, _ = _translate(src)
    try:
        for num in ("3.407.407", "1.234.567", "23"):
            b, a = _rect(before[0], num), _rect(doc[0], num)
            assert abs(a.x0 - b.x0) < 0.01 and abs(a.y0 - b.y0) < 0.01, \
                f"{num} moved: {b} -> {a}"
    finally:
        before.close()
        doc.close()


def test_shaded_cell_keeps_its_background():
    """Redacting must take the glyphs and leave what they were drawn on.

    A white fill over the text's own bbox is invisible on white paper and
    obvious on a shaded header — so look for pure white *inside* the shaded
    cell, which is exactly where the fill would land.
    """
    src = _invoice(shade=True)
    _, doc, _ = _translate(src)
    try:
        page = doc[0]
        assert _rect(page, "Mô tả hạng mục")  # the row really was translated
        clip = fitz.Rect(COLS[0] + 1, ROWS[0] + 1, COLS[-1] - 1, ROWS[1] - 1)
        pix = page.get_pixmap(dpi=150, clip=clip)
        white = sum(
            1
            for y in range(pix.height)
            for x in range(pix.width)
            if pix.pixel(x, y)[:3] == (255, 255, 255)
        )
        assert white == 0, f"{white} white pixels punched into the shaded header"
    finally:
        doc.close()


def test_underline_under_text_survives():
    """Line art the redaction box covers stays put.

    apply_redactions defaults to removing line art it *covers*, so an underline
    that fits inside the text's own bbox — a rule sitting under an underlined
    heading, which is exactly how Word draws one — is silently deleted along
    with the words. Translating replaces the words, not the rule under them.

    The underline has to sit strictly inside the bbox for this to test
    anything: one that overhangs the text is not "covered" and survives even
    with the defaults.
    """
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    page.insert_text((60, 100), "Description", fontsize=FS)
    tight = fitz.Rect(page.get_text("dict")["blocks"][0]["lines"][0]["spans"][0]["bbox"])
    uy = tight.y1 - 0.5
    page.draw_line(fitz.Point(tight.x0 + 1, uy), fitz.Point(tight.x1 - 1, uy), width=0.6)
    assert tight.contains(fitz.Rect(tight.x0 + 1, uy - 0.3, tight.x1 - 1, uy + 0.3)), \
        "fixture is wrong: the underline is not inside the text bbox"
    src = doc.tobytes()
    doc.close()

    _, out, _ = _translate(src)
    try:
        assert _rect(out[0], "Mô tả hạng mục")
        lines = [
            it for d in out[0].get_drawings() for it in d["items"]
            if it[0] == "l" and abs(it[1].y - uy) < 1 and abs(it[2].y - uy) < 1
        ]
        assert lines, "the underline under the translated text was redacted away"
    finally:
        out.close()


def test_long_translation_shrinks_but_survives():
    """A translation that far outgrows its cell is shrunk, never dropped.

    insert_textbox reports "did not fit" by returning a negative number and
    drawing nothing — no exception — and the old text is already redacted away
    by then, so a block that will not fit is a blank cell, not an overflowing
    one. Each of these needs ~10x the room the English took.

    (There is a floor: min_size=5.0. A box too small for even that still loses
    the text — see the note in the module docstring.)
    """
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    for x in (60, 200, 320):
        page.draw_line(fitz.Point(x, 100), fitz.Point(x, 160), width=0.7)
    for y in (100, 130, 160):
        page.draw_line(fitz.Point(60, y), fitz.Point(320, y), width=0.7)
    page.insert_text((64, 121), "Item", fontsize=FS)
    page.insert_text((204, 121), "Note", fontsize=FS)
    page.insert_text((64, 151), "Bolt", fontsize=FS)
    page.insert_text((204, 151), "OK", fontsize=FS)
    src = doc.tobytes()
    doc.close()

    book = {
        "Item": "Hạng mục cần kiểm tra trước nghiệm thu",
        "Note": "Ghi chú của tư vấn giám sát hiện trường",
        "Bolt": "Bu lông neo cường độ cao mạ kẽm",
        "OK": "Đã kiểm tra và chấp thuận theo thiết kế",
    }
    resp, out, _ = _translate(src, book)
    try:
        text = out[0].get_text()
        for vi in book.values():
            # Wrapped text carries line breaks, so match on the first word.
            assert vi.split(" ")[0] in text, f"{vi!r} was dropped from the page"
        assert resp.blocks_translated == len(book)
        # It really did have to shrink — otherwise this proves nothing about
        # the fitting path.
        assert _size(out[0], "Bu lông") < FS
    finally:
        out.close()


def test_plain_page_keeps_the_old_geometry():
    """Off a table, a block's layout box is its bbox and it stays flush left —
    the cell path must not leak into ordinary prose."""
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    page.insert_text((72, 100), "Payment terms", fontsize=12)
    page.insert_text((72, 130), "Description", fontsize=12)
    blocks = api._page_text_blocks(page)
    doc.close()

    assert blocks
    for b in blocks:
        assert b["align"] == 0
        assert b["layout"] == b["bbox"]


def test_fit_fontsize_never_overflows():
    """Whatever size `_fit_fontsize` returns, insert_textbox must accept it.

    The one invariant that matters: it returns a *promise* that the text fits,
    and a wrong promise means the block is redacted and then never redrawn. The
    height rule it encodes is insert_textbox's own and is not guessable — the
    earlier 1.3×fontsize estimate emptied whole tables.
    """
    font = fitz.Font(fontname="helv")
    words = "Mô tả hạng mục Thanh thép gia cường D16 nghiệm thu hiện trường".split()
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    try:
        checked = 0
        for n in range(1, 12):
            text = " ".join(words[:n])
            for w in (20, 35, 60, 90, 140, 220):
                for h in (10, 14, 22, 40, 70):
                    fs = api._fit_fontsize(font, text, w, h, start=12.0, min_size=5.0)
                    if fs <= 5.0:
                        continue  # gave up: insert_textbox is allowed to refuse
                    rect = fitz.Rect(50, 50, 50 + w, 50 + h)
                    rc = page.insert_textbox(rect, text, fontname="helv", fontsize=fs)
                    assert rc >= 0, (
                        f"_fit_fontsize said {fs} fits {w}x{h} for {text!r}, "
                        f"insert_textbox refused by {rc:.2f}pt"
                    )
                    checked += 1
        assert checked > 100, f"only {checked} cases actually exercised"
    finally:
        doc.close()


if __name__ == "__main__":
    # No pytest in the project venv — plain runner, same style as test_export.py.
    for fn in (
        test_table_cells_keep_column_and_alignment,
        test_merged_cell_runs_stay_apart,
        test_number_only_cells_are_left_alone,
        test_shaded_cell_keeps_its_background,
        test_underline_under_text_survives,
        test_long_translation_shrinks_but_survives,
        test_plain_page_keeps_the_old_geometry,
        test_fit_fontsize_never_overflows,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All translate-layout tests passed.")
