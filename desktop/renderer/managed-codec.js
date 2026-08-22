"use strict";

/*
 * "Managed annotation" codec — the private PDF object layer behind editable
 * annotations. Lifted out of editor.js at v0.2.49; every body was verified
 * byte-identical to v0.2.48's editor.js before the move.
 *
 * WHAT A MANAGED ANNOT IS. Text boxes, comment notes, arrows, inserted images and —
 * since v0.2.61/v0.2.63 — rectangles, ovals, revision clouds and freehand strokes are written as
 * REAL PDF annotations (so
 * Foxit/Acrobat show them) that ALSO carry a private `/NabuData` payload, plus — for
 * images — a `/NabuSrc` stream holding the ORIGINAL image file bytes. Re-opening the
 * file reads those back and rebuilds live, editable overlay objects instead of finding
 * flattened pixels.
 *
 * TWO FLAVOURS OF APPEARANCE, and the difference is worth knowing before editing here:
 * text / arrow / image carry a RASTER `/AP` (a PNG), because their ink is Vietnamese
 * glyphs or the user's own photo. box / ellipse / cloud / cloudpen / draw carry a VECTOR `/AP`
 * built from pdf-lib's own operator generators — see shapeAppearance(). The vector ones own
 * no image and no `/NabuSrc`, so the two invariants below are about the raster half of the
 * family.
 *
 * WHY IT LIVES IN ITS OWN FILE (docs/REGRESSION-GUARD.md §1, BI-37 / BI-38). This is
 * the highest-consequence code in the editor: a mistake here does not look like a bug,
 * it looks like the user's inserted image quietly disappearing from their contract, or
 * the file doubling in size on every save. Two invariants carry that weight:
 *   · `managedSrcBytes` returns null — meaning "LEAVE THIS ANNOT ALONE" — for anything
 *     that doesn't look exactly like our own output. A foreign editor that re-compressed
 *     our stream makes the annot read-only, never deleted.
 *   · `stripManagedFromPage` takes `trash` and defers freeing to `freeManagedTrash`,
 *     because ONE image source is shared by every page "Áp ảnh cho nhiều trang" put it
 *     on. Freeing mid-loop makes page 2's lookup return null → its annot is kept AND
 *     re-written → two stamps for one image. The parameter is not optional politeness.
 *
 * EXPOSURE — the `wire.js` tier of §2 (bare names at classic-script top level), same as
 * annot-text.js / annot-geom.js: the call sites in editor.js did not change, so its side
 * of the move is a pure deletion. `module.exports` for node, `window.ManagedCodec` for a
 * probe. MUST be loaded BEFORE editor.js (and AFTER wire.js + annot-text.js).
 *
 * WHAT DELIBERATELY STAYED IN editor.js:
 *   · `deserializeManaged` — mints ids from `ed.seq`, so it needs editor state.
 *   · `addManagedAnnot` (and its `f` formatter) — calls the canvas rasterisers
 *     `renderTextPng` / `renderArrowPng`, so it cannot run outside a browser.
 *   · `URL_TOKEN` — belongs to the undo snapshot pool, not to this codec.
 */

