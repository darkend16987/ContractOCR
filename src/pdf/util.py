"""Small PDF plumbing + numeric/format helpers.

Extracted verbatim from api.py (Phase 4 conservative refactor). Leaf module:
depends only on fastapi + stdlib, so api.py and the sibling pdf modules can
re-import these names with no import cycle.
"""

import base64

from fastapi import HTTPException

# Reject oversized payloads before decoding to avoid blowing up memory.
# ~200 MB of binary => ~280 MB of base64 text.
_MAX_PDF_B64 = 280_000_000


def _decode_pdf_b64(pdf_b64: str) -> bytes:
    """Validate size + decode a base64 PDF payload, raising HTTPException on error."""
    if len(pdf_b64) > _MAX_PDF_B64:
        raise HTTPException(status_code=400, detail="PDF quá lớn (tối đa ~200MB).")
    try:
        return base64.b64decode(pdf_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="pdf_b64 không hợp lệ")


def _require_fitz():
    """Import PyMuPDF or raise a 503 with a Vietnamese message (frozen builds bundle it)."""
    try:
        import fitz  # PyMuPDF

        return fitz
    except ImportError:
        raise HTTPException(status_code=503, detail="PyMuPDF (fitz) chưa cài — không xử lý được PDF.")


def _open_pdf_stream(pdf_bytes: bytes):
    """Open decoded PDF bytes with PyMuPDF, raising the shared 400 on a bad file.

    Centralises the identical open+try/except that every PDF endpoint repeated;
    the caller keeps its own `fitz` binding for the constants/classes it uses next.
    """
    import fitz  # PyMuPDF (cached; the caller already ensured it imports)

    try:
        return fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không mở được PDF: {e}")


def _fmt_page_label(fmt: str, n: int, total: int) -> str:
    """Render the visible label for page number `n` of `total`. ASCII only, so the
    built-in Helvetica (no embedded font) covers every preset."""
    if fmt == "n_of_n":
        return f"{n} / {total}"
    if fmt == "page_n":
        return f"Trang {n}"
    if fmt == "page_n_of_n":
        return f"Trang {n} / {total}"
    if fmt == "dash_n":
        return f"- {n} -"
    return str(n)


def _hex_rgb01(hex_str: str) -> tuple[float, float, float]:
    """'#rrggbb' → (r, g, b) in 0..1. Falls back to black on anything unexpected."""
    s = (hex_str or "").lstrip("#")
    if len(s) != 6:
        return (0.0, 0.0, 0.0)
    try:
        return (int(s[0:2], 16) / 255, int(s[2:4], 16) / 255, int(s[4:6], 16) / 255)
    except ValueError:
        return (0.0, 0.0, 0.0)


def _parse_ranges(spec: str, page_count: int) -> list[tuple[int, int]]:
    """Parse "1-3,5,8-10" into 0-based inclusive (start, end) pairs, clamped.

    Invalid/empty tokens are skipped; out-of-range values are clamped into
    [0, page_count-1]. A bare "5" becomes (4, 4).
    """
    out: list[tuple[int, int]] = []
    for tok in spec.replace(" ", "").split(","):
        if not tok:
            continue
        try:
            if "-" in tok:
                a_s, b_s = tok.split("-", 1)
                a = int(a_s)
                b = int(b_s)
            else:
                a = b = int(tok)
        except ValueError:
            continue
        if a > b:
            a, b = b, a
        a = max(1, min(a, page_count))
        b = max(1, min(b, page_count))
        out.append((a - 1, b - 1))
    return out
