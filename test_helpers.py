"""Characterization tests for the pure helpers in api.py.

These lock in the CURRENT behaviour of the small, side-effect-free helpers so
the planned refactor (moving them into src/pdf/*) cannot change any output
unnoticed. No PDFs, no network — just strings in, values out.

Plain-runner style (no pytest in the venv), same as test_export.py. All console
output is ASCII only: the Windows test console is cp1252 and would crash on a
printed Vietnamese character, so assertions may hold Unicode but prints never do.
"""

import api


# --------------------------------------------------------------------------- #
# _parse_ranges — "1-3,5" -> 0-based inclusive (start,end), clamped to pages
# --------------------------------------------------------------------------- #
def test_parse_ranges_basic():
    assert api._parse_ranges("1-3,5,8-10", 10) == [(0, 2), (4, 4), (7, 9)]


def test_parse_ranges_bare_number():
    assert api._parse_ranges("5", 10) == [(4, 4)]


def test_parse_ranges_reversed_is_swapped():
    assert api._parse_ranges("3-1", 10) == [(0, 2)]


def test_parse_ranges_strips_all_spaces():
    assert api._parse_ranges("1 - 3", 10) == [(0, 2)]


def test_parse_ranges_clamps_out_of_range():
    assert api._parse_ranges("8-20", 10) == [(7, 9)]


def test_parse_ranges_zero_clamps_to_first_page():
    assert api._parse_ranges("0", 10) == [(0, 0)]


def test_parse_ranges_skips_invalid_and_empty_tokens():
    assert api._parse_ranges("a,,2", 10) == [(1, 1)]
    assert api._parse_ranges("", 10) == []


# --------------------------------------------------------------------------- #
# _fmt_page_label — visible page-number label per preset
# --------------------------------------------------------------------------- #
def test_fmt_page_label_presets():
    assert api._fmt_page_label("n_of_n", 2, 5) == "2 / 5"
    assert api._fmt_page_label("page_n", 2, 5) == "Trang 2"
    assert api._fmt_page_label("page_n_of_n", 2, 5) == "Trang 2 / 5"
    assert api._fmt_page_label("dash_n", 2, 5) == "- 2 -"
    # unknown format falls back to the bare number
    assert api._fmt_page_label("whatever", 2, 5) == "2"


# --------------------------------------------------------------------------- #
# _hex_rgb01 — '#rrggbb' -> (r,g,b) 0..1, black on anything unexpected
# --------------------------------------------------------------------------- #
def test_hex_rgb01_valid():
    assert api._hex_rgb01("#ff0000") == (1.0, 0.0, 0.0)
    assert api._hex_rgb01("ffffff") == (1.0, 1.0, 1.0)


def test_hex_rgb01_falls_back_to_black():
    assert api._hex_rgb01("#fff") == (0.0, 0.0, 0.0)     # wrong length
    assert api._hex_rgb01("#gggggg") == (0.0, 0.0, 0.0)  # non-hex
    assert api._hex_rgb01("") == (0.0, 0.0, 0.0)
    assert api._hex_rgb01(None) == (0.0, 0.0, 0.0)


# --------------------------------------------------------------------------- #
# _norm_color — int / hex-str / [r,g,b] (0..1 or 0..255) / None -> (r,g,b) 0..1
# --------------------------------------------------------------------------- #
def test_norm_color_none_is_black():
    assert api._norm_color(None) == (0.0, 0.0, 0.0)


def test_norm_color_packed_int():
    assert api._norm_color(0xFF0000) == (1.0, 0.0, 0.0)


def test_norm_color_hex_string():
    assert api._norm_color("#00ff00") == (0.0, 1.0, 0.0)


def test_norm_color_list_unit_scale():
    assert api._norm_color([1, 0, 0]) == (1.0, 0.0, 0.0)


def test_norm_color_list_255_scale():
    assert api._norm_color([255, 0, 0]) == (1.0, 0.0, 0.0)


def test_norm_color_bad_input_is_black():
    assert api._norm_color("abc") == (0.0, 0.0, 0.0)   # wrong-length string
    assert api._norm_color([1, 2]) == (0.0, 0.0, 0.0)  # wrong-length list


# --------------------------------------------------------------------------- #
# _mask_terms / _unmask_terms — swap numbers/dates/emails out and back verbatim
# --------------------------------------------------------------------------- #
def test_mask_roundtrip_is_lossless():
    text = "Total 1.234,56 on 10/03/2026 to a@b.com end"
    masked, store = api._mask_terms(text)
    assert store == ["1.234,56", "10/03/2026", "a@b.com"]
    assert "1.234,56" not in masked            # the number is really hidden
    assert api._unmask_terms(masked, store) == text


def test_mask_no_terms_is_identity():
    text = "no digits here"
    masked, store = api._mask_terms(text)
    assert store == []
    assert masked == text
    assert api._unmask_terms(masked, store) == text


# --------------------------------------------------------------------------- #
# _mask_key — show only the last 4 chars
# --------------------------------------------------------------------------- #
def test_mask_key():
    assert api._mask_key("") == ""
    assert api._mask_key("abcd1234") == ("•" * 4) + "1234"
    assert api._mask_key("12") == ("•" * 4) + "12"   # min 4 dots
    assert api._mask_key("  abcd1234  ") == ("•" * 4) + "1234"  # trimmed


