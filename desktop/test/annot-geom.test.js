"use strict";

// Regression net for the revision-cloud + arrow-label geometry in
// renderer/annot-geom.js (extracted from editor.js at v0.2.48; every body was verified
// byte-identical to v0.2.47's editor.js before the move). Until now this code had NO
// automated coverage at all — `resizeRect`, its file-mate, is exercised by test:geom.
//
// WHY IT MATTERS. `cloudPath` / `cloudPathPoly` return ONE SVG path string that is
// consumed twice: by the on-screen <svg> overlay (0-origin viewBox) and by pdf-lib's
// drawSvgPath at bake time. Both readings depend on the same two conventions —
// every coordinate shifted into non-negative space by `pad`, and `minX`/`minY`
// reported back so the caller can place the result. Break either and the cloud
// renders fine on screen and lands somewhere else in the saved PDF, or gets clipped.
// Silent, and only visible in the delivered file. docs/REGRESSION-GUARD.md §1.
//
// Run:  node desktop/test/annot-geom.test.js       (or: npm run test:cloud)

const fs = require("fs");
const path = require("path");
const G = require("../renderer/annot-geom.js");
const { arrowLabelPos, cloudPath, cloudPathPoly, arcApex, bumpOf } = G;

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
function near(name, actual, expected, eps) {
  const tol = eps == null ? 1e-9 : eps;
  if (typeof actual === "number" && Math.abs(actual - expected) <= tol) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ≈${expected}\n  actual   ${actual}`);
  }
}

// Every number that appears in a path string.
const nums = (d) => (d.match(/-?\d+\.?\d*/g) || []).map(Number);
const arcCount = (d) => (d.match(/A /g) || []).length;
// The sweep flag of each `A rx ry 0 <large> <sweep> x y` command.
const sweeps = (d) => [...d.matchAll(/A [\d.]+ [\d.]+ 0 \d (\d)/g)].map((m) => +m[1]);
// The endpoint of each arc, in path space.
const endpoints = (d) => [...d.matchAll(/A [\d.]+ [\d.]+ 0 \d \d ([\d.-]+) ([\d.-]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));

// ==========================================================================
// 1. bumpOf + the CLOUD_BUMP constants
// ==========================================================================

check("an annot's own bump wins", bumpOf({ bump: 9 }), 9);
check("no bump → the historical default (clouds drawn before it was configurable)",
  [bumpOf({}), bumpOf(null), bumpOf(undefined)], [G.CLOUD_BUMP, G.CLOUD_BUMP, G.CLOUD_BUMP]);
// Guard: 0 is FALSY, so it must fall back rather than be honoured. A bump of 0 would
// make `Math.round(len / bump)` Infinity inside cloudPath and hang building the path.
check("a stored bump of 0 falls back instead of dividing by zero", bumpOf({ bump: 0 }), G.CLOUD_BUMP);
check("guard — bump 0 really would be catastrophic if honoured", Math.round(50 / 0), Infinity);
check("the size control's range brackets the default",
  [G.CLOUD_BUMP_MIN < G.CLOUD_BUMP, G.CLOUD_BUMP < G.CLOUD_BUMP_MAX], [true, true]);
check("the constants are the values editor.js's slider clamps to",
  [G.CLOUD_BUMP, G.CLOUD_BUMP_MIN, G.CLOUD_BUMP_MAX], [16, 6, 28]);

// ==========================================================================
// 2. cloudPath — the rectangular cloud
// ==========================================================================

{
  const c = cloudPath(100, 50);
  check("returns the four fields both consumers read", Object.keys(c).sort(), ["H", "W", "d", "pad"]);
  check("pad IS the bump (that is the room the bulges need)", c.pad, G.CLOUD_BUMP);
  check("W/H are the box plus a pad on each side", [c.W, c.H], [100 + 32, 50 + 32]);
  check("the path starts at the padded origin", c.d.startsWith(`M ${c.pad} ${c.pad} `), true);
  check("and closes", c.d.endsWith(" Z"), true);
  // THE invariant: nothing may be negative, or the overlay's 0-origin viewBox clips
  // the bulges and pdf-lib places them outside the annotation's rect.
  check("every coordinate in the path is >= 0", Math.min(...nums(c.d)) >= 0, true);
  check("one arc per scallop, four sides, round(len/bump) each",
    arcCount(c.d), 2 * (Math.round(100 / 16) + Math.round(50 / 16)));
  // Traversal is clockwise in y-down space, so sweep 1 is outward on all four sides.
  // A mixed set here means some scallops bulge INTO the box.
  check("every scallop bulges the same way (sweep 1 = outward, clockwise)",
    [...new Set(sweeps(c.d))], [1]);
}
{
  // The last arc must land back on the start point, or the Z closes with a straight
  // chord across the corner.
  const c = cloudPath(64, 64);
  const last = endpoints(c.d).slice(-1)[0];
  check("the final scallop returns to the start point", [last.x, last.y], [c.pad, c.pad]);
}
{
  // Degenerate boxes: a user can click without dragging. max(1, …) keeps the path
  // valid; a 0-size canvas throws in the rasteriser.
  for (const [w, h] of [[0, 0], [0, 50], [50, 0], [-10, -10]]) {
    const c = cloudPath(w, h);
    check(`cloudPath(${w},${h}) stays valid`,
      [/NaN|Infinity/.test(c.d), c.W >= 1 + 32, c.H >= 1 + 32, arcCount(c.d) >= 4],
      [false, true, true, true]);
  }
}
check("a falsy bump argument uses the default", cloudPath(100, 50, 0).d, cloudPath(100, 50).d);
check("a smaller bump means more, tighter scallops",
  arcCount(cloudPath(100, 50, 6).d) > arcCount(cloudPath(100, 50, 28).d), true);
{
  const c = cloudPath(100, 50, 6);
  check("a custom bump also drives the pad", [c.pad, c.W, c.H], [6, 112, 62]);
}
{
  // Each side gets at least one scallop even when it is shorter than one bump, so a
  // thin box is still a cloud rather than a rectangle with two bumps.
  const c = cloudPath(3, 200, 16);
  const perSide = 2 * (Math.max(1, Math.round(3 / 16)) + Math.max(1, Math.round(200 / 16)));
  check("a side shorter than one bump still gets one", arcCount(c.d), perSide);
}
check("coordinates are emitted at 2 decimals (keeps the path string bounded)",
  /A 8\.33 8\.33 0 0 1 /.test(cloudPath(100, 50).d), true);

// ==========================================================================
// 3. arcApex — which sweep bulges outward
// ==========================================================================

{
  const A = { x: 0, y: 0 }, B = { x: 10, y: 0 };
  const p1 = arcApex(A, B, 5, 1), p0 = arcApex(A, B, 5, 0);
  check("the two sweeps put the apex on opposite sides of the chord",
    [p1.y < 0, p0.y > 0], [true, true]);
  check("both apexes sit over the chord midpoint", [p1.x, p0.x], [5, 5]);
  near("and are mirror images", p1.y, -p0.y);
}
{
  // rr smaller than half the chord has no solution — sqrt of a negative. It is raised
  // to chord/2 + 0.01 instead, which is why a semicircle (rr == chord/2) also lands
  // here. Without the clamp every scallop apex would be NaN and the path unusable.
  const A = { x: 0, y: 0 }, B = { x: 10, y: 0 };
  const tiny = arcApex(A, B, 1, 1);
  check("an impossible radius is clamped, not NaN", [isNaN(tiny.x), isNaN(tiny.y)], [false, false]);
  check("rr == chord/2 is clamped too, so it matches the sub-minimum case",
    arcApex(A, B, 5, 1), tiny);
  near("the clamped apex is chord/2+0.01 from the centre, i.e. just past a semicircle",
    Math.abs(tiny.y), 5.01 - Math.sqrt(5.01 * 5.01 - 25), 1e-9);
}
{
  // A zero-length chord happens whenever two resampled points coincide.
  const p = arcApex({ x: 5, y: 5 }, { x: 5, y: 5 }, 3, 1);
  check("a zero-length chord degenerates to the point itself, no NaN", [p.x, p.y], [5, 5]);
}
{
  // Orientation independence: the same chord walked backwards must give apexes on
  // the same two sides (the set of solutions is the same, only the flag swaps).
  const A = { x: 0, y: 0 }, B = { x: 0, y: 10 };
  const f1 = arcApex(A, B, 8, 1), b0 = arcApex(B, A, 8, 0);
  near("walking the chord backwards with the other flag gives the same apex (x)", f1.x, b0.x, 1e-9);
  near("… and the same apex (y)", f1.y, b0.y, 1e-9);
}

// ==========================================================================
// 4. cloudPathPoly — the freehand / polygon cloud
// ==========================================================================

const TRI = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 15, y: 26 }];

{
  const p = cloudPathPoly(TRI);
  check("returns the six fields the callers read", Object.keys(p).sort(), ["H", "W", "d", "minX", "minY", "pad"]);
  check("pad IS the bump, like cloudPath", p.pad, G.CLOUD_BUMP);
  // minX/minY are how the caller maps the local 0-origin path back onto the page.
  // Dropping them would draw every freehand cloud at the top-left of its page.
  check("minX/minY report where the sampled outline actually starts", [p.minX, p.minY], [0, 0]);
  check("every coordinate in the path is >= 0", Math.min(...nums(p.d)) >= 0, true);
  check("the path starts at the padded first sample and closes",
    [p.d.startsWith(`M ${p.pad.toFixed(2)} ${p.pad.toFixed(2)} `), p.d.endsWith(" Z")], [true, true]);
  const L = 30 + Math.hypot(15, 26) * 2;
  check("one arc per resampled span: max(6, round(L/bump))", arcCount(p.d), Math.max(6, Math.round(L / 16)));
  const last = endpoints(p.d).slice(-1)[0];
  const first = nums(p.d.slice(0, 20));
  check("the last arc returns to the first sample (a closed loop)", [last.x, last.y], [first[0], first[1]]);
}
{
  // A translated polygon must produce the SAME path with shifted minX/minY — that is
  // what makes the path reusable at any position on the page.
  const shifted = TRI.map((q) => ({ x: q.x + 137, y: q.y + 42 }));
  const a = cloudPathPoly(TRI), b = cloudPathPoly(shifted);
  check("translating the polygon leaves the path identical", b.d, a.d);
  check("only minX/minY move", [b.minX - a.minX, b.minY - a.minY], [137, 42]);
  near("W is unchanged", b.W, a.W);
  near("H is unchanged", b.H, a.H);
}
{
  // THE claim in the source comment: outward is chosen per span by comparing the two
  // candidate apexes' distance to the CENTROID, so it holds for either winding.
  // Asserted semantically (is the apex really outside?) rather than by flag value.
  for (const [label, pts] of [["clockwise", TRI], ["counter-clockwise", TRI.slice().reverse()]]) {
    const p = cloudPathPoly(pts);
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    // Rebuild the samples the same way the path did, from its own endpoints, then
    // check each chosen apex is farther from the centroid than the chord midpoint.
    const eps = endpoints(p.d).map((q) => ({ x: q.x - p.pad + p.minX, y: q.y - p.pad + p.minY }));
    const fl = sweeps(p.d);
    let outward = 0;
    for (let i = 0; i < eps.length; i++) {
      const a = eps[(i - 1 + eps.length) % eps.length], b = eps[i];
      const rr = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      const ap = arcApex(a, b, rr, fl[i]);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(ap.x - cx, ap.y - cy) >= Math.hypot(mid.x - cx, mid.y - cy) - 1e-9) outward++;
    }
    check(`${label}: every scallop bulges AWAY from the centroid`, outward, eps.length);
  }
}
{
  // Reversing the winding changes the sampling start, so the strings differ — but
  // both must be valid and the same size. Pinned so "they should be identical" is
  // not mistaken for a bug later.
  const a = cloudPathPoly(TRI), b = cloudPathPoly(TRI.slice().reverse());
  check("reversed winding gives a different string (different start point)", a.d === b.d, false);
  check("but the same arc count", arcCount(a.d), arcCount(b.d));
  // W/H come from the RESAMPLED points, not the original vertices, so reversing the
  // winding shifts the sampling phase and can move the extent by a fraction of one
  // step (L/n ≈ 15pt here). Measured: 58 vs 57.995. Same size to well under a point,
  // which is what matters; demanding exact equality would be demanding an accident.
  near("and the same width to well under a point", b.W, a.W, 0.5);
  near("and the same height to well under a point", b.H, a.H, 0.5);
}

// --- the two null gates ---------------------------------------------------
// Both exist so a stray click or a 2-point scribble cannot reach the renderer.
check("fewer than 3 points → null", cloudPathPoly([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
check("no points at all → null", [cloudPathPoly([]), cloudPathPoly(null), cloudPathPoly(undefined)], [null, null, null]);
// Points closer than 0.5 collapse first, so a jittery click is 1 point, not 20.
check("points within 0.5 collapse, so a jittery click is still < 3 points",
  cloudPathPoly([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0 }, { x: 0.3, y: 0.1 }]), null);
check("guard — the same points spread past 0.5 DO make a cloud",
  cloudPathPoly([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }]) !== null, true);
{
  // Perimeter under 1pt → null. Just above it must still work (with tiny arcs)
  // rather than divide by a zero step.
  check("a sub-1pt perimeter → null", cloudPathPoly([{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 0.3, y: 0.2 }]), null);
  const ok = cloudPathPoly([{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 0.3, y: 0.6 }]);
  check("just over 1pt still produces a valid path", [ok !== null, /NaN|Infinity/.test(ok.d)], [true, false]);
  check("and it gets the floor of 6 scallops, not round(L/bump)=0", arcCount(ok.d), 6);
}
check("a falsy bump uses the default", cloudPathPoly(TRI, 0).d, cloudPathPoly(TRI).d);
check("a smaller bump means more scallops", arcCount(cloudPathPoly(TRI, 6).d) > arcCount(cloudPathPoly(TRI, 28).d), true);
{
  // A long freehand scribble — the realistic case. Must not blow up or emit NaN.
  const pts = Array.from({ length: 200 }, (_, i) => ({
    x: 100 + 80 * Math.cos((i / 200) * Math.PI * 2),
    y: 100 + 55 * Math.sin((i / 200) * Math.PI * 2),
  }));
  const p = cloudPathPoly(pts);
  check("a 200-point scribble produces a clean, non-negative, closed path",
    [p !== null, /NaN|Infinity/.test(p.d), Math.min(...nums(p.d)) >= 0, p.d.endsWith(" Z")],
    [true, false, true, true]);
  near("W matches the ellipse's extent plus two pads", p.W, 160 + 32, 1.5);
  near("H matches the ellipse's extent plus two pads", p.H, 110 + 32, 1.5);
}

// ==========================================================================
// 5. arrowLabelPos
// ==========================================================================

{
  // Arrow along +x: head at (100,0), tail at (0,0), ang = 0.
  const a = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const head = arrowLabelPos(a, 0, 0, 100, 0, 0, 12, 10);
  check("the default (no labelEnd) puts the label BEYOND the head", [head.x, head.y], [100 + 12 + 6, 0]);
  const tail = arrowLabelPos({ ...a, labelEnd: "tail" }, 0, 0, 100, 0, 0, 12, 10);
  check("labelEnd 'tail' puts it beyond the tail, pointing away from the tip", [tail.x, tail.y], [-18, 0]);
}
check("the gap is headLength + 0.6 * fontSize",
  arrowLabelPos({}, 0, 0, 0, 0, 0, 20, 10).x, 20 + 6);
{
  // Any unknown labelEnd must behave like "head" — arrows saved before labelEnd
  // existed have no such field and must render exactly where they always did.
  const at = (le) => arrowLabelPos({ labelEnd: le }, 0, 0, 50, 0, 0, 10, 10).x;
  check("unknown / missing labelEnd falls back to the head",
    [at(undefined), at("head"), at("HEAD"), at(""), at(null), at("bogus")],
    [66, 66, 66, 66, 66, 66]);
}
{
  // Diagonal: the offset must follow the arrow's direction, not an axis.
  const ang = Math.PI / 4;
  const p = arrowLabelPos({}, 0, 0, 10, 10, ang, 10, 10);
  near("the label offsets along the arrow direction (x)", p.x, 10 + Math.cos(ang) * 16, 1e-9);
  near("… and (y)", p.y, 10 + Math.sin(ang) * 16, 1e-9);
}
{
  // Straight down in y-down space.
  const p = arrowLabelPos({}, 0, 0, 0, 40, Math.PI / 2, 8, 10);
  near("a vertical arrow's label sits below the tip", p.y, 40 + 14, 1e-9);
  near("and stays on the axis", p.x, 0, 1e-9);
}

// ==========================================================================
// 6. strokeExtend — the Shift-straight rule for the freehand `draw` tool
// ==========================================================================
//
// Called once per mousemove from editor.js's drag.type === "draw" branch, with
// Shift read live off the event. Everything below is about ONE thing: the pivot
// must be captured once and then carried, because the failure mode of getting it
// wrong is a straight line that is always zero-length — i.e. Shift appears to do
// nothing at all, with no error anywhere.

const { strokeExtend, symbolStrokes, SYMBOL_SIZE } = G;
const P = (x, y) => ({ x, y });

{
  // Plain freehand: append, no anchor.
  const r = strokeExtend([P(0, 0), P(1, 1)], P(2, 2), false, null);
  check("freehand appends the point", r.pts, [P(0, 0), P(1, 1), P(2, 2)]);
  check("freehand keeps no anchor", r.anchor, null);
}
{
  // First move with Shift down pins the pivot to the current tip (index 2 here).
  const r = strokeExtend([P(0, 0), P(5, 0), P(9, 3)], P(20, 20), true, null);
  check("Shift pins the anchor to the stroke's tip", r.anchor, 2);
  check("and the segment runs tip → cursor", r.pts, [P(0, 0), P(5, 0), P(9, 3), P(20, 20)]);
}
{
  // Second move, still Shift: the SAME anchor is reused and the rubber-band tip
  // is replaced, not accumulated. Length must not change.
  const a = strokeExtend([P(0, 0), P(9, 3)], P(20, 20), true, null);
  const b = strokeExtend(a.pts, P(40, 5), true, a.anchor);
  check("holding Shift replaces the tip instead of stacking points", b.pts,
    [P(0, 0), P(9, 3), P(40, 5)]);
  check("the anchor is carried, not re-derived", b.anchor, 1);
}
{
  // GUARD for the bug this parameter exists to prevent. Re-deriving the anchor
  // each move (passing null every time) pins it to the point just written, so the
  // segment becomes cursor→cursor: a line of length zero, every frame.
  const a = strokeExtend([P(0, 0), P(9, 3)], P(20, 20), true, null);
  const bad = strokeExtend(a.pts, P(40, 5), true, null); // <- the mistake
  const last2 = bad.pts.slice(-2);
  check("guard — re-deriving the anchor collapses the segment to a point",
    last2, [P(20, 20), P(40, 5)]);
  check("guard — and it grows the stroke instead of replacing the tip",
    bad.pts.length > 3, true);
}
{
  // Releasing Shift resumes freehand FROM the end of the straight segment, which
  // is what lets one stroke be polyline → scribble → polyline.
  const a = strokeExtend([P(0, 0)], P(50, 0), true, null);
  const b = strokeExtend(a.pts, P(51, 2), false, a.anchor);
  check("releasing Shift drops the anchor", b.anchor, null);
  check("and drawing continues from the segment's end", b.pts,
    [P(0, 0), P(50, 0), P(51, 2)]);
}
{
  // Shift held from the very first move: anchor 0, so the whole stroke is the line.
  const r = strokeExtend([P(3, 4)], P(80, 90), true, null);
  check("Shift from the first move makes the whole stroke one segment", r.pts,
    [P(3, 4), P(80, 90)]);
  check("anchored at the mousedown point", r.anchor, 0);
}
{
  // Purity: editor.js keeps the previous array inside its undo snapshots.
  const src = [P(0, 0), P(1, 1)];
  strokeExtend(src, P(2, 2), false, null);
  strokeExtend(src, P(9, 9), true, null);
  check("the input array is never mutated", src, [P(0, 0), P(1, 1)]);
}
check("empty/absent pts does not throw", strokeExtend(undefined, P(1, 1), true, null).pts, [P(1, 1)]);

// ==========================================================================
// 7. symbolStrokes — the ✓ / ✗ stamps
// ==========================================================================
//
// ONE function feeds both the on-screen <svg> and pdf-lib's drawLine at bake
// time (same arrangement as cloudPath, same reason: two implementations would
// disagree and only the saved file would show it).

const inBox = (lines, x, y, w, h) =>
  lines.every((l) => l.every((p) => p.x >= x - 1e-9 && p.x <= x + w + 1e-9 &&
                                    p.y >= y - 1e-9 && p.y <= y + h + 1e-9));

{
  const c = symbolStrokes("check", 0, 0, 100, 100);
  check("a tick is a single 3-point polyline", [c.length, c[0].length], [1, 3]);
  // Shape sanity: down-stroke then a longer up-stroke ending high and right.
  check("the tick's elbow is its lowest point", c[0][1].y > c[0][0].y && c[0][1].y > c[0][2].y, true);
  check("the tick ends up and to the right", c[0][2].x > c[0][1].x && c[0][2].y < c[0][0].y, true);
}
{
  const x = symbolStrokes("cross", 0, 0, 100, 100);
  check("a cross is two 2-point segments", [x.length, x[0].length, x[1].length], [2, 2, 2]);
  check("the two strokes run in opposite x directions",
    (x[0][1].x - x[0][0].x) * (x[1][1].x - x[1][0].x) < 0, true);
  check("the cross is symmetric about the box centre",
    [(x[0][0].x + x[0][1].x) / 2, (x[1][0].x + x[1][1].x) / 2], [50, 50]);
}
// Containment is what keeps the ink under the four resize grips and inside the
// overlay element — a stroke escaping the box lands somewhere the user can't grab.
check("tick stays inside its box", inBox(symbolStrokes("check", 30, 70, 18, 18), 30, 70, 18, 18), true);
check("cross stays inside its box", inBox(symbolStrokes("cross", 30, 70, 18, 18), 30, 70, 18, 18), true);
{
  // Offset + scale: the same shape, translated and stretched. This is the property
  // the bake relies on when it passes a.x/a.y/a.w/a.h straight through.
  // Rounded: `200 + 10*0.38 - 200` is not bit-identical to `10*0.38`, and that
  // difference (1e-14 pt) is meaningless at PDF scale.
  const r9 = (n) => +n.toFixed(9);
  const base = symbolStrokes("check", 0, 0, 10, 10)[0];
  const moved = symbolStrokes("check", 200, 400, 10, 10)[0];
  check("translating the box translates every point",
    moved.map((p) => [r9(p.x - 200), r9(p.y - 400)]), base.map((p) => [r9(p.x), r9(p.y)]));
  const wide = symbolStrokes("check", 0, 0, 20, 10)[0];
  check("width scales x only", wide.map((p) => r9(p.x)), base.map((p) => r9(p.x * 2)));
  check("and leaves y alone", wide.map((p) => r9(p.y)), base.map((p) => r9(p.y)));
}
// Degenerate boxes: a click-placed stamp is created at w=h=1 and only resized on
// mouse-up, so zero/negative sizes DO reach this function mid-gesture.
check("zero size does not divide by zero or escape",
  inBox(symbolStrokes("cross", 5, 5, 0, 0), 5, 5, 1, 1), true);
// An unknown kind must render as nothing rather than throw: drawOneAnnot runs
// inside drawAnnots' per-annot try/catch, where a throw is swallowed into a
// "bỏ qua N mục lỗi" toast — i.e. silent data loss on save.
check("an unknown kind yields no strokes", symbolStrokes("wat", 0, 0, 10, 10), []);
check("the default stamp size is a usable number", SYMBOL_SIZE > 0 && SYMBOL_SIZE < 200, true);

// ==========================================================================
// 8. the module surface (BI-14: a rename here breaks editor.js silently)
// ==========================================================================

check("node import exposes exactly the surface editor.js calls by bare name",
  Object.keys(G).sort(),
  ["ANGLE_SNAP_DEG", "CLOUD_BUMP", "CLOUD_BUMP_MAX", "CLOUD_BUMP_MIN", "SYMBOL_SIZE",
   "annotBounds", "arcApex", "arrowLabelPos", "bumpOf", "cloudPath", "cloudPathPoly",
   "fitShift", "resizeRect", "snapLineEnd", "strokeExtend", "symbolStrokes",
   "translateAnnot", "unionBounds"]);
check("the constants are numbers, the rest functions",
  Object.keys(G).map((k) => (/^[A-Z]/.test(k) ? typeof G[k] === "number" : typeof G[k] === "function")).every(Boolean),
  true);
// resizeRect lives here but is exercised by test:geom — assert it is reachable so a
// move/rename cannot quietly leave that grid testing nothing.
check("resizeRect is exported for test:geom", typeof G.resizeRect, "function");

// ==========================================================================
// snapLineEnd — dragging ONE end of an arrow (v0.2.52)
// ==========================================================================
//
// The gesture: grab an arrow's end grip and swing it about the other end. Shift
// quantises the ANGLE to 15° and must leave the LENGTH alone — "xoay", not "resize".
// Getting that backwards is the kind of thing that looks fine on a horizontal test
// arrow and is obviously wrong on a diagonal one, so the cases below are deliberately
// diagonal.

const { snapLineEnd, ANGLE_SNAP_DEG } = G;
const len = (fx, fy, q) => Math.hypot(q.x - fx, q.y - fy);
const degOf = (fx, fy, q) => (Math.atan2(q.y - fy, q.x - fx) * 180) / Math.PI;

check("the snap step is still 15°", ANGLE_SNAP_DEG, 15);
// Without Shift the cursor wins outright — no rounding, no clamping.
check("no snap → the cursor position, verbatim", snapLineEnd(10, 10, 137.4, -22.9, false), { x: 137.4, y: -22.9 });
check("no snap → passes through even at zero length", snapLineEnd(10, 10, 10, 10, false), { x: 10, y: 10 });

// A cursor 4° off horizontal snaps back to 0° and keeps its distance.
near("snap: 4° off horizontal → 0°", degOf(0, 0, snapLineEnd(0, 0, 100, 7, true)), 0, 1e-9);
near("snap: 4° off horizontal keeps the length", len(0, 0, snapLineEnd(0, 0, 100, 7, true)), Math.hypot(100, 7), 1e-9);
// 40° is nearer 45° than 30°.
near("snap: 40° → 45°", degOf(0, 0, snapLineEnd(0, 0, Math.cos(0.698) * 80, Math.sin(0.698) * 80, true)), 45, 1e-6);
// 37° is nearer 30°: the rounding is to the NEAREST step, not always upward.
near("snap: 37° → 30°", degOf(0, 0, snapLineEnd(0, 0, Math.cos(0.6458) * 80, Math.sin(0.6458) * 80, true)), 30, 1e-6);
// Every snapped result must sit on a multiple of the step, from any fixed point and in
// any quadrant — this is the property, the individual cases above are just samples.
check("snap: every angle lands on a multiple of 15°",
  [[13, -71], [-40, 5], [-9, -60], [88, 3], [0, -50], [-50, 0]]
    .map(([dx, dy]) => degOf(30, 40, snapLineEnd(30, 40, 30 + dx, 40 + dy, true)))
    .map((d) => Math.abs(((d % ANGLE_SNAP_DEG) + ANGLE_SNAP_DEG) % ANGLE_SNAP_DEG) < 1e-6)
    .every(Boolean),
  true);
check("snap: length is preserved from any fixed point",
  [[13, -71], [-40, 5], [-9, -60], [88, 3]]
    .map(([dx, dy]) => {
      const q = snapLineEnd(30, 40, 30 + dx, 40 + dy, true);
      return Math.abs(len(30, 40, q) - Math.hypot(dx, dy)) < 1e-9;
    })
    .every(Boolean),
  true);
// An angle already on the grid must come back untouched, or holding Shift would jitter
// an arrow the user had already lined up.
check("snap: an exact 45° is left alone", (() => {
  const q = snapLineEnd(0, 0, 50, 50, true);
  return [Math.abs(q.x - 50) < 1e-9, Math.abs(q.y - 50) < 1e-9];
})(), [true, true]);
// GUARD (the quiet one): with no length there is no angle to quantise. Rounding
// atan2(0,0)=0 would fling the arrow to 0° the moment the user grabbed a grip and
// pressed Shift without moving — so a degenerate drag must pass through instead.
check("snap: a zero-length drag passes through instead of snapping to 0°",
  snapLineEnd(25, 25, 25, 25, true), { x: 25, y: 25 });
check("snap: a sub-epsilon drag passes through too",
  snapLineEnd(25, 25, 25.0000000001, 25, true), { x: 25.0000000001, y: 25 });

// ==========================================================================
// annotBounds / translateAnnot / fitShift — copy & paste an object (v0.2.52)
// ==========================================================================
//
// Paste has to answer "where is this thing and will it fit on the target page", for
// three different coordinate shapes (box, point list, endpoint pair). The failure is
// quiet in the BI-42 way: an object pasted past the edge of the paper is invisible AND
// unreachable, because the grips that would drag it back are off-paper too. Pasting
// makes that likelier than stamping ever did — the destination page can be a different
// SIZE from the source.

const { annotBounds, translateAnnot, fitShift, unionBounds } = G;

// --- annotBounds, one case per coordinate shape ---
check("bounds: a plain box is itself",
  annotBounds({ kind: "box", x: 10, y: 20, w: 30, h: 40 }), { x: 10, y: 20, w: 30, h: 40 });
check("bounds: an arrow is the box spanned by its two ends, whichever way round",
  annotBounds({ kind: "arrow", x1: 90, y1: 10, x2: 30, y2: 70 }), { x: 30, y: 10, w: 60, h: 60 });
check("bounds: a dim measures like an arrow",
  annotBounds({ kind: "dim", x1: 5, y1: 5, x2: 25, y2: 15 }), { x: 5, y: 5, w: 20, h: 10 });
check("bounds: a freehand stroke is the hull of its points",
  annotBounds({ kind: "draw", pts: [{ x: 10, y: 50 }, { x: 40, y: 5 }, { x: 25, y: 30 }] }),
  { x: 10, y: 5, w: 30, h: 45 });
// The two cloud kinds must include their SCALLOPS. Bounding a cloud by its bare box
// would let a whole ring of bulges hang over the page edge after a clamp.
check("bounds: a boxed cloud includes one bump of scallop on every side",
  annotBounds({ kind: "cloud", x: 100, y: 100, w: 50, h: 40, bump: 12 }),
  { x: 88, y: 88, w: 74, h: 64 });
check("bounds: a freehand cloud includes its scallops too",
  annotBounds({ kind: "cloudpen", bump: 10, pts: [{ x: 50, y: 50 }, { x: 90, y: 80 }] }),
  { x: 40, y: 40, w: 60, h: 50 });
check("bounds: a cloud with no bump falls back to the default, like bumpOf",
  annotBounds({ kind: "cloud", x: 100, y: 100, w: 50, h: 40 }).x, 100 - bumpOf({}));
// Degenerate input must not produce NaN — it would propagate into a style attribute
// and the object would silently fail to render at all.
check("bounds: an empty point list is a zero box",
  annotBounds({ kind: "draw", pts: [] }), { x: 0, y: 0, w: 0, h: 0 });
check("bounds: a missing annot is a zero box", annotBounds(null), { x: 0, y: 0, w: 0, h: 0 });
check("bounds: a box with absent x/y/w/h reads as zeros",
  annotBounds({ kind: "highlight" }), { x: 0, y: 0, w: 0, h: 0 });

// --- translateAnnot: the same shift, expressed in whatever fields the kind has ---
check("translate: a box moves its origin",
  translateAnnot({ kind: "box", x: 10, y: 20, w: 5, h: 5 }, 3, -4),
  { kind: "box", x: 13, y: 16, w: 5, h: 5 });
check("translate: an arrow moves BOTH ends by the same amount",
  translateAnnot({ kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 20 }, 5, 5),
  { kind: "arrow", x1: 5, y1: 5, x2: 15, y2: 25 });
check("translate: a point list moves every point",
  translateAnnot({ kind: "draw", pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, 10, 10).pts,
  [{ x: 11, y: 12 }, { x: 13, y: 14 }]);
// Translating must not change SHAPE — that is what separates a paste from a resize.
check("translate: the bounding box keeps its size for every shape",
  [
    { kind: "box", x: 10, y: 20, w: 30, h: 40 },
    { kind: "arrow", x1: 90, y1: 10, x2: 30, y2: 70 },
    { kind: "draw", pts: [{ x: 10, y: 50 }, { x: 40, y: 5 }] },
    { kind: "cloud", x: 100, y: 100, w: 50, h: 40, bump: 12 },
    { kind: "cloudpen", bump: 10, pts: [{ x: 50, y: 50 }, { x: 90, y: 80 }] },
  ].map((a) => {
    const before = annotBounds(a);
    const after = annotBounds(translateAnnot(a, 17, -23));
    return after.w === before.w && after.h === before.h &&
           after.x === before.x + 17 && after.y === before.y - 23;
  }),
  [true, true, true, true, true]);
check("translate: a missing annot is returned untouched", translateAnnot(null, 1, 1), null);

// --- fitShift: pull it back onto the paper ---
const A4 = [595, 842]; // page size the fit cases clamp against, in points
check("fit: something already inside is not moved",
  fitShift({ x: 100, y: 100, w: 50, h: 50 }, ...A4), { dx: 0, dy: 0 });
check("fit: hanging off the right edge is pulled left by exactly the overhang",
  fitShift({ x: 570, y: 100, w: 50, h: 50 }, ...A4), { dx: -25, dy: 0 });
check("fit: hanging off the bottom is pulled up by exactly the overhang",
  fitShift({ x: 100, y: 800, w: 50, h: 60 }, ...A4), { dx: 0, dy: -18 });
check("fit: negative coordinates are pushed back to the origin",
  fitShift({ x: -30, y: -12, w: 50, h: 50 }, ...A4), { dx: 30, dy: 12 });
check("fit: both axes at once", fitShift({ x: -5, y: 830, w: 20, h: 40 }, ...A4), { dx: 5, dy: -28 });
check("fit: flush against the far edge counts as inside",
  fitShift({ x: 545, y: 792, w: 50, h: 50 }, ...A4), { dx: 0, dy: 0 });
// Bigger than the page: pin the top-left. Pushing it up/left to "fit" the far edge
// would shove the origin AND its grips off the other side — worse than not fitting.
check("fit: an object wider than the page pins its left edge instead of overshooting",
  fitShift({ x: 40, y: 100, w: 900, h: 50 }, ...A4), { dx: -40, dy: 0 });
check("fit: an object taller than the page pins its top edge",
  fitShift({ x: 100, y: 60, w: 50, h: 2000 }, ...A4), { dx: 0, dy: -60 });
// Unknown page size = the caller could not read the page box. Guessing a shift then
// would move an object for no reason, so it must be a no-op on that axis.
check("fit: an unknown page width moves nothing horizontally",
  fitShift({ x: -50, y: 900, w: 10, h: 10 }, 0, 842), { dx: 0, dy: -68 });
check("fit: an unknown page size moves nothing at all",
  fitShift({ x: -50, y: -50, w: 10, h: 10 }, 0, 0), { dx: 0, dy: 0 });

// The property paste actually depends on: bounds → fitShift → translate leaves the
// object inside the page, for every coordinate shape and from any starting offence.
check("fit: bounds→fitShift→translate lands every shape inside the page",
  [
    { kind: "box", x: -80, y: 900, w: 120, h: 60 },
    { kind: "arrow", x1: 580, y1: -20, x2: 700, y2: 40 },
    { kind: "draw", pts: [{ x: -40, y: 830 }, { x: 20, y: 900 }] },
    { kind: "cloud", x: 4, y: 4, w: 200, h: 100, bump: 16 },
    { kind: "cloudpen", bump: 12, pts: [{ x: 590, y: 5 }, { x: 640, y: 60 }] },
    { kind: "check", x: 588, y: 838, w: 18, h: 18 },
  ].map((a) => {
    const s = fitShift(annotBounds(a), ...A4);
    const b = annotBounds(translateAnnot(a, s.dx, s.dy));
    const eps = 1e-9;
    return b.x >= -eps && b.y >= -eps && b.x + b.w <= A4[0] + eps && b.y + b.h <= A4[1] + eps;
  }),
  [true, true, true, true, true, true]);
// --- unionBounds: a Ctrl+click GROUP is clamped as one shape ---
//
// The failure this prevents is shearing: clamp each member on its own and the one near
// the page edge slides while its neighbours stay put, so a diagram pasted onto a
// smaller page silently comes apart.
check("union: one member is just its own bounds",
  unionBounds([{ kind: "box", x: 10, y: 20, w: 30, h: 40 }]), { x: 10, y: 20, w: 30, h: 40 });
check("union: two boxes span both",
  unionBounds([
    { kind: "box", x: 10, y: 20, w: 30, h: 40 },
    { kind: "box", x: 100, y: 5, w: 20, h: 20 },
  ]), { x: 10, y: 5, w: 110, h: 55 });
check("union: a nested member does not grow the box",
  unionBounds([
    { kind: "box", x: 0, y: 0, w: 100, h: 100 },
    { kind: "box", x: 20, y: 20, w: 10, h: 10 },
  ]), { x: 0, y: 0, w: 100, h: 100 });
check("union: mixes coordinate shapes",
  unionBounds([
    { kind: "arrow", x1: 200, y1: 10, x2: 120, y2: 60 },
    { kind: "draw", pts: [{ x: 5, y: 300 }] },
  ]), { x: 5, y: 10, w: 195, h: 290 });
check("union: a cloud contributes its scallops",
  unionBounds([{ kind: "cloud", x: 50, y: 50, w: 10, h: 10, bump: 12 }]), { x: 38, y: 38, w: 34, h: 34 });
check("union: an empty group is a zero box", unionBounds([]), { x: 0, y: 0, w: 0, h: 0 });
check("union: a missing list is a zero box", unionBounds(null), { x: 0, y: 0, w: 0, h: 0 });

// The property paste depends on for a GROUP: one shift for everyone keeps the layout
// rigid AND lands the whole group on the page.
{
  const group = [
    { kind: "box", x: 520, y: 780, w: 120, h: 90 },
    { kind: "arrow", x1: 540, y1: 800, x2: 620, y2: 850 },
    { kind: "cloud", x: 560, y: 810, w: 60, h: 40, bump: 10 },
  ];
  const before = group.map(annotBounds);
  const s = fitShift(unionBounds(group), ...A4);
  for (const a of group) translateAnnot(a, s.dx, s.dy);
  const after = group.map(annotBounds);
  check("group paste: the whole group ends up on the page",
    (() => {
      const u = unionBounds(group);
      return u.x >= -1e-9 && u.y >= -1e-9 && u.x + u.w <= A4[0] + 1e-9 && u.y + u.h <= A4[1] + 1e-9;
    })(), true);
  check("group paste: every member moved by the SAME delta (no shearing)",
    after.map((b, i) => [b.x - before[i].x, b.y - before[i].y]),
    after.map(() => [s.dx, s.dy]));
  check("group paste: the group really did start off the page", s.dx !== 0 || s.dy !== 0, true);
}

// ==========================================================================
// the edit-bar controls these helpers back (BI-9 / BI-10)
// ==========================================================================
//
// Not geometry — but it is the grid for the features above, and this is the cheap half
// of a check that is otherwise only ever done by eye. Same precedent as test:print,
// which validates its dialog's i18n keys from a logic grid. A button whose Vietnamese
// label is missing from the EN dictionary does not fail anywhere: it just stays
// Vietnamese for English users, forever, and nobody who reads Vietnamese will notice.

{
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const i18n = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
  const editor = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");

  // The three controls added with arrow-reverse and object copy/paste.
  for (const id of ["ed-arrow-reverse", "ed-copy", "ed-paste"]) {
    check(`index.html declares #${id}`, html.includes(`id="${id}"`), true);
    check(`editor.js wires #${id}`, editor.includes(`$("${id}")`), true);
  }
  // Reverse is a KIND-only control: it needs an arrow already selected, so offering it
  // under the arrow TOOL (where nothing is selected yet) would be a dead button.
  //
  // Anchored on the DECLARATION and brace-matched, then stripped of comments. Both
  // halves are lessons from getting this check wrong twice: matching on the bare name
  // found the source's own prose ("It is a KIND_CTLS-only control") first and measured
  // a comment, and a lazy `[\s\S]*?\n  };` then landed on the wrong block's closing
  // brace entirely. Anchor on syntax, not on a word that also appears in English.
  const ctlBlock = (name) => {
    const at = editor.indexOf("const " + name + " = {");
    if (at < 0) throw new Error(`const ${name} not found in editor.js — renamed?`);
    const open = editor.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < editor.length; i++) {
      if (editor[i] === "{") depth++;
      else if (editor[i] === "}" && --depth === 0) {
        return editor.slice(open, i + 1).replace(/^\s*\/\/.*$/gm, "");
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  };
  check("arrowrev is offered for a selected arrow", ctlBlock("KIND_CTLS").includes('"arrowrev"'), true);
  check("arrowrev is NOT offered under the bare arrow tool", ctlBlock("TOOL_CTLS").includes("arrowrev"), false);
  // …and the button's data-ctl has to be that exact string, or it is simply never shown.
  check("#ed-arrow-reverse carries data-ctl=\"arrowrev\"",
    /id="ed-arrow-reverse"[^>]*data-ctl="arrowrev"|data-ctl="arrowrev"[^>]*id="ed-arrow-reverse"/.test(html), true);
  // Every new label/tooltip must be translatable (BI-10's other half). Two groups,
  // because they are declared in different files: the buttons are static markup, the
  // object context menu is built in JS and goes through window.t() at call time.
  for (const key of [
    "Đảo chiều",
    "Đảo chiều mũi tên đang chọn — mũi nhọn sang đầu kia (nhãn đi theo mũi nhọn)",
    "Sao chép mục đang chọn (Ctrl+C) — giữ Ctrl bấm để chọn nhiều mục; dán được sang trang khác, kể cả sau khi Áp dụng",
    "Dán mục đã sao chép vào trang đang xem (Ctrl+V)",
  ]) {
    check(`index.html uses "${key.slice(0, 28)}…"`, html.includes(key), true);
    check(`i18n has "${key.slice(0, 28)}…"`, i18n.includes('"' + key + '"'), true);
  }
  for (const key of ["Sao chép", "Dán vào trang này", "Xoá mục"]) {
    check(`the object menu asks for "${key}"`, editor.includes('tr("' + key + '")'), true);
    check(`i18n has the menu key "${key}"`, i18n.includes('"' + key + '"'), true);
  }
  // The paste icon has to exist as a <symbol>, or the button renders blank — a
  // <use href> at a missing id fails silently, with no console error.
  check("the ic-paste symbol exists for #ed-paste", html.includes('id="ic-paste"'), true);
  // The clipboard MUST NOT live on `ed`: reset() and bakePending() both wipe `ed`, and
  // that would delete the clip on "Áp dụng" — the exact thing this feature promises to
  // survive. Pinned as a string check because it is a one-word edit to get wrong.
  check("the clip is a module-level binding, not a field of ed",
    /\n  let clip = null;/.test(editor) && !/ed\.clip/.test(editor), true);
}

// GUARD: the case above is only meaningful if those inputs really were outside to
// begin with — otherwise it would pass with fitShift stubbed out to return zeros.
check("fit: the cases above genuinely started off the page",
  [
    { kind: "box", x: -80, y: 900, w: 120, h: 60 },
    { kind: "arrow", x1: 580, y1: -20, x2: 700, y2: 40 },
    { kind: "draw", pts: [{ x: -40, y: 830 }, { x: 20, y: 900 }] },
    { kind: "cloud", x: 4, y: 4, w: 200, h: 100, bump: 16 },
    { kind: "cloudpen", bump: 12, pts: [{ x: 590, y: 5 }, { x: 640, y: 60 }] },
    { kind: "check", x: 588, y: 838, w: 18, h: 18 },
  ].map((a) => {
    const s = fitShift(annotBounds(a), ...A4);
    return s.dx !== 0 || s.dy !== 0;
  }),
  [true, true, true, true, true, true]);

console.log(`\nannot-geom: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
