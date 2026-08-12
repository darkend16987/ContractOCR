"use strict";

// Regression net for the arithmetic behind Tìm & Thay thế (renderer/find-replace.js).
//
// WHY THIS EXISTS. Every failure mode in this code is SILENT. Splice two occurrences
// in the wrong order and the request still succeeds, the PDF still opens, and a word
// somewhere else on the line has quietly lost three letters. Build two edits for one
// span and the second one — rebuilt from the ORIGINAL text — undoes the first, so the
// user is told "đã thay 2 vị trí" while one of them is still there. Nothing else in
// the app would notice any of that, which is exactly the criterion §1 of
// docs/REGRESSION-GUARD.md uses for "this needs a grid".
//
// Run:  node desktop/test/find-replace.test.js      (or: npm run test:find)

const path = require("path");
const FR = require(path.join(__dirname, "..", "renderer", "find-replace.js"));

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

// A hit shaped exactly like one element of /text-find's `hits` array.
function hit(over) {
  return Object.assign(
    {
      id: 0,
      page: 0,
      span: 0,
      start: 0,
      end: 3,
      span_text: "hop dong so 12 hop le",
      bbox: [50, 100, 250, 112],
      bbox_view: [50, 100, 250, 112],
      origin: [50, 110],
      size: 11,
      font: "Times-Roman",
      color: 0,
      flags: 0,
      replaceable: true,
    },
    over || {}
  );
}

// ---- spliceOccurrences ----------------------------------------------------

const T = "hop dong va hop tac";
check("single occurrence", FR.spliceOccurrences(T, [{ start: 0, end: 3 }], "HĐ"), "HĐ dong va hop tac");

// THE bug this grid exists for: applied left-to-right, the second range would be
// measured against a string whose length already changed.
check(
  "two occurrences, longer replacement",
  FR.spliceOccurrences(T, [{ start: 0, end: 3 }, { start: 12, end: 15 }], "HĐ"),
  "HĐ dong va HĐ tac"
);
check(
  "two occurrences, shorter replacement",
  FR.spliceOccurrences(T, [{ start: 0, end: 3 }, { start: 12, end: 15 }], "x"),
  "x dong va x tac"
);
check(
  "order of the input list must not matter",
  FR.spliceOccurrences(T, [{ start: 12, end: 15 }, { start: 0, end: 3 }], "HĐ"),
  "HĐ dong va HĐ tac"
);
check(
  "three occurrences stay aligned",
  FR.spliceOccurrences("a b a b a", [{ start: 0, end: 1 }, { start: 4, end: 5 }, { start: 8, end: 9 }], "ZZZ"),
  "ZZZ b ZZZ b ZZZ"
);
check("empty replacement deletes", FR.spliceOccurrences(T, [{ start: 0, end: 4 }], ""), "dong va hop tac");
check("no occurrences → unchanged", FR.spliceOccurrences(T, [], "x"), T);
check("null list → unchanged", FR.spliceOccurrences(T, null, "x"), T);
check("null text → empty string", FR.spliceOccurrences(null, [{ start: 0, end: 1 }], "x"), "");
// Guards: a malformed range must leave the document alone rather than corrupt it.
check("range past end ignored", FR.spliceOccurrences("abc", [{ start: 1, end: 99 }], "X"), "abc");
check("negative start ignored", FR.spliceOccurrences("abc", [{ start: -1, end: 2 }], "X"), "abc");
check("empty range ignored", FR.spliceOccurrences("abc", [{ start: 1, end: 1 }], "X"), "abc");
// Overlaps cannot arise from the real pipeline — _find_occurrences advances past each
// match, so a span's occurrences are non-overlapping by construction, and groupEdits
// only ever collects occurrences from one such scan. This is a defensive guard, and
// what it must guarantee is "never splice with stale offsets", not any particular
// winner. Splicing runs right-to-left, so the RIGHTMOST range is applied and the one
// that overlaps it is dropped. Pinned so a refactor that changes it gets noticed.
check(
  "overlapping ranges — one applied, the other dropped, never corrupted",
  FR.spliceOccurrences("abcdef", [{ start: 0, end: 4 }, { start: 2, end: 6 }], "X"),
  "abX"
);
check("replacement containing the query is inserted verbatim", FR.spliceOccurrences("hop", [{ start: 0, end: 3 }], "hop dong"), "hop dong");
// Vietnamese: JS strings are UTF-16 and these are all in the BMP, so offsets are
// plain character counts — the property /text-find's offsets rely on.
check(
  "diacritics do not shift offsets",
  FR.spliceOccurrences("Bên A ký hợp đồng", [{ start: 9, end: 17 }], "phụ lục"),
  "Bên A ký phụ lục"
);

