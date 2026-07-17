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
    data = page.get_text("dict")
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
