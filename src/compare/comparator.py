"""Compare two PDFs page-by-page and line-by-line.

Text-layer pages are diffed from their embedded text (fast, exact, with per-line
bounding boxes for on-screen highlighting). Scanned pages fall back to OCR — text
is still diffed, and boxes are provided when the page is upright (rotation 0).

The diff itself is stdlib ``difflib.SequenceMatcher`` on whitespace-normalised
line text, so pure layout reflow is not reported as a change. Line boxes are
returned in the same scale-1 coordinate space the renderer already uses for text
spans, so the UI overlays them with a plain ``bbox * scale`` transform.
"""

from __future__ import annotations

import difflib
import io
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Render zoom used when OCR'ing a scanned page; boxes are scaled back by this to
# land in PDF-point (scale-1) space.
_OCR_ZOOM = 2.0
# Hard cap on pages compared per document — bounds OCR time and payload size.
_MAX_PAGES = 500


def _normalize(text: str) -> str:
    """Collapse runs of whitespace so reflowed-but-identical text isn't flagged."""
    return " ".join(text.split())


def _lines_from_text_layer(page) -> list[dict[str, Any]]:
    """Lines from a page's embedded text: ``[{text, bbox:[x0,y0,x1,y1]}]``."""
    out: list[dict[str, Any]] = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(sp.get("text", "") for sp in line.get("spans", []))
            if not text.strip():
                continue
            x0, y0, x1, y1 = line["bbox"]
            out.append({"text": text, "bbox": [x0, y0, x1, y1]})
    return out


def _lines_from_ocr(page, get_ocr: Callable[[], Any]) -> list[dict[str, Any]]:
    """OCR a scanned page. Boxes only when upright (rotation 0); else text-only."""
    import fitz  # PyMuPDF
    from PIL import Image

    engine = get_ocr()
    pix = page.get_pixmap(matrix=fitz.Matrix(_OCR_ZOOM, _OCR_ZOOM))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    upright = int(page.rotation) == 0

    out: list[dict[str, Any]] = []
    try:
        for text, box in engine.recognize_boxes(img):
            if not text.strip():
                continue
            bbox = None
            if upright and box and len(box) == 4:
                bbox = [c / _OCR_ZOOM for c in box]
            out.append({"text": text, "bbox": bbox})
    except NotImplementedError:
        # Recognition-only engine (no layout) — plain full-page text, split by line.
        for ln in engine.recognize(img).splitlines():
            if ln.strip():
                out.append({"text": ln, "bbox": None})
    return out


def _page_lines(page, mode: str, get_ocr: Callable[[], Any]) -> tuple[list[dict], str]:
    """Return ``(lines, used_mode)`` for one page under the requested mode.

    mode: ``"text"`` (embedded text only), ``"ocr"`` (force OCR), or ``"auto"``
    (OCR only when the page has no usable text layer).
    """
    has_text = bool((page.get_text("text") or "").strip())
    if mode == "ocr" or (mode == "auto" and not has_text):
        try:
            return _lines_from_ocr(page, get_ocr), "ocr"
        except Exception:
            logger.exception("OCR failed on a page; falling back to text layer")
            return _lines_from_text_layer(page), "text"
    lines = _lines_from_text_layer(page)
    return lines, ("text" if lines else "empty")


