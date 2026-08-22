"""Table/cell/block geometry, text-fit, and term-masking for layout-preserving
translation.

Extracted verbatim from api.py (Phase 4 conservative refactor). Depends on
_require_fitz (util) plus stdlib re/logging; api.py re-imports these names so
every call site (and the translate-layout tests) is unchanged.
"""

import logging
import re as _re

from src.pdf.util import _require_fitz

logger = logging.getLogger(__name__)


# Sentinel-wrapped placeholder for a masked term (private-use chars, unlikely in
# real text). Numbers/dates/emails are swapped out before translation and put
# back verbatim after, so Gemini can't "helpfully" rewrite an amount or a code.
_MASK_OPEN = ""
_MASK_CLOSE = ""
_MASK_TERM_RE = _re.compile(
    r"[\w.+-]+@[\w-]+\.[\w.-]+"          # email
    r"|\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}"  # date dd/mm/yyyy & co
    r"|\d[\d.,]*"                          # number (incl. 1.234,56)
)
_MASK_RESTORE_RE = _re.compile(_MASK_OPEN + r"(\d+)" + _MASK_CLOSE)


def _mask_terms(text: str) -> tuple[str, list[str]]:
    """Replace numbers/dates/emails with sentinel tokens; return (masked, store)."""
    store: list[str] = []

    def repl(m):
        store.append(m.group(0))
        return f"{_MASK_OPEN}{len(store) - 1}{_MASK_CLOSE}"

    return _MASK_TERM_RE.sub(repl, text), store


def _unmask_terms(text: str, store: list[str]) -> str:
    """Restore sentinel tokens back to their original terms."""
    def repl(m):
        i = int(m.group(1))
        return store[i] if 0 <= i < len(store) else m.group(0)

    return _MASK_RESTORE_RE.sub(repl, text)


# ---------------------------------------------------------------------------
# Span geometry repair: the "baseline on the top edge" quirk
# ---------------------------------------------------------------------------
#
# WHAT IS BROKEN, MEASURED. Some real PDFs (text converted to vector outlines plus a
# parallel *blank* Type3 font carrying the searchable text — a common "keep it
# selectable" export) make MuPDF report a span box whose TOP edge sits exactly on the
# baseline, i.e. the whole box hangs BELOW the text instead of enclosing it:
#
#     span bbox=(56.0, 43.0, 71.6, 57.0)  origin=(56.0, 43.0)  size=14  asc=0.9 desc=-0.1
#     the ink for those glyphs is actually at y 32.94 .. 43.17
#
# So the reported box is off by a whole line height. Every consumer inherits that:
# `/translate-pdf` redacts empty paper and types the translation one line low (which is
# how the original stayed readable UNDER the translation — the reported bug), and
# "Sửa nội dung" / "Tìm & Thay thế" highlight the gap below the word they mean.
#
# THE RULE, and why a normal document cannot trip it. For horizontal Latin text MuPDF
# derives the box as [origin.y - ascender*size, origin.y - descender*size], so
# `origin.y - y0` is `ascender*size` ≈ 0.9*size — nowhere near the 0.25*size threshold
# below. The quirk gives exactly 0. The test is scale-free (a fraction of the font
# size, not an absolute point count), so a 4pt footnote is judged by the same rule as a
# 40pt heading.
#
# ONLY HORIZONTAL TEXT. On a rotated line the axis-aligned box is not built from the
# ascender along y at all, and `origin.y - y0` means something else entirely — see the
# `line["dir"]` reasoning behind BI-66. Those lines are left exactly as MuPDF reported
# them.
#
# THE METRICS WE SUBSTITUTE ARE MEASURED, NOT ASSUMED. The fonts that show this quirk
# report a suspiciously round asc=0.9 / desc=-0.1 (MuPDF's fallback pair, not the
# font's own). Against the real ink on the sample file: the tallest line needs 0.89*size
# above the baseline and the deepest descender reaches 0.21*size below it. 0.9 / -0.25
# covers both with a hair to spare, and over-covering is the safe direction here — the
# box's job is to say "the old glyphs are in here", and it is redrawn afterwards anyway.
_BASELINE_TOP_FRAC = 0.25   # origin.y - y0 below this share of the size ⇒ quirk
_QUIRK_ASCENDER = 0.9
_QUIRK_DESCENDER = -0.25