# --------------------------------------------------------------------------- #
# _clean_font_name / _norm_fam — PDF font name -> plain family for lookup
# --------------------------------------------------------------------------- #
def test_clean_font_name():
    assert api._clean_font_name("ABCDEF+Arial") == "Arial"      # 6-char subset prefix
    assert api._clean_font_name("ABC+Arial") == "ABC+Arial"     # 3-char prefix untouched
    assert api._clean_font_name("TimesNewRomanPS-BoldMT") == "TimesNewRoman"
    assert api._clean_font_name("Arial,Bold") == "Arial"


def test_norm_fam():
    assert api._norm_fam("Times New Roman") == "timesnewroman"
    assert api._norm_fam("Arial-Bold") == "arialbold"


# --------------------------------------------------------------------------- #
# legacy / broken Vietnamese text detection
# --------------------------------------------------------------------------- #
def test_is_legacy_font():
    assert api._is_legacy_font(".VnArial") is True
    assert api._is_legacy_font("VnTime") is True
    assert api._is_legacy_font("TCVN-Arial") is True
    assert api._is_legacy_font("VNI-Times") is True
    assert api._is_legacy_font("Arial") is False


def test_has_mojibake_chars():
    assert api._has_mojibake_chars("Hello") is False
    assert api._has_mojibake_chars("abc\t\n") is False          # tab/newline allowed
    assert api._has_mojibake_chars("Пр") is True      # Cyrillic
    assert api._has_mojibake_chars("\x03abc") is True           # stray control char
    assert api._has_mojibake_chars("�") is True            # replacement char
    assert api._has_mojibake_chars("") is True            # private use area


def test_span_is_suspect():
    assert api._span_is_suspect("", "Arial") is False                 # empty
    assert api._span_is_suspect("Hello", ".VnArial") is False         # clean ASCII in legacy font
    assert api._span_is_suspect("Пр", "Arial") is True      # mojibake


def test_span_is_suspect_legacy_nonascii():
    # a legacy .Vn font holding any char >= 0x80 is flagged (mangled diacritics),
    # while proper Unicode Vietnamese in a legacy font is likewise flagged for recovery
    assert api._span_is_suspect("µ®", ".VnArial") is True
    assert api._span_is_suspect("Hà Nội", ".VnTime") is True


def test_transcode_tcvn3():
    assert api._transcode_tcvn3("µ®") == "àđ"  # "mu ae" -> "a-grave d-bar"
    assert api._transcode_tcvn3("Hello") == "Hello"               # passthrough


def test_looks_vietnamese():
    assert api._looks_vietnamese("Hà Nội") is True   # has real diacritics
    assert api._looks_vietnamese("Hello") is False             # no diacritic
    assert api._looks_vietnamese("Пр") is False      # mojibake rejected


# --------------------------------------------------------------------------- #
# _font_covers — every glyph present, else False (guards notdef boxes)
# --------------------------------------------------------------------------- #
def test_font_covers_builtin_gaps():
    # Base-14 Helvetica has Latin-1 but not the full Vietnamese range.
    assert api._font_covers("Hello", fontname="helv") is True
    assert api._font_covers("à", fontname="helv") is True     # a-grave (Latin-1)
    assert api._font_covers("ữ", fontname="helv") is False    # u-horn-tilde (missing)


def test_font_covers_dejavu_has_vietnamese():
    vf = api._vietnamese_font()
    if not vf:
        print("SKIP test_font_covers_dejavu_has_vietnamese (no DejaVu on this box)")
        return
    assert api._font_covers("ữ", fontfile=vf) is True


def test_font_covers_bad_fontfile_is_false():
    assert api._font_covers("x", fontfile="/no/such/font.ttf") is False


if __name__ == "__main__":
    # No pytest in the project venv - plain runner, same style as test_export.py.
    for fn in (
        test_parse_ranges_basic,
        test_parse_ranges_bare_number,
        test_parse_ranges_reversed_is_swapped,
        test_parse_ranges_strips_all_spaces,
        test_parse_ranges_clamps_out_of_range,
        test_parse_ranges_zero_clamps_to_first_page,
        test_parse_ranges_skips_invalid_and_empty_tokens,
        test_fmt_page_label_presets,
        test_hex_rgb01_valid,
        test_hex_rgb01_falls_back_to_black,
        test_norm_color_none_is_black,
        test_norm_color_packed_int,
        test_norm_color_hex_string,
        test_norm_color_list_unit_scale,
        test_norm_color_list_255_scale,
        test_norm_color_bad_input_is_black,
        test_mask_roundtrip_is_lossless,
        test_mask_no_terms_is_identity,
        test_mask_key,
        test_clean_font_name,
        test_norm_fam,
        test_is_legacy_font,
        test_has_mojibake_chars,
        test_span_is_suspect,
        test_span_is_suspect_legacy_nonascii,
        test_transcode_tcvn3,
        test_looks_vietnamese,
        test_font_covers_builtin_gaps,
        test_font_covers_dejavu_has_vietnamese,
        test_font_covers_bad_fontfile_is_false,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All helper tests passed.")