// WRAPPED IN AN IIFE, unlike annot-text.js / annot-geom.js — and that is not stylistic.
// This file needs pdf-lib's `PDFName` / `PDFRawStream` / `PDFDict` / `degrees` by BARE
// NAME (the function bodies below are byte-identical to editor.js's, which had them in
// scope). Declaring those at the top level of a classic script puts them in the SHARED
// global scope, where `degrees` collides with `app.js:17`
// (`const { PDFDocument, degrees } = window.PDFLib`) — two top-level `const`s of one
// name is a SyntaxError, app.js dies, and every script after it loses `$`. The whole app
// went white. node's require() cannot see this at all (no shared global scope): all 537
// grid cases passed while the app was broken. Only the Electron probe caught it.
// So: pdf-lib stays PRIVATE in here, and the public surface is published explicitly at
// the bottom. Lesson recorded in BI-14 — when hoisting code into a classic script, check
// the DESTRUCTURED BINDINGS for collisions, not just the function names.
(function () {
  // The browser gets the UMD global from vendor/pdf-lib.min.js (loaded first in
  // index.html); node (tests) resolves the same 1.17.1 from node_modules, which
  // `npm run vendor` copies verbatim into renderer/vendor — byte-identical, so answers
  // measured in node apply to the build.
  const _PDFLib =
    (typeof window !== "undefined" && window.PDFLib) ||
    (typeof require === "function" ? require("pdf-lib") : null);
  if (!_PDFLib) throw new Error("managed-codec: pdf-lib unavailable (load vendor/pdf-lib.min.js first)");
  // `drawRectangle` / `drawEllipse` here are pdf-lib's low-level OPERATOR GENERATORS
  // (they return PDFOperator[]), not the PDFPage methods of the same name — the very
  // functions `page.drawRectangle` calls once it has resolved its own options. Taking
  // them by the same route as PDFName keeps them inside this IIFE, so BI-14's collision
  // trap does not apply: nothing of theirs reaches the shared classic-script scope.
  const { PDFName, PDFRawStream, PDFDict, degrees, drawRectangle, drawEllipse, drawSvgPath,
          setLineJoin, LineCapStyle, LineJoinStyle } = _PDFLib;

  // `pushB64Chunks` (wire.js) and `normTextStyle` (annot-text.js) are bare names in the
  // shared classic-script scope; in node they come from their modules. Resolved lazily
  // inside the functions that need them so this file has no load-order trap of its own
  // beyond the documented "after wire.js / annot-text.js".
  function _pushB64Chunks(parts, bytes) {
    if (typeof pushB64Chunks === "function") return pushB64Chunks(parts, bytes);
    return require("./wire.js").pushB64Chunks(parts, bytes);
  }
  function _normTextStyle(a) {
    if (typeof normTextStyle === "function") return normTextStyle(a);
    return require("./annot-text.js").normTextStyle(a);
  }
  // Same lazy shape for annot-geom.js's cloud geometry — loaded before this file in the
  // browser (index.html), require()d here under node. shapeAppearance() calls these
  // rather than re-deriving a scallop: the overlay <svg>, the flattened bake and the
  // round-trip appearance must all be the SAME path string, or a re-opened cloud comes
  // back a slightly different shape than the one the user drew.
  function _cloudPath(w, h, bump) {
    if (typeof cloudPath === "function") return cloudPath(w, h, bump);
    return require("./annot-geom.js").cloudPath(w, h, bump);
  }
  function _cloudPathPoly(pts, bump) {
    if (typeof cloudPathPoly === "function") return cloudPathPoly(pts, bump);
    return require("./annot-geom.js").cloudPathPoly(pts, bump);
  }
  function _bumpOf(a) {
    if (typeof bumpOf === "function") return bumpOf(a);
    return require("./annot-geom.js").bumpOf(a);
  }
  function _strokePath(pts) {
    if (typeof strokePath === "function") return strokePath(pts);
    return require("./annot-geom.js").strokePath(pts);
  }
  function _simplifyStroke(pts) {
    if (typeof simplifyStroke === "function") return simplifyStroke(pts);
    return require("./annot-geom.js").simplifyStroke(pts);
  }

  // ---- the private keys ----------------------------------------------------

  // Kinds that round-trip as real annotations rather than being flattened to pixels.
  //
  // `box` / `ellipse` / `cloud` / `cloudpen` joined at v0.2.61 and `draw` at v0.2.63;
  // they are the members whose appearance is VECTOR rather than a rasterised PNG — see
  // shapeAppearance() below for why that is the cheap option here and not for text/arrow.
  const MANAGED_KINDS = new Set(["text", "note", "image", "arrow", "box", "ellipse", "cloud", "cloudpen", "draw"]);
  // The vector half of the family, as one name: five kinds that share ONE branch in
  // addManagedAnnot and ONE branch in deserializeManaged (shapeAppearance splits them
  // three ways internally — box/ellipse, cloud/cloudpen, draw — but no caller cares
  // which, and that is the point of having the predicate).
  // Named because "is this kind vector?" is asked in three files, and an inline `||`
  // chain in each is how those three drift apart (same argument as RESIZABLE_KINDS).
  const VECTOR_KINDS = new Set(["box", "ellipse", "cloud", "cloudpen", "draw"]);
  function isVectorKind(k) { return VECTOR_KINDS.has(k); }
  const NABU_KIND = PDFName.of("NabuKind");
  const NABU_DATA = PDFName.of("NabuData");
  // Private carrier for an image's ORIGINAL file bytes — see addManagedAnnot's
  // image branch for why the bytes can't live in /NabuData like every other kind.
  const NABU_SRC = PDFName.of("NabuSrc");
  const NABU_IMG = PDFName.of("NabuImg"); // the appearance's one XObject resource name
  const P_ANNOTS = PDFName.of("Annots");

  function isManagedKind(k) { return MANAGED_KINDS.has(k); }

  // ---- bytes / images -----------------------------------------------------

  // Identify an image by its magic bytes — pdf-lib can only embed PNG or JPEG, and
  // the file's reported MIME is unreliable (empty for some files, wrong for others).
  // Returns "png", "jpg", or null (unsupported: webp/gif/bmp/svg/…).
  function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return "png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    return null;
  }

  function strToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  // ---- coordinate mapping -------------------------------------------------

  function makeMap(vp1, mode) {
    if (mode === "image") return (x, y) => [x, vp1.height - y];
    return (x, y) => {
      const r = vp1.convertToPdfPoint(x, y);
      return [r[0], r[1]];
    };
  }

  function pageRotate(page) {
    return degrees(page.getRotation().angle);
  }

  // ---- placing an appearance on a page that carries /Rotate ----------------
  //
  // THE PROBLEM these three solve. A managed annot's appearance is a Form XObject
  // placed by its `/Rect`, which lives in UNROTATED user space — the viewer applies
  // `/Rotate` to page content and annotations alike, afterwards. So on a rotated page
  // an appearance written the naive way comes out spun (and in the wrong place), which
  // is why text / arrow / image used to answer `false` there and fall through to being
  // flattened into pixels. Flattened is irreversible: nothing is left for
  // importManaged() to read, so every text box on a rotated page was permanently
  // un-editable — including on any page the user rotated with our own "Xoay trang".
  //
  // THE FIX, and why it needs no new constant. The `/AP` content is
  // `q w 0 0 h 0 0 cm /NabuImg Do Q`: the unit square scaled to (w,h) in FORM space.
  // The flattened path emits `translate(bx,by) · R(angle) · scale(w,h)`. Balance the
  // two and the appearance's own matrix falls out as `/Matrix = R(angle)` with the
  // translation `(bx, by)` — the anchor `map(a.x, a.y + a.h)` already computes. Then by
  // PDF 32000-1 §12.5.5 the viewer bounds `Matrix × BBox`, maps that box onto `/Rect`,
  // and draws through both — so `/Rect` must be exactly that bbox moved to the anchor,
  // or the viewer would SCALE the appearance to fit and distort it.
  //
  // MEASURED, not derived on paper: `npm run test:rotate` bakes the same annot onto
  // four pages differing only in /Rotate, composes the real CTM out of the content
  // stream, and checks the annotation lands on the same DISPLAY-space quad as the
  // flattened path — at 0/90/180/270, with the /AP mapping scale pinned at exactly 1
  // in both axes. See docs/SPEC-annot-rotated.md §5.
  //
  // At 0° `apMatrixFor` is the identity and `apRectFor` returns `[bx, by, bx+w, by+h]`
  // — byte-for-byte what shipped before this existed. addManagedAnnot writes no
  // `/Matrix` at all in that case, so unrotated documents (very nearly all of them) are
  // untouched. Do not "simplify" that guard away. BI-59.
  function normAngle(angle) {
    return (((Number(angle) || 0) % 360) + 360) % 360;
  }

  // Only clean quarter turns get a rotated appearance. /Rotate 45 is out of spec but
  // real files carry it; those keep flattening rather than being placed wrong.
  function apRotatable(angle) {
    return normAngle(angle) % 90 === 0;
  }

  // R(angle) as a PDF matrix [a b c d e f]: (x,y) → (a·x + c·y + e, b·x + d·y + f).
  function apMatrixFor(angle) {
    const a = normAngle(angle);
    if (a === 90) return [0, 1, -1, 0, 0, 0];
    if (a === 180) return [-1, 0, 0, -1, 0, 0];
    if (a === 270) return [0, -1, 1, 0, 0, 0];
    return [1, 0, 0, 1, 0, 0];
  }

  // The bbox of `apMatrixFor(angle) × [0,w]×[0,h]`, translated so the appearance's
  // visual anchor lands on (bx, by) — the same point the flattened path draws from.
  // Dimensions swap at 90/270, which is exactly right: that is what the viewer will
  // un-rotate back into a w×h box on screen.
  function apRectFor(angle, w, h, bx, by) {
    const m = apMatrixFor(angle);
    const xs = [];
    const ys = [];
    for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
      xs.push(m[0] * x + m[2] * y + m[4]);
      ys.push(m[1] * x + m[3] * y + m[5]);
    }
    return [bx + Math.min(...xs), by + Math.min(...ys), bx + Math.max(...xs), by + Math.max(...ys)];
  }

  // ---- vector appearances (box / ellipse) ---------------------------------
  //
  // WHY THESE TWO ARE NOT RASTERISED. text and arrow put a PNG in their `/AP` because
  // their ink is Vietnamese glyphs, and embedding a font that renders "Nghiệm thu" is a
  // problem we deliberately do not have. A rectangle and an oval have no such excuse:
  // pdf-lib EXPORTS the very operator generators `page.drawRectangle` / `page.drawEllipse`
  // call internally, so the appearance can be the SAME path the flattened writer emits —
  // just inside a Form XObject instead of the page content stream. That buys three things
  // a canvas could not: it stays sharp at any zoom and on paper, it costs a few dozen
  // bytes instead of a supersampled bitmap, and — because the geometry comes from the
  // same function — the round-trip cannot drift away from `drawOneAnnot`'s output.
  //
  // `stroke` / `fill` are pdf-lib rgb() objects, NOT hex: hexRgb lives in editor.js and
  // this file stays free of it, the same way it stays free of the canvas rasterisers.
  // `fill` null means stroke-only, which is the common case.
  //
  // THE PADDING IS LOAD-BEARING. A `/AP` form CLIPS to its `/BBox`, and half of a stroke
  // sits outside the path it follows — at a mitred rectangle corner, √2 halves. Size the
  // BBox to w×h and the user's border comes back shaved on all four sides. One full
  // stroke width covers the mitre with room to spare; the extra margin is transparent,
  // so being generous costs nothing and being exact costs a bug report.
  //
  // Fill opacity travels in an ExtGState that is written DIRECT (inline in /Resources),
  // never as a registered indirect object. That is not a style choice: collectManagedChain
  // frees `/NabuSrc`, `/NabuImg` and the form itself, and an indirect ExtGState would be a
  // fourth object nobody frees — a slow leak on every re-bake, which is exactly the class
  // of bug BI-38 exists to prevent. A direct dict dies with the form that holds it.
  //
  // ROTATION IS NOT THIS FUNCTION'S JOB, and that is the single most important line here.
  // The flattened writer must pass `rotate: pageRotate(page)` to drawSvgPath, because it
  // hands pdf-lib a LOCAL coordinate system and lets it place that system in user space —
  // forgetting it is exactly how khoanh mây came out spun on every rotated page until
  // v0.2.52 (BI-45). Inside a Form XObject the local system IS the form's own space, which
  // is display-upright by construction, and `/Matrix = R(angle)` on the form does the
  // turning. So everything below draws at `degrees(0)`, always. Passing the page angle in
  // here would rotate it TWICE.
  //
  // RETURNS `ox` / `oy` — the OVERLAY coordinates of the form's bottom-left corner — so the
  // caller maps one point and never has to know which kind's padding rule applied. That is
  // deliberate: `pad` means different things to a box (half a mitred stroke) and to a cloud
  // (a whole scallop bump PLUS the stroke), and a caller re-deriving the anchor per kind is
  // four chances to be off by one stroke width. Returns null for a degenerate freehand
  // cloud (<3 distinct points), which means "flatten this one" — cloudPathPoly says the
  // same thing to drawOneAnnot, so both writers agree to draw nothing.
  function shapeAppearance(a, stroke, fill, fillOpacity) {
    const lw = Math.max(0.1, +a.width || 2);
    const useGs = !!fill && fillOpacity != null && fillOpacity < 1;
    const common = {
      borderWidth: lw,
      borderColor: stroke,
      color: fill || undefined, // undefined ⇒ pdf-lib emits `S` (stroke) instead of `B`
      rotate: degrees(0), // see ROTATION note above — never the page angle
    };
    if (useGs) common.graphicsState = "NabuGS"; // emits `/NabuGS gs`
    const out = (ops, wPt, hPt, left, top) => ({
      ops: ops.map(String).join("\n"),
      wPt, hPt, pad: lw,
      ox: left,
      oy: top + hPt, // overlay y grows DOWN, so the form's bottom edge is top + height
      // `ca` only — the flattened path passes pdf-lib just `opacity`, which is fill
      // alpha; stroke alpha (`CA`) is a knob the editor does not expose, and inventing
      // one here would make the bake disagree with the overlay.
      resources: useGs ? { ExtGState: { NabuGS: { Type: "ExtGState", ca: fillOpacity } } } : null,
    });

    // -- freehand strokes: an open polyline, y-DOWN, local 0-origin ------------
    //
    // ROUND CAPS AND ROUND JOINS ARE NOT DECORATION — they are what makes this /AP
    // and drawOneAnnot's flattened version the SAME PICTURE. The flattened writer
    // draws the stroke as N independent `drawLine` segments with `LineCapStyle.Round`
    // (it has to: independently mapped endpoints are what keeps it correct on a
    // rotated page, see the note above drawAnnots). A round cap at every shared
    // endpoint is geometrically identical to a round join along one polyline, so the
    // two primitives paint the same ink. Drop either setting and they stop matching:
    // butt caps leave notches between segments, and a mitre join spikes up to 10x the
    // pen width at a Shift-straight elbow.
    //
    // `setLineJoin` is spliced in AFTER drawSvgPath's own `q` (its ops[0] is
    // pushGraphicsState) rather than prepended, so `1 j` is scoped by the same
    // q/Q pair as everything else it affects and cannot leak into a later operator.
    // pdf-lib exposes no borderLineJoin option — measured on the shipped 1.17.1,
    // drawSvgPath emits `J` from `borderLineCap` and nothing at all for the join.
    if (a.kind === "draw") {
      const g = _strokePath(a.pts);
      if (!g) return null; // fewer than two distinct points — caller flattens (= nothing)
      const wPt = g.W + 2 * lw;
      const hPt = g.H + 2 * lw;
      const ops = drawSvgPath(g.d, Object.assign({}, common, {
        x: lw, y: hPt - lw, borderLineCap: LineCapStyle.Round,
      }));
      ops.splice(1, 0, setLineJoin(LineJoinStyle.Round));
      return out(ops, wPt, hPt, g.minX - lw, g.minY - lw);
    }

    // -- revision clouds: ONE SVG path, y-DOWN, local 0-origin -----------------
    // annot-geom already shifts the path by its own `pad` so the scallops stay ≥ 0 —
    // the same string the overlay <svg> uses. All this adds is room for the STROKE,
    // which sits outside the bulges and would otherwise be clipped by /BBox.
    if (a.kind === "cloud" || a.kind === "cloudpen") {
      const g = a.kind === "cloud"
        ? _cloudPath(a.w, a.h, _bumpOf(a))
        : _cloudPathPoly(a.pts, _bumpOf(a));
      if (!g) return null; // degenerate polygon — caller falls through to flatten
      // Overlay position of the path's local (0,0): the same anchor drawOneAnnot maps.
      const gx = (a.kind === "cloud" ? a.x : g.minX) - g.pad;
      const gy = (a.kind === "cloud" ? a.y : g.minY) - g.pad;
      const wPt = g.W + 2 * lw;
      const hPt = g.H + 2 * lw;
      // drawSvgPath emits translate(x,y) · R · scale(1,-1), so its anchor is the path
      // box's TOP-left, not its bottom-left. Inside the form that point is (lw, hPt-lw).
      const ops = drawSvgPath(g.d, Object.assign({}, common, { x: lw, y: hPt - lw }));
      return out(ops, wPt, hPt, gx - lw, gy - lw);
    }

    // -- rectangles and ovals --------------------------------------------------
    const w = Math.max(0, +a.w || 0);
    const h = Math.max(0, +a.h || 0);
    const wPt = w + 2 * lw;
    const hPt = h + 2 * lw;
    // xSkew / ySkew are REQUIRED by drawRectangle in pdf-lib 1.17.1 — it reads `.type`
    // off each without a guard and throws on a missing one. drawEllipse does not take
    // them at all, and drawSvgPath ignores them. Measured, not assumed.
    const boxCommon = Object.assign({}, common, { xSkew: degrees(0), ySkew: degrees(0) });
    const ops =
      a.kind === "ellipse"
        ? drawEllipse(Object.assign({}, common, {
            x: lw + w / 2, y: lw + h / 2, xScale: w / 2, yScale: h / 2,
          }))
        : drawRectangle(Object.assign({}, boxCommon, { x: lw, y: lw, width: w, height: h }));
    return out(ops, wPt, hPt, a.x - lw, a.y - lw);
  }

  // ---- the /NabuData payload ----------------------------------------------

  // Editable payload stored in /NabuData so a re-opened file reconstructs the
  // overlay object. Geometry travels here too (not just the /Rect) so retyping /
  // restyling is lossless.
  function serializeManaged(a) {
    if (a.kind === "text") {
      const s = _normTextStyle(a);
      return { k: "text", x: a.x, y: a.y, w: a.w, h: a.h, text: a.text,
               font: a.font, fontSize: a.fontSize, color: a.color,
               bold: !!a.bold, italic: !!a.italic, underline: !!a.underline,
               strike: s.strike, align: s.align, lineHeight: s.lineHeight,
               paraSpacing: s.paraSpacing, letterSpacing: s.letterSpacing,
               wordSpacing: s.wordSpacing, charScale: s.charScale,
               indent: s.indent, listType: s.listType, opacity: s.opacity,
               rot: s.rot };
    }
    if (a.kind === "arrow") {
      return { k: "arrow", x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2,
               color: a.color, width: a.width || 2,
               label: a.label || "", labelEnd: a.labelEnd === "tail" ? "tail" : "head",
               labelSize: a.labelSize || 14 };
    }
    // Boxes and ovals: geometry + the four style knobs the edit bar exposes for them.
    // No appearance data at all travels here — shapeAppearance() rebuilds the vector
    // path from these numbers on every bake, so there is nothing that could go stale.
    // `fill` is written ONLY when there is one: an absent key reads back as "no fill",
    // which is what a file written before this existed must also mean.
    if (isVectorKind(a.kind)) {
      const o = { k: a.kind, color: a.color, width: a.width || 2 };
      if (a.kind === "draw") {
        // THINNED, unlike cloudpen's verbatim corners. A freehand stroke gains a
        // point per mousemove, so what reaches here is hundreds to thousands of
        // samples that all have to survive as hex inside /NabuData. simplifyStroke
        // is idempotent, so re-saving a reopened stroke writes the same list rather
        // than eroding it a little further every round. See annot-geom.js.
        o.pts = _simplifyStroke(a.pts).map((p) => ({
          x: +p.x.toFixed(2), y: +p.y.toFixed(2),
        }));
      } else if (a.kind === "cloudpen") {
        // The polygon's own vertices, at full precision. They are the ONLY record of the
        // shape (the scallops are re-derived from them), and a cloudpen is a handful of
        // clicked corners — not a freehand scribble — so there is nothing to thin out.
        o.pts = (a.pts || []).map((p) => ({ x: p.x, y: p.y }));
      } else {
        o.x = a.x; o.y = a.y; o.w = a.w; o.h = a.h;
      }
      // Written RESOLVED, not as `a.bump`: a cloud drawn before the size control existed
      // carries no `bump` at all and renders at the historical default, so pinning what
      // was actually drawn is what keeps it looking the same after a round-trip.
      if (a.kind === "cloud" || a.kind === "cloudpen") o.bump = _bumpOf(a);
      if (a.fill && a.fill !== "none") {
        o.fill = a.fill;
        o.fillOpacity = a.fillOpacity != null ? a.fillOpacity : 1;
      }
      return o;
    }
    // Geometry only — the pixels travel in the /NabuSrc stream, not in here.
    if (a.kind === "image") {
      return { k: "image", x: a.x, y: a.y, w: a.w, h: a.h, fmt: a.fmt === "jpg" ? "jpg" : "png" };
    }
    // note
    return { k: "note", x: a.x, y: a.y, w: a.w, h: a.h, text: a.text || "",
             color: a.color, replies: a.replies || [] };
  }

  function pushPageAnnot(doc, page, ref) {
    let arr = page.node.Annots();
    if (!arr) { arr = doc.context.obj([]); page.node.set(P_ANNOTS, arr); }
    arr.push(ref);
  }

  // ---- reading an image back ----------------------------------------------

  // The original image bytes behind a managed image annot, or null when they can't
  // be trusted. `null` deliberately means "leave this annot alone": it is neither
  // imported as an editable object nor stripped on the next bake, so a file that has
  // been through another PDF editor loses nothing — the image simply stays a plain
  // stamp. We write the stream with NO /Filter, so any filter at all means someone
  // else re-encoded it and `contents` is no longer the image file.
  function managedSrcBytes(doc, dict) {
    try {
      const ref = dict.get(NABU_SRC);
      if (!ref) return null;
      const st = doc.context.lookup(ref);
      if (!(st instanceof PDFRawStream) || !st.contents || !st.contents.length) return null;
      const d = st.dict || st;
      if (d.get && d.get(PDFName.of("Filter"))) return null;
      return sniffImage(st.contents) ? st.contents : null;
    } catch (_) {
      return null;
    }
  }

  // Image bytes → the data URL the overlay <img> and the next bake both need.
  // Uses wire.js's pushB64Chunks, the one tested chunked encoder in the renderer:
  // btoa(String.fromCharCode(...wholeBuffer)) blows the stack on a real photo, and
  // BI-24 is explicit that no new general-purpose byte→base64 helper gets written.
  // One image needing one data: URL is the narrow case that legitimately needs the
  // string at all — do NOT generalise this to documents.
  function managedSrcDataUrl(bytes) {
    const parts = [];
    _pushB64Chunks(parts, bytes);
    return "data:image/" + (sniffImage(bytes) === "jpg" ? "jpeg" : "png") + ";base64," + parts.join("");
  }

  // ---- replacing / freeing ------------------------------------------------

  // Every object a managed annot privately owns, collected for deletion: its /AP
  // form, that form's /NabuImg image (+ the /SMask a transparent PNG brings) and its
  // /NabuSrc stream, then the annot dict itself. Anything that doesn't look exactly
  // like our own output is skipped — worst case we keep the old growth, never a
  // dangling reference.
  function collectManagedChain(doc, dict, annotRef, out) {
    const ctx = doc.context;
    try {
      const src = dict.get(NABU_SRC);
      if (src) out.push(src);
      const apDict = ctx.lookup(dict.get(PDFName.of("AP")));
      const nRef = apDict && apDict.get && apDict.get(PDFName.of("N"));
      if (nRef) {
        const form = ctx.lookup(nRef);
        const fd = form && (form.dict || form);
        const resDict = fd && fd.get && ctx.lookup(fd.get(PDFName.of("Resources")));
        const xoDict = resDict && resDict.get && ctx.lookup(resDict.get(PDFName.of("XObject")));
        const imgRef = xoDict && xoDict.get && xoDict.get(NABU_IMG);
        if (imgRef) {
          const img = ctx.lookup(imgRef);
          const sm = img && (img.dict || img).get && (img.dict || img).get(PDFName.of("SMask"));
          if (sm) out.push(sm);
          out.push(imgRef);
        }
        out.push(nRef);
      }
    } catch (_) {
      /* leave whatever we could not walk in place */
    }
    out.push(annotRef);
  }

  // Actually free the collected objects. Deferred to the END of a whole-document
  // strip on purpose: an image source is SHARED by every page "Áp ảnh/chữ ký cho
  // nhiều trang" put it on, so deleting page 1's copy mid-loop would make page 2's
  // managedSrcBytes come back null and its annot would be kept AND re-written —
  // two stamps for one image. Duplicate refs are de-duped here, so sharing is free.
  function freeManagedTrash(doc, trash) {
    const uniq = new Map();
    for (const r of trash) if (r) uniq.set(String(r), r);
    for (const r of uniq.values()) {
      try { doc.context.delete(r); } catch (_) { /* already gone / not an indirect ref */ }
    }
  }

  // Unlink every previously-written managed annotation on `page`, so a re-bake
  // replaces rather than duplicates them, pushing what they own onto `trash` for
  // freeManagedTrash. Returns the count unlinked.
  //
  // Unlinking alone is NOT enough, and that was a real (if quiet) bug: pdf-lib keeps
  // every parsed object and writes them all back, so the appearance PNG of each
  // replaced stamp stayed in the file forever — a text box re-baked ten times
  // shipped ten copies of its PNG. With images (megabytes) that growth is impossible
  // to ignore, hence the chain delete. It is provably safe: pdf-lib's embedPng /
  // embedJpg hand out a FRESH ref per call (they never dedupe by content), and
  // /NabuImg is a resource name nothing else writes, so once the annot is gone
  // nothing can still point at its appearance.
  function stripManagedFromPage(doc, page, trash) {
    const arr = page.node.Annots();
    if (!arr) return 0;
    const bin = trash || [];
    let removed = 0;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const ref = arr.get(i);
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict) || !dict.get(NABU_KIND)) continue;
      // A managed image whose source bytes we can't read is not ours to replace:
      // importManaged skipped it too, so ed.annots holds no copy and removing it
      // would delete the user's image outright.
      if (String(dict.get(NABU_KIND)) === "/image" && !managedSrcBytes(doc, dict)) continue;
      arr.remove(i);
      collectManagedChain(doc, dict, ref, bin);
      removed++;
    }
    if (!trash) freeManagedTrash(doc, bin); // single-page call: nothing left to share with
    return removed;
  }
  function stripManagedAnnots(doc) {
    const trash = [];
    let removed = 0;
    for (const page of doc.getPages()) removed += stripManagedFromPage(doc, page, trash);
    freeManagedTrash(doc, trash);
    return removed;
  }

  // node (tests) takes the module export. The browser needs these reachable BY BARE NAME
  // from editor.js, and the IIFE above means they are no longer top-level declarations —
  // so publish them onto the global object explicitly. A global *property* resolves for a
  // bare-name read exactly like a top-level `const` would, and unlike one it cannot
  // SyntaxError against another script's declaration (that is the whole point).
  // Safe to Object.assign here because every entry is a plain function or constant: the
  // v0.2.45 trap (Object.assign copies a getter's VALUE, freezing it) needs a getter,
  // and this surface has none. Do not add one without revisiting this.
  const _SURFACE = {
    MANAGED_KINDS, VECTOR_KINDS, NABU_KIND, NABU_DATA, NABU_SRC, NABU_IMG, P_ANNOTS,
    isManagedKind, isVectorKind, sniffImage, strToBytes, makeMap, pageRotate,
    normAngle, apRotatable, apMatrixFor, apRectFor, shapeAppearance,
    serializeManaged, pushPageAnnot, managedSrcBytes, managedSrcDataUrl,
    collectManagedChain, freeManagedTrash, stripManagedFromPage, stripManagedAnnots,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = _SURFACE;
  if (typeof window !== "undefined") {
    window.ManagedCodec = _SURFACE; // the name a probe/test can assert on
    Object.assign(window, _SURFACE); // the bare names editor.js calls
  }
})();
