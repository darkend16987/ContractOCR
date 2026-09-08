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
// `viewRasterDpr` + its two budget constants took the SAME road on 2026-09-08: they
// moved to `renderer/raster-cap.js` so the read-only split-view pane can share ONE
// definition of BI-78 instead of keeping a copy (a copy is how that invariant dies by
// halves — capped on one side, blank A0 sheet on the other). Same treatment, same
// proof: the cases below are untouched, and this file failed loudly on the move
// itself, which is exactly what `extractConst` was written to do.
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
// Same deal for the free-zoom range, the button step and the raster budget: they are
// LIFTED, never restated, so the cases below cannot keep passing while describing a
// range the app no longer has (which is exactly what the old hard-coded `3 / 0.4`
// case did before v0.2.66).
const ZOOM_MIN = extractConst("renderer/app.js", "ZOOM_MIN");
const ZOOM_MAX = extractConst("renderer/app.js", "ZOOM_MAX");
const ZOOM_STEP_BASE = extractConst("renderer/app.js", "ZOOM_STEP_BASE");
// The raster budget is a plain require() since 2026-09-08 (see the header): one
// definition, shared by index.html and the read-only pane, testable under node.
const RasterCap = require("../renderer/raster-cap.js");
const MAX_VIEW_MEGAPIXELS = RasterCap.MAX_VIEW_MEGAPIXELS;
const MAX_VIEW_SIDE_PX = RasterCap.MAX_VIEW_SIDE_PX;

// Plain require since v0.2.48 — annot-geom.js is DOM-free (see the header).
const { resizeRect } = require("../renderer/annot-geom.js");
const nearestScrollDelta = extractFn("renderer/app.js", "nearestScrollDelta");
const wheelZoomFactor = extractFn("renderer/app.js", "wheelZoomFactor");
const viewRasterDpr = RasterCap.viewRasterDpr;
// The hoist must not have left a copy behind: two definitions is the failure mode
// raster-cap.js exists to prevent, and grep is the only thing that can see it.
(() => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  for (const name of ["MAX_VIEW_MEGAPIXELS", "MAX_VIEW_SIDE_PX"]) {
    if (new RegExp("^\s*const " + name + "\s*=", "m").test(app)) {
      console.error("FAIL app.js van con khai bao " + name + " — BI-78 dang co HAI ban");
      fail++;
    } else pass++;
  }
  if (/^\s*function viewRasterDpr\s*\(/m.test(app)) {
    console.error("FAIL app.js van con dinh nghia viewRasterDpr — BI-78 dang co HAI ban");
    fail++;
  } else pass++;
})();

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
check("even clamped, one notch can't exceed the whole zoom span in a single step",
  Math.pow(ZOOM_WHEEL_BASE, 3) < ZOOM_MAX / ZOOM_MIN, true);

// ---- the free-zoom range and the ± button step ---------------------------

check("the free-zoom range is 20–500%", [ZOOM_MIN, ZOOM_MAX], [0.2, 5]);
// The fit commands have their own, lower floor on purpose (a whole A0 does not fit
// above 20%). If the free floor ever dropped to meet it, that distinction is gone.
check("the fit floor stays below the free-zoom floor",
  extractConst("renderer/app.js", "FIT_MIN_SCALE") < ZOOM_MIN, true);
check("the ± step base is 1.25 per press", ZOOM_STEP_BASE, 1.25);
// zoomStep divides to zoom out rather than multiplying by (2 - base), so ++−− is a
// round trip. A fixed additive step is what this replaced: on a 20–500% range it was
// +100% relative off the floor and +4% near the ceiling.
near("one press out exactly undoes one press in",
  (1 * ZOOM_STEP_BASE) / ZOOM_STEP_BASE, 1, 1e-12);
check("one press moves more than one wheel notch", ZOOM_STEP_BASE > ZOOM_WHEEL_BASE, true);
check("one press can't cross the whole range", ZOOM_STEP_BASE < ZOOM_MAX / ZOOM_MIN, true);

