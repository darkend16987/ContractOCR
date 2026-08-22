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


# --------------------------------------------------------------------------- #
# _fix_span_box / _fix_text_dict — the "baseline on the top edge" span quirk
#
# WHY A GRID HERE AND NOT ONLY IN test_translate_layout. The repair sits in ONE
# reader (`_page_text_dict`) that /translate-pdf, /text-spans and /text-find all
# go through, so its rule is shared-surface code: getting it wrong moves every
# highlight box in "Sua noi dung" as well as the translation. These cases are
# pure dicts in, tuples out - no PDF, no font, nothing to render - so they say
# exactly what the rule is, and the fixture-driven cases in
# test_translate_layout.py say what it DOES.
#
# The guard case at the end rebuilds the old (broken) behaviour and demands the
# grid notice: a rule nothing can fail is not a rule.
# --------------------------------------------------------------------------- #

def _span(y0, y1, oy, size=10.0, asc=0.9, desc=-0.1):
    return {"bbox": (50.0, y0, 150.0, y1), "origin": (50.0, oy),
            "size": size, "ascender": asc, "descender": desc}


def test_fix_span_box_leaves_a_normal_font_alone():
    """Baseline 0.9*size below the top edge - exactly how MuPDF reports real text."""
    sp = _span(y0=91.0, y1=101.0, oy=100.0)  # oy - y0 = 9.0 = 0.9 * 10
    assert api._fix_span_box(sp) is None


def test_fix_span_box_repairs_baseline_on_top_edge():
    """The quirk: origin sits ON y0, so the whole box hangs below the glyphs."""
    sp = _span(y0=100.0, y1=110.0, oy=100.0)
    box = api._fix_span_box(sp)
    assert box is not None
    # 0.9 / -0.25 are the substituted metrics, measured against real ink.
    assert box == (50.0, 100.0 - 9.0, 150.0, 100.0 + 2.5)


def test_fix_span_box_is_scale_free():
    """A 4pt footnote is judged by the same fraction as a 40pt heading."""
    small = api._fix_span_box(_span(y0=200.0, y1=204.0, oy=200.0, size=4.0))
    assert small == (50.0, 200.0 - 3.6, 150.0, 200.0 + 1.0)
    # ...and a 4pt span reported correctly is still left alone, even though the
    # 3.6pt offset would look "small" to any absolute threshold.
    assert api._fix_span_box(_span(y0=196.4, y1=200.4, oy=200.0, size=4.0)) is None


def test_fix_span_box_keeps_the_fonts_own_metrics_when_they_are_bigger():
    """max/min, not a blind overwrite: a font with a deeper descender keeps it."""
    box = api._fix_span_box(_span(y0=100.0, y1=110.0, oy=100.0, asc=1.1, desc=-0.4))
    assert box == (50.0, 100.0 - 11.0, 150.0, 100.0 + 4.0)


def test_fix_span_box_skips_a_squashed_box():
    """Shorter than half the font size: a clipped mark, not a misplaced line box."""
    assert api._fix_span_box(_span(y0=100.0, y1=103.0, oy=100.0)) is None


def test_fix_span_box_survives_junk():
    assert api._fix_span_box({}) is None
    assert api._fix_span_box({"bbox": (0, 0, 1, 1)}) is None
    assert api._fix_span_box(_span(y0=100.0, y1=110.0, oy=100.0, size=0.0)) is None


def test_fix_text_dict_leaves_rotated_lines_alone():
    """A vertical line's box is not built from the ascender along y at all."""
    data = {"blocks": [{"type": 0, "lines": [
        {"dir": (0.0, -1.0), "spans": [_span(y0=100.0, y1=110.0, oy=100.0)]},
    ]}]}
    assert api._fix_text_dict(data) == 0
    assert data["blocks"][0]["lines"][0]["spans"][0]["bbox"] == (50.0, 100.0, 150.0, 110.0)


def test_fix_text_dict_rebuilds_line_and_block_boxes():
    """Callers read all three boxes; a mix of repaired and stale ones is worse."""
    data = {"blocks": [{
        "type": 0,
        "bbox": (50.0, 100.0, 150.0, 130.0),
        "lines": [
            {"dir": (1.0, 0.0), "bbox": (50.0, 100.0, 150.0, 110.0),
             "spans": [_span(y0=100.0, y1=110.0, oy=100.0)]},
            {"dir": (1.0, 0.0), "bbox": (50.0, 120.0, 150.0, 130.0),
             "spans": [_span(y0=120.0, y1=130.0, oy=120.0)]},
        ],
    }]}
    assert api._fix_text_dict(data) == 2
    b = data["blocks"][0]
    assert b["lines"][0]["bbox"] == (50.0, 91.0, 150.0, 102.5)
    assert b["lines"][1]["bbox"] == (50.0, 111.0, 150.0, 122.5)
    assert b["bbox"] == (50.0, 91.0, 150.0, 122.5)


def test_fix_text_dict_skips_image_blocks():
    data = {"blocks": [{"type": 1, "bbox": (0, 0, 10, 10)}]}
    assert api._fix_text_dict(data) == 0


def test_fix_span_box_guard_old_behaviour_would_fail_the_grid():
    """Rebuild the pre-fix behaviour (never repair) and demand the grid notices.

    Without this a future "simplification" that returns None unconditionally
    would leave every case above green except the two that assert a repair - and
    it is easy to convince yourself those two are the odd ones out.
    """
    quirk = _span(y0=100.0, y1=110.0, oy=100.0)
    assert api._fix_span_box(quirk) is not None, (
        "the quirk span must be repaired; returning None here IS the shipped bug"
    )



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
        test_fix_span_box_leaves_a_normal_font_alone,
        test_fix_span_box_repairs_baseline_on_top_edge,
        test_fix_span_box_is_scale_free,
        test_fix_span_box_keeps_the_fonts_own_metrics_when_they_are_bigger,
        test_fix_span_box_skips_a_squashed_box,
        test_fix_span_box_survives_junk,
        test_fix_text_dict_leaves_rotated_lines_alone,
        test_fix_text_dict_rebuilds_line_and_block_boxes,
        test_fix_text_dict_skips_image_blocks,
        test_fix_span_box_guard_old_behaviour_would_fail_the_grid,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All helper tests passed.")
