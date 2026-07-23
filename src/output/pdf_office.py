"""Convert a PDF's real content (text + tables) into editable Office files.

Format-smart, per the product decision:
  * XLSX / CSV — *structured*: every table PyMuPDF detects becomes real
    rows × columns; prose between tables is kept as full-width text rows so
    nothing is lost.
  * DOCX — *full document*: text in reading order as paragraphs (bold + size
    carried over) with tables preserved as Word tables (bordered grid).

Extraction is PyMuPDF only (get_text("dict") + find_tables); it works on PDFs
that have a real text layer. A scanned PDF (no text) yields no content — the
caller surfaces that to the user rather than writing an empty file.

DOCX needs python-docx (a new dependency; bundled into the frozen sidecar via
sidecar.spec). openpyxl (XLSX) and csv (stdlib) were already available.
"""

from __future__ import annotations

import csv
import io
import logging

from src.pdf.util import _require_fitz

logger = logging.getLogger(__name__)


# A text block whose centre lands inside a detected table is table content, not
# prose — this guard keeps it from being emitted twice.
def _center_in_any(rect, table_rects) -> bool:
    cx = (rect.x0 + rect.x1) / 2
    cy = (rect.y0 + rect.y1) / 2
    for r in table_rects:
        if r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1:
            return True
    return False


def _norm_rows(rows: list) -> list[list[str]]:
    """Rectangularise a table: pad short rows, coerce every cell to a string."""
    width = max((len(r) for r in rows), default=0)
    out: list[list[str]] = []
    for r in rows:
        cells = [("" if c is None else str(c)).strip() for c in r]
        if len(cells) < width:
            cells += [""] * (width - len(cells))
        out.append(cells)
    return out


def extract_pages(doc, page_indices: list[int]) -> list[list[dict]]:
    """Ordered content per page.

    Returns a list (one entry per requested page) of item lists. Each item is
    either ``{"kind": "text", "text", "size", "bold"}`` or
    ``{"kind": "table", "rows": [[cell, ...], ...]}``, sorted top-to-bottom
    (then left-to-right) so the reading order matches the page.
    """
    fitz = _require_fitz()
    pages_out: list[list[dict]] = []

    for pno in page_indices:
        page = doc[pno]

        # Tables first, so their bboxes can mask out the text drawn inside them.
        tables: list[tuple] = []  # (bbox_rect, normalised_rows)
        try:
            found = page.find_tables()
            for t in getattr(found, "tables", []):
                rows = _norm_rows(t.extract())
                if rows and any(any(c for c in row) for row in rows):
                    tables.append((fitz.Rect(t.bbox), rows))
        except Exception as e:  # find_tables is best-effort
            logger.debug("find_tables skipped p%s: %s", pno, e)
        table_rects = [r for r, _ in tables]

        items: list[tuple] = []  # (y0, x0, dict) for a stable reading-order sort

        try:
            data = page.get_text("dict")
        except Exception as e:
            logger.debug("get_text dict failed p%s: %s", pno, e)
            data = {"blocks": []}

        for b in data.get("blocks", []):
            if b.get("type", 0) != 0:  # image block
                continue
            bbox = fitz.Rect(b["bbox"])
            if _center_in_any(bbox, table_rects):
                continue  # belongs to a table, emitted below
            first = None
            line_txts: list[str] = []
            for line in b.get("lines", []):
                spans = line.get("spans", [])
                lt = "".join(sp.get("text", "") for sp in spans)
                if lt.strip():
                    line_txts.append(lt.strip())
                if first is None:
                    for sp in spans:
                        if sp.get("text", "").strip():
                            first = sp
                            break
            text = "\n".join(line_txts).strip()
            if not text:
                continue
            flags = int(first.get("flags", 0)) if first else 0
            items.append((bbox.y0, bbox.x0, {
                "kind": "text",
                "text": text,
                "size": float(first.get("size", 11.0)) if first else 11.0,
                "bold": bool(flags & 16),
            }))

        for rect, rows in tables:
            items.append((rect.y0, rect.x0, {"kind": "table", "rows": rows}))

        items.sort(key=lambda it: (round(it[0], 1), it[1]))
        pages_out.append([it[2] for it in items])

    return pages_out


def has_content(pages: list[list[dict]]) -> bool:
    return any(pages)


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