// ---- viewRasterDpr: the page bitmap can never reach Chromium's cliff -----
//
// Measured in Chromium 148 (docs/RESEARCH-2026-09-07-zoom-range-20-500.md §3.2): past
// a canvas AREA of ~268 MP Chromium accepts canvas.width, hands back a 2d context,
// resolves page.render — and paints NOTHING, with no exception for renderPageCanvas's
// try/catch to catch. The page goes blank and commitScale then thinks it is crisp.
// A zoom ceiling alone cannot avoid that (a big enough sheet blows the cap at ANY
// ceiling), so the bitmap is capped instead. These cases are the proof of that claim.
const CHROMIUM_MAX_CANVAS_MP = 268; // measured 267.96 (= 2^28 px); do not raise
const CHROMIUM_MAX_TEXTURE_PX = 16384; // Skia; past it the canvas falls off the GPU

// {name, w, h} in PDF points (== CSS px at scale 1), page rotation already applied.
const PAPERS = [
  { name: "A4", w: 595, h: 842 },
  { name: "A3", w: 842, h: 1191 },
  { name: "A0", w: 2384, h: 3370 }, // the large-format case that actually breaks
  { name: "strip 1:6", w: 200, h: 1200 }, // extreme aspect: the SIDE cap must bind
];
// dpr comes only from the Windows display scale (no setZoomFactor anywhere in the
// app), so these four are the real spread — 2.5 is a 4K laptop at 250%.
for (const paper of PAPERS) {
  for (const dpr of [1, 1.5, 2, 2.5]) {
    for (const zoom of [ZOOM_MIN, 1, 3, 4, ZOOM_MAX]) {
      const cw = paper.w * zoom;
      const ch = paper.h * zoom;
      const rd = viewRasterDpr(cw, ch, dpr);
      const tag = `${paper.name} at ${Math.round(zoom * 100)}% dpr ${dpr}`;
      const mp = (cw * rd * ch * rd) / 1e6;
      check(`${tag}: bitmap within the ${MAX_VIEW_MEGAPIXELS} MP budget`,
        mp <= MAX_VIEW_MEGAPIXELS + 1e-6, true);
      check(`${tag}: bitmap far below Chromium's blank-canvas cliff`,
        mp < CHROMIUM_MAX_CANVAS_MP, true);
      check(`${tag}: long side stays on the GPU path`,
        Math.max(cw, ch) * rd <= MAX_VIEW_SIDE_PX
          && MAX_VIEW_SIDE_PX < CHROMIUM_MAX_TEXTURE_PX, true);
      // Rasterising ABOVE the display's own resolution buys nothing and costs the
      // square of it, so the real dpr is always the ceiling.
      check(`${tag}: never upscales past the real dpr`, rd <= dpr, true);
    }
  }
}

// The budget must be invisible on everyday pages — if it started easing A4 down at
// ordinary zoom levels, this whole change would be a sharpness regression.
for (const zoom of [ZOOM_MIN, 0.4, 1, 2, 3, ZOOM_MAX]) {
  check(`A4 at ${Math.round(zoom * 100)}% on a 150% display renders at full dpr`,
    viewRasterDpr(595 * zoom, 842 * zoom, 1.5), 1.5);
}
// …and it must actually bite where the measurements say it has to.
check("A0 at 500% dpr 1.5 is eased down (uncapped: 452 MP → blank page)",
  viewRasterDpr(2384 * 5, 3370 * 5, 1.5) < 1.5, true);
check("A3 at 500% dpr 2.5 is eased down (uncapped: 157 MP ≈ 598 MB)",
  viewRasterDpr(842 * 5, 1191 * 5, 2.5) < 2.5, true);
// On a 1:6 strip the area budget alone would allow a 13856 px side, so the side cap
// is what keeps it off the software path. This case is why there are TWO limits.
check("on an extreme aspect ratio the SIDE cap is the binding one",
  Math.round(Math.max(200, 1200) * 5 * viewRasterDpr(200 * 5, 1200 * 5, 2.5)),
  MAX_VIEW_SIDE_PX);
check("a degenerate box does not produce NaN", viewRasterDpr(0, 0, 1.5), 1.5);

