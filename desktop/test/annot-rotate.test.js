"use strict";

// Regression net for ONE invariant, and it is the quietest one in the editor:
//
//   ink baked onto a page with a /Rotate entry must land exactly where the
//   on-screen overlay drew it — for EVERY annotation kind, at 0/90/180/270°.
//
// WHY THIS GRID EXISTS. Pages carrying /Rotate (scans, or anything left after a
// rotate-left/right round-trip) display rotated, but pdf-lib draws in UNROTATED user
// space. v0.2.11 fixed that for the three `drawImage` callers (text / image /
// watermark) by spinning each back with `rotate: pageRotate(page)`, and its commit
// message concluded "axis-aligned shapes were unaffected and stay as-is". True at the
// time — but revision clouds arrived later and they are neither an image nor
// axis-aligned: they go in through `page.drawSvgPath`, which has its OWN `rotate`
// option that nobody passed. Result, reported by a user at v0.2.51: khoanh mây baked
// spun on landscape (rotated) pages, exactly the v0.2.11 bug in a new place.
//
// That is the whole argument for a grid instead of a one-line patch: the bug class is
// "a NEW drawing primitive silently opts out of the rotation compensation", and the
// only defence is a test that walks EVERY kind. Adding a kind to KINDS below is the
// price of adding a kind to drawOneAnnot.
//
// HOW IT MEASURES — no per-kind expected geometry, and nothing hand-derived:
//   1. bake the same annot onto four pages that differ ONLY in /Rotate;
//   2. walk the emitted content stream, composing the real CTM from its `cm`
//      operators, and transform every path point (m / l / c / re) by it — that is
//      the actual ink position in user space;
//   3. map each point BACK to display space with pdf.js's convertToViewportPoint.
// If the compensation is right, all four rotations produce the SAME display-space
// points — because display space is where the user drew them. Rotation 0 is the
// known-good reference (it is what ships and what users see today), so agreement
// across rotations transfers its correctness to the other three. Case 0 additionally
// pins the absolute box for the two kinds whose expected geometry is unambiguous, so
// "all four agree" can't degenerate into "all four are equally wrong".
//
// Points are compared as a SORTED, DE-DUPLICATED set, not in emission order. Two
// measured reasons, both artefacts of pdf-lib's emitters rather than of geometry:
//   · drawRectangle / drawEllipse lay their corners out in their own local frame, so a
//     rotated page legitimately re-orders the same set;
//   · drawEllipse closes its Bézier chain back onto its start point, so ONE point
//     appears twice — and which one is the duplicate rotates with the page. Comparing
//     multisets made `ellipse` report a mismatch whose bbox and distinct points were
//     both identical. De-duping drops the artefact and keeps the sensitivity: ink that
//     actually moved changes the distinct set and the bbox (see the guard case).
//
// THE GUARD CASE AT THE END IS NOT OPTIONAL. It re-creates the bug by hand (one
// drawSvgPath with the `rotate` option left off) and asserts the points DISAGREE. A
// grid that can only ever pass proves nothing; this is what makes a green run mean
// "the compensation is present and doing something". Same reasoning as the
// strokeExtend guard in annot-geom.test.js (BI-42).
//
// The functions under test are LIFTED OUT OF THE SHIPPED editor.js at run time (the
// brace-matching cut used by viewer-geom / managed-image), so what is measured here is
// literally what runs in the app — no copy to drift. Kinds that need a canvas
// (renderTextPng: text, an arrow/dim WITH a label, image) can't be driven from node;
// their `drawImage` calls already carry `rotate: pageRotate(page)` and have since
// v0.2.11. The arrow's line + head and the dim's line + ticks ARE covered here, which
// is the half that could regress geometrically.
//
// Run:  node desktop/test/annot-rotate.test.js     (or: npm run test:rotate)

const fs = require("fs");
const path = require("path");
const PDFLib = require("pdf-lib");
const { PDFDocument, rgb, PDFName, PDFHexString, PDFRawStream, degrees } = PDFLib;
// pdf.js prints a canvas/bindings warning on require in node — harmless here, we only
// use PageViewport arithmetic (getViewport / convertTo*Point), never rasterisation.
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

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

