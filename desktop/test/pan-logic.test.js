"use strict";

// Regression net for the hand-tool decision logic (renderer/pan.js).
//
// Why this file exists: `shouldPan` reads six pieces of state owned by four
// other renderer modules (annotation mode, text-edit mode, copy-image mode, the
// current tool, the space key, what is under the cursor). Get one of them wrong
// and the failure is silent and nasty — the hand tool starts eating the drags
// that annotating or the copy-image marquee need, in a layer that has no other
// automated coverage (docs/REGRESSION-GUARD.md §1).
//
// Run:  node desktop/test/pan-logic.test.js      (or: npm run test:pan)

const P = require("../renderer/pan.js");

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

// A document is open, nothing else is going on, text-selection tool.
const BASE = {
  button: 0,
  hasDoc: true,
  tool: "select",
  spaceHeld: false,
  overlayEditing: false,
  textEditing: false,
  capturing: false,
  onInteractive: false,
};
const withCtx = (o) => Object.assign({}, BASE, o);
const panning = (o) => P.shouldPan(withCtx(o));

// ---- shouldPan: the basics -----------------------------------------------

check("left drag with the select tool does NOT pan", panning({}), false);
check("left drag with the hand tool pans", panning({ tool: "hand" }), true);
check("left drag while space is held pans", panning({ spaceHeld: true }), true);
check("middle drag pans even on the select tool", panning({ button: 1 }), true);
check("right button never pans (context menus own it)", panning({ button: 2, tool: "hand" }), false);
check("unknown button never pans", panning({ button: 4, tool: "hand" }), false);

// ---- shouldPan: no document ----------------------------------------------

check("no document: left+hand does not pan", panning({ hasDoc: false, tool: "hand" }), false);
check("no document: middle does not pan", panning({ hasDoc: false, button: 1 }), false);
check("no document: space does not pan", panning({ hasDoc: false, spaceHeld: true }), false);

// ---- shouldPan: the other modes own the LEFT button ----------------------
// (BI-2 keeps annotate and text-edit mutually exclusive; both, plus copy-image,
// drag with the left button for their own purpose.)

check("annotating: left+hand must not steal the drag", panning({ overlayEditing: true, tool: "hand" }), false);
check("annotating: left+space must not steal the drag", panning({ overlayEditing: true, spaceHeld: true }), false);
check("text-editing: left+hand must not steal the drag", panning({ textEditing: true, tool: "hand" }), false);
check("copy-image: left+hand must not steal the marquee", panning({ capturing: true, tool: "hand" }), false);

// ---- shouldPan: middle button is unclaimed everywhere, so it always works --

check("annotating: middle still pans", panning({ overlayEditing: true, button: 1 }), true);
check("text-editing: middle still pans", panning({ textEditing: true, button: 1 }), true);
check("copy-image: middle still pans", panning({ capturing: true, button: 1 }), true);

// ---- shouldPan: don't eat clicks aimed at something -----------------------

check("hand tool over a note marker does not pan", panning({ tool: "hand", onInteractive: true }), false);
check("space over a note marker does not pan", panning({ spaceHeld: true, onInteractive: true }), false);
check("middle over a note marker still pans", panning({ button: 1, onInteractive: true }), true);

// ---- shouldPan: junk input ------------------------------------------------

check("no context at all", P.shouldPan(), false);
check("null context", P.shouldPan(null), false);

// ---- panScroll: the sign is the whole point ------------------------------

const start = { left: 100, top: 200 };
check(
  "dragging right moves the viewport left",
  P.panScroll(start, { x: 50, y: 50 }, { x: 80, y: 50 }),
  { left: 70, top: 200 }
);
check(
  "dragging left moves the viewport right",
  P.panScroll(start, { x: 50, y: 50 }, { x: 20, y: 50 }),
  { left: 130, top: 200 }
);
check(
  "dragging down moves the viewport up",
  P.panScroll(start, { x: 50, y: 50 }, { x: 50, y: 90 }),
  { left: 100, top: 160 }
);
check(
  "no movement, no change",
  P.panScroll(start, { x: 50, y: 50 }, { x: 50, y: 50 }),
  { left: 100, top: 200 }
);
check(
  "offsets are always measured from the START of the drag, never accumulated",
  P.panScroll(start, { x: 50, y: 50 }, { x: 250, y: 450 }),
  { left: -100, top: -200 } // negative is fine: the DOM clamps to the scroll range
);