// ---- the UI must advertise the range the code actually enforces ----------
//
// The range is spelled out in three user-visible places, and i18n's key IS the
// Vietnamese markup string — so a half-done edit does not error, it just quietly
// serves Vietnamese to the English UI (same failure mode as the compress-dialog keys
// below). Derive the expected text from the constants rather than repeating it.
const RANGE = `${Math.round(ZOOM_MIN * 100)}–${Math.round(ZOOM_MAX * 100)}`;
const readRenderer = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");
const zoomHtmlSrc = readRenderer("index.html");
const i18nZoomSrc = readRenderer("i18n.js");
const helpSrc = readRenderer("help.js");
const zoomTitle = (/<input id="zoom-input"[^>]*title="([^"]+)"/.exec(zoomHtmlSrc) || [])[1];
check("the zoom box has a title", typeof zoomTitle, "string");
check(`the zoom box advertises ${RANGE}`, !!zoomTitle && zoomTitle.includes("(" + RANGE + ")"), true);
// Not "i18n mentions the range" — the KEY has to be that title, character for character.
check("i18n has the zoom box title verbatim as a key",
  i18nZoomSrc.includes('"' + zoomTitle + '":'), true);
// The English side of that pair has to carry the same numbers — a translated tooltip
// still quoting 40–300 is worse than a missing one, because it looks authoritative.
const i18nZoomLine = (i18nZoomSrc.split("\n").find((l) => l.includes('"' + zoomTitle + '":')) || "");
check(`the English zoom box title advertises ${RANGE}`,
  i18nZoomLine.slice(i18nZoomLine.indexOf('":') + 2).includes("(" + RANGE + ")"), true);
check(`Trợ giúp advertises ${RANGE} in both languages`,
  helpSrc.split("(" + RANGE + ")").length - 1 >= 2, true);
// A stale copy of the OLD range anywhere in those three files means one was missed.
for (const [name, src] of [["index.html", zoomHtmlSrc], ["i18n.js", i18nZoomSrc], ["help.js", helpSrc]]) {
  check(`${name} has no stale 40–300 left`, src.includes("40–300"), false);
}

// ---- drop-gap arithmetic for reordering pages (v0.2.52) -------------------
//
// The page column drops into a GAP between two pages, not "onto" a page: gap g means
// "between page g-1 and page g". `reorderPage` then splices the page OUT and back IN,
// so an index measured on the ORIGINAL list is one too high once the moved page sat
// before it — that off-by-one is `gapToReorderIndex`, and getting it wrong silently
// files the page one slot away from where the cue promised. Which is why it is here and
// not inline: this is page-order arithmetic, and BI-27's lesson is that page arithmetic
// gets a grid because the failure mode is a document quietly in the wrong order.
//
// The cases below assert against a real splice rather than against a restated formula —
// a formula compared to itself proves nothing.

const gapToReorderIndex = extractConst("renderer/app.js", "gapToReorderIndex");
const gapIsNoOp = extractConst("renderer/app.js", "gapIsNoOp");

// What the document order becomes when page `from` is dropped into gap `gap`.
const orderAfter = (n, from, gap) => {
  const order = [...Array(n).keys()];
  const [m] = order.splice(from, 1);
  order.splice(gapToReorderIndex(gap, from), 0, m);
  return order;
};

check("drop page 0 into the gap before the last page", orderAfter(4, 0, 3), [1, 2, 0, 3]);
check("drop page 0 to the very bottom", orderAfter(4, 0, 4), [1, 2, 3, 0]);
check("drop the last page to the very top", orderAfter(4, 3, 0), [3, 0, 1, 2]);
check("drop the last page into the gap after the first", orderAfter(4, 3, 1), [0, 3, 1, 2]);
check("drop a middle page upward", orderAfter(5, 3, 1), [0, 3, 1, 2, 4]);
check("drop a middle page downward", orderAfter(5, 1, 4), [0, 2, 3, 1, 4]);
check("a two-page swap is reachable from either side", orderAfter(2, 0, 2), [1, 0]);
check("dropping into the gap just above yourself is identity", orderAfter(4, 2, 2), [0, 1, 2, 3]);
check("dropping into the gap just below yourself is identity", orderAfter(4, 2, 3), [0, 1, 2, 3]);

// Those last two are exactly the drops the dragover handler refuses, so the identity
// above is a belt-and-braces property and `gapIsNoOp` is the thing users feel: it is
// what stops a stationary drop from costing a full document rewrite + an undo step.
check("the gap above a page is a no-op", gapIsNoOp(2, 2), true);
check("the gap below a page is a no-op", gapIsNoOp(3, 2), true);
check("the gap two above is a real move", gapIsNoOp(1, 2), false);
check("the gap two below is a real move", gapIsNoOp(4, 2), false);
check("first page: only gaps 0 and 1 are no-ops",
  [0, 1, 2].map((g) => gapIsNoOp(g, 0)), [true, true, false]);