// ---- hitRect --------------------------------------------------------------

check(
  "match in the middle of a span",
  FR.hitRect(hit({ bbox_view: [0, 0, 100, 10], span_text: "0123456789", start: 5, end: 7 })),
  { x0: 50, y0: 0, x1: 70, y1: 10 }
);
check(
  "whole span (a cross-span hit spans its union box exactly)",
  FR.hitRect(hit({ bbox_view: [20, 5, 120, 17], span_text: "abcde", start: 0, end: 5 })),
  { x0: 20, y0: 5, x1: 120, y1: 17 }
);
check(
  "offsets past the text are clamped, never negative-width",
  FR.hitRect(hit({ bbox_view: [0, 0, 100, 10], span_text: "abc", start: 99, end: 200 })),
  { x0: 100, y0: 0, x1: 100, y1: 10 }
);
check(
  "empty span text does not divide by zero",
  FR.hitRect(hit({ bbox_view: [0, 0, 100, 10], span_text: "", start: 0, end: 0 })),
  { x0: 0, y0: 0, x1: 0, y1: 10 }
);
check(
  "falls back to bbox when the sidecar sent no bbox_view",
  FR.hitRect({ bbox: [0, 0, 40, 8], bbox_view: null, span_text: "ab", start: 1, end: 2 }),
  { x0: 20, y0: 0, x1: 40, y1: 8 }
);

// ---- editForSpan ----------------------------------------------------------

const e1 = FR.editForSpan(hit({ start: 0, end: 8, span_text: "hop dong so 12" }), [{ start: 0, end: 8 }], "phu luc");
check("edit.new_text is the spliced span", e1.new_text, "phu luc so 12");
check("edit carries the span box /edit-text redraws into", e1.bbox, [50, 100, 250, 112]);
check("edit carries the baseline origin", e1.origin, [50, 110]);
// BI-25: without these the backend cannot recover the geometry the document drew the
// run at, and replacements come out too long and too tall.
check("edit carries orig_text", e1.orig_text, "hop dong so 12");
check("edit carries orig_size", e1.orig_size, 11);
check("edit keeps the span's own font (BI-21)", e1.font, "Times-Roman");
check("edit adds no background fill", e1.bg, null);
check(
  "missing font falls back to a named family, not empty string",
  FR.editForSpan(hit({ font: "" }), [{ start: 0, end: 3 }], "x").font,
  "default"
);
check("bold comes from flag bit 4", FR.editForSpan(hit({ flags: 16 }), [{ start: 0, end: 3 }], "x").bold, true);
check("italic comes from flag bit 1", FR.editForSpan(hit({ flags: 2 }), [{ start: 0, end: 3 }], "x").italic, true);
check("bold+italic together", [
  FR.editForSpan(hit({ flags: 18 }), [{ start: 0, end: 3 }], "x").bold,
  FR.editForSpan(hit({ flags: 18 }), [{ start: 0, end: 3 }], "x").italic,
], [true, true]);
check("plain span is neither", [
  FR.editForSpan(hit({ flags: 0 }), [{ start: 0, end: 3 }], "x").bold,
  FR.editForSpan(hit({ flags: 0 }), [{ start: 0, end: 3 }], "x").italic,
], [false, false]);
check("colour packs to #rrggbb", FR.editForSpan(hit({ color: 0xff0000 }), [{ start: 0, end: 3 }], "x").color, "#ff0000");
check("black stays padded to six digits", FR.editForSpan(hit({ color: 0 }), [{ start: 0, end: 3 }], "x").color, "#000000");

