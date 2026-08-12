"""Tests for the read half of Find & Replace (/text-find, /text-find-bin).

WHY THIS EXISTS. Every way this endpoint can be wrong is quiet. It cannot crash the
app and it cannot produce a visibly broken PDF on its own — it hands the renderer a
list of offsets, and the renderer faithfully writes to whatever those offsets point
at. So a boundary computed against the wrong string does not raise; it replaces four
characters in the middle of a different word, in a contract, and nobody finds out.

The two bugs that motivated the file, both found by measuring a real document:

  * A match was declared a "whole word" if it started at the beginning of its SPAN.
    A line drawn as ["AB", "2026"] therefore reported `2026` as a whole word AND as
    replaceable, and replacing it corrupted `AB2026`.
  * Whitespace-only spans were dropped before the line was joined. PyMuPDF makes one
    of those whenever a line is drawn in pieces with a cursor jump — very common in
    exported/justified text — so "Hợp đồng" simply could not be found.

Half the cases run against a hand-built index (no PDF at all): that is the layer the
arithmetic lives in, and building it by hand is the only way to state a case like
"two spans, identical style, 0.0001pt apart" exactly. The rest go through real PDFs
so the index builder itself is covered.

Run:  .venv\\Scripts\\python test_text_find.py       (or via run_tests.py)
"""

import asyncio
import base64

import fitz  # PyMuPDF

from api import (
    TextFindRequest,
    _find_build_index,
    _find_index_for,
    _find_scan_index,
    _FIND_CACHE,
    text_find,
    text_find_bin,
)

PASS = 0
FAIL = 0


def check(name, actual, expected):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}\n  expected {expected!r}\n  actual   {actual!r}")


# ---------------------------------------------------------------------------
# Hand-built index — one line is (joined, offsets, parts, span_base)
# ---------------------------------------------------------------------------


def part(text, *, host=None, size=11.0, font="Times", color=0, flags=0, x=0.0):
    """One flattened span. `host=False` marks the whitespace spans PyMuPDF
    synthesises for a cursor jump: their text counts, but they never take a write."""
    if host is None:
        host = bool(text.strip())
    bbox = (x, 100.0, x + max(1.0, 5.0 * len(text)), 112.0)
    return (text, host, bbox, bbox, (bbox[0], bbox[3]), size, font, color, flags)


def page(*lines):
    """A page from lists of parts, numbering spans across the page like the builder."""
    out = []
    span_base = 0
    for parts in lines:
        offsets, acc = [], 0
        for p in parts:
            offsets.append(acc)
            acc += len(p[0])
        out.append(("".join(p[0] for p in parts), offsets, parts, span_base))
        span_base += len(parts)
    return out


def scan(pages, query, *, match_case=False, whole_word=False, max_hits=5000):
    return _find_scan_index(pages, query, match_case, whole_word, max_hits)


# T1 — the dropped-whitespace bug. PyMuPDF turns a cursor jump into a real span
# holding " "; dropping it joined the line to "Hopdong so 5".
hits, crossing, trunc = scan([page([part("Hop"), part(" "), part("dong so 5")])], "Hop dong")
check("T1 a match across a synthesised gap is found", len(hits), 1)
check("T1 …and is not offered for replacement", hits[0].replaceable if hits else None, False)

# T1b — the same line, a query that fits inside one real span, stays replaceable.
hits, _, _ = scan([page([part("Hop"), part(" "), part("dong so 5")])], "dong")
check("T1b an in-span match is still replaceable", [h.replaceable for h in hits], [True])
check("T1b …with offsets into that span alone", [(h.start, h.end, h.span_text) for h in hits], [(0, 4, "dong so 5")])

# T2 — "202" + "6" with a 0.0001pt size difference. Measured: PyMuPDF merges spans of
# identical style, so a split like this always means the style really did change, even
# when nothing looks different. Counted and shown, never half-rewritten.
hits, crossing, _ = scan([page([part("Ngay 202", size=11.0), part("6", size=11.0001)])], "2026")
check("T2 a near-identical style split is found", len(hits), 1)
check("T2 …and counted as crossing", crossing, 1)
check("T2 …and locked", hits[0].replaceable if hits else None, False)