check("last page of 4: only gaps 3 and 4 are no-ops",
  [2, 3, 4].map((g) => gapIsNoOp(g, 3)), [false, true, true]);

// Every gap on a 5-page document either moves the page or is refused — no gap may do
// something in between (that would be a page landing where no cue was drawn).
check("no gap on a 5-page doc both counts as a move and changes nothing",
  [0, 1, 2, 3, 4, 5].filter((g) => {
    const moved = JSON.stringify(orderAfter(5, 2, g)) !== JSON.stringify([0, 1, 2, 3, 4]);
    return moved === gapIsNoOp(g, 2); // a real move that is flagged no-op, or vice versa
  }), []);

// ---- compressEta: "how long will Nén take" -------------------------------
//
// The estimate is shown before a job that can run for minutes and cannot be cancelled,
// so being wrong here is not cosmetic — it is the number the user plans around.
//
// It predicts from BYTES, and that is the measured choice, not a convenience: across
// an all-image scan, a 600-page text document and a CAD-like A0 vector set, seconds
// per MB spanned 0.098–0.189 (2x) while seconds per PAGE spanned 0.001–0.439 (439x).

const COMPRESS_S_PER_MB = extractConst("renderer/app.js", "COMPRESS_S_PER_MB");
const COMPRESS_WORKER_MIN_BYTES = extractConst("renderer/app.js", "COMPRESS_WORKER_MIN_BYTES");
const COMPRESS_WORKER_START_S = extractConst("renderer/app.js", "COMPRESS_WORKER_START_S");
const COMPRESS_WARN_BYTES = extractConst("renderer/app.js", "COMPRESS_WARN_BYTES");
const compressEta = extractFn("renderer/app.js", "compressEta");

const MB = 1e6;

// Against the real measurements, with one correction that matters: the 57.8 MB
// figures below were timed by calling the compressor DIRECTLY, while a document that
// size goes through the child process in the app — so what the user waits for is the
// measured time PLUS the worker's interpreter start. The 86.7 MB figure was already
// measured end to end over HTTP, worker included.
function within(actual, expected, tol) {
  return Math.abs(actual - expected) <= expected * tol;
}
const W = COMPRESS_WORKER_START_S;
check("86.7 MB ebook ≈ the 16.8s measured end-to-end",
  within(compressEta(86.7 * MB, "ebook"), 16.8, 0.3), true);
check("57.8 MB ebook ≈ the measured 8.8s + worker start",
  within(compressEta(57.8 * MB, "ebook"), 8.8 + W, 0.3), true);
check("57.8 MB screen ≈ the measured 2.7s + worker start",
  within(compressEta(57.8 * MB, "screen"), 2.7 + W, 0.5), true);
check("57.8 MB printer ≈ the measured 10.3s + worker start",
  within(compressEta(57.8 * MB, "printer"), 10.3 + W, 0.3), true);
// A 6.1 MB text document measured 0.60 s and stays in-process — no worker cost at all.
check("6.1 MB text ≈ the measured 0.6s, with no worker cost",
  compressEta(6.1 * MB, "ebook") <= 2, true);

// lossless skips rewrite_images, which is 98.9% of the work. If the estimate ever
// stops reflecting that, the dialog tells people a cleanup will take minutes.
check("lossless is far cheaper than ebook",
  compressEta(500 * MB, "lossless") * 5 < compressEta(500 * MB, "ebook"), true);

// The worker's interpreter start is a STEP at the threshold, not a slope — a document
// one byte over should not look dramatically slower than one byte under.
const under = compressEta(COMPRESS_WORKER_MIN_BYTES - 1, "ebook");
const over = compressEta(COMPRESS_WORKER_MIN_BYTES, "ebook");
check("crossing the worker threshold adds the startup cost",
  over - under, COMPRESS_WORKER_START_S);
check("…and nothing more", over - under <= COMPRESS_WORKER_START_S, true);

// Monotonic and never zero: "0 giây" on a real document reads as "it is broken".
check("bigger is never faster",
  [1, 10, 100, 500, 999].every((mb) => compressEta(mb * MB, "ebook") >= compressEta((mb - 1) * MB, "ebook")),
  true);
check("an empty document still reports at least 1s", compressEta(0, "ebook"), 1);
check("garbage input does not produce NaN", compressEta(undefined, "ebook"), 1);
check("an unknown preset falls back to ebook",
  compressEta(50 * MB, "nonsense"), compressEta(50 * MB, "ebook"));