// ---- spanKey / groupEdits -------------------------------------------------

check("replaceable hits key by page:span", FR.spanKey(hit({ page: 2, span: 7 })), "2:7");
check("cross-span hits have no key", FR.spanKey(hit({ replaceable: false })), null);

// THE second bug this grid exists for. /edit-text redacts the span's box and redraws
// it from new_text, so two edits on the same span would BOTH start from the original
// text and the second would wipe out the first.
const sameSpan = [
  hit({ id: 0, page: 0, span: 3, span_text: "hop dong va hop tac", start: 0, end: 3 }),
  hit({ id: 1, page: 0, span: 3, span_text: "hop dong va hop tac", start: 12, end: 15 }),
];
const grouped = FR.groupEdits(sameSpan, "HĐ");
check("two hits in one span produce ONE edit", grouped.length, 1);
check("…and that edit has both replaced", grouped[0].new_text, "HĐ dong va HĐ tac");

const twoSpans = [
  hit({ id: 0, page: 0, span: 1, span_text: "hop dong", start: 0, end: 3 }),
  hit({ id: 1, page: 0, span: 2, span_text: "hop tac", start: 0, end: 3 }),
];
check("hits in different spans produce two edits", FR.groupEdits(twoSpans, "X").length, 2);

const acrossPages = [
  hit({ id: 0, page: 0, span: 1, span_text: "hop dong", start: 0, end: 3 }),
  hit({ id: 1, page: 4, span: 1, span_text: "hop tac", start: 0, end: 3 }),
];
check("same span index on different pages is not the same span", FR.groupEdits(acrossPages, "X").length, 2);
check("edits keep their page", FR.groupEdits(acrossPages, "X").map((e) => e.page).sort(), [0, 4]);

check(
  "cross-span hits are never turned into edits",
  FR.groupEdits([hit({ replaceable: false }), hit({ span: 9 })], "X").length,
  1
);
check("nothing replaceable → no edits", FR.groupEdits([hit({ replaceable: false })], "X"), []);
check("empty list → no edits", FR.groupEdits([], "X"), []);
check("null list → no edits", FR.groupEdits(null, "X"), []);

// ---- ordering + cursor ----------------------------------------------------

check("hitOrder is page, top, left, offset", FR.hitOrder(hit({ page: 3, bbox_view: [12.34, 56.78, 99, 60], start: 5 })), [3, 56.8, 12.3, 5]);

const list = [
  hit({ id: 0, page: 0, bbox_view: [50, 100, 250, 112], start: 0 }),
  hit({ id: 1, page: 0, bbox_view: [50, 100, 250, 112], start: 20 }),
  hit({ id: 2, page: 0, bbox_view: [50, 300, 250, 312], start: 0 }),
  hit({ id: 3, page: 5, bbox_view: [50, 80, 250, 92], start: 0 }),
];
check("no anchor → first hit", FR.indexAtOrAfter(list, null), 0);
check("empty list → -1", FR.indexAtOrAfter([], { page: 0, top: 0, left: 0, start: 0 }), -1);
// After replacing hit 0, the anchor sits just past the inserted text (start 0 + len).
// Hit 1 is further along the SAME line, so that is where Find Next resumes.
check(
  "resumes at the next match on the same line",
  FR.indexAtOrAfter(list, { page: 0, top: 100, left: 50, start: 5 }),
  1
);
check(
  "an anchor past everything on the line moves to the next line",
  FR.indexAtOrAfter(list, { page: 0, top: 100, left: 50, start: 999 }),
  2
);
check("anchor on a later page skips the earlier ones", FR.indexAtOrAfter(list, { page: 5, top: 0, left: 0, start: 0 }), 3);
check("past the last match wraps to the top", FR.indexAtOrAfter(list, { page: 99, top: 0, left: 0, start: 0 }), 0);
// The loop-guard: a replacement that CONTAINS the query ("hợp đồng" → "phụ lục hợp
// đồng") creates a fresh match inside the text just written. The anchor is past the
// inserted text, so that match is stepped over instead of being offered forever.
check(
  "a match created inside the replacement is stepped over",
  FR.indexAtOrAfter(
    [hit({ id: 0, page: 0, bbox_view: [50, 100, 250, 112], start: 9 }), hit({ id: 1, page: 0, bbox_view: [50, 100, 250, 112], start: 40 })],
    { page: 0, top: 100, left: 50, start: 17 }
  ),
  1
);

