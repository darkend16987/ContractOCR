"""Legacy / broken Vietnamese text detection & recovery (TCVN3, mojibake).

Extracted verbatim from api.py (Phase 4 conservative refactor). Depends only on
_clean_font_name from the sibling fonts module; api.py re-imports these names.
"""

from src.pdf.fonts import _clean_font_name


# ---- legacy / broken Vietnamese text detection & recovery -----------------
# CAD/Revit PDFs frequently carry Vietnamese text that get_text() cannot decode:
#   1. Legacy TCVN3 ".Vn" fonts (VnArial, VnTime…): single-byte WinAnsi encoding
#      whose high bytes are Vietnamese glyphs → extraction returns mojibake.
#   2. Type0/Identity-H fonts with a broken/absent ToUnicode CMap (e.g. a subset
#      Arial-BoldMT that maps to Cyrillic garbage).
# Neither is fixable by picking a font — the extracted STRING is already wrong. We
# (a) flag such spans so the UI can recover them, (b) try a fast TCVN3 transcode,
# and (c) fall back to OCR-ing the span's pixels (the only universal recovery).

def _is_legacy_font(font: str) -> bool:
    f = _clean_font_name(font or "").lower().lstrip(".")
    return f.startswith("vn") or "tcvn" in f or f.startswith("vni")


def _has_mojibake_chars(text: str) -> bool:
    """True if `text` contains code points that a Vietnamese/Latin document should
    never legitimately hold — the signature of a broken ToUnicode CMap."""
    for ch in text:
        o = ord(ch)
        if 0x0080 <= o <= 0x009F:  # C1 control block
            return True
        if 0x0400 <= o <= 0x04FF:  # Cyrillic (garbage in a Vietnamese drawing)
            return True
        if 0x0370 <= o <= 0x03FF:  # Greek
            return True
        if 0xE000 <= o <= 0xF8FF:  # Private Use Area
            return True
        if o == 0xFFFD:            # replacement char
            return True
        if o < 0x20 and ch not in "\t\n\r":  # stray control chars (e.g. \x03)
            return True
    return False


def _span_is_suspect(text: str, font: str) -> bool:
    """Whether a span's extracted text is likely wrong (legacy/broken encoding).

    Conservative on purpose — legacy .Vn fonts routinely carry perfectly-correct
    ASCII (part codes, coordinates, short labels), so those must NOT be flagged
    (OCR-ing correct text only makes it worse). A span is suspect only when it
    actually shows the signature of mis-decoding:
      * mojibake code points (Cyrillic/C1/PUA/…) — a broken ToUnicode CMap, or
      * a legacy .Vn font carrying non-ASCII bytes — mangled TCVN3 diacritics.
    (Silently-dropped diacritics leave clean ASCII and can't be auto-detected;
    the UI offers a manual OCR action for those.)
    """
    if not text.strip():
        return False
    if _has_mojibake_chars(text):
        return True
    if _is_legacy_font(font) and any(ord(c) >= 0x80 for c in text):
        return True
    return False


# TCVN3 (TCVN 5712 / "ABC") → Unicode. Key = the character get_text() returns after
# WinAnsi-decoding the font byte; value = the real Vietnamese character. Only the
# code points that differ from plain ASCII/Latin-1 are listed. Applied ONLY to
# legacy-font spans and only accepted when the result validates (see _transcode_tcvn3).
_TCVN3_MAP = {
    "µ": "à", "¸": "á", "¶": "ả", "·": "ã", "¹": "ạ",
    "¨": "ă", "»": "ằ", "¾": "ắ", "¼": "ẳ", "½": "ẵ", "Æ": "ặ",
    "©": "â", "Ç": "ầ", "Ê": "ấ", "È": "ẩ", "É": "ẫ", "Ë": "ậ",
    "Ì": "è", "Ð": "é", "Î": "ẻ", "Ï": "ẽ", "Ñ": "ẹ",
    "ª": "ê", "Ò": "ề", "Õ": "ế", "Ó": "ể", "Ô": "ễ", "Ö": "ệ",
    "×": "ì", "Ý": "í", "Ø": "ỉ", "Ü": "ĩ", "Þ": "ị",
    "ß": "ò", "ã": "ó", "á": "ỏ", "â": "õ", "ä": "ọ",
    "«": "ô", "å": "ồ", "è": "ố", "æ": "ổ", "ç": "ỗ", "é": "ộ",
    "¬": "ơ", "ê": "ờ", "í": "ớ", "ë": "ở", "ì": "ỡ", "î": "ợ",
    "ï": "ù", "ó": "ú", "ñ": "ủ", "ò": "ũ", "ô": "ụ",
    "­": "ư", "õ": "ừ", "ø": "ứ", "ö": "ử", "÷": "ữ", "ù": "ự",
    "ú": "ỳ", "ý": "ý", "û": "ỷ", "ü": "ỹ", "þ": "ỵ",
    "®": "đ",
    # Upper-case forms use the same lead bytes in TCVN3's paired range.
    "§": "Đ", "¡": "Ă", "¢": "Â", "£": "Ê", "¤": "Ô", "¥": "Ơ", "¦": "Ư",
}


def _transcode_tcvn3(text: str) -> str:
    """Map a TCVN3-decoded string to Unicode. Non-mapped chars pass through."""
    return "".join(_TCVN3_MAP.get(ch, ch) for ch in text)


def _looks_vietnamese(text: str) -> bool:
    """Accept a recovered string only if it reads as clean Vietnamese/Latin: no
    remaining mojibake and at least one real Vietnamese diacritic present."""
    if _has_mojibake_chars(text):
        return False
    return any(0x00C0 <= ord(c) <= 0x1EF9 for c in text)
