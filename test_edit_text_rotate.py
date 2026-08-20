"""Tests for the DIRECTION /edit-text redraws a span in (BI-66).

WHY THIS GRID EXISTS. `page.insert_text` — like every PyMuPDF content method —
draws in UNROTATED page space and ignores `/Rotate` completely: measured on
PyMuPDF 1.27.2, the identical call on a page at 0°, 90°, 180° and 270° produces
the identical bbox. `get_text` reports in that same space. So the redraw had no
idea which way the text it was replacing ran, and drew every span left-to-right.

On an ordinary Word/Excel export that is right and nothing was ever wrong. On a
/Rotate 90 drawing sheet — the whole tender/CAD half of this app's real input —
the original glyphs run VERTICALLY in unrotated space so they read upright after
the viewer applies the rotation, and a left-to-right redraw comes out turned 90°.
That is the user-visible bug: "Sửa nội dung" and the replacement text of
"Tìm & Thay thế" auto-rotate on landscape pages.

PAGE ROTATION IS NOT THE ANSWER, and this grid pins that too. A real sheet
carries BOTH orientations at once: the reference file behind this fix
(260521_CLD_NAVY_SGSU, 30 pages, every page /Rotate 90) has 5799 spans reading
upright — dir (0,-1) — and 902 vertical labels — dir (-1,0). One page angle
cannot describe both, so the redraw follows the SPAN's own direction.

Every case here has a GUARD twin that re-creates the old behaviour by sending
`dir=None` and demands the result be wrong — otherwise a green grid would not
prove the compensation is doing anything.

Run:  .venv\\Scripts\\python test_edit_text_rotate.py
"""

import asyncio
import base64
import sys

import fitz  # PyMuPDF

from api import (
    EditTextRequest,
    TextEdit,
    TextSpansRequest,
    _text_find_core,
    _text_frame,
    edit_text,
    text_spans,
)
from src.pdf.fonts import _vietnamese_font

# The default Windows console codec is cp1252 and this file compares Vietnamese
# strings: a FAILING case would otherwise die inside `print` instead of reporting
# itself, which is the one moment a test has a job to do.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PASS = 0
FAIL = 0


def check(name, actual, expected):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}\n  expected {expected!r}\n  actual   {actual!r}")


def want(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}" + (f"\n  {detail}" if detail else ""))


def _font() -> str:
    p = _vietnamese_font()
    assert p, "no DejaVu found — the redraw font must exist for these measurements"
    return p


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

TEXT = "Ban ve so 12"
SIZE = 11.0
AT = (300.0, 400.0)


def make_pdf(page_rot: int, text_rot=0, text=TEXT, size=SIZE, morph_deg=None) -> bytes:
    """A page holding ONE run, drawn at `text_rot` (or an arbitrary `morph_deg`),
    on a sheet whose /Rotate is `page_rot`.

    The run is drawn in the SAME face the redraw will use (bundled DejaVu), so the
    hscale/vscale corrections sit in their dead band and cannot be confused with a
    direction error.
    """
    doc = fitz.open()
    try:
        page = doc.new_page(width=842, height=595)
        page.insert_font(fontname="F0", fontfile=_font())
        kw = {}
        if morph_deg is not None:
            kw["morph"] = (fitz.Point(*AT), fitz.Matrix(morph_deg))
        else:
            kw["rotate"] = text_rot
        page.insert_text(AT, text, fontname="F0", fontsize=size, **kw)
        page.set_rotation(page_rot)  # /Rotate does not touch the content stream
        return doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()


def spans_of(pdf: bytes, page=0):
    res = asyncio.run(
        text_spans(TextSpansRequest(pdf_b64=base64.b64encode(pdf).decode(), page=page))
    )
    assert res.success, res.error
    return res.spans