def _fix_span_box(sp: dict) -> tuple[float, float, float, float] | None:
    """Corrected bbox for one span, or None when MuPDF's is already right.

    Pure: reads the span dict, writes nothing. `_fix_text_dict` is what applies it.
    """
    try:
        x0, y0, x1, y1 = (float(v) for v in sp["bbox"])
        oy = float(sp["origin"][1])
        size = float(sp.get("size", 0.0) or 0.0)
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    if size <= 0 or not (y1 > y0):
        return None
    # Baseline well below the top edge ⇒ an ordinary, correctly-reported box.
    if (oy - y0) >= _BASELINE_TOP_FRAC * size:
        return None
    # A box far shorter than the font size is a clipped/degenerate mark, not a line
    # box that happens to be misplaced. Leave those to the callers' own filters.
    if (y1 - y0) < 0.5 * size:
        return None
    asc = float(sp.get("ascender", 0.0) or 0.0)
    desc = float(sp.get("descender", 0.0) or 0.0)
    asc = max(asc, _QUIRK_ASCENDER)
    desc = min(desc, _QUIRK_DESCENDER)
    return (x0, oy - asc * size, x1, oy - desc * size)


def _fix_text_dict(data: dict) -> int:
    """Repair the quirk in a `get_text("dict")` result IN PLACE; return spans fixed.

    Line and block boxes are recomputed from the corrected spans, because callers
    read all three (`_page_text_blocks` redacts the BLOCK box, `_visual_lines` groups
    on the SPAN box) and a mixture of repaired and stale boxes is worse than either.
    """
    fixed = 0
    for block in data.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        bx0 = by0 = bx1 = by1 = None
        touched_block = False
        for line in block.get("lines", []):
            d = line.get("dir", (1.0, 0.0))
            try:
                horizontal = abs(float(d[1])) <= 1e-3 and float(d[0]) > 0
            except (TypeError, ValueError, IndexError):
                horizontal = False
            lx0 = ly0 = lx1 = ly1 = None
            touched_line = False
            for sp in line.get("spans", []):
                box = _fix_span_box(sp) if horizontal else None
                if box is not None:
                    sp["bbox"] = box
                    fixed += 1
                    touched_line = True
                try:
                    sx0, sy0, sx1, sy1 = (float(v) for v in sp["bbox"])
                except (KeyError, TypeError, ValueError):
                    continue
                lx0 = sx0 if lx0 is None else min(lx0, sx0)
                ly0 = sy0 if ly0 is None else min(ly0, sy0)
                lx1 = sx1 if lx1 is None else max(lx1, sx1)
                ly1 = sy1 if ly1 is None else max(ly1, sy1)
            if touched_line and lx0 is not None:
                line["bbox"] = (lx0, ly0, lx1, ly1)
                touched_block = True
            if lx0 is not None:
                bx0 = lx0 if bx0 is None else min(bx0, lx0)
                by0 = ly0 if by0 is None else min(by0, ly0)
                bx1 = lx1 if bx1 is None else max(bx1, lx1)
                by1 = ly1 if by1 is None else max(by1, ly1)
        if touched_block and bx0 is not None:
            block["bbox"] = (bx0, by0, bx1, by1)
    return fixed


def _page_text_dict(page) -> dict:
    """`page.get_text("dict")` with the baseline-on-top quirk repaired.

    THE ONE ENTRY POINT. Every place that parses a page's spans goes through here —
    `/text-spans`, `/text-find`'s index and `_page_text_blocks` — so the three
    features can never disagree about where a word is. Adding a fourth reader means
    calling this, not `page.get_text("dict")`.
    """
    data = page.get_text("dict")
    _fix_text_dict(data)
    return data