def to_csv(pages: list[list[dict]]) -> bytes:
    """Structured CSV: tables as real rows, prose as single-column rows.

    utf-8-sig so Excel opens Vietnamese correctly. Pages separated by a blank
    row; each table preceded by a marker comment row so the source is traceable.
    """
    buf = io.StringIO(newline="")
    w = csv.writer(buf)
    for pi, items in enumerate(pages):
        if pi > 0:
            w.writerow([])
            w.writerow([f"# Trang {pi + 1}"])
        for item in items:
            if item["kind"] == "table":
                for row in item["rows"]:
                    w.writerow(row)
                w.writerow([])
            else:
                for line in item["text"].split("\n"):
                    w.writerow([line])
    return buf.getvalue().encode("utf-8-sig")


def to_xlsx(pages: list[list[dict]]) -> bytes:
    """Structured XLSX: one sheet, content in reading order.

    Tables land as real cell grids (rows × columns); prose lands in column A.
    Page-header rows are bold. Column widths are auto-fit to the content, capped
    so a long paragraph can't stretch a column off-screen.
    """
    import openpyxl
    from openpyxl.styles import Alignment, Font

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Nội dung"
    wrap = Alignment(wrap_text=True, vertical="top")
    bold = Font(bold=True)
    col_max: dict[int, int] = {}

    def note_width(col_idx: int, value: str):
        n = max((len(seg) for seg in str(value).split("\n")), default=0)
        if n > col_max.get(col_idx, 0):
            col_max[col_idx] = n

    r = 1
    for pi, items in enumerate(pages):
        hdr = ws.cell(row=r, column=1, value=f"— Trang {pi + 1} —")
        hdr.font = bold
        note_width(1, hdr.value)
        r += 1
        for item in items:
            if item["kind"] == "table":
                for row in item["rows"]:
                    for ci, cell in enumerate(row, start=1):
                        c = ws.cell(row=r, column=ci, value=cell)
                        c.alignment = wrap
                        note_width(ci, cell)
                    r += 1
                r += 1  # blank spacer row after a table
            else:
                c = ws.cell(row=r, column=1, value=item["text"])
                c.alignment = wrap
                note_width(1, item["text"])
                r += 1
        r += 1  # blank spacer row between pages

    from openpyxl.utils import get_column_letter
    for ci, width in col_max.items():
        ws.column_dimensions[get_column_letter(ci)].width = min(max(width + 2, 10), 80)

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def to_docx(pages: list[list[dict]]) -> bytes:
    """Full-document DOCX: paragraphs (bold + size preserved) + Word tables.

    Pages are separated by a page break so the flow mirrors the source; tables
    use the 'Table Grid' style so their borders show.
    """
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: F401 (kept for future use)
    from docx.shared import Pt

    document = Document()
    for pi, items in enumerate(pages):
        if pi > 0:
            document.add_page_break()
        for item in items:
            if item["kind"] == "table":
                rows = item["rows"]
                ncols = max((len(row) for row in rows), default=0)
                if ncols == 0:
                    continue
                table = document.add_table(rows=len(rows), cols=ncols)
                try:
                    table.style = "Table Grid"
                except Exception:
                    pass  # style missing in some minimal templates — plain table
                for ri, row in enumerate(rows):
                    for ci in range(ncols):
                        table.rows[ri].cells[ci].text = row[ci] if ci < len(row) else ""
                document.add_paragraph("")  # breathing room after a table
            else:
                para = document.add_paragraph()
                run = para.add_run(item["text"])
                run.bold = bool(item.get("bold"))
                try:
                    size = float(item.get("size", 11.0))
                    if 4.0 <= size <= 96.0:
                        run.font.size = Pt(size)
                except Exception:
                    pass

    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def convert(pdf_bytes: bytes, fmt: str, page_indices: list[int] | None = None):
    """Open ``pdf_bytes``, extract, and return (data_bytes, had_content).

    ``fmt`` is one of "xlsx" | "docx" | "csv". Raises ValueError on an unknown
    format. ``page_indices`` defaults to every page.
    """
    fmt = (fmt or "").lower()
    writers = {"xlsx": to_xlsx, "csv": to_csv, "docx": to_docx}
    if fmt not in writers:
        raise ValueError(f"unsupported format: {fmt!r}")

    fitz = _require_fitz()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if page_indices is None:
            page_indices = list(range(doc.page_count))
        else:
            page_indices = [p for p in page_indices if 0 <= p < doc.page_count]
        pages = extract_pages(doc, page_indices)
    finally:
        doc.close()

    if not has_content(pages):
        return b"", False
    return writers[fmt](pages), True