check("step forward", FR.stepIndex(0, 3, 1), 1);
check("step forward wraps", FR.stepIndex(2, 3, 1), 0);
check("step back wraps", FR.stepIndex(0, 3, -1), 2);
check("step from nothing selected", FR.stepIndex(-1, 3, 1), 0);
check("step with no hits", FR.stepIndex(0, 0, 1), -1);

// ---- summarise ------------------------------------------------------------

check("counts split replaceable vs crossing", FR.summarise([hit({}), hit({ replaceable: false }), hit({})]), {
  total: 3,
  crossing: 1,
  replaceable: 2,
});
check("empty", FR.summarise([]), { total: 0, crossing: 0, replaceable: 0 });
check("null", FR.summarise(null), { total: 0, crossing: 0, replaceable: 0 });

// ---- the module must stay require()-able without a DOM --------------------
// find-replace.js also contains the panel, wired at load time. If the DOM half ever
// escapes its `typeof document === "undefined"` gate, this file would throw on the
// require above — but assert the exported surface too, so a rename is caught here
// rather than by a blank panel in the app (BI-14).
for (const fn of [
  "spliceOccurrences", "hitRect", "editForSpan", "spanKey",
  "groupEdits", "hitOrder", "indexAtOrAfter", "stepIndex", "summarise",
]) {
  check(`exports ${fn}`, typeof FR[fn], "function");
}

// ---- every tr() key must exist in the i18n dictionary ---------------------
//
// Same guard print-range.test.js carries, and for the same reason: a missing key is
// not an error at runtime — t() just returns its input — so the English UI silently
// shows Vietnamese and only a bilingual reader would ever notice.

const fs = require("fs");
const srcPath = path.join(__dirname, "..", "renderer", "find-replace.js");
const src = fs.readFileSync(srcPath, "utf8");
const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");

