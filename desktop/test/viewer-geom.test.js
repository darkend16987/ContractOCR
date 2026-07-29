"use strict";

// Regression net for the pure geometry behind the viewer's zoom / page-list / resize
// behaviour.
//
// `nearestScrollDelta` / `wheelZoomFactor` still live inside `app.js`, which cannot be
// require()d — it touches document/pdf.js at top level (docs/REGRESSION-GUARD.md §1).
// So instead of copying them (which would drift the day someone edits the real one),
// this grid LIFTS THEM OUT OF THE SHIPPED FILE at run time by brace-matching the
// source and eval'ing it. Same technique the v0.2.47 page-range merge was verified
// with: what is tested here is literally what ships.
//
// `resizeRect` used to be lifted the same way out of `editor.js`. At v0.2.48 it moved
// to `renderer/annot-geom.js` (pure, no DOM) so it is now a plain require() — the same
// code, one less eval. Its cases below are unchanged, which is how the move was
// verified: they were written against the pre-move implementation.
//
// Run:  node desktop/test/viewer-geom.test.js      (or: npm run test:geom)

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
function near(name, actual, expected, eps) {
  const tol = eps == null ? 1e-9 : eps;
  if (typeof actual === "number" && Math.abs(actual - expected) <= tol) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ≈${expected}\n  actual   ${actual}`);
  }
}

// Pull `function NAME(...) { ... }` out of a source file by matching braces from the
// header's opening brace. Throws loudly if the function is gone or renamed — that is
// the point: a rename must break this file rather than silently stop testing.
function extractFn(file, name) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in ${file} — renamed or removed?`);
  if (src.slice(at - 6, at) === "async ") at -= 6; // keep the keyword, or `await` won't parse
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        // eslint-disable-next-line no-eval
        return eval("(" + src.slice(at, i + 1) + ")");
      }
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}() from ${file}`);
}

// Same idea for a `const NAME = <literal>;` an extracted function closes over.
// (A direct eval inherits this module's scope chain, so the name resolves at call
// time exactly as it does in the browser.)
function extractConst(file, name) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const hits = src.match(new RegExp("^\\s*const " + name + "\\s*=\\s*[^;]+;", "gm")) || [];
  if (!hits.length) throw new Error(`const ${name} not found in ${file} — renamed or removed?`);
  // Ambiguity is an error, not a coin toss: a local `const f = …` deeper in the file
  // must not silently become "the" f (that is exactly what happened first try).
  if (hits.length > 1) throw new Error(`const ${name} is declared ${hits.length}× in ${file} — too ambiguous to lift`);
  // eslint-disable-next-line no-eval
  return eval("(" + /=\s*([^;]+);/.exec(hits[0])[1] + ")");
}

// Declared before the extraction below so the lifted wheelZoomFactor can close over
// it. Asserted, not trusted: changing the base is a deliberate UX decision and must
// fail this grid rather than quietly rewrite what "one notch" means.
const ZOOM_WHEEL_BASE = extractConst("renderer/app.js", "ZOOM_WHEEL_BASE");

// Plain require since v0.2.48 — annot-geom.js is DOM-free (see the header).
const { resizeRect } = require("../renderer/annot-geom.js");
const nearestScrollDelta = extractFn("renderer/app.js", "nearestScrollDelta");
const wheelZoomFactor = extractFn("renderer/app.js", "wheelZoomFactor");

// ---- resizeRect: which corner stays pinned -------------------------------
// Box at (10,20) sized 100×50. The corner OPPOSITE the grip must not move.

const B = { x: 10, y: 20, w: 100, h: 50 };
const R = (dir, dx, dy, shift) => resizeRect(dir, B, dx, dy, !!shift, 4);

check("se grows right/down, origin fixed", R("se", 30, 10), { x: 10, y: 20, w: 130, h: 60 });
check("se shrinks, origin fixed", R("se", -30, -10), { x: 10, y: 20, w: 70, h: 40 });
check("nw drag up-left grows and moves origin", R("nw", -30, -10), { x: -20, y: 10, w: 130, h: 60 });
check("nw keeps the SE corner pinned", (() => {
  const g = R("nw", -30, -10);
  return [g.x + g.w, g.y + g.h];
})(), [B.x + B.w, B.y + B.h]);
check("ne keeps the SW corner pinned", (() => {
  const g = R("ne", 25, -15);
  return [g.x, g.y + g.h];
})(), [B.x, B.y + B.h]);
check("sw keeps the NE corner pinned", (() => {
  const g = R("sw", -25, 15);
  return [g.x + g.w, g.y];
})(), [B.x + B.w, B.y]);
check("ne widens right and lifts the top", R("ne", 20, -20), { x: 10, y: 0, w: 120, h: 70 });
check("sw widens left and drops the bottom", R("sw", -20, 20), { x: -10, y: 20, w: 120, h: 70 });

// A grip dragged past the opposite corner clamps at `min` — it must not flip.
check("se dragged far past the origin clamps at min", R("se", -500, -500), { x: 10, y: 20, w: 4, h: 4 });
check("nw dragged far past the far corner clamps and pins SE", (() => {
  const g = R("nw", 500, 500);
  return [g.w, g.h, g.x + g.w, g.y + g.h];
})(), [4, 4, B.x + B.w, B.y + B.h]);

// Missing/unknown dir behaves like the single bottom-right grip this replaced.
check("unknown dir falls back to se", resizeRect("se", B, 10, 10, false, 4), resizeRect("zz", B, 10, 10, false, 4));

// ---- resizeRect: Shift keeps the aspect ratio -----------------------------
// B is 100×50, ratio 2:1.

check("shift + se: horizontal pull drives both sides", R("se", 100, 0, true), { x: 10, y: 20, w: 200, h: 100 });
check("shift + se: vertical pull drives both sides", R("se", 0, 50, true), { x: 10, y: 20, w: 200, h: 100 });
check("shift + se: the axis pulled FURTHER wins", R("se", 100, 5, true), { x: 10, y: 20, w: 200, h: 100 });
check("shift keeps ratio exactly on shrink", (() => {
  const g = R("se", -50, 0, true);
  return [g.w, g.h, g.w / g.h];
})(), [50, 25, 2]);
check("shift + nw still pins the SE corner", (() => {
  const g = R("nw", -100, 0, true);
  return [g.w, g.h, g.x + g.w, g.y + g.h];
})(), [200, 100, B.x + B.w, B.y + B.h]);
// The bug this guards: clamping one side at `min` without re-deriving the other
// silently ends the ratio lock right where the user is squeezing hardest.
check("shift still holds the ratio at the minimum size", (() => {
  const g = R("se", -99.9, -49.9, true);
  return g.w / g.h;
})(), 2);
check("shift with a square box stays square", (() => {
  const g = resizeRect("se", { x: 0, y: 0, w: 40, h: 40 }, 60, 5, true, 4);
  return [g.w, g.h];
})(), [100, 100]);
check("no shift → sides move independently", (() => {
  const g = R("se", 100, 5, false);
  return [g.w, g.h];
})(), [200, 55]);

// ---- nearestScrollDelta: the page list follows the view -------------------
// Container spans y 100..500 in client coords; pad 12.

const D = (top, bottom) => nearestScrollDelta(100, 500, top, bottom, 12);

check("already comfortably inside → no scroll", D(200, 280), 0);
check("above the top → scroll up by the shortfall", D(60, 140), 60 - 112);
check("below the bottom → scroll down by the overflow", D(460, 540), 540 - 488);
check("exactly on the padded top edge → no scroll", D(112, 200), 0);
check("exactly on the padded bottom edge → no scroll", D(400, 488), 0);
check("one px inside the pad still nudges", D(111, 200), -1);
check("taller than the container prefers showing its top", D(50, 900), 50 - 112);
check("pad defaults to 0 when omitted", nearestScrollDelta(100, 500, 100, 200), 0);

// ---- wheelZoomFactor: Ctrl+wheel steps multiplicatively ------------------

check("the wheel step base is still 1.1 per notch", ZOOM_WHEEL_BASE, 1.1);
near("one notch up = ×1.1", wheelZoomFactor(-100), 1.1, 1e-12);
near("one notch down = ÷1.1", wheelZoomFactor(100), 1 / 1.1, 1e-12);
near("up then down returns to where it started", wheelZoomFactor(-100) * wheelZoomFactor(100), 1, 1e-12);
near("no delta = no change", wheelZoomFactor(0), 1, 1e-12);
near("half a notch is half a step", wheelZoomFactor(-50), Math.pow(1.1, 0.5), 1e-12);
// A trackpad pinch sends many small deltas: each must still move the scale, which is
// why zoomTo quantises to 3 decimals rather than 2.
check("a small pinch delta still changes the factor", wheelZoomFactor(-4) > 1, true);
check("a small pinch delta survives 3-decimal rounding at 100%", Math.round(1 * wheelZoomFactor(-4) * 1000) / 1000 !== 1, true);
// A violent fling must not teleport across the whole range.
near("huge positive delta clamps at 3 notches down", wheelZoomFactor(99999), Math.pow(1.1, -3), 1e-12);
near("huge negative delta clamps at 3 notches up", wheelZoomFactor(-99999), Math.pow(1.1, 3), 1e-12);
check("garbage delta is treated as no movement", wheelZoomFactor(undefined), 1);
check("even clamped, one notch can't exceed the 40–300% span in a single step",
  Math.pow(1.1, 3) < 3 / 0.4, true);

// ---- summary -------------------------------------------------------------

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