# T3 — a real style change mid-word ("Bên **A**").
hits, crossing, _ = scan([page([part("Bên "), part("A", flags=16)])], "Bên A")
check("T3 a bold-split match is found but locked", [h.replaceable for h in hits], [False])

# T4 — two table columns. Measured: PyMuPDF puts them on separate LINES, and lines are
# matched independently, so the digits must not join across the gap.
hits, _, _ = scan([page([part("12")], [part("34")])], "1234")
check("T4 text on two lines does not join", len(hits), 0)

# T5 — THE corruption bug. `2026` starts its span but not its word.
hits, _, _ = scan([page([part("AB"), part("2026")])], "2026", whole_word=True)
check("T5 whole-word is judged on the line, not the span", len(hits), 0)
hits, _, _ = scan([page([part("AB"), part("2026")])], "2026", whole_word=False)
check("T5b without whole-word it is found", [(len(hits), hits[0].replaceable)], [(1, True)])

# T5c — the boundary still works the normal way inside a joined line.
hits, _, _ = scan([page([part("Hợp đồng "), part("số 5")])], "đồng", whole_word=True)
check("T5c a real whole word on a split line is found", [h.replaceable for h in hits], [True])

# T6 — several matches in ONE span all report that span, so the renderer can group
# them into a single /edit-text call (two calls would undo each other).
hits, _, _ = scan([page([part("2026 va 2026 va 2026")])], "2026")
check("T6 three matches in one span", len(hits), 3)
check("T6 …all naming the same span", len({h.span for h in hits}), 1)
check("T6 …at the right offsets", [(h.start, h.end) for h in hits], [(0, 4), (8, 12), (16, 20)])

# T7 — match_case.
hits, _, _ = scan([page([part("Hop DONG hop dong")])], "hop", match_case=True)
check("T7 match_case is honoured", len(hits), 1)
hits, _, _ = scan([page([part("Hop DONG hop dong")])], "hop", match_case=False)
check("T7b folded case finds both", len(hits), 2)

# T8 — the safety valve reports WHERE it gave up, so the count is not read as the truth.
pages = [page([part("2026 2026 2026")]), page([part("2026 2026")])]
hits, _, trunc = scan(pages, "2026", max_hits=2)
check("T8 max_hits stops the scan", len(hits), 2)
check("T8 …and says which page it stopped on", trunc, 1)
hits, _, trunc = scan(pages, "2026", max_hits=99)
check("T8b under the ceiling nothing is truncated", (len(hits), trunc), (5, 0))

# T9 — a match landing only in a whitespace span is never replaceable, so a write can
# never be aimed at a span PyMuPDF invented.
hits, _, _ = scan([page([part("a"), part("   "), part("b")])], " ")
check("T9 a whitespace query still matches", len(hits), 3)
check("T9b …but never hosts a write", any(h.replaceable for h in hits), False)


# ---------------------------------------------------------------------------
# Real PDFs — covers the index builder, both endpoints, and the cache
# ---------------------------------------------------------------------------


def gap_pdf() -> bytes:
    """"Hop dong so 5" drawn in two pieces with a cursor jump — the exact shape that
    makes PyMuPDF synthesise a whitespace span. This is the user's bug, on paper."""
    doc = fitz.open()
    p = doc.new_page(width=400, height=200)
    p.insert_text((40, 60), "Hop", fontsize=11)
    p.insert_text((40 + fitz.get_text_length("Hop", fontsize=11) + 6, 60), "dong so 5", fontsize=11)
    out = doc.tobytes()
    doc.close()
    return out


