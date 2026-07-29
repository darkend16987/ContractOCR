"use strict";

/*
 * Pure geometry for the overlay editor — lifted out of editor.js at v0.2.48.
 * The cloud + arrow bodies were verified line-by-line against v0.2.47's editor.js
 * before the move: byte-identical, so this was a change of address, not a rewrite.
 * `resizeRect` is newer — it arrived with the 4-corner-handles work in this same
 * release, so its reference point is test:geom's 39 cases rather than a shipped file.
 *
 * WHY THIS FILE EXISTS (docs/REGRESSION-GUARD.md §1). Two jobs live here, and both
 * fail quietly:
 *   · `cloudPath` / `cloudPathPoly` emit ONE SVG path string that drives BOTH the
 *     on-screen <svg> overlay AND pdf-lib's drawSvgPath at bake time. There is no
 *     second implementation to disagree with — but the local-origin/`pad` bookkeeping
 *     the two consumers rely on is easy to break, and the result is a revision cloud
 *     that sits somewhere else in the saved PDF than the user drew it.
 *   · `resizeRect` decides which corner stays pinned while a grip is dragged. Get it
 *     wrong and boxes creep or flip. It was ALREADY under test before this split, by
 *     lifting the source out of editor.js at run time and eval'ing it; now it is a
 *     plain require() and `npm run test:geom` no longer needs that trick for it.
 *
 * EXPOSURE — the `wire.js` tier of §2 (bare names at classic-script top level), not
 * the `page-range.js` tier. These names had 11 call sites in editor.js; keeping them
 * bare meant the editor.js half of this change is a pure deletion, with no chance of
 * a mistyped `AnnotGeom.` sneaking in. `module.exports` is for node, `window.AnnotGeom`
 * is the same set under a name a probe can assert on.
 *
 * TRADE-OFF (same as wire.js / annot-text.js): this file MUST load BEFORE editor.js
 * in index.html, and a rename here without a matching call-site edit is a runtime
 * ReferenceError with no build-time warning — BI-14. The grid is the net.
 *
 * Everything here is pure: no DOM, no `ed`, no `state`. Angles/points are in the
 * annotation's own scale-1 PDF-point space with a TOP-LEFT origin and y pointing
 * DOWN (the pdf.js viewport at scale 1) — not pdf-lib's bottom-left user space.
 */

// ---- arrow label ---------------------------------------------------------

// Centre point (in whatever coord space the endpoints are given) where an arrow's
// label sits. `sx,sy`=tail (x1,y1), `ex,ey`=head/tip (x2,y2), `ang`=head direction
// (atan2(ey-sy, ex-sx)), `hl`=head length, `fs`=label font size. labelEnd "tail"
// puts it just beyond the base pointing away from the tip; anything else = head
// (the historical default, so arrows without a labelEnd render unchanged).
function arrowLabelPos(a, sx, sy, ex, ey, ang, hl, fs) {
  const gap = hl + fs * 0.6;
  if (a.labelEnd === "tail") {
    return { x: sx - Math.cos(ang) * gap, y: sy - Math.sin(ang) * gap };
  }
  return { x: ex + Math.cos(ang) * gap, y: ey + Math.sin(ang) * gap };
}

// ---- revision clouds -----------------------------------------------------

// Revision-cloud outline as an SVG path. The perimeter of the a.w×a.h box is
// replaced by outward semicircular scallops — the construction-industry standard
// "khoanh mây". Coordinates are shifted by `pad` so the bulges stay ≥ 0, letting
// the same string drive both the overlay <svg> (0-origin viewBox) and pdf-lib's
// drawSvgPath at bake time. Returns { d, pad, W, H }.
const CLOUD_BUMP = 16; // default scallop diameter in scale-1 PDF points
const CLOUD_BUMP_MIN = 6; // tightest/densest cloud the size control allows
const CLOUD_BUMP_MAX = 28; // puffiest cloud the size control allows
// Per-annotation scallop size. Users asked for smaller/denser clouds, so each
// cloud carries its own `bump`; clouds drawn before this was configurable have
// no `bump` and fall back to the historical default so they render unchanged.
const bumpOf = (a) => (a && a.bump) || CLOUD_BUMP;
function cloudPath(w, h, bump) {
  bump = bump || CLOUD_BUMP;
  const pad = bump; // room for the outward bulges
  const x0 = pad;
  const y0 = pad;
  const x1 = pad + Math.max(1, w);
  const y1 = pad + Math.max(1, h);
  const parts = [];
  // Emit `n` semicircular arcs along the straight edge A→B, each bulging outward.
  // Traversing the rectangle clockwise (in the y-down overlay space), a sweep
  // flag of 1 puts every bump on the outer side.
  const side = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / bump));
    const r = len / n / 2;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      parts.push(`A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)}`);
    }
  };
  side(x0, y0, x1, y0); // top: left → right
  side(x1, y0, x1, y1); // right: top → bottom
  side(x1, y1, x0, y1); // bottom: right → left
  side(x0, y1, x0, y0); // left: bottom → top
  const d = `M ${x0} ${y0} ` + parts.join(" ") + " Z";
  return { d, pad, W: Math.max(1, w) + 2 * pad, H: Math.max(1, h) + 2 * pad };
}

