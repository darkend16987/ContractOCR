"""PDF comparison: text word-stream diff and visual drawing diff."""

from .comparator import compare_pdfs
from .drawing import annotate_pdf, compare_drawings

__all__ = ["compare_pdfs", "compare_drawings", "annotate_pdf"]