def plain_pdf() -> bytes:
    doc = fitz.open()
    p = doc.new_page(width=400, height=200)
    p.insert_text((40, 60), "Hop dong nam 2026", fontsize=11)
    doc.new_page(width=400, height=200).insert_text((40, 60), "2026 o trang hai", fontsize=11)
    out = doc.tobytes()
    doc.close()
    return out


def blank_pdf() -> bytes:
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    out = doc.tobytes()
    doc.close()
    return out


def find(pdf: bytes, query: str, **kw):
    req = TextFindRequest(pdf_b64=base64.b64encode(pdf).decode("ascii"), query=query, **kw)
    return asyncio.run(text_find(req))


class FakeRequest:
    """Enough of starlette's Request for text_find_bin: it only awaits .body()."""

    def __init__(self, body: bytes):
        self._body = body

    async def body(self) -> bytes:
        return self._body


# The whitespace-gap document, end to end. Before the fix this returned zero hits
# while the page plainly reads "Hop dong so 5".
gap = gap_pdf()
res = find(gap, "Hop dong")
check("R1 the gap document reports success", res.success, True)
check("R1 …and finds the phrase", len(res.hits), 1)
check("R1 …as a locked, crossing match", (res.hits[0].replaceable, res.crossing), (False, 1))

# Sanity: the same document, a query inside one span, is replaceable.
res = find(gap, "dong so")
check("R2 an in-span phrase stays replaceable", [h.replaceable for h in res.hits], [True])

# A plain document: two pages, reading order, and the offsets a replacement rides on.
plain = plain_pdf()
res = find(plain, "2026")
check("R3 both pages are searched", [h.page for h in res.hits], [0, 1])
check("R3 …pages_scanned is the document length", res.pages_scanned, 2)
check("R3 …every hit is replaceable", all(h.replaceable for h in res.hits), True)
first = res.hits[0]
check("R3 …offsets point at the query", first.span_text[first.start : first.end], "2026")

# has_text drives the "this is a scan, go and OCR it" branch in the UI.
check("R4 a page with no text reports has_text False", find(blank_pdf(), "x").has_text, False)
check("R4b a page with text reports has_text True", find(plain, "zzzz").has_text, True)

# Whole-word, through the endpoint, on real spans.
check("R5 whole-word finds a standalone number", len(find(plain, "2026", whole_word=True).hits), 2)
check("R5b whole-word rejects a substring", len(find(plain, "202", whole_word=True).hits), 0)

# 3b — the index is cached by content hash. Same bytes reuse it; different bytes must
# NOT, or every offset would be measured against the wrong document.
_FIND_CACHE["entry"] = None
check("R6 a cold search parses", find(plain, "2026").cached, False)
check("R6b the same document reuses the index", find(plain, "nam").cached, True)
check("R6c a different document does not", find(gap, "Hop").cached, False)
check("R6d …and the first one is re-parsed after eviction", find(plain, "2026").cached, False)

# The key is the CONTENT, so a document that differs only deep inside the page text
# must miss — serving the old index for it would measure every offset against the
# wrong characters, which is how a replacement lands on innocent text (BI-50).
doc = fitz.open()
doc.new_page(width=400, height=200).insert_text((40, 60), "Hop dong nam 2027", fontsize=11)
doc.new_page(width=400, height=200).insert_text((40, 60), "2026 o trang hai", fontsize=11)
variant = doc.tobytes()
doc.close()
_FIND_CACHE["entry"] = None
find(plain, "2026")
check("R7 a document differing only in page text misses the cache", _find_index_for(variant)[1], False)
check("R7b …and the two disagree, as they should", len(find(variant, "2026").hits), 1)

# 3a — the binary route must agree with the JSON route, hit for hit.
res_bin = asyncio.run(text_find_bin(FakeRequest(plain), query="2026"))
res_json = find(plain, "2026")
check("R8 /text-find-bin matches /text-find",
      [(h.page, h.start, h.end, h.span_text) for h in res_bin.hits],
      [(h.page, h.start, h.end, h.span_text) for h in res_json.hits])
check("R8b …and reports the same page count", res_bin.pages_scanned, res_json.pages_scanned)

