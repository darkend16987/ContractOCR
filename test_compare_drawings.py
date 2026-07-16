"""Tests for the visual drawing compare (src/compare/drawing.py).

Synthetic drawing PDFs are built with PyMuPDF so the expected outcome is known
exactly: which pages should pair up, which page is new, and roughly where the
changed regions must land. No fixtures, no golden files.
"""

import fitz  # PyMuPDF

from src.compare.drawing import annotate_pdf, compare_drawings

W, H = 842, 595  # A4 landscape, points


def _sheet(doc, sheet_no: str):
    """New page with a title block — the constant part of every sheet."""
    page = doc.new_page(width=W, height=H)
    page.draw_rect(fitz.Rect(20, 20, W - 20, H - 20), color=(0, 0, 0), width=1)
    page.draw_rect(fitz.Rect(W - 220, H - 80, W - 20, H - 20), color=(0, 0, 0), width=1)
    page.insert_text((W - 200, H - 40), sheet_no, fontsize=12)
    return page


def _base_plan(page):
    """The 'floor plan' shared by both versions of sheet A-102."""
    page.draw_line(fitz.Point(100, 100), fitz.Point(700, 100), width=2)
    page.draw_line(fitz.Point(100, 100), fitz.Point(100, 450), width=2)
    page.draw_rect(fitz.Rect(150, 150, 350, 300), width=1.5)


def _make_docs():
    """A = 2 sheets. B = same 2 sheets with changes on A-102, plus a brand-new
    sheet inserted between them. Expected alignment: (0,0) identical,
    (1,2) changed; B page 1 is new."""
    a = fitz.open()
    p = _sheet(a, "A-101")
    p.draw_circle(fitz.Point(400, 250), 60, width=2)
    p = _sheet(a, "A-102")
    _base_plan(p)
    p.draw_line(fitz.Point(500, 200), fitz.Point(650, 200), width=2)  # removed in B

    b = fitz.open()
    p = _sheet(b, "A-101")  # identical to A page 0
    p.draw_circle(fitz.Point(400, 250), 60, width=2)
    p = _sheet(b, "A-101b")  # brand-new sheet, visually distinct
    for y in range(120, 480, 30):
        p.draw_line(fitz.Point(80, y), fitz.Point(760, y), width=1)
    p.insert_text((100, 100), "NEW DETAIL SHEET", fontsize=20)
    p = _sheet(b, "A-102")  # changed: line removed, circle added
    _base_plan(p)
    p.draw_circle(fitz.Point(550, 380), 45, width=2)  # added in B

    return a.tobytes(), b.tobytes()


def _overlaps(box, x0, y0, x1, y1):
    bx0, by0, bx1, by1 = box[:4]
    return bx0 < x1 and bx1 > x0 and by0 < y1 and by1 > y0


def test_alignment_and_regions():
    pdf_a, pdf_b = _make_docs()
    rep = compare_drawings(pdf_a, pdf_b)
    assert rep["success"]
    s = rep["summary"]

    # Page alignment: inserted sheet detected, others paired in order.
    assert s["pages_only_b"] == [1]
    assert s["pages_only_a"] == []
    pairs = {(p["a"], p["b"]) for p in s["page_pairs"]}
    assert pairs == {(0, 0), (1, 2)}

    # Identical pair produced no regions; changed pair did.
    by_pair = {(p["a"], p["b"]): p["regions"] for p in s["page_pairs"]}
    assert by_pair[(0, 0)] == 0
    assert by_pair[(1, 2)] >= 1

    # The new sheet gets one full-page "ins" box on B.
    assert "1" in rep["b_boxes"]
    full = rep["b_boxes"]["1"][0]
    assert full[4] == "ins" and full[2] > W - 5 and full[3] > H - 5

    # Removed line (A p1 at y=200, x=500..650) → "del"/"rep" box on A page 1.
    a1 = rep["a_boxes"].get("1", [])
    assert any(_overlaps(b, 490, 190, 660, 210) and b[4] in ("del", "rep") for b in a1)

    # Added circle (B p2 around 550,380 r=45) → "ins"/"rep" box on B page 2.
    b2 = [b for b in rep["b_boxes"].get("2", [])]
    assert any(_overlaps(b, 500, 330, 600, 430) and b[4] in ("ins", "rep") for b in b2)

    # Unchanged title block must NOT be flagged on the changed pair.
    assert not any(_overlaps(b, W - 220, H - 80, W - 20, H - 20) for b in b2)

    assert not s["identical"]
    assert len(rep["changes"]) == s["changes"] and s["changes"] >= 3


def test_identical_docs():
    pdf_a, _ = _make_docs()
    rep = compare_drawings(pdf_a, pdf_a)
    assert rep["success"]
    assert rep["summary"]["identical"]
    assert rep["a_boxes"] == {} and rep["b_boxes"] == {}