// ---- keyTool: H / V, and the annotation-shortcut collision ----------------

const KBASE = {
  hasDoc: true,
  viewerVisible: true,
  typing: false,
  focusInteractive: false,
  overlayEditing: false,
  textEditing: false,
};
const kctx = (o) => Object.assign({}, KBASE, o);
const key = (ev, o) => P.keyTool(Object.assign({ key: "h" }, ev), kctx(o));

check("h selects the hand tool", key({ key: "h" }), "hand");
check("H (caps lock) selects the hand tool", key({ key: "H" }), "hand");
check("v selects the text tool", key({ key: "v" }), "select");
check("any other letter is left alone", key({ key: "g" }), null);
check("Ctrl+H is not ours (browser/menu accelerators)", key({ key: "h", ctrlKey: true }), null);
check("Alt+H is not ours", key({ key: "h", altKey: true }), null);
check("Shift+H is not ours", key({ key: "h", shiftKey: true }), null);
check("key repeat is ignored", key({ key: "h", repeat: true }), null);
check("no document → no tool switch", key({ key: "h" }, { hasDoc: false }), null);
check("typing in a field → no tool switch", key({ key: "h" }, { typing: true }), null);
check("a focused control keeps its key", key({ key: "h" }, { focusInteractive: true }), null);
// The collision that would fire two actions at once: editor.js binds h=highlight,
// v=select while annotating. This module must stand down there.
// The compare / overlay views replace the page view and scroll themselves.
check("compare view open → H is not ours", key({ key: "h" }, { viewerVisible: false }), null);
check("annotating: h belongs to the highlighter", key({ key: "h" }, { overlayEditing: true }), null);
check("annotating: v belongs to the annotation select tool", key({ key: "v" }, { overlayEditing: true }), null);
check("text-editing: h is left alone", key({ key: "h" }, { textEditing: true }), null);
check("missing key field", P.keyTool({}, kctx()), null);
check("no event at all", P.keyTool(), null);

// ---- claimsSpace ----------------------------------------------------------

const SBASE = Object.assign({ capturing: false }, KBASE);
const sctx = (o) => Object.assign({}, SBASE, o);
const space = (ev, o) => P.claimsSpace(Object.assign({ key: " " }, ev), sctx(o));

check("space arms the temporary hand", space({}), true);
check("space by e.code also counts", P.claimsSpace({ code: "Space" }, sctx()), true);
check("a repeat still counts (it must keep eating the page-scroll)", space({ repeat: true }), true);
check("other keys are not space", space({ key: "a" }), false);
check("Ctrl+Space is not ours", space({ ctrlKey: true }), false);
check("no document → space is not ours", space({}, { hasDoc: false }), false);
check("typing → space types a space", space({}, { typing: true }), false);
// The accessibility one: space activates a focused button in every browser.
check("focused button keeps space (it activates the button)", space({}, { focusInteractive: true }), false);
// Space must keep page-scrolling the compare panes, not get eaten here.
check("compare view open → space is not ours", space({}, { viewerVisible: false }), false);
check("annotating → space is not ours", space({}, { overlayEditing: true }), false);
check("text-editing → space is not ours", space({}, { textEditing: true }), false);
check("copy-image → space is not ours", space({}, { capturing: true }), false);
check("no event at all", P.claimsSpace(), false);

// ---- requiring this file must not need a DOM ------------------------------
// (the DOM half is behind a `typeof document` guard; if that ever regresses,
// every check above dies at require() time, but assert the exports explicitly)

check(
  "node import exposes exactly the pure surface",
  Object.keys(P).sort(),
  ["MIDDLE", "claimsSpace", "keyTool", "panScroll", "shouldPan"]
);

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