def read_runs(pdf: bytes, page=0):
    """[(text, dir, bbox, origin)] for every span on the page, from the OUTPUT."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        out = []
        for b in doc[page].get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                for sp in line["spans"]:
                    out.append(
                        (
                            sp["text"],
                            tuple(round(v, 3) for v in line["dir"]),
                            tuple(round(v, 2) for v in sp["bbox"]),
                            tuple(round(v, 2) for v in sp["origin"]),
                        )
                    )
        return out
    finally:
        doc.close()


def apply_edit(pdf: bytes, sp, new_text, *, dir_override="span", **over) -> bytes:
    """Send exactly what the renderer sends for one span. `dir_override=None`
    re-creates the pre-BI-66 request (no direction) — that is the guard."""
    edit = dict(
        page=0,
        bbox=list(sp.bbox),
        origin=list(sp.origin),
        new_text=new_text,
        size=sp.size,
        color="#000000",
        bg=None,
        bold=False,
        italic=False,
        underline=False,
        font="default",
        orig_text=sp.text,
        orig_size=sp.size,
        dir=list(sp.dir) if dir_override == "span" else dir_override,
    )
    edit.update(over)
    res = asyncio.run(
        edit_text(
            EditTextRequest(
                pdf_b64=base64.b64encode(pdf).decode(), edits=[TextEdit(**edit)]
            )
        )
    )
    assert res.success, res.error
    return base64.b64decode(res.data_b64)


def extent(bbox, along):
    """(along-text, across-text) extents of an axis-aligned bbox for a quadrant."""
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    return (w, h) if along % 2 == 0 else (h, w)


# ---------------------------------------------------------------------------
# 1 · the pure helper
# ---------------------------------------------------------------------------

check("H1 no direction -> left-to-right (the pre-BI-66 frame)", _text_frame(None)[:1], (0.0,))
check("H1b ...and it is flagged axis-aligned", _text_frame(None)[3], 0)
check("H2 dir (0,-1) -> 90 deg", _text_frame([0.0, -1.0])[0], 90.0)
check("H3 dir (-1,0) -> 180 deg", _text_frame([-1.0, 0.0])[0], 180.0)
check("H4 dir (0,1) -> 270 deg", _text_frame([0.0, 1.0])[0], 270.0)
# The reference file really contains these: text drawn a hundredth of a degree off
# axis. Snapping keeps u/n free of float dust AND keeps quadrant 0 byte-identical.
check("H5 a hair off axis snaps to the right angle", _text_frame([0.002, -1.0])[0], 90.0)
check("H5b ...and its unit vectors are exact", _text_frame([0.002, -1.0])[1:3], ((0.0, -1.0), (1.0, 0.0)))
# A CAD leader label at 49° is NOT a right angle and must not pretend to be: the
# axis-aligned bbox cannot be split, so `quadrant` is None and no ratio is built.
check("H6 an off-axis run reports no quadrant", _text_frame([0.656, 0.755])[3], None)
th, u, n, q = _text_frame([0.656, 0.755])
want("H6b ...and its baseline vector IS the direction it was given",
     abs(u[0] - 0.656) < 1e-3 and abs(u[1] - 0.755) < 1e-3, f"u={u}")
want("H6c ...with a perpendicular normal", abs(u[0] * n[0] + u[1] * n[1]) < 1e-9, f"u.n={u[0]*n[0]+u[1]*n[1]}")
# Garbage in must not throw and must not rotate anything.
for bad in ([], [float("nan"), 1.0], [0.0, 0.0], "nonsense", [None, None]):
    check(f"H7 garbage direction {bad!r} -> no rotation", _text_frame(bad)[0], 0.0)


# ---------------------------------------------------------------------------
# 2 · the dead band: an ordinary document must not change at all
# ---------------------------------------------------------------------------

flat = make_pdf(0, 0)
sp = spans_of(flat)[0]
check("D1 an unrotated run reports the horizontal direction", tuple(sp.dir), (1.0, 0.0))
out_dir = apply_edit(flat, sp, "Ban ve so 34")
out_none = apply_edit(flat, sp, "Ban ve so 34", dir_override=None)
check("D2 ...and its redraw still runs left-to-right", read_runs(out_dir)[0][1], (1.0, 0.0))
# THE dead-band proof: with and without the new field the page must come out the
# same. Compared as rendered pixels, because that is what the user sees.
px_dir = fitz.open(stream=out_dir, filetype="pdf")[0].get_pixmap(dpi=110).tobytes("png")
px_none = fitz.open(stream=out_none, filetype="pdf")[0].get_pixmap(dpi=110).tobytes("png")
check("D3 sending the direction changes NOTHING on an unrotated run", px_dir == px_none, True)


# ---------------------------------------------------------------------------
# 3 · the reported bug: upright text on a /Rotate 90 sheet
# ---------------------------------------------------------------------------

rot90 = make_pdf(90, 90)  # reads upright on screen; runs (0,-1) in page space
sp = spans_of(rot90)[0]
check("R1 an upright run on a rotated sheet reports dir (0,-1)", tuple(sp.dir), (0.0, -1.0))
fixed = apply_edit(rot90, sp, "Ban ve so 34")
check("R2 the redraw keeps that direction", read_runs(fixed)[0][1], (0.0, -1.0))
check("R2b ...and the old glyphs are gone", "so 12" in read_runs(fixed)[0][0], False)
# GUARD — this is the bug, re-created. Without it a green R2 could just mean
# "insert_text happened to be right", which is exactly what it was not.
broken = apply_edit(rot90, sp, "Ban ve so 34", dir_override=None)
check("R3 GUARD: no direction -> the old 90 deg-off redraw", read_runs(broken)[0][1], (1.0, 0.0))


# ---------------------------------------------------------------------------
# 4 · the case that rules out "just use page.rotation"
# ---------------------------------------------------------------------------

# 902 spans of the reference file look like this: a vertical label on a sheet that
# is ALREADY rotated. Its direction is (-1,0), not the sheet's (0,-1).
label = make_pdf(90, 180)
sp = spans_of(label)[0]
check("P1 a vertical label on a rotated sheet reports dir (-1,0)", tuple(sp.dir), (-1.0, 0.0))
out = apply_edit(label, sp, "Ban ve so 34")
check("P2 the redraw keeps THAT direction", read_runs(out)[0][1], (-1.0, 0.0))
# GUARD — a page-rotation-derived fix would have written it at the sheet's angle.
check("P3 GUARD: it is NOT drawn at the sheet's angle", read_runs(out)[0][1] == (0.0, -1.0), False)


# ---------------------------------------------------------------------------
# 5 · all four right angles, on rotated and unrotated sheets alike
# ---------------------------------------------------------------------------

WANT = {0: (1.0, 0.0), 90: (0.0, -1.0), 180: (-1.0, 0.0), 270: (0.0, 1.0)}
for page_rot in (0, 90, 180, 270):
    for text_rot in (0, 90, 180, 270):
        pdf = make_pdf(page_rot, text_rot)
        sp = spans_of(pdf)[0]
        check(f"Q1 /Rotate {page_rot}, run {text_rot} deg is reported as such",
              tuple(sp.dir), WANT[text_rot])
        out = apply_edit(pdf, sp, "Ban ve so 34")
        run = read_runs(out)[0]
        check(f"Q2 /Rotate {page_rot}, run {text_rot} deg survives the redraw",
              run[1], WANT[text_rot])
        # The baseline must not move either: the new run has to start where the old
        # one started, or a corrected direction just moves the error somewhere else.
        want(f"Q3 /Rotate {page_rot}, run {text_rot} deg keeps its baseline origin",
             abs(run[3][0] - sp.origin[0]) < 0.6 and abs(run[3][1] - sp.origin[1]) < 0.6,
             f"origin {run[3]} vs {tuple(round(v, 2) for v in sp.origin)}")
        # …and /Rotate itself must be untouched (a "page turned itself" report has
        # two possible causes; this is the second one — see BI-65).
        d = fitz.open(stream=out, filetype="pdf")
        check(f"Q4 /Rotate {page_rot} is unchanged by an edit", d[0].rotation, page_rot)
        d.close()


# ---------------------------------------------------------------------------
# 6 · the geometry corrections must divide by the ALONG-text extent
# ---------------------------------------------------------------------------
#
# hscale = (span width) / (measured width of the old string). On a rotated span the
# span's WIDTH is the line height, so the old arithmetic divided a ~6 pt number by a
# ~20 pt one. Usually that lands outside the credibility band and is discarded — but
# on a SHORT run it lands inside it, and then the redraw is squeezed to a fraction of
# its length with nothing said. The guard below proves this case is one of those.

short = make_pdf(90, 90, text="12")
sp = spans_of(short)[0]
along0, across0 = extent(sp.bbox, 1)
fobj = fitz.Font(fontfile=_font())
natural = fobj.text_length("12", fontsize=sp.size)
wrong_r = across0 / natural
want("G1 GUARD: the wrong axis lands INSIDE the dead band on a short run",
     0.5 <= wrong_r <= 2.0 and abs(wrong_r - 1.0) > 0.02,
     f"wrong hscale would be {wrong_r:.3f} (band 0.5–2.0, needs >2% off 1.0)")
out = apply_edit(short, sp, "12")  # same text back: nothing may change size
run = read_runs(out)[0]
along1, across1 = extent(run[2], 1)
want("G2 an unchanged short run keeps its length", abs(along1 / along0 - 1.0) < 0.05,
     f"along {along1:.2f} vs {along0:.2f} (ratio {along1/along0:.3f})")
want("G3 ...and its line height", abs(across1 / across0 - 1.0) < 0.05,
     f"across {across1:.2f} vs {across0:.2f} (ratio {across1/across0:.3f})")


# ---------------------------------------------------------------------------
# 7 · the underline turns with the glyphs
# ---------------------------------------------------------------------------

rot90 = make_pdf(90, 90)
sp = spans_of(rot90)[0]


def rule_of(pdf: bytes):
    """The straight stroke /edit-text drew for `underline`, as (p0, p1)."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        for d in doc[0].get_drawings():
            for item in d["items"]:
                if item[0] == "l":
                    return (item[1], item[2])
        return None
    finally:
        doc.close()


