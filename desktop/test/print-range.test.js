"use strict";

// Regression net for the print dialog's page-range arithmetic.
//
// WHY THIS GRID EXISTS. Printing pages 1-2 used to mean typing "1-2" into the
// SYSTEM print dialog, where the number counts printed SHEETS, not document pages
// — so a page that spilled onto a second sheet made "1-2" print page 1 twice. The
// sheet spill is fixed in app.css (BI-43); this file guards the other half, the
// range box Nabu now owns. A mistake here is silent in the worst way: the job
// spools, the printer runs, and the wrong pages come out on paper.
//
// `printPageIndices` / `syncPrintPages` live in `app.js`, which cannot be
// require()d (it touches document / pdf.js at top level — docs/REGRESSION-GUARD.md
// §1). So, same technique as `viewer-geom.test.js`: LIFT THEM OUT OF THE SHIPPED
// FILE at run time by brace-matching and eval. What is tested is literally what
// ships, and a rename breaks this file loudly instead of quietly ending coverage.
//
// `window.PageRange` is the REAL page-range.js — the parser is not re-implemented
// here (BI-27). What this grid pins is the layer above it: blank = all pages, the
// preview sentence, and the gate on the "In" button.
//
// Run:  node desktop/test/print-range.test.js      (or: npm run test:print)

const fs = require("fs");
const path = require("path");

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

// Pull `function NAME(...) { ... }` out of a source file by matching braces from the
// header's opening brace. Throws loudly if the function is gone or renamed.
function extractFn(file, name) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in ${file} — renamed or removed?`);
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      // eslint-disable-next-line no-eval
      if (depth === 0) return eval("(" + src.slice(at, i + 1) + ")");
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}() from ${file}`);
}

// ---- the scope the lifted functions close over ---------------------------
//
// A direct eval inherits this module's scope chain, so the bare names the browser
// resolves against app.js's globals resolve against these at call time.

const state = { numPages: 0 };
const dom = {};
function $(id) {
  return dom[id] || null;
}
// i18n's t(): Vietnamese passthrough + {name} substitution. Same contract as
// renderer/i18n.js, so the expected strings below are the real UI strings.
function t(vi, params) {
  let s = vi;
  if (params) for (const k in params) s = s.replace(new RegExp("\\{" + k + "\\}", "g"), params[k]);
  return s;
}
const window = { PageRange: require("../renderer/page-range.js") };

const printPageIndices = extractFn("renderer/app.js", "printPageIndices");
const syncPrintPages = extractFn("renderer/app.js", "syncPrintPages");

// Fresh fake dialog. `spec` is what the user typed into #print-pages.
function open(total, spec) {
  state.numPages = total;
  dom["print-pages"] = { value: spec };
  dom["print-pages-hint"] = { textContent: "" };
  dom["print-ok"] = { disabled: false };
  syncPrintPages();
  return { sel: printPageIndices(), hint: dom["print-pages-hint"].textContent, ok: !dom["print-ok"].disabled };
}

// ---- blank box = every page (the behaviour from before the box existed) ----

check("blank prints all 4 pages", open(4, "").sel.indices, [0, 1, 2, 3]);
check("blank reports all:true", open(4, "").sel.all, true);
check("blank keeps In enabled", open(4, "").ok, true);
check("blank hint counts the document", open(4, "").hint, "Sẽ in tất cả 4 trang.");
check("whitespace only is still blank", open(4, "   ").sel.indices, [0, 1, 2, 3]);
check("blank on a 1-page doc", open(1, "").sel.indices, [0]);

// ---- the ranges people actually type -------------------------------------

check("1-2 on the BBNT file", open(4, "1-2").sel.indices, [0, 1]);
check("1-2 is not all:true", open(4, "1-2").sel.all, false);
check("single page", open(4, "3").sel.indices, [2]);
check("list", open(10, "1, 4, 9").sel.indices, [0, 3, 8]);
check("range + list", open(10, "1-3, 5, 8-10").sel.indices, [0, 1, 2, 4, 7, 8, 9]);
check("spaces inside a range", open(10, "1 - 3, 5").sel.indices, [0, 1, 2, 4]);
check("en dash pasted from Word", open(10, "1–3").sel.indices, [0, 1, 2]);
check("semicolon separator", open(10, "5;7").sel.indices, [4, 6]);
check("reversed pair is swapped, not dropped", open(10, "3-1").sel.indices, [0, 1, 2]);
check("out-of-order input comes back sorted", open(10, "5,1").sel.indices, [0, 4]);
check("duplicates collapse", open(10, "2,2,2-2").sel.indices, [1]);

// ---- BI-27: junk is SKIPPED and over-range is CLAMPED, so the preview must
//      show the result. These two cases are the reason the hint is mandatory.

check("one junk token doesn't reject the whole string", open(10, "1-2, abc, 5").sel.indices, [0, 1, 4]);
check("\"99\" on a 4-page doc clamps to the last page", open(4, "99").sel.indices, [3]);
check("...and the hint says so before you press In", open(4, "99").hint, "Sẽ in 1 trang: 4.");
check("\"-3\" is junk, not page 1", open(10, "-3").sel.indices, []);
check("\"3-\" is junk too", open(10, "3-").sel.indices, []);

// ---- the gate on "In" -----------------------------------------------------

check("unrecognisable text disables In", open(4, "abc").ok, false);
check("...and says what to type", open(4, "abc").hint, "Chưa nhận ra trang nào — vd: 1-2, 5, 8-10.");
check("a valid range enables In", open(4, "2").ok, true);
check("no document at all disables In", open(0, "").ok, false);
check("no document yields no pages", open(0, "").sel.indices, []);
check("no document, typed range, still nothing", open(0, "1-2").sel.indices, []);

// ---- the preview sentence -------------------------------------------------

check("contiguous range is summarised with an en dash", open(10, "1-3").hint, "Sẽ in 3 trang: 1–3.");
check("gaps are listed", open(10, "1, 4-6, 10").hint, "Sẽ in 5 trang: 1, 4–6, 10.");
check("count matches the indices", (() => {
  const r = open(10, "2-4, 8");
  return [r.sel.indices.length, r.hint];
})(), [4, "Sẽ in 4 trang: 2–4, 8."]);

// ---- every t() key the print dialog uses must exist in the i18n dictionary --
// Otherwise the English UI silently shows Vietnamese (BI-10's neighbour: a missing
// key is not an error at runtime, t() just returns its input).

const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
for (const key of [
  "Sẽ in tất cả {n} trang.",
  "Sẽ in {n} trang: {list}.",
  "Chưa nhận ra trang nào — vd: 1-2, 5, 8-10.",
  "Đang chuẩn bị in… (trang {n}/{total})",
  "Đang chuẩn bị in…",
  "Trang cần in — để trống là in tất cả",
  "vd: 1-2, 5, 8-10",
]) {
  check(`i18n has "${key}"`, i18nSrc.includes('"' + key + '"'), true);
}
// The live hint must be exempt from the i18n re-render, or switching language
// overwrites "Sẽ in 2 trang: 1–2." with the static source text (BI-10).
check("print-pages-hint is in SKIP_IDS", /SKIP_IDS[\s\S]{0,1200}"print-pages-hint"/.test(i18nSrc), true);

// ---- summary -------------------------------------------------------------

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