// Every preset offered by the dialog must have a number, or it silently gets ebook's.
const presetsInHtml = (fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8")
  .match(/<select id="cmp-preset">[\s\S]*?<\/select>/) || [""])[0]
  .match(/value="([a-z]+)"/g) || [];
check("the dialog offers 4 presets", presetsInHtml.length, 4);
for (const raw of presetsInHtml) {
  const p = /value="([a-z]+)"/.exec(raw)[1];
  check(`COMPRESS_S_PER_MB covers "${p}"`, typeof COMPRESS_S_PER_MB[p], "number");
}

// ---- the thresholds must agree with the sidecar ---------------------------
//
// Same cross-language discipline find-replace.test.js applies to the payload ceilings:
// the renderer's estimate is built on where api.py actually switches to the worker, so
// a change on one side that misses the other makes the estimate quietly wrong.
const apiSrc = fs.readFileSync(path.join(__dirname, "..", "..", "api.py"), "utf8");
const pyNum = (re) => {
  const m = re.exec(apiSrc);
  return m ? Number(m[1].replace(/_/g, "")) : NaN;
};
check("renderer and sidecar agree on the worker threshold",
  pyNum(/_COMPRESS_WORKER_MIN_BYTES\s*=\s*([\d_]+)/), COMPRESS_WORKER_MIN_BYTES);
// The warning has to fire well before the sidecar's hard ceiling, or the only feedback
// a user gets on an impossible document is a 400.
check("the warn threshold sits below the sidecar's hard cap",
  COMPRESS_WARN_BYTES < pyNum(/_MAX_PDF_BIN\s*=\s*([\d_]+)/), true);
check("…and above the worker threshold",
  COMPRESS_WARN_BYTES > COMPRESS_WORKER_MIN_BYTES, true);

// The dialog's live line and its heads-up are built in JS, so they are NOT covered by
// i18n's static markup sweep. A missing key is not an error at runtime — t() returns
// its input — so the English UI would just quietly show Vietnamese.
const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
for (const key of [
  "{n} giây",
  "{n} phút",
  "Tài liệu {size} · ước tính khoảng {time}",
  "tài liệu rất lớn, máy sẽ cần nhiều RAM",
  "Đang nén PDF… (khoảng {time})",
  "Tài liệu {size} — nén có thể mất khoảng {time} và dùng nhiều bộ nhớ. Trong lúc chạy không dừng lại được. Tiếp tục?",
]) {
  check(`i18n has ${JSON.stringify(key)}`, i18nSrc.includes('"' + key + '"'), true);
}
// …and the readout must be excluded from the language sweep, or switching to English
// overwrites "Tài liệu 82 MB · ước tính…" with stale static text (BI-10).
check("cmp-eta is in SKIP_IDS", /SKIP_IDS[\s\S]{0,2000}"cmp-eta"/.test(i18nSrc), true);

// The DOM half gets source assertions, the compromise this repo already makes for
// renderer code (see REGRESSION-GUARD §1). Three wires, each of which fails silently:
// a missing element writes nowhere, a missing call leaves the line blank, and a
// missing onchange leaves a 20×-wrong number on screen after switching preset.
const appSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
check("the dialog has somewhere to write", /id="cmp-eta"/.test(htmlSrc), true);
check("opening the dialog fills it",
  /function openCompress\(\)[\s\S]{0,600}updateCompressEta\(\)/.test(appSrc), true);
check("changing the preset refreshes it",
  /\$\("cmp-preset"\)\.onchange\s*=\s*updateCompressEta/.test(appSrc), true);
// The heads-up has to come BEFORE bakePending(), which rewrites state.bytes: baking
// first would leave a dirtied document behind a cancelled compress.
// Anchored on the CALL, not the bare word: the prose above it names bakePending too,
// and matching that would test the comment instead of the code.
const runAt = appSrc.indexOf("async function runCompress");
const confirmAt = appSrc.indexOf("COMPRESS_WARN_BYTES", runAt);
const bakeAt = appSrc.indexOf("Editor.bakePending()", runAt);
check("the large-document confirm runs before annotations are baked",
  confirmAt > 0 && confirmAt < bakeAt, true);

// ---- summary -------------------------------------------------------------

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