// Freehand / polygon revision cloud: scallop a *closed* polygon given by an
// ordered point list (scale-1 space). The perimeter is resampled into ~`bump`
// spaced points and each span becomes an outward semicircular bump. "Outward"
// is decided per-span relative to the polygon centroid, so it works for any
// winding. Returns { d, minX, minY, pad, W, H } (local 0-origin, y-down —
// drives both the overlay <svg> and pdf-lib's drawSvgPath, like cloudPath) or
// null if there aren't enough distinct points. Corners are lightly rounded.
// Apex (farthest point) of the SVG elliptical-arc A→B with rx=ry=rr, x-rotation
// 0 and large-arc-flag 0, for a given sweep flag. Uses the SVG endpoint→center
// parameterisation. Lets cloudPathPoly decide which sweep bulges outward.
function arcApex(A, B, rr, sweep) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const chord = Math.hypot(dx, dy) || 1;
  rr = Math.max(rr, chord / 2 + 0.01);
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const h = Math.sqrt(Math.max(0, rr * rr - (chord / 2) * (chord / 2)));
  const ux = -dy / chord, uy = dx / chord; // unit perpendicular to the chord
  const sign = sweep ? 1 : -1; // large-arc-flag is 0, so center sign = ±1 by sweep
  const ccx = mx + sign * h * ux, ccy = my + sign * h * uy;
  let vx = mx - ccx, vy = my - ccy;
  const vl = Math.hypot(vx, vy) || 1;
  return { x: ccx + (rr * vx) / vl, y: ccy + (rr * vy) / vl };
}

function cloudPathPoly(rawPts, bump) {
  bump = bump || CLOUD_BUMP;
  const pts = [];
  for (const p of rawPts || []) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const loop = pts.concat([pts[0]]);
  let L = 0;
  for (let i = 1; i < loop.length; i++) L += Math.hypot(loop[i].x - loop[i - 1].x, loop[i].y - loop[i - 1].y);
  if (L < 1) return null;
  const n = Math.max(6, Math.round(L / bump));
  const step = L / n;
  // Resample n points evenly along the closed perimeter.
  const samples = [];
  let segI = 1, dist = 0;
  let segStart = loop[0], segEnd = loop[1];
  let segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (target > dist + segLen && segI < loop.length - 1) {
      dist += segLen;
      segI++;
      segStart = loop[segI - 1];
      segEnd = loop[segI];
      segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
    }
    const t = segLen > 0 ? Math.min(1, (target - dist) / segLen) : 0;
    samples.push({ x: segStart.x + (segEnd.x - segStart.x) * t, y: segStart.y + (segEnd.y - segStart.y) * t });
  }
  const xs = samples.map((s) => s.x), ys = samples.map((s) => s.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  const pad = bump;
  const lx = (x) => (x - minX + pad).toFixed(2);
  const ly = (y) => (y - minY + pad).toFixed(2);
  const rNum = step / 2;
  const r = rNum.toFixed(2);
  const parts = [];
  for (let k = 0; k < n; k++) {
    const a = samples[k], b = samples[(k + 1) % n];
    // Bulge each span outward. The two sweep flags put the arc apex on opposite
    // sides of the chord; pick the one whose apex is farther from the centroid.
    // Winding-independent, so it's correct for either polygon orientation.
    const ap1 = arcApex(a, b, rNum, 1), ap0 = arcApex(a, b, rNum, 0);
    const d1 = Math.hypot(ap1.x - cx, ap1.y - cy), d0 = Math.hypot(ap0.x - cx, ap0.y - cy);
    const sweep = d1 > d0 ? 1 : 0;
    parts.push(`A ${r} ${r} 0 0 ${sweep} ${lx(b.x)} ${ly(b.y)}`);
  }
  const d = `M ${lx(samples[0].x)} ${ly(samples[0].y)} ` + parts.join(" ") + " Z";
  return { d, minX, minY, pad, W: maxX - minX + 2 * pad, H: maxY - minY + 2 * pad };
}

// ---- freehand stroke: the Shift-straight rule ----------------------------

// Next point list for a freehand (`draw`) stroke, given the cursor at `p`.
//
//   straight   Shift held right now — read LIVE off the mouse event, so it can be
//              pressed and released mid-drag (same rule as resizeRect's `ratio`).
//   anchor     index in `pts` the straight segment pivots on, or null while the
//              user is scribbling freely.
//
// Returns { pts, anchor }; the caller stores `anchor` back on its drag state.
//
// THE WHOLE POINT OF THE `anchor` PARAMETER, and the only way to get this wrong:
// the pivot must be captured ONCE, on the first move after Shift goes down, and
// then reused. Re-deriving it as "the last point" on every mousemove pins it to
// the point we just wrote, so the segment is always cursor→cursor and the line
// collapses to nothing. test:cloud has a guard case for exactly that.
//
// Releasing Shift hands control back with `anchor: null`, so drawing resumes from
// wherever the straight segment ended — that is what makes polylines possible
// (straight, freehand, straight… all inside one stroke).
//
// A new array per move rather than an in-place push: `pts` is truncated on the
// straight path anyway, and the cost is nothing next to renderLayer(), which
// already rebuilds the entire SVG path string from every point on every move.
function strokeExtend(pts, p, straight, anchor) {
  const src = pts || [];
  if (!straight) return { pts: src.concat([p]), anchor: null };
  // First move with Shift down → pin the pivot to the stroke's current tip.
  const at = anchor == null ? Math.max(0, src.length - 1) : anchor;
  return { pts: src.slice(0, at + 1).concat([p]), anchor: at };
}