def _word_diff(a: str, b: str) -> dict[str, list[dict[str, str]]]:
    """Inline word-level diff of two lines, for the detail panel.

    Returns ``{"a": [{t, op}], "b": [{t, op}]}`` where op is ``equal`` or ``change``.
    """
    aw, bw = a.split(), b.split()
    sm = difflib.SequenceMatcher(None, aw, bw, autojunk=False)
    a_segs: list[dict[str, str]] = []
    b_segs: list[dict[str, str]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        op = "equal" if tag == "equal" else "change"
        if i1 < i2:
            a_segs.append({"t": " ".join(aw[i1:i2]), "op": op})
        if j1 < j2:
            b_segs.append({"t": " ".join(bw[j1:j2]), "op": op})
    return {"a": a_segs, "b": b_segs}


def _diff_lines(a_lines: list[dict], b_lines: list[dict]) -> list[dict[str, Any]]:
    """Diff two line lists → list of ops, each carrying the source/target lines."""
    a_norm = [_normalize(l["text"]) for l in a_lines]
    b_norm = [_normalize(l["text"]) for l in b_lines]
    sm = difflib.SequenceMatcher(None, a_norm, b_norm, autojunk=False)

    ops: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        entry: dict[str, Any] = {
            "type": tag,  # "replace" | "delete" | "insert"
            "a": a_lines[i1:i2],
            "b": b_lines[j1:j2],
        }
        # Inline word diff when a single line was edited into a single line.
        if tag == "replace" and (i2 - i1) == 1 and (j2 - j1) == 1:
            entry["words"] = _word_diff(a_lines[i1]["text"], b_lines[j1]["text"])
        ops.append(entry)
    return ops


def _open(pdf_bytes: bytes):
    import fitz  # PyMuPDF

    return fitz.open(stream=pdf_bytes, filetype="pdf")


def _page_meta(page) -> dict[str, Any]:
    r = page.rect
    return {"width": r.width, "height": r.height, "rotation": int(page.rotation)}


def compare_pdfs(
    pdf_a: bytes,
    pdf_b: bytes,
    mode: str = "auto",
    get_ocr: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Compare two PDFs. Returns a JSON-serialisable diff report.

    ``mode``: ``"text"`` | ``"ocr"`` | ``"auto"`` (default). ``get_ocr`` is a
    zero-arg callable returning the OCR engine; required only for ocr/auto on
    scanned pages.
    """
    doc_a = _open(pdf_a)
    doc_b = _open(pdf_b)
    try:
        n_a = min(doc_a.page_count, _MAX_PAGES)
        n_b = min(doc_b.page_count, _MAX_PAGES)
        n = max(n_a, n_b)

        pages: list[dict[str, Any]] = []
        changed_pages: list[int] = []

        for i in range(n):
            has_a = i < n_a
            has_b = i < n_b

            if has_a and has_b:
                pa, pb = doc_a[i], doc_b[i]
                a_lines, mode_a = _page_lines(pa, mode, get_ocr)
                b_lines, mode_b = _page_lines(pb, mode, get_ocr)
                ops = _diff_lines(a_lines, b_lines)
                status = "differ" if ops else "same"
                page = {
                    "index": i,
                    "status": status,
                    "mode_a": mode_a,
                    "mode_b": mode_b,
                    "meta_a": _page_meta(pa),
                    "meta_b": _page_meta(pb),
                    "diffs": ops,
                }
            elif has_a:
                pa = doc_a[i]
                a_lines, mode_a = _page_lines(pa, mode, get_ocr)
                status = "only_a"
                page = {
                    "index": i,
                    "status": status,
                    "mode_a": mode_a,
                    "mode_b": None,
                    "meta_a": _page_meta(pa),
                    "meta_b": None,
                    "diffs": [{"type": "delete", "a": a_lines, "b": []}],
                }
            else:
                pb = doc_b[i]
                b_lines, mode_b = _page_lines(pb, mode, get_ocr)
                status = "only_b"
                page = {
                    "index": i,
                    "status": status,
                    "mode_a": None,
                    "mode_b": mode_b,
                    "meta_a": None,
                    "meta_b": _page_meta(pb),
                    "diffs": [{"type": "insert", "a": [], "b": b_lines}],
                }

            if status != "same":
                changed_pages.append(i)
            pages.append(page)

        return {
            "success": True,
            "pages": pages,
            "summary": {
                "pages_a": doc_a.page_count,
                "pages_b": doc_b.page_count,
                "compared": n,
                "changed_pages": changed_pages,
                "identical": not changed_pages,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()