seg = rule_of(apply_edit(rot90, sp, "Ban ve so 34", underline=True))
want("U1 an underline is drawn at all", seg is not None)
if seg:
    dx, dy = seg[1].x - seg[0].x, seg[1].y - seg[0].y
    want("U2 it runs ALONG the text, not across it", abs(dx) < 0.6 and abs(dy) > 5,
         f"segment delta ({dx:.2f}, {dy:.2f}) — expected roughly (0, -length)")
    want("U3 it sits on the descender side of the baseline", seg[0].x > sp.origin[0],
         f"rule x {seg[0].x:.2f} vs baseline x {sp.origin[0]:.2f}")
seg_old = rule_of(apply_edit(rot90, sp, "Ban ve so 34", underline=True, dir_override=None))
if seg_old:
    want("U4 GUARD: no direction -> the old horizontal rule",
         abs(seg_old[1].y - seg_old[0].y) < 0.6 and abs(seg_old[1].x - seg_old[0].x) > 5,
         f"segment delta ({seg_old[1].x - seg_old[0].x:.2f}, {seg_old[1].y - seg_old[0].y:.2f})")


# ---------------------------------------------------------------------------
# 8 · text that is not at a right angle at all
# ---------------------------------------------------------------------------
#
# A dimension/leader label on a CAD sheet is drawn at whatever angle its leader
# runs at — the reference file has runs at 15°, 22.7°, 30°, 49°. `insert_text`'s
# own `rotate` takes multiples of 90 only; the morph matrix does not, so these are
# reproduced exactly rather than snapped to the nearest quarter turn.

