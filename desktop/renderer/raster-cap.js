"use strict";

/**
 * Nabu PDF — raster budget for a page bitmap (BI-78). Pure, no DOM.
 *
 * Lives in its own file for ONE reason, the same reason page-range.js does: when
 * this arithmetic is wrong the failure is SILENT. Past a canvas area of ~268 MP
 * Chromium accepts canvas.width, returns a 2d context, resolves page.render in
 * ~7 ms — and paints NOTHING. No exception to catch, so a large-format sheet just
 * goes blank (docs/RESEARCH-2026-09-07-zoom-range-20-500.md §3.2).
 *
 * Hoisted out of app.js on 2026-09-08 because the split-view work adds a SECOND
 * page (renderer/view.html, the read-only pane) that rasterises PDF pages. A copy
 * of these three constants in that file would be BI-78 dying by halves: change one
 * side, the other keeps the old number, and the symptom is a white A0 drawing with
 * nothing in the console. One definition, both callers.
 *
 * Loaded as a classic <script> (shared global scope, like every renderer file) AND
 * requireable from node — see desktop/test/raster-cap.test.js. Callers use
 * `window.RasterCap.*`, never bare names, so a missing file fails loudly at the
 * call site instead of poisoning the shared scope (BI-14). The IIFE keeps the
 * constants private for the same reason (BI-14, second half: a bare top-level
 * `const` in a new classic script can collide with app.js and kill it outright).
 */
(function () {
  // A page's bitmap is `CSS box × devicePixelRatio`, so it grows with the SQUARE of
  // the zoom level. Measured in Chromium 148 with the pdf.js we ship:
  //   • A3 at 500%, dpr 1.5 → 56 MP = 215 MB for ONE page;
  //   • A0 at 300%, dpr 1.5 → 163 MP = 621 MB — i.e. already true at the OLD 300%
  //     ceiling, so this budget fixes a hole that predates the wider zoom range;
  //   • past a canvas AREA of ~268 MP (2^28) the page silently goes blank (above);
  //   • past a SIDE of 16384 px (Skia's texture limit) the canvas falls off the GPU
  //     path: the same render goes from 36 ms to 305 ms.
  // So the fix cannot be "pick a zoom ceiling that happens to fit" — a big enough
  // sheet blows the area cap at any ceiling. Instead we cap the bitmap and keep the
  // CSS box: the page still lays out at the full zoom (geometry, text layer,
  // annotations, scroll all unchanged — BI-36), only its pixels are coarser. Same
  // trick, same shape and the same reasoning as printScaleFor() on the print path.
  //
  // 32 MP ≈ 122 MB/page. Nothing under the budget is touched, so every everyday page
  // (A4 at 500%, dpr 1.5 = 28 MP) still rasterises at the full device resolution;
  // only large-format sheets and high-dpr extremes are eased down — and they are
  // eased to something FAR sharper than what the 268 MP cliff was silently giving.
  const MAX_VIEW_MEGAPIXELS = 32;
  // Second guard, for extreme aspect ratios that stay under the area budget: keep the
  // long side clear of Skia's 16384 px texture limit with room to spare.
  const MAX_VIEW_SIDE_PX = 12000;

  /**
   * Device-pixel ratio to rasterise a page whose CSS box is cw×ch at: the smallest
   * of the real dpr, the area budget and the side cap. NEVER upscales past the real
   * dpr — that would cost memory for no sharpness.
   */
  function viewRasterDpr(cw, ch, dpr) {
    if (!(cw > 0) || !(ch > 0)) return dpr;
    return Math.min(
      dpr,
      Math.sqrt((MAX_VIEW_MEGAPIXELS * 1e6) / (cw * ch)),
      MAX_VIEW_SIDE_PX / Math.max(cw, ch)
    );
  }

  const api = { viewRasterDpr, MAX_VIEW_MEGAPIXELS, MAX_VIEW_SIDE_PX };
  if (typeof window !== "undefined") window.RasterCap = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
