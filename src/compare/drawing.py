"""Compare two *drawing* PDFs (AutoCAD / Revit exports) visually.

The text word-stream diff in :mod:`comparator` is useless for drawings — the
interesting changes are geometry (moved walls, added dimensions, deleted
details), most of which never touches a text run. Professional tools
(Bluebeam Revu "Compare Documents", Drawboard) solve this with **raster
diffing**: render both pages to images and find where the ink differs.
Diffing the vector path lists directly is a trap — every CAD export splits,
joins and reorders paths differently, so path-level diff drowns in false
positives. Rendering first normalises all of that away, and because the input
is vector (no scan noise) the pixel diff is essentially exact.

Pipeline:

1. **Fingerprint** every page: a difference-hash of a small grayscale render
   plus the set of text words (sheet numbers in the title block are gold for
   matching). Cheap: one tiny render per page.
2. **Align** the two page sequences with monotonic dynamic programming
   (Needleman–Wunsch style) over fingerprint similarity. Handles inserted /
   removed / reordered-by-insertion sheets; a page pairs up only when it is
   clearly more similar than skipping both.
3. **Diff each matched pair**: render both pages onto the same pixel grid,
   cancel small translation offsets via phase correlation, then compare ink
   masks with a small dilation tolerance (forgives antialiasing). Morphology
   merges changed strokes into regions; connected components become boxes.
4. **Classify** each region: ink only in A → ``del`` (removed, red), only in
   B → ``ins`` (added, green), both → ``rep`` (modified, yellow). Boxes are
   returned in scale-1 PDF-point space, the same format as the text compare,
   so the renderer's highlight overlay works unchanged.

Unmatched pages get one full-page box (``del`` on A / ``ins`` on B).

No new dependencies: numpy + OpenCV (already bundled for RapidOCR) + PyMuPDF.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Long-side pixels for the fingerprint render (tiny, fast).
_THUMB_LONG = 256
# dHash grid; 16x16 = 256 bits keeps enough detail for sparse CAD sheets.
_HASH_SIZE = 16
# Long-side pixels for the working diff render. 3000px on an A0 sheet is
# ~2.5px/mm — fine for line work while keeping two grayscale buffers small.
_WORK_LONG = 3000
# Ink threshold on grayscale (dark lines on white background).
_INK_THRESH = 200
# Pages pair up only when similarity beats skipping both (2 * gap score).
_GAP_SCORE = 0.25
# Bound work like the text compare does.
_MAX_PAGES = 400
# Cap regions per page; beyond this the page is one big "rep" box (a page
# that changed in 300+ places is effectively "redrawn" anyway).
_MAX_REGIONS_PER_PAGE = 200

# Sensitivity presets: (min changed pixels per region at _WORK_LONG scale,
# ink-tolerance dilation kernel px, region-merge dilation px).
_SENSITIVITY = {
    "low": (60, 5, 15),
    "normal": (25, 3, 11),
    "high": (8, 3, 7),
}


def _np():
    import numpy as np

    return np


def _cv2():
    import cv2

    return cv2


def _page_gray(page, long_px: int):
    """Render a page to a grayscale numpy array. Returns ``(img, scale)``
    where ``scale`` is pixels per PDF point on this grid."""
    import fitz  # PyMuPDF

    np = _np()
    r = page.rect
    scale = long_px / max(r.width, r.height, 1.0)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
    return img, scale


def _dhash(gray) -> Any:
    """Difference hash as a flat bool array (row-wise gradient signs)."""
    cv2 = _cv2()
    small = cv2.resize(gray, (_HASH_SIZE + 1, _HASH_SIZE), interpolation=cv2.INTER_AREA)
    return (small[:, 1:] < small[:, :-1]).flatten()


def _fingerprint(page) -> dict[str, Any]:
    g, _ = _page_gray(page, _THUMB_LONG)
    words = {w[4].lower() for w in page.get_text("words") if w[4].strip()}
    r = page.rect
    return {
        "hash": _dhash(g),
        "words": words,
        "size": (round(r.width), round(r.height)),
    }


def _similarity(fa: dict, fb: dict) -> float:
    """0..1 similarity of two page fingerprints."""
    np = _np()
    hash_sim = 1.0 - float(np.count_nonzero(fa["hash"] != fb["hash"])) / fa["hash"].size
    # Different sheet sizes are almost never the same drawing.
    if fa["size"] != fb["size"]:
        hash_sim *= 0.6
    wa, wb = fa["words"], fb["words"]
    if wa or wb:
        jac = len(wa & wb) / max(len(wa | wb), 1)
        return 0.7 * hash_sim + 0.3 * jac
    return hash_sim


def _align_pages(fps_a: list[dict], fps_b: list[dict]):
    """Monotonic DP alignment of two page sequences.

    Returns ``(pairs, only_a, only_b)`` where pairs is ``[(ia, ib, sim)]``.
    A pair forms only when ``sim > 2 * _GAP_SCORE`` (otherwise two gaps score
    higher), so wildly different pages stay unmatched instead of producing a
    garbage full-page diff against the wrong sheet.
    """
    np = _np()
    n, m = len(fps_a), len(fps_b)
    sim = np.zeros((n, m), dtype=np.float64)
    for i in range(n):
        for j in range(m):
            sim[i, j] = _similarity(fps_a[i], fps_b[j])

    NEG = -1e9
    dp = np.full((n + 1, m + 1), NEG)
    dp[0, :] = np.arange(m + 1) * _GAP_SCORE
    dp[:, 0] = np.arange(n + 1) * _GAP_SCORE
    move = np.zeros((n + 1, m + 1), dtype=np.int8)  # 0=diag 1=up(gap A) 2=left(gap B)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = dp[i - 1, j - 1] + sim[i - 1, j - 1]
            mv = 0
            up = dp[i - 1, j] + _GAP_SCORE
            if up > best:
                best, mv = up, 1
            left = dp[i, j - 1] + _GAP_SCORE
            if left > best:
                best, mv = left, 2
            dp[i, j] = best
            move[i, j] = mv

    pairs: list[tuple[int, int, float]] = []
    only_a: list[int] = []
    only_b: list[int] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and move[i, j] == 0:
            pairs.append((i - 1, j - 1, float(sim[i - 1, j - 1])))
            i, j = i - 1, j - 1
        elif i > 0 and (j == 0 or move[i, j] == 1):
            only_a.append(i - 1)
            i -= 1
        else:
            only_b.append(j - 1)
            j -= 1
    pairs.reverse()
    only_a.reverse()
    only_b.reverse()
    return pairs, only_a, only_b


def _register(ga, gb):
    """Cancel a small translation of ``gb`` relative to ``ga``.

    Phase correlation gives the shift magnitude; rather than trusting the
    sign convention, both directions are tried and the one that actually
    reduces the difference wins. Returns ``(gb_aligned, (tx, ty))`` where
    ``(tx, ty)`` is the pixel translation that was applied to ``gb``.
    """
    cv2 = _cv2()
    np = _np()

    def _shifted(img, tx, ty):
        M = np.float32([[1, 0, tx], [0, 1, ty]])
        return cv2.warpAffine(
            img, M, (img.shape[1], img.shape[0]),
            flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=255,
        )

    try:
        # The Hanning window is essential: without it the hard image borders
        # dominate the spectrum and the detected shift collapses to ~0.
        win = cv2.createHanningWindow((ga.shape[1], ga.shape[0]), cv2.CV_32F)
        (dx, dy), response = cv2.phaseCorrelate(np.float32(ga), np.float32(gb), win)
    except Exception:
        return gb, (0.0, 0.0)

    mag = max(abs(dx), abs(dy))
    # Sub-pixel shifts are already forgiven by the ink-tolerance dilation;
    # huge "shifts" mean phase correlation latched onto content changes.
    if mag < 1.0 or mag > 0.05 * max(ga.shape) or response < 0.05:
        return gb, (0.0, 0.0)

    base = int(np.count_nonzero(cv2.absdiff(ga, gb) > 50))
    best_img, best_t, best_n = gb, (0.0, 0.0), base
    for sign in (-1.0, 1.0):
        cand = _shifted(gb, sign * dx, sign * dy)
        nctr = int(np.count_nonzero(cv2.absdiff(ga, cand) > 50))
        if nctr < best_n:
            best_img, best_t, best_n = cand, (sign * dx, sign * dy), nctr
    return best_img, best_t


def _diff_pair(page_a, page_b, sens: tuple[int, int, int]):
    """Diff one matched page pair.

    Returns ``(regions_a, regions_b)``: lists of ``[x0, y0, x1, y1, kind]``
    boxes in each page's own PDF-point space.
    """
    cv2 = _cv2()
    np = _np()
    min_px, tol_px, merge_px = sens

    ga, scale_a = _page_gray(page_a, _WORK_LONG)
    gb, _ = _page_gray(page_b, _WORK_LONG)
    # Same pixel grid for both; remember B's effective point→pixel scale.
    if gb.shape != ga.shape:
        gb = cv2.resize(gb, (ga.shape[1], ga.shape[0]), interpolation=cv2.INTER_AREA)
    rb = page_b.rect
    scale_bx = ga.shape[1] / max(rb.width, 1.0)
    scale_by = ga.shape[0] / max(rb.height, 1.0)

    gb, (tx, ty) = _register(ga, gb)

    ink_a = (ga < _INK_THRESH).astype(np.uint8)
    ink_b = (gb < _INK_THRESH).astype(np.uint8)
    tol_k = np.ones((tol_px, tol_px), dtype=np.uint8)
    # Ink present in one doc with no ink *nearby* in the other. The dilation
    # tolerance forgives antialiasing and sub-pixel rendering jitter.
    del_mask = ink_a & (1 - cv2.dilate(ink_b, tol_k))
    ins_mask = ink_b & (1 - cv2.dilate(ink_a, tol_k))

    change = ((del_mask | ins_mask) * 255).astype(np.uint8)
    if not change.any():
        return [], []

    # Merge changed strokes into regions before labelling.
    merge_k = cv2.getStructuringElement(cv2.MORPH_RECT, (merge_px, merge_px))
    blob = cv2.morphologyEx(change, cv2.MORPH_CLOSE, merge_k)
    blob = cv2.dilate(blob, merge_k)
    n_lbl, labels, stats, _ = cv2.connectedComponentsWithStats(blob, connectivity=8)

    regions: list[tuple[int, int, int, int, str]] = []
    for lbl in range(1, n_lbl):
        x, y, w, h, _area = stats[lbl]
        roi = labels[y : y + h, x : x + w] == lbl
        d = int(np.count_nonzero(del_mask[y : y + h, x : x + w][roi]))
        a = int(np.count_nonzero(ins_mask[y : y + h, x : x + w][roi]))
        if d + a < min_px:
            continue  # antialiasing dust
        if d >= min_px and a >= min_px:
            kind = "rep"
        elif a > d:
            kind = "ins"
        else:
            kind = "del"
        regions.append((int(x), int(y), int(x + w), int(y + h), kind))

    if len(regions) > _MAX_REGIONS_PER_PAGE:
        xs0 = min(r[0] for r in regions); ys0 = min(r[1] for r in regions)
        xs1 = max(r[2] for r in regions); ys1 = max(r[3] for r in regions)
        regions = [(xs0, ys0, xs1, ys1, "rep")]

    regions.sort(key=lambda r: (r[1], r[0]))  # top-to-bottom reading order

    pad = 3  # px, so hairlines don't sit exactly on the box edge
    ra = page_a.rect
    regions_a, regions_b = [], []
    for x0, y0, x1, y1, kind in regions:
        ax0 = max((x0 - pad) / scale_a, 0.0); ay0 = max((y0 - pad) / scale_a, 0.0)
        ax1 = min((x1 + pad) / scale_a, ra.width); ay1 = min((y1 + pad) / scale_a, ra.height)
        regions_a.append([round(ax0, 2), round(ay0, 2), round(ax1, 2), round(ay1, 2), kind])
        # B was translated by (tx, ty) onto A's grid → undo before mapping.
        bx0 = max((x0 - pad - tx) / scale_bx, 0.0); by0 = max((y0 - pad - ty) / scale_by, 0.0)
        bx1 = min((x1 + pad - tx) / scale_bx, rb.width); by1 = min((y1 + pad - ty) / scale_by, rb.height)
        regions_b.append([round(bx0, 2), round(by0, 2), round(bx1, 2), round(by1, 2), kind])
    return regions_a, regions_b


def compare_drawings(pdf_a: bytes, pdf_b: bytes, sensitivity: str = "normal") -> dict[str, Any]:
    """Visual diff of two drawing PDFs.

    Returns the same shape as :func:`comparator.compare_pdfs` (``a_boxes`` /
    ``b_boxes`` / ``changes`` / ``summary``) so the existing compare renderer
    displays it unchanged, plus ``summary.page_pairs`` with the alignment.
    """
    import fitz  # PyMuPDF

    sens = _SENSITIVITY.get(sensitivity, _SENSITIVITY["normal"])
    doc_a = fitz.open(stream=pdf_a, filetype="pdf")
    doc_b = fitz.open(stream=pdf_b, filetype="pdf")
    try:
        na = min(doc_a.page_count, _MAX_PAGES)
        nb = min(doc_b.page_count, _MAX_PAGES)
        fps_a = [_fingerprint(doc_a[i]) for i in range(na)]
        fps_b = [_fingerprint(doc_b[i]) for i in range(nb)]
        pairs, only_a, only_b = _align_pages(fps_a, fps_b)

        a_boxes: dict[int, list] = {}
        b_boxes: dict[int, list] = {}
        changes: list[dict[str, Any]] = []
        pair_infos: list[dict[str, Any]] = []

        for ia, ib, sim in pairs:
            regions_a, regions_b = _diff_pair(doc_a[ia], doc_b[ib], sens)
            pair_infos.append(
                {"a": ia, "b": ib, "similarity": round(sim, 3), "regions": len(regions_a)}
            )
            if not regions_a:
                continue
            a_boxes.setdefault(ia, []).extend(regions_a)
            b_boxes.setdefault(ib, []).extend(regions_b)
            kind_names = {"del": "Xoá nét vẽ", "ins": "Thêm nét vẽ", "rep": "Sửa nét vẽ"}
            kind_types = {"del": "delete", "ins": "insert", "rep": "replace"}
            for k, (boxa, boxb) in enumerate(zip(regions_a, regions_b)):
                kind = boxa[4]
                label = f"{kind_names[kind]} · vùng {k + 1}/{len(regions_a)}"
                changes.append(
                    {
                        "type": kind_types[kind],
                        "a_text": label if kind != "ins" else "",
                        "b_text": label if kind != "del" else "",
                        "a_page": ia,
                        "b_page": ib,
                    }
                )

        for ia in only_a:
            r = doc_a[ia].rect
            a_boxes.setdefault(ia, []).append([0, 0, round(r.width, 2), round(r.height, 2), "del"])
            changes.append(
                {
                    "type": "delete",
                    "a_text": f"Trang {ia + 1} (A) không còn trong B",
                    "b_text": "",
                    "a_page": ia,
                    "b_page": None,
                }
            )
        for ib in only_b:
            r = doc_b[ib].rect
            b_boxes.setdefault(ib, []).append([0, 0, round(r.width, 2), round(r.height, 2), "ins"])
            changes.append(
                {
                    "type": "insert",
                    "a_text": "",
                    "b_text": f"Trang {ib + 1} (B) là trang mới",
                    "a_page": None,
                    "b_page": ib,
                }
            )

        # Keep document order in the change list: sort by B page then A page.
        changes.sort(key=lambda c: (c["b_page"] if c["b_page"] is not None else c["a_page"] or 0,
                                    c["a_page"] if c["a_page"] is not None else 0))

        return {
            "success": True,
            "a_boxes": {str(k): v for k, v in a_boxes.items()},
            "b_boxes": {str(k): v for k, v in b_boxes.items()},
            "changes": changes,
            "summary": {
                "pages_a": doc_a.page_count,
                "pages_b": doc_b.page_count,
                "changes": len(changes),
                "changed_pages_a": sorted(a_boxes.keys()),
                "changed_pages_b": sorted(b_boxes.keys()),
                "identical": not changes,
                "truncated": doc_a.page_count > _MAX_PAGES or doc_b.page_count > _MAX_PAGES,
                "kind": "drawing",
                "page_pairs": pair_infos,
                "pages_only_a": only_a,
                "pages_only_b": only_b,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()


def overlay_drawings(pdf_a: bytes, pdf_b: bytes) -> dict[str, Any]:
    """Match pages of two drawings and compute the translation that best
    aligns each matched pair, for an on-screen onion-skin overlay.

    Reuses the fingerprint page-matching and phase-correlation registration of
    the diff pipeline, but renders nothing back — the frontend rasterises both
    PDFs itself (pdf.js) and just needs, per matched pair, the offset (in the A
    page's PDF points) to shift B by so the linework lines up.

    Returns ``{success, pairs:[{a, b, similarity, dx, dy}], only_a, only_b,
    summary:{...}}``. ``dx/dy`` are in PDF points; positive shifts B right/down.
    """
    import fitz  # PyMuPDF

    doc_a = fitz.open(stream=pdf_a, filetype="pdf")
    doc_b = fitz.open(stream=pdf_b, filetype="pdf")
    try:
        cv2 = _cv2()
        na = min(doc_a.page_count, _MAX_PAGES)
        nb = min(doc_b.page_count, _MAX_PAGES)
        fps_a = [_fingerprint(doc_a[i]) for i in range(na)]
        fps_b = [_fingerprint(doc_b[i]) for i in range(nb)]
        pairs, only_a, only_b = _align_pages(fps_a, fps_b)

        out_pairs: list[dict[str, Any]] = []
        for ia, ib, sim in pairs:
            ga, scale_a = _page_gray(doc_a[ia], _WORK_LONG)
            gb, _ = _page_gray(doc_b[ib], _WORK_LONG)
            if gb.shape != ga.shape:
                gb = cv2.resize(gb, (ga.shape[1], ga.shape[0]), interpolation=cv2.INTER_AREA)
            _, (tx, ty) = _register(ga, gb)
            # tx/ty are pixels on A's grid; scale_a is px per A-point.
            out_pairs.append(
                {
                    "a": ia,
                    "b": ib,
                    "similarity": round(sim, 3),
                    "dx": round(tx / scale_a, 2),
                    "dy": round(ty / scale_a, 2),
                }
            )

        return {
            "success": True,
            "pairs": out_pairs,
            "only_a": only_a,
            "only_b": only_b,
            "summary": {
                "pages_a": doc_a.page_count,
                "pages_b": doc_b.page_count,
                "matched": len(out_pairs),
                "truncated": doc_a.page_count > _MAX_PAGES or doc_b.page_count > _MAX_PAGES,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()


# Stroke colours for exported markup, by change kind.
_MARKUP_COLORS = {
    "del": (0.85, 0.10, 0.10),   # removed → red
    "ins": (0.00, 0.55, 0.20),   # added → green
    "rep": (0.90, 0.55, 0.00),   # modified → orange
}
_MARKUP_LABELS = {"del": "Đã xoá so với bản trước", "ins": "Mới thêm", "rep": "Đã thay đổi"}


def annotate_pdf(pdf_bytes: bytes, boxes: dict[str, Any], style: str = "cloud") -> bytes:
    """Stamp change regions onto a PDF as real annotations (revision clouds).

    ``boxes`` is the ``b_boxes`` (or ``a_boxes``) mapping from the compare
    report: ``{page_index_str: [[x0, y0, x1, y1, kind], ...]}`` in scale-1
    PDF-point display space. Square annotations with a cloudy border effect
    are the standard construction "revision cloud"; any PDF viewer can later
    move or delete them. Falls back to a plain border if the installed
    PyMuPDF doesn't support the cloud border effect.
    """
    import fitz  # PyMuPDF

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for pstr, blist in (boxes or {}).items():
            try:
                pno = int(pstr)
            except (TypeError, ValueError):
                continue
            if not (0 <= pno < doc.page_count) or not isinstance(blist, list):
                continue
            page = doc[pno]
            for b in blist:
                if not isinstance(b, (list, tuple)) or len(b) < 4:
                    continue
                x0, y0, x1, y1 = (float(v) for v in b[:4])
                kind = str(b[4]) if len(b) > 4 else "rep"
                pad = 4.0
                rect = fitz.Rect(x0 - pad, y0 - pad, x1 + pad, y1 + pad)
                # Display space → annotation (unrotated) page space.
                rect = fitz.Rect(
                    *(rect.tl * page.derotation_matrix),
                    *(rect.br * page.derotation_matrix),
                ).normalize() & page.rect if page.rotation else rect
                if rect.is_empty or not rect.is_valid:
                    continue
                annot = page.add_rect_annot(rect)
                annot.set_colors(stroke=_MARKUP_COLORS.get(kind, _MARKUP_COLORS["rep"]))
                annot.set_info(
                    title="Nabu PDF — So sánh bản vẽ",
                    content=_MARKUP_LABELS.get(kind, _MARKUP_LABELS["rep"]),
                )
                if style == "cloud":
                    try:
                        annot.set_border(width=1.5, clouds=2)
                    except Exception:
                        annot.set_border(width=1.5)
                else:
                    annot.set_border(width=1.5)
                annot.update()
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()