// ---- lift the real implementation out of editor.js ------------------------

const SRC = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");

function fnSource(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in editor.js — renamed or removed?`);
  if (SRC.slice(at - 6, at) === "async ") at -= 6; // keep the keyword, or `await` won't parse
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

// Names the lifted drawOneAnnot closes over, resolved at MODULE scope (that is where
// an eval'd function looks them up). Geometry comes from annot-geom.js and the
// rotation helper from managed-codec.js — plain require()s, so a rename there is a
// load-time TypeError rather than a silently skipped case.
const {
  cloudPath, cloudPathPoly, bumpOf, symbolStrokes, arrowLabelPos,
} = require("../renderer/annot-geom.js");
const {
  makeMap, pageRotate, sniffImage, strToBytes, serializeManaged, pushPageAnnot,
  normAngle, apRotatable, apMatrixFor, apRectFor,
  NABU_KIND, NABU_DATA, NABU_SRC,
} = require("../renderer/managed-codec.js");
const { normTextStyle } = require("../renderer/annot-text.js");
// At MODULE scope for the LIFTED `dataUrlToBytes`, which delegates to it — an eval'd
// function resolves bare names here, not inside the function that called lift().
// eslint-disable-next-line no-unused-vars
const { b64ToU8 } = require("../renderer/wire.js");
const SYMBOL_KINDS = new Set(["check", "cross"]);
// The two CANVAS rasterisers stay stubbed to throw: this grid drives no text box and no
// labelled arrow, and throwing beats returning junk — if a future edit routes such a
// kind through here, the case fails loudly instead of quietly measuring nothing.
// `dataUrlToBytes` / `sniffImage` are NOT stubbed (they are pure byte functions, no
// canvas), because section 5 drives the image kind through the annotation writer.
const renderTextPng = () => {
  throw new Error("renderTextPng: this grid drives no canvas-backed kind — see header");
};
const renderArrowPng = renderTextPng;
const noteThreadText = renderTextPng;
// eslint-disable-next-line no-eval
const lift = (name) => eval("(" + fnSource(name) + ")");
const hexRgb = lift("hexRgb");
const dataUrlToBytes = lift("dataUrlToBytes");
const drawOneAnnot = lift("drawOneAnnot");
// The annotation writer, for section 5. `f` is its number formatter — ambiguous to
// lift (a bare arrow const), and a 2-decimal formatter is not what this grid is about.
const addManagedAnnot = lift("addManagedAnnot");
const f = (n) => (+n).toFixed(2);

// ---- content-stream reader (the measuring instrument) ---------------------

// Compose PDF's `cm`: the new CTM is M × CTM, both row-vector 3x2 form
// [a b c d e f] meaning (x,y) -> (a·x + c·y + e, b·x + d·y + f).
function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Every path point the page's content stream draws, in USER space. Walks the operator
// list the way a PDF consumer would: q/Q push and pop the CTM, `cm` concatenates, and
// the path operators are read in the CTM current at that moment. `re` contributes its
// four corners. Text/XObject operators are ignored — no kind driven here emits them.
function inkUserPoints(page) {
  const ops = page.contentStream ? page.contentStream.operators.map(String) : [];
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (const line of ops) {
    const t = line.trim().split(/\s+/);
    const op = t[t.length - 1];
    const n = t.slice(0, -1).map(Number);
    if (op === "q") stack.push(ctm.slice());
    else if (op === "Q") ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (op === "cm" && n.length === 6 && n.every((v) => !isNaN(v))) ctm = mul(n, ctm);
    else if ((op === "m" || op === "l") && n.length === 2) out.push(apply(ctm, n[0], n[1]));
    else if (op === "c" && n.length === 6) {
      // Control points included on purpose: for a scalloped cloud the bulges live
      // ENTIRELY in the control points, so dropping them would blind the grid to
      // exactly the geometry the cloud bug moves.
      out.push(apply(ctm, n[0], n[1]), apply(ctm, n[2], n[3]), apply(ctm, n[4], n[5]));
    } else if (op === "re" && n.length === 4) {
      const [x, y, w, h] = n;
      out.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h));
    }
  }
  return out;
}

// Same walk, but for XObject invocations instead of path operators: capture the CTM
// live at each `Do` and push the unit square through it. drawImage emits no path ops at
// all (`q cm /Img Do Q`), so inkUserPoints above is blind to it — this is the reader
// section 5 needs to see where a flattened IMAGE landed.
function xobjectUserQuad(page) {
  const ops = page.contentStream ? page.contentStream.operators.map(String) : [];
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (const line of ops) {
    const t = line.trim().split(/\s+/);
    const op = t[t.length - 1];
    const n = t.slice(0, -1).map(Number);
    if (op === "q") stack.push(ctm.slice());
    else if (op === "Q") ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (op === "cm" && n.length === 6 && n.every((v) => !isNaN(v))) ctm = mul(n, ctm);
    else if (op === "Do") for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) out.push(apply(ctm, u, v));
  }
  return out;
}

// Where a VIEWER puts an appearance, by PDF 32000-1 §12.5.5: bound `Matrix × BBox` into
// T, build A mapping T onto /Rect, draw the content through Matrix then A. Implemented
// here rather than trusted, so the grid measures the placement a real reader computes —
// including the scale factors, which are the tell for a stretched stamp.
function apUserQuad(rect, m, w, h) {
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(m, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const tx = Math.min(...xs);
  const ty = Math.min(...ys);
  const tw = Math.max(...xs) - tx;
  const th = Math.max(...ys) - ty;
  const sx = tw ? (rect[2] - rect[0]) / tw : 1;
  const sy = th ? (rect[3] - rect[1]) / th : 1;
  const A = [sx, 0, 0, sy, rect[0] - tx * sx, rect[1] - ty * sy];
  return { quad: pts.map(([x, y]) => apply(A, x, y)), scale: [+sx.toFixed(6), +sy.toFixed(6)] };
}

// One page at a given /Rotate, plus the pdf.js scale-1 viewport for it — the exact
// pair the bake path uses (`state.pdf.getPage(i+1).getViewport({scale:1})`).
const PAGE_W = 400;
const PAGE_H = 620; // deliberately non-square: a w/h mix-up cannot cancel out
async function makePage(rot) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.setRotation(degrees(rot));
  const pdf = await pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false }).promise;
  const vp1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  return { doc, page, vp1 };
}

// User-space points → the sorted, de-duplicated DISPLAY-space set (see header).
function toDisplaySet(pts, vp1) {
  const seen = new Map();
  for (const [x, y] of pts) {
    const v = vp1.convertToViewportPoint(x, y);
    const p = [+v[0].toFixed(3), +v[1].toFixed(3)];
    seen.set(p[0] + "," + p[1], p);
  }
  return [...seen.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

// Bake `a` onto a fresh page rotated by `rot`, then report where the ink ended up in
// display space — the space the annotation was authored in.
async function displayInk(a, rot) {
  const { doc, page, vp1 } = await makePage(rot);
  await drawOneAnnot(doc, page, a, makeMap(vp1, "orig"));
  return toDisplaySet(inkUserPoints(page), vp1);
}
const bbox = (pts) =>
  pts.length
    ? [
        +Math.min(...pts.map((p) => p[0])).toFixed(2),
        +Math.min(...pts.map((p) => p[1])).toFixed(2),
        +Math.max(...pts.map((p) => p[0])).toFixed(2),
        +Math.max(...pts.map((p) => p[1])).toFixed(2),
      ]
    : [];

// ---- the kinds under test ------------------------------------------------

// Every kind drawOneAnnot can bake WITHOUT a canvas. Coordinates are scale-1
// PDF points, top-left origin, y DOWN (the overlay's own space).
const KINDS = [
  { name: "highlight", a: { kind: "highlight", x: 40, y: 60, w: 120, h: 30, color: "#ffd54a" } },
  { name: "box", a: { kind: "box", x: 40, y: 60, w: 120, h: 30, color: "#ff0000", width: 2 } },
  { name: "box+fill", a: { kind: "box", x: 40, y: 60, w: 120, h: 30, color: "#ff0000", width: 2, fill: "#00ff00", fillOpacity: 0.5 } },
  { name: "ellipse", a: { kind: "ellipse", x: 40, y: 60, w: 120, h: 30, color: "#ff0000", width: 2 } },
  { name: "draw", a: { kind: "draw", color: "#0000ff", width: 3, pts: [{ x: 30, y: 40 }, { x: 90, y: 120 }, { x: 150, y: 70 }] } },
  { name: "cloud", a: { kind: "cloud", x: 60, y: 90, w: 140, h: 80, color: "#d32f2f", width: 2, bump: 12 } },
  { name: "cloud+fill", a: { kind: "cloud", x: 60, y: 90, w: 140, h: 80, color: "#d32f2f", width: 2, bump: 12, fill: "#ffffff", fillOpacity: 1 } },
  { name: "cloudpen", a: { kind: "cloudpen", color: "#d32f2f", width: 2, bump: 10, closed: true,
      pts: [{ x: 50, y: 50 }, { x: 160, y: 70 }, { x: 140, y: 170 }, { x: 45, y: 140 }] } },
  { name: "check", a: { kind: "check", x: 70, y: 100, w: 24, h: 18, color: "#2e7d32", width: 2 } },
  { name: "cross", a: { kind: "cross", x: 70, y: 100, w: 24, h: 18, color: "#d32f2f", width: 2 } },
  // Unlabelled on purpose: the label is a PNG (renderTextPng → canvas) and its
  // drawImage already carries `rotate`. What is measured here is the line + head.
  { name: "arrow", a: { kind: "arrow", x1: 40, y1: 50, x2: 180, y2: 130, color: "#000000", width: 2 } },
  // Same for dim: line + two perpendicular end ticks, no measured text.
  { name: "dim", a: { kind: "dim", x1: 40, y1: 50, x2: 180, y2: 130, color: "#000000", width: 2, text: "" } },
];

(async () => {
  // ---- 1. every kind lands in the same display-space place at every rotation ----
  for (const { name, a } of KINDS) {
    const ref = await displayInk(a, 0);
    check(`${name}: rotation 0 actually emits ink`, ref.length > 0, true);
    for (const rot of [90, 180, 270]) {
      const got = await displayInk(a, rot);
      check(`${name}: /Rotate ${rot} bakes to the same display points as 0°`, got, ref);
      check(`${name}: /Rotate ${rot} bakes to the same display bbox as 0°`, bbox(got), bbox(ref));
    }
  }

  // ---- 2. rotation 0 is the right ABSOLUTE answer, not just the shared one ----
  // Without this, "all four rotations agree" could be satisfied by four identically
  // wrong results. Only the kinds whose baked extent is unambiguous by definition.
  {
    const hl = { kind: "highlight", x: 40, y: 60, w: 120, h: 30, color: "#ffd54a" };
    check("highlight: 0° box is exactly the annot's own box",
      bbox(await displayInk(hl, 0)), [40, 60, 160, 90]);
    const bx = { kind: "box", x: 40, y: 60, w: 120, h: 30, color: "#f00", width: 2 };
    check("box: 0° box is exactly the annot's own box",
      bbox(await displayInk(bx, 0)), [40, 60, 160, 90]);
    // The cloud's ink spans the box GROWN by one bump on each side — that is what
    // `pad` is for, and it is the number the overlay's <svg> viewBox uses too (BI-40).
    const cl = { kind: "cloud", x: 60, y: 90, w: 140, h: 80, color: "#d32f2f", width: 2, bump: 12 };
    const cb = bbox(await displayInk(cl, 0));
    check("cloud: 0° ink starts at the padded top-left (x)", cb[0] <= 60 && cb[0] >= 60 - 12, true);
    check("cloud: 0° ink starts at the padded top-left (y)", cb[1] <= 90 && cb[1] >= 90 - 12, true);
    check("cloud: 0° ink ends at the padded bottom-right (x)", cb[2] >= 200 && cb[2] <= 200 + 12, true);
    check("cloud: 0° ink ends at the padded bottom-right (y)", cb[3] >= 170 && cb[3] <= 170 + 12, true);
    // An arrow's ink must contain both endpoints the user dragged out.
    const ar = { kind: "arrow", x1: 40, y1: 50, x2: 180, y2: 130, color: "#000", width: 2 };
    const ab = bbox(await displayInk(ar, 0));
    check("arrow: 0° ink contains tail and tip", ab[0] <= 40 && ab[1] <= 50 && ab[2] >= 180 && ab[3] >= 130, true);
  }

  // ---- 3. GUARD: prove this grid can still FAIL --------------------------------
  // Re-creates the reported bug by hand — the same cloud path drawn WITHOUT the
  // `rotate` option — and demands the points disagree with rotation 0. If someone
  // deletes `rotate: pageRotate(page)` from drawOneAnnot, section 1 must go red; this
  // case is what proves section 1 is sensitive rather than vacuously green.
  {
    const a = { kind: "cloud", x: 60, y: 90, w: 140, h: 80, color: "#d32f2f", width: 2, bump: 12 };
    const { d, pad } = cloudPath(a.w, a.h, bumpOf(a));
    const bare = async (rot) => {
      const { page, vp1 } = await makePage(rot);
      const map = makeMap(vp1, "orig");
      const [bx, by] = map(a.x - pad, a.y - pad);
      page.drawSvgPath(d, { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: 2 }); // no rotate — the bug
      return toDisplaySet(inkUserPoints(page), vp1);
    };
    const ref = await bare(0);
    for (const rot of [90, 180, 270]) {
      const got = await bare(rot);
      check(`guard: drawSvgPath WITHOUT rotate is wrong at ${rot}° (grid is sensitive)`,
        JSON.stringify(got) !== JSON.stringify(ref), true);
    }
    // …and the same path WITH the option is right, so the guard is measuring the
    // option and not some unrelated difference between the four pages.
    check("guard: the only difference is the rotate option",
      JSON.stringify(await displayInk(a, 90)) === JSON.stringify(await displayInk(a, 0)), true);
  }

  // ---- 4. the compensation is a NO-OP on a normal page -------------------------
  // Unrotated pages are every ordinary document. `degrees(0)` must leave the emitted
  // matrix alone, or this "fix" would move ink for every existing user.
  {
    const { page } = await makePage(0);
    check("pageRotate(unrotated page) is 0°", pageRotate(page).angle, 0);
  }

  // ---- 5. a RE-EDITABLE annotation lands where the flattened path put it (BI-59) --
  //
  // The same invariant as section 1, for the other writer. `addManagedAnnot` does not
  // draw into the content stream at all — it writes a /Stamp whose /AP form the viewer
  // places from /Rect + /Matrix — so section 1's reader cannot see it and section 1's
  // pass says nothing about it. Until BI-59 the question did not arise: the three
  // /AP-bearing kinds simply refused a rotated page and were flattened instead, which
  // is irreversible and cost the user every text box on every drawing sheet.
  //
  // Reference is the SHIPPED flatten path for the same annot — not a hand-derived box.
  // So a pass means "re-editable ink is where dan-cung ink was", and section 1 already
  // pins dan-cung ink to where the user drew it. The chain is closed.
  //
  // Only the IMAGE kind is driven, for the reason in the header: text and arrow need a
  // canvas. Their geometry is the SAME two calls (`apMatrixFor` / `apRectFor`) with a
  // rasterised w×h, and `test:managed` pins /Matrix and /Rect per angle for them.
  {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxIAE0DkAAKUcA/wgQ8p3AAAAAElFTkSuQmCC",
      "base64");
    const a = { id: 1, kind: "image", x: 40, y: 60, w: 120, h: 90,
                dataUrl: "data:image/png;base64," + PNG.toString("base64"), fmt: "png" };

    // Read the annot the writer just produced back into a display-space quad.
    async function annotDisplay(rot) {
      const { doc, page, vp1 } = await makePage(rot);
      const wrote = await addManagedAnnot(doc, page, a, makeMap(vp1, "orig"), new Map());
      const ref = page.node.Annots().get(0);
      const dict = doc.context.lookup(ref);
      const rect = dict.get(PDFName.of("Rect")).asArray().map((n) => n.asNumber());
      const form = doc.context.lookup(doc.context.lookup(dict.get(PDFName.of("AP"))).get(PDFName.of("N")));
      const fd = form.dict || form;
      const mtxObj = fd.get(PDFName.of("Matrix"));
      const m = mtxObj ? mtxObj.asArray().map((n) => n.asNumber()) : [1, 0, 0, 1, 0, 0];
      const bbox = fd.get(PDFName.of("BBox")).asArray().map((n) => n.asNumber());
      const { quad, scale } = apUserQuad(rect, m, bbox[2] - bbox[0], bbox[3] - bbox[1]);
      return { wrote, set: toDisplaySet(quad, vp1), scale, hasMatrix: !!mtxObj };
    }
    // The flattened path for the same annot, through the `Do` reader.
    async function flatDisplay(rot) {
      const { doc, page, vp1 } = await makePage(rot);
      await drawOneAnnot(doc, page, a, makeMap(vp1, "orig"));
      return toDisplaySet(xobjectUserQuad(page), vp1);
    }

    const flatRef = await flatDisplay(0);
    check("the flatten reference actually produced a quad", flatRef.length, 4);
    check("… and it is the box the user drew", bbox(flatRef), [40, 60, 160, 150]);
    for (const rot of [0, 90, 180, 270]) {
      check(`managed image: flatten path still agrees with 0° at ${rot}°`, await flatDisplay(rot), flatRef);
      const got = await annotDisplay(rot);
      check(`managed image: /Rotate ${rot} is written as a real annotation`, got.wrote, true);
      check(`managed image: /Rotate ${rot} annotation == flattened placement`, got.set, flatRef);
      check(`managed image: /Rotate ${rot} /AP mapping has no scaling (no stretch)`, got.scale, [1, 1]);
      check(`managed image: /Matrix present only when rotated (${rot}°)`, got.hasMatrix, rot !== 0);
    }

    // ---- GUARD: prove section 5 can still FAIL ---------------------------------
    // Re-creates the pre-BI-59 mistake by hand: an /AP written the naive way — no
    // /Matrix, /Rect = [bx, by, bx+w, by+h] — on a rotated page. That is exactly what
    // would ship if someone "simplified" apMatrixFor/apRectFor away, and it must
    // DISAGREE. Without this case, section 5 could be vacuously green (same reasoning
    // as the drawSvgPath guard in section 3 and BI-42).
    const naive = async (rot) => {
      const { vp1 } = await makePage(rot);
      const [bx, by] = makeMap(vp1, "orig")(a.x, a.y + a.h);
      const { quad } = apUserQuad([bx, by, bx + a.w, by + a.h], [1, 0, 0, 1, 0, 0], a.w, a.h);
      return toDisplaySet(quad, vp1);
    };
    check("guard: the naive /AP is RIGHT at 0° (so the guard isn't measuring noise)",
      JSON.stringify(await naive(0)), JSON.stringify(flatRef));
    for (const rot of [90, 180, 270]) {
      check(`guard: the naive /AP is wrong at ${rot}° (section 5 is sensitive)`,
        JSON.stringify(await naive(rot)) !== JSON.stringify(flatRef), true);
    }

    // An angle that is not a quarter turn has no matrix that would place it right, so
    // it must keep flattening. `/Rotate 45` is out of spec but real files carry it.
    const odd = await makePage(0);
    odd.page.node.set(PDFName.of("Rotate"), PDFLib.PDFNumber.of(45));
    check("an out-of-spec /Rotate 45 still falls back to flatten",
      await addManagedAnnot(odd.doc, odd.page, a, makeMap(odd.vp1, "orig"), new Map()), false);
    check("apRotatable / normAngle normalise the way the writer assumes",
      [apRotatable(-90), apRotatable(450), apRotatable(45), normAngle(-90), normAngle(360)],
      [true, true, false, 270, 0]);
  }

  console.log(`annot-rotate: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
