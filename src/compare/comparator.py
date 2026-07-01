"""Compare two PDFs as professional document-diff tools do.

Instead of aligning page N of A against page N of B (which falls apart the moment
one version inserts or removes content and shifts every later page), this treats
each document as a single **word stream** in reading order — every word tagged
with the page and bounding box it came from. The two streams are diffed with an
LCS/Myers-style sequence matcher (``difflib``), exactly like ``git diff`` over
tokens. Each changed run is mapped back to the page + box of its words, so a
change is highlighted on whatever page it actually lands on, in either document.

Text-layer pages take their words from PyMuPDF (real per-word boxes). Scanned
pages are OCR'd; each recognised line is split into words that share the line box
(coarser highlight, still on the right page). The result is robust to page shifts,
reflow, and font/margin changes — the failure modes of naïve per-page line diff.
"""

from __future__ import annotations

import difflib
import io
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)

# OCR render zoom; boxes are scaled back by this to land in PDF-point space.
_OCR_ZOOM = 2.0
# Bound work: pages per doc and total tokens (SequenceMatcher is ~quadratic worst
# case). Typical contracts are well under these; huge inputs degrade gracefully.
_MAX_PAGES = 1000
_MAX_TOKENS = 300_000


def _text_words(page) -> list[dict[str, Any]]:
    """Words from a page's text layer, in reading order: ``[{t, bbox}]``.

    PyMuPDF ``get_text("words")`` yields ``(x0,y0,x1,y1, word, block, line, wno)``.
    Sorting by (block, line, word-in-line) keeps a stable reading order even for
    multi-block layouts.
    """
    ws = page.get_text("words")
    ws.sort(key=lambda w: (w[5], w[6], w[7]))
    out: list[dict[str, Any]] = []
    for w in ws:
        word = w[4]
        if not word.strip():
            continue
        out.append({"t": word, "bbox": [w[0], w[1], w[2], w[3]]})
    return out


def _ocr_words(page, get_ocr: Callable[[], Any]) -> list[dict[str, Any]]:
    """OCR a scanned page → words. Each word inherits its line's box (upright only)."""
    import fitz  # PyMuPDF
    from PIL import Image

    engine = get_ocr()
    pix = page.get_pixmap(matrix=fitz.Matrix(_OCR_ZOOM, _OCR_ZOOM))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    upright = int(page.rotation) == 0

    out: list[dict[str, Any]] = []
    try:
        lines = engine.recognize_boxes(img)
    except NotImplementedError:
        # Recognition-only engine: no layout — one box-less token per word.
        for ln in engine.recognize(img).splitlines():
            for word in ln.split():
                out.append({"t": word, "bbox": None})
        return out

    for text, box in lines:
        bbox = None
        if upright and box and len(box) == 4:
            bbox = [c / _OCR_ZOOM for c in box]
        for word in text.split():
            if word.strip():
                out.append({"t": word, "bbox": bbox})
    return out


def _page_words(page, mode: str, get_ocr: Callable[[], Any] | None) -> list[dict[str, Any]]:
    has_text = bool((page.get_text("text") or "").strip())
    if mode == "ocr" or (mode == "auto" and not has_text):
        if get_ocr is None:
            return _text_words(page)
        try:
            return _ocr_words(page, get_ocr)
        except Exception:
            logger.exception("OCR failed on a page; using text layer instead")
            return _text_words(page)
    return _text_words(page)


def _doc_tokens(doc, mode: str, get_ocr: Callable[[], Any] | None) -> list[dict[str, Any]]:
    """Flatten a whole document into one word stream: ``[{t, page, bbox}]``."""
    tokens: list[dict[str, Any]] = []
    n = min(doc.page_count, _MAX_PAGES)
    for i in range(n):
        if len(tokens) >= _MAX_TOKENS:
            break
        for w in _page_words(doc[i], mode, get_ocr):
            tokens.append({"t": w["t"], "page": i, "bbox": w["bbox"]})
    return tokens


def _open(pdf_bytes: bytes):
    import fitz  # PyMuPDF

    return fitz.open(stream=pdf_bytes, filetype="pdf")


def _snippet(tokens: list[dict[str, Any]], limit: int = 60) -> str:
    """Readable text for a run of tokens (trimmed for the change list)."""
    s = " ".join(t["t"] for t in tokens)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def compare_pdfs(
    pdf_a: bytes,
    pdf_b: bytes,
    mode: str = "auto",
    get_ocr: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Compare two PDFs via whole-document word-stream diff.

    Returns a JSON-serialisable report:

    - ``a_boxes`` / ``b_boxes``: ``{page_index: [[x0,y0,x1,y1, kind], ...]}`` where
      kind is ``"del"`` (removed, red on A), ``"ins"`` (added, green on B), or
      ``"rep"`` (changed, yellow on both). Boxes are in scale-1 PDF-point space.
    - ``changes``: ordered runs ``[{type, a_text, b_text, a_page, b_page}]`` for the
      change list / navigation. ``type`` is ``delete|insert|replace``; ``a_page`` /
      ``b_page`` is the first page of that run in each doc (null if absent there).
    - ``summary``: page counts, changed-page lists per side, change count, identical.
    """
    doc_a = _open(pdf_a)
    doc_b = _open(pdf_b)
    try:
        toks_a = _doc_tokens(doc_a, mode, get_ocr)
        toks_b = _doc_tokens(doc_b, mode, get_ocr)
        words_a = [t["t"] for t in toks_a]
        words_b = [t["t"] for t in toks_b]

        sm = difflib.SequenceMatcher(None, words_a, words_b, autojunk=False)

        a_boxes: dict[int, list] = {}
        b_boxes: dict[int, list] = {}
        changes: list[dict[str, Any]] = []

        def add_boxes(store: dict[int, list], tokens: list[dict[str, Any]], kind: str):
            for tk in tokens:
                if not tk["bbox"]:
                    continue
                x0, y0, x1, y1 = tk["bbox"]
                store.setdefault(tk["page"], []).append([x0, y0, x1, y1, kind])

        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                continue
            at = toks_a[i1:i2]
            bt = toks_b[j1:j2]
            if tag == "delete":
                add_boxes(a_boxes, at, "del")
            elif tag == "insert":
                add_boxes(b_boxes, bt, "ins")
            else:  # replace
                add_boxes(a_boxes, at, "rep")
                add_boxes(b_boxes, bt, "rep")
            changes.append(
                {
                    "type": tag,
                    "a_text": _snippet(at),
                    "b_text": _snippet(bt),
                    "a_page": at[0]["page"] if at else None,
                    "b_page": bt[0]["page"] if bt else None,
                }
            )

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
                "truncated": len(toks_a) >= _MAX_TOKENS or len(toks_b) >= _MAX_TOKENS,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()