diag = make_pdf(90, morph_deg=30)
sp = spans_of(diag)[0]
want("A1 an off-axis run is reported at its real angle",
     abs(sp.dir[0] - 0.866) < 0.01 and abs(sp.dir[1] + 0.5) < 0.01, f"dir {sp.dir}")
run = read_runs(apply_edit(diag, sp, "Ban ve so 34"))[0]
want("A2 ...and the redraw reproduces it, not the nearest right angle",
     abs(run[1][0] - 0.866) < 0.01 and abs(run[1][1] + 0.5) < 0.01, f"dir {run[1]}")
check("A3 GUARD: no direction -> flat", read_runs(
    apply_edit(diag, sp, "Ban ve so 34", dir_override=None))[0][1], (1.0, 0.0))


# ---------------------------------------------------------------------------
# 9 · Tìm & Thay thế inherits it (there is no second write path)
# ---------------------------------------------------------------------------
#
# find-replace.js builds the /edit-text payload field for field from a /text-find
# hit. This walks that exact route, so the two features cannot drift apart.

doc = fitz.open()
page = doc.new_page(width=842, height=595)
page.insert_font(fontname="F0", fontfile=_font())
page.insert_text((300, 400), "Hop dong so 12", fontname="F0", fontsize=11, rotate=90)
page.insert_text((360, 400), "Phu luc so 7", fontname="F0", fontsize=11, rotate=180)
page.set_rotation(90)
sheet = doc.tobytes(deflate=True, garbage=3)
doc.close()

