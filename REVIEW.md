# api.py — function review (Phase 2, read-only)

Scope: `api.py` @ 2963 lines, 25 routes. This is an observations log to drive the
optimize (Phase 3) and refactor (Phase 4) steps. **No code was changed to produce
it.** Every item below is verified against the source, not inferred. Line numbers
are from the reviewed revision and will drift once edits start.

Regression net in place before any of this is acted on: `run_tests.py` → 7 files,
~85 tests, every endpoint covered. Nothing here is actioned without the net green
before and after.

---

## 1. Dead code (safe to delete, Phase 3)

| Item | Line | Evidence |
|------|------|----------|
| `_LEGACY_FONT_MARKERS = (".vn","vn","vni","tcvn")` | 1593 | Defined once, **0 uses**. `_is_legacy_font` (1596) does its own `startswith("vn") / "tcvn" in f / startswith("vni")` checks and ignores this tuple. Stale leftover. |

No other unused module-level symbol found (every helper `_cell_of`, `_visual_lines`,
`_split_runs`, `_run_boxes`, `_block_from_spans`, `_split_block_by_cells`,
`_page_text_blocks`, `_translate_blocks`, `_dejavu_variant`, `_mask_terms`,
`_unmask_terms` has ≥1 live caller).

---

## 2. Duplication (quantified — Phase 3/4 consolidation targets)

The "decode → size-check → open" preamble and the "timestamp → b64encode response"
tail are copy-pasted across the PDF endpoints. Counts in the current file:

| Pattern | Count | Note |
|---------|-------|------|
| inline `base64.b64decode(req.pdf_b64)` | 8 | `_decode_pdf_b64` helper (1006) already exists but only 6 sites use it |
| inline `if len(req.pdf_b64) > _MAX_PDF_B64` | 13 | same guard, hand-written each time |
| inline `fitz.open(stream=pdf_bytes, filetype="pdf")` + try/except | 12 | same 400 message each time |
| local `import fitz` inside a function | 10 | vs 19 `_require_fitz()` calls — mixed convention |
| `datetime.now().strftime("%Y%m%d_%H%M%S")` response ts | 13 | identical |
| `base64.b64encode(out_bytes).decode("ascii")` | 13 | identical |

There is already a comment at 999–1004 acknowledging this: the shared helpers were
added for the "P7" endpoints and older endpoints "keep their inline version to stay
surgical." That was the right call at the time; with a test net it can now be unified.

**Proposed helper (Phase 3), behaviour-preserving:**
```python
def _open_req_pdf(pdf_b64: str):
    """size-check -> decode -> fitz.open, raising the same HTTPExceptions as today."""
```
Swapping the 12 inline preambles onto it removes ~50 lines and one class of
copy-paste drift (e.g. the size-cap or the error message getting fixed in only
some endpoints). Each swap is guarded by an existing endpoint test.

*Caveat:* the inline error strings differ slightly per endpoint ("không nén được",
"không mở khoá được", …). Preserve those by passing the message in, or accept the
generic one only where a test doesn't pin the exact text. Do NOT change any status
code or user-facing Vietnamese string silently.

---

## 3. Long functions (Phase 4 — extract internals, don't split routes)

| Function | Lines | Span | Refactor note |
|----------|-------|------|---------------|
| `edit_text` (/edit-text) | ~224 | 1911–2135 | Font-resolution + coverage-fallback block is the bulk; already leans on `_dejavu_variant`, `_resolve_local_font`, `_BUILTIN_VARIANTS`, `_fresh_fontname`. Extract the "pick an embeddable font for this edit" decision into one helper. Heavily covered by `test_edit_text_rounds.py`. |
| `translate_pdf` (/translate-pdf) | ~218 | 2544–2762 | Layout/geometry already factored into `_table_cells`…`_page_text_blocks`. The route body is orchestration; low duplication. Covered by `test_translate_layout.py`. |

These are long but cohesive and well-tested. Prefer extracting **named internal
helpers** over splitting the route — keeps the single import surface (`from api
import edit_text`) that the tests and `main.js` depend on.

---

## 4. Refactor seams (Phase 4 — Conservative extraction to `src/pdf/`)

Pure, side-effect-free, already-tested → cheapest to move, zero behaviour risk:

| New module | Helpers to move |
|------------|-----------------|
| `src/pdf/fonts.py` | `_vietnamese_font`, `_dejavu_variant`, `_font_covers`, `_fresh_fontname`, `_clean_font_name`, `_norm_fam`, `_family_index`, `_resolve_local_font`, `_list_local_font_families`, `_DEJAVU_SUFFIX`, `_BUILTIN_VARIANTS`, `_FAM_INDEX`, `_LOCAL_FONT_CACHE`, `_FONT_PATH` |
| `src/pdf/legacy_text.py` | `_is_legacy_font`, `_has_mojibake_chars`, `_span_is_suspect`, `_transcode_tcvn3`, `_looks_vietnamese`, `_TCVN3_MAP` |
| `src/pdf/layout.py` | `_table_cells`, `_cell_of`, `_cell_layout`, `_visual_lines`, `_split_runs`, `_run_boxes`, `_block_from_spans`, `_split_block_by_cells`, `_page_text_blocks`, `_fit_fontsize`, `_mask_terms`, `_unmask_terms`, `_norm_color` |
| `src/pdf/util.py` | `_decode_pdf_b64`, `_require_fitz`, `_hex_rgb01`, `_fmt_page_label`, `_parse_ranges`, `_open_req_pdf` (new) |

Expected api.py reduction: ~800–1000 lines → routes + Pydantic models remain.

**Hard constraints for Phase 4:**
- Global caches (`_FAM_INDEX`, `_LOCAL_FONT_CACHE`, `_FONT_PATH`, `ocr_engine`,
  `gemini_agent`) move with their owning module; api.py keeps re-exporting the
  route names.
- `sidecar.spec` / PyInstaller: new `src/pdf/*` modules must be collected. Verify
  the frozen sidecar imports them (rebuild + smoke test) — this is the one step
  the unit tests can't catch.
- Test imports switch from `from api import _x` to `from src.pdf... import _x`;
  route tests keep `from api import <route>`.
- Do it one module at a time, `run_tests.py` green after each.

---

## 5. Correctness — nothing actionable found

No wrong status codes, no obvious logic bug surfaced while reading + while writing
the characterization tests (every endpoint returned what its contract implies).
The tests now *pin* that behaviour, including the deliberate quirks:
- `_parse_ranges` clamps `0`→page 1 and swaps reversed ranges rather than erroring.
- `compress` hands back the original bytes if "compression" grew the file (924–926).
- `_span_is_suspect` flags proper-Unicode Vietnamese sitting in a legacy `.Vn` font
  (so the UI can offer recovery) — intended, now locked by a test.

If any of these are later judged wrong, fix them in a **separate** commit with a
test that goes red→green — never fold a behaviour change into the refactor.
