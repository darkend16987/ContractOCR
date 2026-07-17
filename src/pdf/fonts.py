"""Font resolution + coverage helpers for the PDF text editor.

Extracted verbatim from api.py (Phase 4 conservative refactor). Self-contained:
no dependency on api. api.py re-imports these names, so every call site there is
unchanged. matplotlib/fitz/sys stay lazily imported inside the functions.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


# Cache the resolved Unicode font path (Vietnamese-capable) across requests.
_FONT_PATH: str | None = None


def _vietnamese_font() -> str | None:
    """Find a TTF that covers Vietnamese diacritics for the invisible text layer.

    Prefers DejaVu Sans (full Vietnamese coverage), which ships with matplotlib —
    already a transitive dependency. P5 packaging should bundle this TTF explicitly.
    """
    global _FONT_PATH
    if _FONT_PATH is not None:
        return _FONT_PATH or None
    candidates: list[str] = []
    # In the frozen (PyInstaller) app matplotlib.get_data_path() can point somewhere
    # the collected fonts didn't land, so the DejaVu lookup silently fails and the
    # editor drops Vietnamese text to a Latin-1 builtin (→ □). Search the bundle root
    # (sys._MEIPASS) and the executable dir FIRST so a rebuild always finds the font.
    import sys as _sys
    frozen_roots: list[Path] = []
    mei = getattr(_sys, "_MEIPASS", None)
    if mei:
        frozen_roots.append(Path(mei))
    frozen_roots.append(Path(_sys.executable).resolve().parent)
    frozen_roots.append(Path(__file__).resolve().parent)
    for root in frozen_roots:
        candidates.append(str(root / "matplotlib" / "mpl-data" / "fonts" / "ttf" / "DejaVuSans.ttf"))
        candidates.append(str(root / "fonts" / "DejaVuSans.ttf"))
        candidates.append(str(root / "DejaVuSans.ttf"))
    try:
        # NB: use the data path (a real str), not font_manager.findfont(), which
        # returns a FontPath object that PyMuPDF rejects as "bad fontfile".
        import matplotlib
        candidates.append(str(Path(matplotlib.get_data_path()) / "fonts" / "ttf" / "DejaVuSans.ttf"))
    except Exception:  # pragma: no cover - matplotlib always present via deps
        pass
    try:
        for site in __import__("site").getsitepackages():
            candidates.append(str(Path(site) / "imgaug" / "DejaVuSans.ttf"))
    except Exception:
        pass
    for c in candidates:
        if c and Path(c).is_file():
            _FONT_PATH = c
            return c
    _FONT_PATH = ""  # cache "not found" to avoid re-searching
    return None


# DejaVu ships style variants beside the regular TTF. Using the real bold/oblique
# file renders far cleaner than faux-bold stroking (the old approach blobbed at
# small sizes). Returns None when the variant file is absent → caller faux-styles.
_DEJAVU_SUFFIX = {
    (False, False): "",
    (True, False): "-Bold",
    (False, True): "-Oblique",
    (True, True): "-BoldOblique",
}


def _dejavu_variant(base_path: str, bold: bool, italic: bool) -> str | None:
    if not base_path:
        return None
    suffix = _DEJAVU_SUFFIX[(bold, italic)]
    if not suffix:
        return base_path
    cand = Path(base_path).with_name(f"DejaVuSans{suffix}.ttf")
    return str(cand) if cand.is_file() else None


def _font_covers(text: str, *, fontfile: str | None = None, fontname: str | None = None) -> bool:
    """True if the font has a real glyph for every char in `text`.

    Guards the text-edit redraw: a Base-14 builtin (helv/tiro/cour) or a mis-resolved
    local TTF may lack Vietnamese diacritics, in which case insert_text SILENTLY draws
    notdef boxes (□) instead of raising — so we must check coverage up front and fall
    back to the bundled DejaVu when any glyph is missing.
    """
    try:
        import fitz
        f = fitz.Font(fontfile=fontfile) if fontfile else fitz.Font(fontname=fontname)
    except Exception:
        return False
    try:
        for ch in set(text):
            if ch.isspace():
                continue
            if f.has_glyph(ord(ch)) == 0:
                return False
        return True
    except Exception:
        return False


def _fresh_fontname(page, base: str) -> str:
    """A font resource name `page` is not already using.

    Page.insert_font() matches on the RESOURCE name: if the page already has one,
    it returns that font and IGNORES the fontfile we passed. A previous edit round
    leaves its own /vnedit, /loc… behind — and subset_fonts() has since stripped
    them down to just that round's glyphs — so reusing a name silently redraws with
    a subset that can't cover the new text, giving notdef boxes (□) for every char
    the earlier round didn't happen to use. Always embed under an unused name.
    """
    try:
        used = {f[4] for f in page.get_fonts()}
    except Exception:
        return base
    if base not in used:
        return base
    i = 1
    while f"{base}{i}" in used:
        i += 1
    return f"{base}{i}"


# PyMuPDF Base14 names by (bold, italic). Real font variants, no faux needed.
_BUILTIN_VARIANTS = {
    "helv": {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"},
    "tiro": {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"},
    "cour": {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"},
}


# ---- local system fonts (text edit) --------------------------------------
# matplotlib's font_manager already indexes the machine's installed fonts
# (C:\Windows\Fonts on Windows). We reuse it both to list families for the UI
# and to resolve a family + style → an actual TTF the editor can embed, so an
# edited span can keep its original font instead of falling back to DejaVu.
import re as _re

_LOCAL_FONT_CACHE: dict[tuple[str, bool, bool], str] = {}


def _clean_font_name(name: str) -> str:
    """Normalise a PDF/PostScript font name to a plain family for lookup.

    Strips the 6-char subset prefix ("ABCDEF+Arial") and common style suffixes
    ("TimesNewRomanPS-BoldMT" → "TimesNewRoman").
    """
    if "+" in name and len(name.split("+", 1)[0]) == 6:
        name = name.split("+", 1)[1]
    name = name.split(",")[0].split("-")[0]
    name = _re.sub(r"(PSMT|PS|MT)$", "", name)
    return name.strip() or name


# Normalised index of installed families: {alnum-lowercased name: real family}.
# A PDF font name like "TimesNewRomanPSMT" cleans to "TimesNewRoman" (no spaces),
# which matplotlib can't match against the installed "Times New Roman". Normalising
# both sides (drop spaces/case) lets us recover the real family so findfont resolves.
_FAM_INDEX: dict[str, str] | None = None


def _norm_fam(s: str) -> str:
    return _re.sub(r"[^a-z0-9]", "", s.lower())


def _family_index() -> dict[str, str]:
    global _FAM_INDEX
    if _FAM_INDEX is None:
        idx: dict[str, str] = {}
        try:
            from matplotlib import font_manager as fm
            for f in fm.fontManager.ttflist:
                idx.setdefault(_norm_fam(f.name), f.name)
        except Exception as fe:
            logger.debug("build family index failed: %s", fe)
        _FAM_INDEX = idx
    return _FAM_INDEX


def _resolve_local_font(name: str, bold: bool, italic: bool) -> str | None:
    """Resolve a font family name + style to a local TTF path, or None.

    Uses matplotlib.font_manager.findfont with fallback disabled so a missing
    family raises (→ None) instead of silently returning DejaVu — the caller
    then applies its own DejaVu fallback for Vietnamese safety.
    """
    key = (name, bold, italic)
    if key in _LOCAL_FONT_CACHE:
        return _LOCAL_FONT_CACHE[key] or None
    path = ""
    try:
        from matplotlib import font_manager as fm

        cleaned = _clean_font_name(name)
        # Map the cleaned name onto a real installed family when possible (handles
        # space-collapsed PDF names like "TimesNewRoman" -> "Times New Roman").
        family = _family_index().get(_norm_fam(cleaned), cleaned)
        fp = fm.FontProperties(
            family=family,
            weight="bold" if bold else "normal",
            style="italic" if italic else "normal",
        )
        found = fm.findfont(fp, fallback_to_default=False)
        # findfont returns a FontPath (a str subclass carrying a face index) that
        # PyMuPDF's insert_font rejects as "bad fontfile" — coerce to a plain str.
        if found and Path(found).is_file():
            path = str(found)
    except Exception as fe:  # ValueError when no family matches
        logger.debug("resolve local font '%s' failed: %s", name, fe)
        path = ""
    _LOCAL_FONT_CACHE[key] = path
    return path or None


def _list_local_font_families() -> list[str]:
    try:
        from matplotlib import font_manager as fm

        return sorted({f.name for f in fm.fontManager.ttflist})
    except Exception as fe:
        logger.debug("list local fonts failed: %s", fe)
        return []
