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
  ["CLOUD_BUMP", "CLOUD_BUMP_MAX", "CLOUD_BUMP_MIN", "SYMBOL_SIZE", "arcApex",
   "arrowLabelPos", "bumpOf", "cloudPath", "cloudPathPoly", "resizeRect",
   "strokeExtend", "symbolStrokes"]);
check("the constants are numbers, the rest functions",
  Object.keys(G).map((k) => (/^[A-Z]/.test(k) ? typeof G[k] === "number" : typeof G[k] === "function")).every(Boolean),
  true);
// resizeRect lives here but is exercised by test:geom — assert it is reachable so a
// move/rename cannot quietly leave that grid testing nothing.
check("resizeRect is exported for test:geom", typeof G.resizeRect, "function");

console.log(`\nannot-geom: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