res = _text_find_core(sheet, "so", match_case=False, whole_word=True, max_hits=100)
want("F1 both runs on the rotated sheet are found", len([h for h in res.hits if h.replaceable]) == 2,
     f"{[(h.span_text, h.dir) for h in res.hits]}")
by_text = {h.span_text: h for h in res.hits if h.replaceable}
check("F2 the upright run's hit carries dir (0,-1)", tuple(by_text["Hop dong so 12"].dir), (0.0, -1.0))
check("F3 the vertical run's hit carries dir (-1,0)", tuple(by_text["Phu luc so 7"].dir), (-1.0, 0.0))
# /text-spans must agree with /text-find about the same runs, or "Sửa nội dung" and
# "Thay thế" would write the same span two different ways.
by_span = {s.text: tuple(s.dir) for s in spans_of(sheet)}
check("F4 /text-spans and /text-find agree on direction",
      {t: tuple(h.dir) for t, h in by_text.items()},
      {t: by_span[t] for t in by_text})

edits = [
    TextEdit(
        page=h.page,
        bbox=list(h.bbox),
        origin=list(h.origin),
        new_text=h.span_text.replace("so", "SO"),
        size=h.size,
        color="#000000",
        bg=None,
        bold=False,
        italic=False,
        underline=False,
        font="default",
        orig_text=h.span_text,
        orig_size=h.size,
        dir=list(h.dir),
    )
    for h in by_text.values()
]
res2 = asyncio.run(
    edit_text(EditTextRequest(pdf_b64=base64.b64encode(sheet).decode(), edits=edits))
)
want("F5 the replacement is written", res2.success, res2.error)
after = {t: d for t, d, _b, _o in read_runs(base64.b64decode(res2.data_b64))}
want("F6 the upright replacement stays upright", after.get("Hop dong SO 12") == (0.0, -1.0),
     f"{after}")
want("F7 the vertical replacement stays vertical", after.get("Phu luc SO 7") == (-1.0, 0.0),
     f"{after}")
want("F8 ...and neither original survives",
     "Hop dong so 12" not in after and "Phu luc so 7" not in after, f"{after}")


print(f"\nedit-text rotation: {PASS} pass, {FAIL} fail")
raise SystemExit(1 if FAIL else 0)