// ---- tick / cross symbols ------------------------------------------------

// Side length (scale-1 PDF points) of a symbol dropped with a plain click rather
// than dragged out. ~18pt reads at about the size of a checkbox in a contract.
const SYMBOL_SIZE = 18;

// A ✓ or ✗ as polylines inside the box (x, y, w, h) — annot space, top-left
// origin, y DOWN. Like cloudPath, this is the SINGLE source of truth read twice:
// by the on-screen <svg> and by pdf-lib's drawLine at bake time. Two readings of
// one function can't disagree; two implementations silently would, and the bake
// half is the one nobody sees until the file is delivered.
//
// The fractions keep the ink clear of the box edge so the stroke isn't clipped by
// the overlay element and lines up with the resize grips. Unknown kind → [], so a
// stray annot renders as nothing instead of throwing mid-bake.
function symbolStrokes(kind, x, y, w, h) {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  const px = (f) => x + W * f;
  const py = (f) => y + H * f;
  if (kind === "check") {
    // Down-stroke to the low point at ~38% across, then the long up-stroke.
    return [[
      { x: px(0.1), y: py(0.55) },
      { x: px(0.38), y: py(0.84) },
      { x: px(0.9), y: py(0.14) },
    ]];
  }
  if (kind === "cross") {
    return [
      [{ x: px(0.14), y: py(0.14) }, { x: px(0.86), y: py(0.86) }],
      [{ x: px(0.86), y: py(0.14) }, { x: px(0.14), y: py(0.86) }],
    ];
  }
  return [];
}

// ---- corner-grip resize --------------------------------------------------

// New box for a corner-grip drag. PURE arithmetic in the annot's own scale-1,
// y-down space, which is why it can be tested outside the browser:
// test/viewer-geom.test.js drives THIS function (docs/REGRESSION-GUARD.md §1).
//
//   dir    which corner is held — "nw" | "ne" | "sw" | "se".
//   orig   the box as it was when the drag started ({x, y, w, h}).
//   dx,dy  how far the cursor has moved since then.
//   ratio  true (Shift held) → keep orig's aspect ratio. The axis the user pulled
//          further wins, so the box follows the cursor instead of jittering
//          between the two candidate sizes.
//   min    smallest allowed side.
//
// The corner OPPOSITE the held one stays pinned; that is the whole job of the
// returned x/y. Dragging past that corner clamps at `min` rather than flipping.
function resizeRect(dir, orig, dx, dy, ratio, min) {
  const m = min > 0 ? min : 4;
  const west = dir.indexOf("w") >= 0;
  const north = dir.indexOf("n") >= 0;
  let w = orig.w + (west ? -dx : dx);
  let h = orig.h + (north ? -dy : dy);
  if (ratio && orig.w > 0 && orig.h > 0) {
    const r = orig.w / orig.h;
    // |Δw|/w vs |Δh|/h, cross-multiplied to dodge the divisions.
    if (Math.abs(w - orig.w) * orig.h >= Math.abs(h - orig.h) * orig.w) h = w / r;
    else w = h * r;
    // Clamping one side has to re-derive the other, or Shift would silently stop
    // holding the ratio as soon as the box reached the minimum.
    if (w < m) { w = m; h = m / r; }
    if (h < m) { h = m; w = m * r; }
  }
  w = Math.max(m, w);
  h = Math.max(m, h);
  return {
    x: west ? orig.x + orig.w - w : orig.x,
    y: north ? orig.y + orig.h - h : orig.y,
    w: w,
    h: h,
  };
}

// node (tests) takes the module export; the browser already has the bare names
// above in the shared script scope. window.AnnotGeom is the same set under a name a
// probe can assert on. Mirrors the tail of wire.js / annot-text.js exactly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CLOUD_BUMP, CLOUD_BUMP_MIN, CLOUD_BUMP_MAX, bumpOf, SYMBOL_SIZE,
    arrowLabelPos, cloudPath, arcApex, cloudPathPoly, resizeRect,
    strokeExtend, symbolStrokes,
  };
}
if (typeof window !== "undefined") {
  window.AnnotGeom = {
    CLOUD_BUMP, CLOUD_BUMP_MIN, CLOUD_BUMP_MAX, bumpOf, SYMBOL_SIZE,
    arrowLabelPos, cloudPath, arcApex, cloudPathPoly, resizeRect,
    strokeExtend, symbolStrokes,
  };
}
