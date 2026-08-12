"use strict";

// Regression net for uiConfirm's optional THIRD choice and the crash-recovery prompt
// that needed it.
//
// WHY THIS GRID EXISTS. One #confirm-modal is reused by every confirm in the app, so the
// third button's *visibility* is per-call state living on a shared element. Forget to
// re-hide it and a destructive "Xoá, không hỏi lại" button turns up on an unrelated
// yes/no question, wired to a resolution that caller never handles. That failure is
// silent in every automated sense: the dialog still works, it just grows a button.
//
// WHAT IS MEASURED WHERE. `uiConfirm` is DOM code, but it is promise-shaped and needs no
// document state, so it CAN be driven for real — and it was, in an Electron probe
// covering: third button resolves "third"; a following plain confirm has it hidden again;
// Esc / corner ✕ still resolve false with it present (no hung promise); ok still wins;
// and the dialog still has exactly ONE [data-modal-close], which is what Esc / backdrop
// / ✕ all click (app.js "dismissing a dialog" header). All five passed. node cannot host
// that (no DOM), so what this grid pins is the CONTRACT those cases depend on, in source
// — the same approach find-replace.js's DOM half and page-drop.test.js use.
//
// Run:  node desktop/test/confirm-dialog.test.js     (or: npm run test:confirm)

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const R = path.join(__dirname, "..", "renderer");
const APP = fs.readFileSync(path.join(R, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(R, "index.html"), "utf8");
const I18N = fs.readFileSync(path.join(R, "i18n.js"), "utf8");

// ---- 1. the markup ---------------------------------------------------------
// Slice out exactly the confirm dialog: from its id to the start of the next .modal, so
// a count inside it cannot accidentally pick up a neighbouring dialog's buttons.
const at = HTML.indexOf('id="confirm-modal"');
check("index.html still has #confirm-modal", at >= 0, true);
const nextModal = HTML.indexOf('class="modal"', at);
// Comments stripped first: the markup carries a note explaining why the third button must
// NOT be data-modal-close, and counting the attribute would otherwise count that prose.
const block = HTML.slice(at, nextModal < 0 ? HTML.length : nextModal).replace(/<!--[\s\S]*?-->/g, "");

check("the confirm dialog has EXACTLY one data-modal-close",
  (block.match(/data-modal-close/g) || []).length, 1);
check("the third button exists", /id="confirm-third"/.test(block), true);

const thirdTag = /<button id="confirm-third"[^>]*>/.exec(block);
check("the third button is a real <button>", !!thirdTag, true);
check("… starts hidden (a plain confirm must not show it)", /\bhidden\b/.test(thirdTag[0]), true);
// If it ever carried data-modal-close, Esc / backdrop / ✕ would click the DESTRUCTIVE
// button instead of cancel — the exact opposite of what those gestures mean.
check("… and is NOT the dismiss button", /data-modal-close/.test(thirdTag[0]), false);
check("the dismiss button is still #confirm-cancel",
  /<button id="confirm-cancel" data-modal-close>/.test(block), true);

// ---- 2. the uiConfirm contract --------------------------------------------
check("thirdText is opt-in with a null default",
  /thirdText = null\s*\}\s*=\s*opts \|\| \{\}/.test(APP), true);
// The reuse reset. Both halves matter: set on open (so it appears only when asked for)
// and cleared in finish() (so it cannot outlive the dialog that requested it).
check("the third button is (re)hidden on EVERY open", /thirdBtn\.hidden = !thirdText;/.test(APP), true);
check("… and hidden again when the dialog resolves",
  /const finish = \(val\) => \{[\s\S]{0,300}?thirdBtn\.hidden = true;/.test(APP), true);
check("it resolves the distinct sentinel \"third\"",
  /const onThird = \(\) => finish\("third"\);/.test(APP), true);
check("its listener is removed with the others",
  /thirdBtn\.removeEventListener\("click", onThird\);/.test(APP), true);
// Enter/Escape must keep meaning ok/cancel — a destructive choice gets no hotkey.
check("no keyboard path reaches the third choice",
  /finish\("third"\)/g.test(APP) && (APP.match(/finish\("third"\)/g) || []).length, 1);

// ---- 3. the recovery prompt (the reason the third choice exists) ----------
check("declining still keeps the snapshots for a later launch",
  /if \(!answer\) return; \/\/ "Để sau"/.test(APP), true);
check("the cancel button says \"Để sau\", not \"Bỏ qua\"", /cancelText: "Để sau"/.test(APP), true);
check("the third choice is handled BEFORE the truthiness check",
  APP.indexOf('if (answer === "third")') < APP.indexOf("if (!answer) return;"), true);
// The label has to carry the count: the message names only the most recent document, so
// an unqualified "không hỏi lại" would delete files the user was never shown.
check("the label states how many snapshots will go",
  /thirdText: more \? `Xoá cả \$\{orphans\.length\} bản, không hỏi lại` : "Xoá, không hỏi lại"/.test(APP), true);
check("choosing it clears EVERY orphan, not just the offered one",
  /for \(const o of orphans\) \{[\s\S]{0,300}?recovery\.clear\(o\.docId\)/.test(APP), true);
check("a failed delete is reported instead of silently re-prompting next launch",
  /Không xoá được \$\{failed\} bản khôi phục/.test(APP), true);

// ---- 4. i18n (BI-10) ------------------------------------------------------
// Label and visibility are both per-call, so the language switcher must never capture
// this node into its registry.
check("confirm-third is in SKIP_IDS", /"confirm-third",/.test(I18N), true);
const skipAt = I18N.indexOf("const SKIP_IDS");
check("… inside the SKIP_IDS set, not somewhere else in the file",
  skipAt >= 0 && I18N.indexOf('"confirm-third"', skipAt) > skipAt, true);

console.log(`confirm-dialog: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