# An empty body is a client bug, not an empty document.
try:
    asyncio.run(text_find_bin(FakeRequest(b""), query="x"))
    check("R9 an empty body is rejected", "no error", "HTTPException")
except Exception as e:
    check("R9 an empty body is rejected", type(e).__name__, "HTTPException")

# A rotated page: the highlight box must land where the text is DISPLAYED.
doc = fitz.open()
pg = doc.new_page(width=400, height=200)
pg.insert_text((40, 60), "2026", fontsize=11)
pg.set_rotation(90)
rot = doc.tobytes()
doc.close()
res = find(rot, "2026")
check("R10 a rotated page still finds its text", len(res.hits), 1)
if res.hits:
    h = res.hits[0]
    check("R10b …and reports a separate displayed box", h.bbox != h.bbox_view, True)

# R10c — the SAME contract has to hold for a crossing hit, and it did not: the union
# was built from the already-rotated parts and copied into both fields, so `bbox` —
# documented as "UNROTATED span box; this is what /edit-text redraws into" — carried
# displayed coordinates. Harmless only while these hits stay replaceable=False; the
# day anyone lifts that, /edit-text redacts the wrong rectangle on rotated pages and
# says nothing. Pin both boxes to the two spaces they belong to.
doc = fitz.open()
pg = doc.new_page(width=400, height=200)
pg.insert_text((40, 60), "Hop", fontsize=11)
pg.insert_text((40 + fitz.get_text_length("Hop", fontsize=11) + 6, 60), "dong so 5", fontsize=11)
pg.set_rotation(90)
rot_gap = doc.tobytes()
doc.close()

res = find(rot_gap, "Hop dong")
check("R10c a crossing match is found on a rotated page", len(res.hits), 1)
if res.hits:
    h = res.hits[0]
    check("R10c …and is still locked", h.replaceable, False)
    # The two boxes must NOT be the same rectangle: one is page space, one is screen.
    check("R10c …bbox and bbox_view are different rectangles", h.bbox != h.bbox_view, True)
    # And `bbox` must be the union of the UNROTATED span boxes — the rectangle
    # /edit-text would redact. Recover them from the index and compare.
    d = fitz.open(stream=rot_gap, filetype="pdf")
    idx, _n = _find_build_index(d)
    d.close()
    parts = idx[0][0][2]  # page 0, first line, its spans
    ux0 = min(p[2][0] for p in parts)
    uy0 = min(p[2][1] for p in parts)
    ux1 = max(p[2][2] for p in parts)
    uy1 = max(p[2][3] for p in parts)
    check(
        "R10c …bbox is the union of the UNROTATED span boxes",
        [round(v, 3) for v in h.bbox],
        [round(v, 3) for v in (ux0, uy0, ux1, uy1)],
    )
    vx0 = min(p[3][0] for p in parts)
    vy0 = min(p[3][1] for p in parts)
    vx1 = max(p[3][2] for p in parts)
    vy1 = max(p[3][3] for p in parts)
    check(
        "R10c …bbox_view is the union of the DISPLAYED span boxes",
        [round(v, 3) for v in h.bbox_view],
        [round(v, 3) for v in (vx0, vy0, vx1, vy1)],
    )

# R10d — on an UNROTATED page rotation_matrix is the identity, so the two unions must
# come out identical. This is what makes the fix above a no-op for ordinary documents.
res = find(gap, "Hop dong")
if res.hits:
    check("R10d unrotated: the two boxes still agree", res.hits[0].bbox, res.hits[0].bbox_view)

# The index builder must survive a page it can say nothing about.
d = fitz.open(stream=blank_pdf(), filetype="pdf")
pages_idx, total = _find_build_index(d)
d.close()
check("R11 an empty page yields an empty index", (len(pages_idx), total), (1, 0))


print(f"\ntext-find: {PASS} pass, {FAIL} fail")
raise SystemExit(1 if FAIL else 0)