def test_shifted_content_not_flagged():
    """Same drawing printed with a small offset must diff clean (registration)."""
    a = fitz.open()
    p = _sheet(a, "A-201")
    _base_plan(p)
    # B = exactly the same content, everything drawn 4pt down-right — like a
    # different print margin. Built by hand (NOT via _sheet, which would stamp
    # a second, unshifted border on top).
    b = fitz.open()
    pb = b.new_page(width=W, height=H)
    pb.draw_rect(fitz.Rect(24, 24, W - 16, H - 16), color=(0, 0, 0), width=1)
    pb.draw_rect(fitz.Rect(W - 216, H - 76, W - 16, H - 16), color=(0, 0, 0), width=1)
    pb.insert_text((W - 196, H - 36), "A-201", fontsize=12)
    pb.draw_line(fitz.Point(104, 104), fitz.Point(704, 104), width=2)
    pb.draw_line(fitz.Point(104, 104), fitz.Point(104, 454), width=2)
    pb.draw_rect(fitz.Rect(154, 154, 354, 304), width=1.5)

    rep = compare_drawings(a.tobytes(), b.tobytes())
    assert rep["success"]
    # Registration + ink tolerance should keep this at (near) zero regions.
    total = sum(len(v) for v in rep["b_boxes"].values())
    assert total == 0, f"shifted-only page produced {total} false regions: {rep['b_boxes']}"


def test_annotate_pdf_clouds():
    pdf_a, pdf_b = _make_docs()
    rep = compare_drawings(pdf_a, pdf_b)
    out = annotate_pdf(pdf_b, rep["b_boxes"], style="cloud")
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        per_page = {i: len(list(doc[i].annots() or [])) for i in range(doc.page_count)}
        for pstr, blist in rep["b_boxes"].items():
            assert per_page[int(pstr)] == len(blist)
        # They are Square annots (the revision-cloud carrier type).
        page = doc[int(next(iter(rep["b_boxes"])))]
        assert next(page.annots()).type[1] == "Square"
    finally:
        doc.close()


def test_change_box_refs():
    """Every change points at its own box — the link the cloud picker needs."""
    pdf_a, pdf_b = _make_docs()
    rep = compare_drawings(pdf_a, pdf_b)
    kind_of = {"delete": "del", "insert": "ins", "replace": "rep"}
    seen_b = set()
    for c in rep["changes"]:
        assert "a_box" in c and "b_box" in c, c
        for side, ref in (("a", c["a_box"]), ("b", c["b_box"])):
            if ref is None:
                # No box on that side only when the page is missing there too.
                assert c[f"{side}_page"] is None, c
                continue
            pno, i = ref
            assert pno == c[f"{side}_page"], c
            box = rep[f"{side}_boxes"][str(pno)][i]  # must resolve
            assert box[4] == kind_of[c["type"]], (c, box)
        if c["b_box"]:
            seen_b.add(tuple(c["b_box"]))
    # The refs are a bijection onto b_boxes: no box orphaned, none claimed twice.
    assert len(seen_b) == sum(len(v) for v in rep["b_boxes"].values())


def test_export_selected_subset_only():
    """Clouding a chosen subset stamps exactly those regions — the picker flow."""
    pdf_a, pdf_b = _make_docs()
    rep = compare_drawings(pdf_a, pdf_b)
    picked = [c for c in rep["changes"] if c["b_box"]][::2]  # user ticks every other
    assert len(picked) >= 2, "need a few regions to make this meaningful"

    boxes: dict[str, list] = {}
    for c in picked:
        pno, i = c["b_box"]
        boxes.setdefault(str(pno), []).append(rep["b_boxes"][str(pno)][i])

    doc = fitz.open(stream=annotate_pdf(pdf_b, boxes, style="cloud"), filetype="pdf")
    try:
        total = sum(len(list(doc[i].annots() or [])) for i in range(doc.page_count))
        assert total == len(picked), f"{total} clouds for {len(picked)} picked regions"
        for pstr, blist in boxes.items():
            assert len(list(doc[int(pstr)].annots() or [])) == len(blist)
    finally:
        doc.close()


def test_annotate_pdf_ignores_garbage_boxes():
    pdf_a, _ = _make_docs()
    out = annotate_pdf(
        pdf_a,
        {"99": [[0, 0, 10, 10, "ins"]], "x": [[0, 0, 1, 1]], "0": [None, [1, 2], [10, 10, 60, 60, "rep"]]},
    )
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert len(list(doc[0].annots())) == 1  # only the one valid box landed
    finally:
        doc.close()


if __name__ == "__main__":
    # No pytest in the project venv — plain runner, same style as test_export.py.
    for fn in (
        test_alignment_and_regions,
        test_identical_docs,
        test_shifted_content_not_flagged,
        test_annotate_pdf_clouds,
        test_change_box_refs,
        test_export_selected_subset_only,
        test_annotate_pdf_ignores_garbage_boxes,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All drawing-compare tests passed.")