# ---------------------------------------------------------------------------
# Did the redaction actually remove the old glyphs?
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS. `/translate-pdf` redacts a block and types the translation into the
# same box. That works because redaction deletes the show-text operators that painted
# the words. On a PDF whose text was CONVERTED TO OUTLINES, the words are filled vector
# paths and the text layer is a blank parallel font: redaction deletes the (invisible)
# text layer and the visible words stay exactly where they were, so the translation is
# typed ON TOP of a Vietnamese page nobody can now read. That is the shipped bug this
# answers, reproduced and measured on the reporter's own file.
#
# WHY NOT JUST TURN LINE-ART REMOVAL BACK ON. v0.2.23 did redact line art (the plain
# `apply_redactions()` default) and v0.2.43 deliberately stopped, because that also
# drops the underline under the text and the shading behind it. Measured on the sample
# file, turning it back on does not even fix this: MuPDF removes only the sub-paths its
# heuristic thinks are covered, so headings come back with their diacritics shaved off.
# Both branches of that trade are bad; neither is the answer.
#
# THE SIGNAL, and why it cannot fire on an ordinary document. Render the page at 72 dpi
# BEFORE and AFTER `apply_redactions`, and compare the block's own pixels. If not one
# pixel changed, the redaction provably removed nothing visible from that block — the
# only way that happens for a block we KNOW holds text is that the visible words are
# not text. On any normal PDF the glyphs disappear, so the two renders differ and this
# stays out of the way entirely. Note what the test is NOT: it never asks "is this
# region dark" or "does it look like a photo", so a caption over a photograph (where
# redaction does clear the glyph pixels) is never mistaken for outlined text.
#
# WHAT WE DO ABOUT IT. Paint the block over with the page colour sampled from the band
# just above and below it, then typeset the translation on the fresh ground. If that
# band is NOT one flat colour — text sitting on a photo or a gradient — no rectangle is
# painted at all: an opaque patch across a rendering is a worse outcome than a page
# that reports it could not be cleaned. The caller counts both cases and tells the user.
_INK_PROBE_DPI = 72
_COVER_RING_PT = 3.0     # band (in points) above/below a block, sampled for the page colour
_COVER_MODAL_MIN = 0.6   # share of that band that must agree before we trust a colour


def _probe_list(page):
    """(display list, zoom) for the ink probe.

    A DISPLAY LIST, not a full-page pixmap, and the difference is not a micro-
    optimisation. Measured on a dense A0 CAD sheet (3370x2384pt, 4000 paths):

        one full-page render at 72 dpi          11 950 ms
        the WHOLE probe, 16 blocks, this way       389 ms

    Two full-page renders per page would have put 24 SECONDS on every page of a
    drawing set, silently, to answer a question that only ever concerns the handful
    of rectangles the blocks occupy. The display list parses the page content once;
    each clip then rasterises only its own few thousand pixels. The same probe on an
    ordinary A4 text page is 5 ms, so nothing was traded away to get this.
    """
    return page.get_displaylist(), _INK_PROBE_DPI / 72.0


def _probe_clip(dl, page, rect, z, ring: float = 0.0):
    """RGB pixmap of `rect` (UNROTATED page space), optionally grown by `ring` points.

    The rect goes through `page.rotation_matrix` first: `get_text` reports boxes in
    unrotated space while rendering happens in DISPLAYED space, and on a /Rotate 90
    sheet those are different places. Verified against rendered ink at all four
    quarter turns. Returns None when the box lands outside the page.
    """
    fitz = _require_fitz()
    r = fitz.Rect(rect) * page.rotation_matrix
    r.normalize()
    if ring:
        r = fitz.Rect(r.x0 - ring, r.y0 - ring, r.x1 + ring, r.y1 + ring)
    r = r & dl.rect
    if r.is_empty or r.width <= 0 or r.height <= 0:
        return None
    try:
        return dl.get_pixmap(matrix=fitz.Matrix(z, z), clip=r,
                             colorspace=fitz.csRGB, alpha=False)
    except Exception as e:
        logger.debug("probe clip failed: %s", e)
        return None


def _ink_survived(pm_before, pm_after) -> bool:
    """True when redaction changed NOT ONE pixel of this block — the glyphs are still there.

    Byte equality, deliberately: any looser test would need a notion of "how much
    ink" and would start guessing about photographs. What this asks is only whether
    the redaction did anything at all here, which is a fact, not a judgement.
    """
    if pm_before is None or pm_after is None:
        return False
    if pm_before.width != pm_after.width or pm_before.height != pm_after.height:
        return False
    return bytes(pm_before.samples) == bytes(pm_after.samples)