const trKeys = new Set();
// tr("…") and tr('…'), honouring backslash escapes inside the literal.
const re = /\btr\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
let m;
while ((m = re.exec(src))) {
  const lit = m[1];
  // Unescape the JS literal to the string the dictionary is keyed by.
  trKeys.add(lit.slice(1, -1).replace(/\\(['"\\])/g, "$1"));
}
check("tr() is actually used for runtime strings", trKeys.size > 10, true);
for (const key of trKeys) {
  // i18n.js keys are written as double-quoted literals, so escape any inner quote
  // the same way the source does.
  const asLiteral = '"' + key.replace(/"/g, '\\"') + '"';
  check(`i18n has ${JSON.stringify(key)}`, i18nSrc.includes(asLiteral), true);
}

// The live status line is rewritten on every keystroke; leaving it out of SKIP_IDS
// means a language switch overwrites "3/12 kết quả" with stale static text (BI-10).
check("fr-status is in SKIP_IDS", /SKIP_IDS[\s\S]{0,2000}"fr-status"/.test(i18nSrc), true);

// The panel writes through /edit-text, so its button must be gated like every other
// paid entry point — and Ctrl+H, which has no button, is gated inside canRun() (BI-9,
// BI-26). Both halves are asserted because either one alone leaves a hole.
const appSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
check("btn-find-replace is in GATED_BTNS", /GATED_BTNS[\s\S]{0,1500}"btn-find-replace"/.test(appSrc), true);
check("canRun() gates the keyboard entry point", /function canRun\(\)[\s\S]{0,400}gateProFeature\(\)/.test(src), true);

// BI-2: writing to the bytes underneath a live editor desyncs its pending edits.
check("refuses to run while an editor is active", /Editor[\s\S]{0,200}\.active[\s\S]{0,400}TextEdit[\s\S]{0,120}\.active/.test(src), true);

// BI-3: the undo step must be pushed BEFORE state.bytes moves, not after.
const pushIdx = src.indexOf("DocHistory.pushUndo");
const assignIdx = src.indexOf("state.bytes = new Uint8Array");
check("pushUndo comes before state.bytes is replaced", pushIdx > 0 && pushIdx < assignIdx, true);

// ---- the scan is EXPLICIT (v0.2.56) ---------------------------------------
//
// Search-as-you-type was the original design and it does not survive contact with a
// real document: one keystroke = base64 the whole PDF + reopen it + get_text("dict")
// every page, which is milliseconds on a 3-page contract and tens of seconds on a
// 480-page A1 set. Typing "2026" fired four of those, and they raced.

const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");

check(
  "typing marks the result stale instead of scanning",
  /\$\("fr-find"\)\.addEventListener\("input",\s*\(\)\s*=>\s*markStale\(\)\)/.test(src),
  true
);
check(
  "no scan is wired to the input event",
  /addEventListener\("input"[\s\S]{0,160}runFind/.test(src),
  false
);
check("there is a button to start the scan", /id="fr-go"/.test(htmlSrc), true);
check("that button is wired to runFind", /\$\("fr-go"\)\.onclick\s*=\s*\(\)\s*=>\s*runFind\(/.test(src), true);
check("toggling an option does not scan either", /\$\("fr-case"\)\.onchange\s*=\s*\(\)\s*=>\s*markStale\(\)/.test(src), true);

// A second scan landing on top of the first is how "không tìm thấy" got reported for
// a word that IS in the document: the older, slower answer won.
check("scans carry a generation number", /\+\+fr\.runSeq/.test(src), true);
check("a superseded scan does not paint", /seq !== fr\.runSeq/.test(src), true);

// The options were togglable mid-scan, which started a second walk of the same
// document while the first was still running.
const busyList = /for \(const id of \[([^\]]*)\]/.exec(src);
check("setBusy locks the options too", !!busyList && /"fr-case"[\s\S]*"fr-word"/.test(busyList[1]), true);
// …but the find box must NOT be disabled: a disabled input drops keystrokes and loses
// focus, so characters typed during a scan vanished.
check("the find box is not disabled mid-scan", !!busyList && !/"fr-find"/.test(busyList[1]), true);
check("the find box is read-only mid-scan instead", /readOnly = !!on/.test(src), true);

// THE bug behind "it only ever says không tìm thấy": setBusy(false) → refreshStatus()
// ran in runFind's `finally` and overwrote whatever had just been reported — the
// error, the "this is a scan" hint, the truncation warning. Every failure reached the
// user as "no matches found". A sticky message has to outrank the running count.
const stickyAt = src.indexOf("if (fr.sticky) return setStatus");
const countAt = src.indexOf('tr("Không tìm thấy kết quả nào.")');
check("refreshStatus paints a sticky message first", stickyAt > 0 && stickyAt < countAt, true);
// For each message that must survive: the painter call it is passed to has to be
// setSticky, not the wipeable setStatus.
function paintedStickily(label) {
  const at = src.indexOf(label);
  if (at < 0) return false;
  const before = src.slice(Math.max(0, at - 220), at);
  return before.lastIndexOf("setSticky(") > before.lastIndexOf("setStatus(");
}
for (const label of ["Lỗi tìm: {msg}", "Quá nhiều kết quả", "không có chữ thật", "PDF quá lớn để tìm"]) {
  check(`"${label}" survives the busy flag being cleared`, paintedStickily(label), true);
}

// ---- "Thay tất cả" must not promise more than the scan covered ------------
//
// /text-find stops at max_hits (5000). Measured on a 600-page file, a common word
// stops the walk on page 28 — 5% in. The confirm dialog is the ONLY place that tells
// the user what the action covers, so "trong toàn bộ tài liệu" there is a promise the
// app cannot keep: they replace 5000 of far more, are told it is done, and the rest
// sit untouched. The truncation is reported by runFind's sticky line, but replaceAll
// cannot read a sticky string — the flag has to live on `fr`.

check("the scan records that it was truncated", /fr\.truncated = !!data\.truncated/.test(src), true);
check("…and where it stopped", /fr\.truncatedPage = data\.truncated_page \|\| 0/.test(src), true);

// Reset BEFORE the request, not on the success path: every early return below (empty
// query, oversized file, transport error) would otherwise leave the previous scan's
// flag standing behind the next "Thay tất cả".
const resetAt = src.indexOf("fr.truncated = false");
const fetchAt = src.indexOf('sidecarFetch("/text-find-bin"');
check("the flag is cleared before the request goes out", resetAt > 0 && resetAt < fetchAt, true);

// The wording has to branch on it, and the "toàn bộ tài liệu" claim has to sit on the
// FALSE side of that branch rather than being emitted unconditionally.
check(
  "the confirm text branches on the truncation flag",
  /const head = fr\.truncated[\s\S]{0,260}tr\("Thay \{n\} vị trí trong toàn bộ tài liệu\?"/.test(src),
  true
);
check(
  "…and says so when the scan stopped early",
  /fr\.truncatedPage[\s\S]{0,200}Lượt quét dừng ở trang \{p\}/.test(src),
  true
);
// Closing the panel abandons the answer, so it must abandon the claim with it.
check(
  "closePanel clears the truncation flag",
  /function closePanel\(\)[\s\S]{0,600}fr\.truncated = false/.test(src),
  true
);

// ---- the two ceilings (v0.2.56) -------------------------------------------
//
// Reading and writing travel differently, so they have DIFFERENT limits, and the
// renderer has to mirror both. Get one wrong and it either refuses documents the
// sidecar would have taken, or lets the user press Thay on a document /edit-text is
// going to reject.
const utilPy = fs.readFileSync(path.join(__dirname, "..", "..", "src", "pdf", "util.py"), "utf8");
const apiPy = fs.readFileSync(path.join(__dirname, "..", "..", "api.py"), "utf8");
const num = (m) => (m ? Number(m[1].replace(/_/g, "")) : NaN);

const pyB64 = num(/_MAX_PDF_B64\s*=\s*([\d_]+)/.exec(utilPy));
const jsEdit = num(/const MAX_EDIT_B64 = ([\d_]+);/.exec(src));
check("renderer and sidecar agree on the WRITE ceiling", pyB64 === jsEdit && pyB64 > 0, true);

const pyBin = num(/_MAX_PDF_BIN\s*=\s*([\d_]+)/.exec(apiPy));
const jsFind = num(/const MAX_FIND_BIN = ([\d_]+);/.exec(src));
check("renderer and sidecar agree on the READ ceiling", pyBin === jsFind && pyBin > 0, true);
check("the read ceiling is the larger one", pyBin > pyB64, true);

// The whole point of 3a: searching must not go through base64 any more.
check("the search uses the binary route", /sidecarFetch\("\/text-find-bin"/.test(src), true);
check("…with the document as the request body", /body: new Blob\(\[state\.bytes\]/.test(src), true);
check("…and no base64 payload is built for it", /pdfJsonBody\(state\.bytes, \{\s*query/.test(src), false);
// /edit-text is untouched and still base64 — that is deliberate, and the grid pins it
// so nobody "tidies" the two paths into one without re-reading BI-21/23/25.
check("the write path still uses pdfJsonBody", /sidecarFetch\("\/edit-text\?raw=1"[\s\S]{0,220}pdfJsonBody/.test(src), true);
check("Thay is locked on a document too big to write", /lockWrite = fr\.busy \|\| fr\.stale \|\| overWriteLimit\(\)/.test(src), true);

// The endpoint must actually exist on the sidecar side, with a raw body.
check("/text-find-bin exists", /@app\.post\("\/text-find-bin"/.test(apiPy), true);
check("…and reads the body as bytes", /async def text_find_bin[\s\S]{0,1600}await request\.body\(\)/.test(apiPy), true);

console.log(`\nfind-replace: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