def _ring_color(pm, ring_px: int) -> tuple[float, float, float] | None:
    """Modal RGB (0..1) of the top and bottom `ring_px` rows, or None if they vary.

    `pm` is the block's clip grown by the ring, so those rows are the band just above
    and below the words. Above/below rather than a full frame: for a line of text that
    band is the inter-line gap, which is the page colour by construction, while the
    left and right edges may butt against a neighbouring column.
    """
    if pm is None or ring_px <= 0 or pm.height <= 2 * ring_px:
        return None
    n = pm.n
    stride = pm.stride
    s = pm.samples
    counts: dict[bytes, int] = {}
    total = 0
    rows = list(range(0, ring_px)) + list(range(pm.height - ring_px, pm.height))
    for y in rows:
        row = s[y * stride: y * stride + pm.width * n]
        for i in range(0, len(row), n):
            px = bytes(row[i:i + 3])
            counts[px] = counts.get(px, 0) + 1
            total += 1
    if not total:
        return None
    best, hits = max(counts.items(), key=lambda kv: kv[1])
    if hits / total < _COVER_MODAL_MIN:
        return None  # not one flat colour — refuse to paint over it
    return (best[0] / 255.0, best[1] / 255.0, best[2] / 255.0)


def _fit_fontsize(font, text: str, width: float, height: float,
                  start: float, min_size: float = 5.0) -> float:
    """Largest font size (≤ start) at which `text` wraps within width×height.

    Greedy word-wrap measured with the real font metrics; no drawing side effects.
    Falls back to min_size if even that overflows (insert_textbox then clips).

    The height a size needs is insert_textbox's own rule — one line costs
    ``fontsize * (ascender - descender)`` and the first one also pays
    ``fontsize * -descender`` on top. Guessing that factor is not safe: come in
    under it by a fraction of a point and insert_textbox quietly draws *nothing*
    (it returns a negative number and raises no error), so the text disappears.
    """
    if width <= 1 or height <= 1:
        return max(min_size, min(start, 8.0))

    try:
        lead = float(font.ascender) - float(font.descender)
        first = -float(font.descender)
    except Exception:
        lead, first = 0.0, 0.0
    if not 0.5 < lead < 3.0:  # nonsense metrics → DejaVu's, which are typical
        lead, first = 1.164, 0.236

    def line_count(fs: float) -> int:
        total = 0
        for para in text.split("\n"):
            lines = 0
            cur = ""
            for word in para.split(" "):
                ww = font.text_length(word, fontsize=fs)
                if ww > width:
                    # No line can hold this word, so insert_textbox splits it
                    # mid-word across as many lines as it takes. Counting it as
                    # one line under-counts the height and loses the text.
                    if cur:
                        lines += 1
                        cur = ""
                    lines += -(-int(ww * 1000) // int(width * 1000))  # ceil
                    continue
                trial = word if not cur else cur + " " + word
                if not cur or font.text_length(trial, fontsize=fs) <= width:
                    cur = trial
                else:
                    lines += 1
                    cur = word
            if cur or lines == 0:
                lines += 1
            total += lines
        return max(1, total)

    fs = float(start)
    while fs >= min_size:
        if fs * (line_count(fs) * lead + first) <= height:
            return fs
        fs -= 0.5
    return min_size


# Keep re-typeset cell text clear of the gridlines by this much (points).
_CELL_PAD = 2.0
# A gap this many font-sizes wide is a tab stop inside a merged cell, not a
# word space — the two sides of it are laid out independently.
_RUN_GAP = 2.0


def _table_cells(page) -> list:
    """Cell rectangles of every table on the page, or [] if it has none.

    MuPDF groups a whole table *row* into a single text block, so translating a
    block as a unit turns the row into one left-aligned paragraph and the
    columns collapse. Knowing the cells lets each one be translated and redrawn
    on its own. No table found → [], and nothing about the page changes.
    """
    fitz = _require_fitz()
    out: list = []
    try:
        tables = page.find_tables()
    except Exception as e:
        logger.debug("find_tables skipped: %s", e)
        return out
    for t in getattr(tables, "tables", []):
        for row in t.rows:
            for c in row.cells:
                if not c:
                    continue  # merged / empty cell
                r = fitz.Rect(c)
                if r.is_valid and not r.is_empty and r.width > 4 and r.height > 4:
                    out.append(r)
    return out


def _cell_of(cells: list, rect) -> int:
    """Index of the cell holding `rect`'s centre, or -1 if it sits outside."""
    p = ((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
    for i, c in enumerate(cells):
        if c.x0 <= p[0] <= c.x1 and c.y0 <= p[1] <= c.y1:
            return i
    return -1


def _cell_layout(text, cell) -> tuple:
    """(rect, align) to re-typeset a translated cell into.

    The aligned edge is pinned exactly where the source glyphs sat, so a
    translation that still fits does not move at all, and the box grows into the
    cell's free space — which is what stops a longer translation from being
    shrunk to 5pt inside a bbox that hugged the original text. Alignment is read
    back from where the text sits in its cell (number columns are right-aligned,
    headers usually centred), because re-typesetting all of them flush left is
    itself a layout change.
    """
    fitz = _require_fitz()
    x0, x1 = cell.x0 + _CELL_PAD, cell.x1 - _CELL_PAD
    if x1 - x0 < 4:  # cell too narrow to lay anything out in
        return fitz.Rect(text), 0
    y0 = text.y0
    y1 = max(text.y1, cell.y1 - _CELL_PAD)  # room to wrap downwards
    left_gap, right_gap = text.x0 - x0, x1 - text.x1
    tol = max(2.0, 0.05 * (x1 - x0))
    if abs(left_gap - right_gap) <= tol:  # centred
        mid = (text.x0 + text.x1) / 2
        half = min(mid - x0, x1 - mid)
        return fitz.Rect(mid - half, y0, mid + half, y1), 1
    if right_gap + tol < left_gap:  # right-aligned
        return fitz.Rect(x0, y0, text.x1, y1), 2
    return fitz.Rect(text.x0, y0, x1, y1), 0  # left-aligned


def _visual_lines(spans: list[dict]) -> list[list[dict]]:
    """Group a cell's spans into the lines they actually form on the page.

    MuPDF's block "lines" are text objects, not rows: in a CAD/Word/invoice
    export each cell — and each label and value inside a merged one — tends to
    be its own "line". The y position is what really says whether two spans sit
    side by side, so group on that.
    """
    out: list[list[dict]] = []
    for sp in sorted(spans, key=lambda s: (s["bbox"][1], s["bbox"][0])):
        near = max(float(sp.get("size", 9.0)), 1.0) * 0.6
        for row in out:
            if abs(row[0]["bbox"][1] - sp["bbox"][1]) <= near:
                row.append(sp)
                break
        else:
            out.append([sp])
    return out


def _split_runs(spans: list[dict]) -> list[list[dict]]:
    """Split one line of a cell into runs separated by a tab-stop-sized gap.

    A merged cell — an invoice's totals row spans the whole table width — holds
    several label/value groups sitting far apart. Joined into one string they
    become a single sentence: the gap collapses and the amount is dragged out of
    its money column. Kept apart, each group is laid out where it started, and a
    pure-number run is left untouched entirely (it translates to itself).
    """
    ordered = sorted(spans, key=lambda s: s["bbox"][0])
    runs = [[ordered[0]]]
    for sp in ordered[1:]:
        prev = runs[-1][-1]
        gap = sp["bbox"][0] - prev["bbox"][2]
        # Relative to the font: a word space is a fraction of it, a tab stop is
        # multiples. Anything in between is left joined.
        if gap > _RUN_GAP * max(float(sp.get("size", 9.0)), 1.0):
            runs.append([sp])
        else:
            runs[-1].append(sp)
    return runs


def _run_boxes(runs: list[list[dict]], cell):
    """A sub-cell per run: the cell split at the midpoint of each gap.

    Each run then lays out in its own share of the merged cell, so a longer
    translation grows into the empty space beside it instead of over its
    neighbour.
    """
    fitz = _require_fitz()
    out = []
    for k, run in enumerate(runs):
        x0 = cell.x0 if k == 0 else (runs[k - 1][-1]["bbox"][2] + run[0]["bbox"][0]) / 2
        x1 = cell.x1 if k == len(runs) - 1 else (run[-1]["bbox"][2] + runs[k + 1][0]["bbox"][0]) / 2
        out.append(fitz.Rect(x0, cell.y0, x1, cell.y1))
    return out


def _block_from_spans(spans: list[dict], box) -> dict | None:
    """One translatable block: the spans' text, tight bbox, and where to redraw."""
    fitz = _require_fitz()
    text = " ".join(sp["text"].strip() for sp in spans if sp["text"].strip()).strip()
    if not text:
        return None
    tight = fitz.Rect(spans[0]["bbox"])
    for sp in spans[1:]:
        tight |= fitz.Rect(sp["bbox"])
    lay, align = _cell_layout(tight, box)
    first = spans[0]
    flags = int(first.get("flags", 0))
    return {
        # bbox stays tight around the glyphs: it is what gets redacted, and a
        # redaction over the whole cell would take the gridlines with it.
        "bbox": [tight.x0, tight.y0, tight.x1, tight.y1],
        "layout": [lay.x0, lay.y0, lay.x1, lay.y1],
        "align": align,
        "text": text,
        "font": str(first.get("font", "")),
        "size": float(first.get("size", 11.0)),
        "color": int(first.get("color", 0)),
        "bold": bool(flags & 16),
        "italic": bool(flags & 2),
    }


def _split_block_by_cells(b: dict, cells: list) -> list[dict]:
    """Split one text block into a block per table cell it covers.

    Returns [] when any span of the block falls outside every cell — the block
    is then not cleanly a table row, and the caller keeps the plain path.
    """
    fitz = _require_fitz()
    groups: dict[int, list[dict]] = {}
    for line in b.get("lines", []):
        for sp in line.get("spans", []):
            if not sp.get("text", "").strip():
                continue
            ci = _cell_of(cells, fitz.Rect(sp["bbox"]))
            if ci < 0:
                return []
            groups.setdefault(ci, []).append(sp)
    if not groups:
        return []

    out: list[dict] = []
    for ci, spans in groups.items():
        cell = cells[ci]
        rows = _visual_lines(spans)
        if len(rows) == 1:
            runs = _split_runs(rows[0])
        else:
            # A wrapped cell: those gaps are line breaks, not tab stops, so the
            # lines belong together as one paragraph.
            runs = [spans]
        for run, box in zip(runs, _run_boxes(runs, cell)):
            blk = _block_from_spans(run, box)
            if blk:
                out.append(blk)
    return out


def _page_text_blocks(page) -> list[dict]:
    """Editable text blocks on a page: joined text + bbox + first-span style.

    Each block also carries `layout` (the rect its translation is typeset into)
    and `align`. Outside a table those are just the bbox and flush left; inside
    one they are the cell's own box and alignment — see `_split_block_by_cells`.
    """
    cells = _table_cells(page)
    out: list[dict] = []
    data = _page_text_dict(page)
    for b in data.get("blocks", []):
        if b.get("type", 0) != 0:  # skip image blocks
            continue
        if cells:
            parts = _split_block_by_cells(b, cells)
            if parts:
                out.extend(parts)
                continue
        first = None
        line_txts: list[str] = []
        for line in b.get("lines", []):
            spans = line.get("spans", [])
            lt = "".join(sp.get("text", "") for sp in spans)
            if lt.strip():
                line_txts.append(lt)
            if first is None:
                for sp in spans:
                    if sp.get("text", "").strip():
                        first = sp
                        break
        text = " ".join(s.strip() for s in line_txts).strip()
        if not text or first is None:
            continue
        flags = int(first.get("flags", 0))
        bbox = [float(v) for v in b["bbox"]]
        out.append({
            "bbox": bbox,
            "layout": bbox,
            "align": 0,
            "text": text,
            "font": str(first.get("font", "")),
            "size": float(first.get("size", 11.0)),
            "color": int(first.get("color", 0)),
            "bold": bool(flags & 16),
            "italic": bool(flags & 2),
        })
    return out
