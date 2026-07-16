"use strict";

/**
 * Nabu PDF — renderer (Phase 4: overlay editor).
 *
 * Adds annotation / watermark / redaction / form-fill on top of the P1 viewer.
 * Design notes:
 *  - Annotations live in `ed.annots[pageIndex]` as plain objects whose coords are
 *    in *scale-1 PDF-point space, top-left origin* (the pdf.js viewport at scale 1).
 *    The overlay renders them at `state.scale`; baking maps them to pdf-lib's
 *    bottom-left user space via the page viewport's `convertToPdfPoint`.
 *  - Vietnamese text is rendered to a PNG via the system font and embedded as an
 *    image — pdf-lib's standard fonts can't encode Vietnamese diacritics and we
 *    deliberately avoid vendoring a Unicode font (offline / zero new deps).
 *  - Redaction is *secure*: any page with a redaction box is rasterised with the
 *    box burned in and the page content is replaced by that image, so the original
 *    text is physically gone (not merely covered). Other pages stay vector.
 *
 * Shares app.js globals (same classic-script scope): state, $, toast,
 * showOverlay/hideOverlay, renderAll, renderViewer, updateToolbar.
 */

(function () {
  const PDFLib = window.PDFLib;
  const { PDFDocument, rgb, PDFName, PDFHexString, degrees } = PDFLib;

  const ed = {
    active: false,
    tool: "select",
    color: "#ffd54a", // highlight / draw / new-text colour
    redactColor: "#000000", // redaction fill colour (separate from `color`)
    fontSize: 16, // points
    font: "sans", // text-box font family key (see FONT_STACKS)
    bold: false,
    italic: false,
    underline: false,
    penWidth: 2,
    fillColor: "#ffffff", // interior fill for box / ellipse / cloud / cloudpen
    fillOn: false, // false → transparent interior (the default for revision clouds)
    fillOpacity: 1, // 0..1 interior-fill opacity (0 = fully transparent, 1 = solid)
    annots: {}, // pageIndex -> [annot]
    watermark: null, // { text, size, angle, opacity, color }
    seq: 1,
    sel: null, // selected annot id (numbers are unique across pages)
    pendingImage: null, // { dataUrl, mime } awaiting a placement click
    _poly: null, // freehand-cloud polygon in progress: { page, id, layer, cx, cy }
    _form: null,
    _formDoc: null,
    // Measure/dimension tool: calibration from one known length + last-used unit.
    // unitsPerPoint = real-world units per PDF point; reset per edit session (a
    // different drawing has a different scale). See the "measure" tool branches.
    measureCal: null, // { unitsPerPoint } or null (not yet calibrated)
    measureUnit: "m", // unit label appended to auto dim text
    measureDecimals: 2, // decimal places for the measured value
    _dimPending: null, // drag awaiting the calibration modal: { id, page, layer, pdfDist }
  };

  // ---- model helpers -------------------------------------------------------

  function annotsFor(i) {
    return ed.annots[i] || (ed.annots[i] = []);
  }
  function findAnnot(id) {
    for (const i of Object.keys(ed.annots)) {
      const a = ed.annots[i].find((x) => x.id === id);
      if (a) return { a, page: +i };
    }
    return null;
  }
  function hasAny() {
    return Object.values(ed.annots).some((a) => a.length) || !!ed.watermark;
  }
  function countAnnots() {
    return Object.values(ed.annots).reduce((s, a) => s + a.length, 0) + (ed.watermark ? 1 : 0);
  }

  // ---- annotation-level undo/redo (Ctrl+Z/Y while the editor is open) ------
  // Snapshots of the *pending* annotations, separate from app.js's document
  // history: nothing here touches state.bytes until bake.

  const edHist = { past: [], future: [], lastKey: null, lastT: 0 };

  function edSnapshot() {
    return {
      annots: JSON.parse(JSON.stringify(ed.annots)),
      watermark: ed.watermark ? { ...ed.watermark } : null,
    };
  }
  // Record an undo step *before* a mutation. `coalesceKey` merges rapid repeats
  // (a colour-picker drag / font-size spinner fires per tick) into one step.
  function pushEdUndo(coalesceKey) {
    const now = Date.now();
    if (coalesceKey && edHist.lastKey === coalesceKey && now - edHist.lastT < 800) {
      edHist.lastT = now;
      return;
    }
    edHist.lastKey = coalesceKey || null;
    edHist.lastT = now;
    edHist.past.push(edSnapshot());
    if (edHist.past.length > 50) edHist.past.shift();
    edHist.future.length = 0;
    syncUndoBtns();
  }
  // Drop the last snapshot (a cancelled drag returned us to exactly that state).
  function dropLastEdUndo() {
    edHist.past.pop();
    edHist.lastKey = null;
    syncUndoBtns();
  }
  function edRestore(s) {
    ed.annots = s.annots;
    ed.watermark = s.watermark;
    ed.sel = null;
    syncOverlays();
    syncUndoBtns();
  }
  function edUndo() {
    if (drag) return; // never mutate the model mid-drag
    if (!edHist.past.length) {
      toast("Không còn thao tác để hoàn tác.", "");
      return;
    }
    edHist.future.push(edSnapshot());
    edHist.lastKey = null;
    edRestore(edHist.past.pop());
  }
  function edRedo() {
    if (drag || !edHist.future.length) return;
    edHist.past.push(edSnapshot());
    edHist.lastKey = null;
    edRestore(edHist.future.pop());
  }
  function clearEdHistory() {
    edHist.past.length = 0;
    edHist.future.length = 0;
    edHist.lastKey = null;
    syncUndoBtns();
  }
  // While the editor owns Ctrl+Z/Y, the toolbar buttons should reflect *its*
  // stacks; app.js's updateUndoRedo() takes back over on exit.
  function syncUndoBtns() {
    if (!ed.active) return;
    const u = $("btn-undo");
    const r = $("btn-redo");
    if (u) u.disabled = !edHist.past.length;
    if (r) r.disabled = !edHist.future.length;
  }

  // ---- geometry helpers ----------------------------------------------------

  function layerFor(i) {
    return document.querySelector(`.annot-layer[data-index="${i}"]`);
  }
  function layerPoint(layer, e) {
    const r = layer.getBoundingClientRect();
    const s = state.scale;
    const w = +layer.dataset.w || r.width / s;
    const h = +layer.dataset.h || r.height / s;
    const x = Math.max(0, Math.min(w, (e.clientX - r.left) / s));
    const y = Math.max(0, Math.min(h, (e.clientY - r.top) / s));
    return { x, y };
  }

  let _measureCtx;
  function measureCtx() {
    if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
    return _measureCtx;
  }
  // Built-in font-family keys → a CSS font-family stack. Any other value is taken
  // as a literal system family name (from the /fonts picker) and quoted as-is.
  const FONT_STACKS = {
    sans: 'system-ui, "Segoe UI", Arial, sans-serif',
    serif: '"Times New Roman", Times, serif',
    mono: '"Courier New", Courier, monospace',
  };
  function fontFamily(key) {
    return FONT_STACKS[key] || `"${(key || "sans").replace(/"/g, "")}", sans-serif`;
  }
  // CSS `font` shorthand from a size (px) and an optional style object
  // ({ font, bold, italic }). Defaults match a plain sans-serif text box.
  function textFont(fontSizePx, opts) {
    const o = opts || {};
    const style = o.italic ? "italic " : "";
    const weight = o.bold ? "700 " : "";
    return `${style}${weight}${fontSizePx}px ${fontFamily(o.font)}`;
  }
  function measureText(text, fontSizePt, opts) {
    const ctx = measureCtx();
    ctx.font = textFont(fontSizePt, opts);
    const lines = (text || "").split("\n");
    let w = 1;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln || " ").width);
    const lh = fontSizePt * 1.3;
    return { w: Math.ceil(w) + 4, h: Math.ceil(lh * lines.length) + 4 };
  }
  // The style bundle stored on / read from a text annotation.
  function textStyle(a) {
    return { font: a.font, bold: a.bold, italic: a.italic };
  }

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return rgb(0, 0, 0);
    const n = parseInt(m[1], 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  function dataUrlToBytes(dataUrl) {
    const bin = atob(dataUrl.split(",")[1]);
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return u8;
  }

  // Identify an image by its magic bytes — pdf-lib can only embed PNG or JPEG, and
  // the file's reported MIME is unreliable (empty for some files, wrong for others).
  // Returns "png", "jpg", or null (unsupported: webp/gif/bmp/svg/…).
  function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return "png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    return null;
  }

  // Coerce any browser-decodable image data URL into one pdf-lib can embed.
  // PNG/JPEG pass through unchanged; anything else the browser can decode (BMP,
  // GIF, WebP…) is re-encoded to PNG via a canvas so it can still be placed.
  // Resolves { dataUrl, fmt } or null (undecodable). Async: image decode + draw.
  function toEmbeddable(dataUrl) {
    return new Promise((resolve) => {
      let bytes;
      try {
        bytes = dataUrlToBytes(dataUrl);
      } catch (_) {
        resolve(null);
        return;
      }
      const fmt = sniffImage(bytes);
      if (fmt) {
        resolve({ dataUrl, fmt });
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || 1;
          c.height = img.naturalHeight || 1;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve({ dataUrl: c.toDataURL("image/png"), fmt: "png" });
        } catch (_) {
          resolve(null); // e.g. a tainted canvas — shouldn't happen for local files
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // Effective interior fill for a newly created box/ellipse/cloud: a hex colour
  // when the fill toggle is on, otherwise "none" (transparent — the usual choice
  // for a revision cloud so the marked-up content stays visible).
  function effFill() {
    return ed.fillOn ? ed.fillColor : "none";
  }

  // "#rgb" / "#rrggbb" + alpha (0..1) → CSS rgba() for the overlay fill preview.
  function hexToRgba(hex, alpha) {
    let h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    const a = alpha != null ? alpha : 1;
    return `rgba(${r},${g},${b},${a})`;
  }

  // Revision-cloud outline as an SVG path. The perimeter of the a.w×a.h box is
  // replaced by outward semicircular scallops — the construction-industry standard
  // "khoanh mây". Coordinates are shifted by `pad` so the bulges stay ≥ 0, letting
  // the same string drive both the overlay <svg> (0-origin viewBox) and pdf-lib's
  // drawSvgPath at bake time. Returns { d, pad, W, H }.
  const CLOUD_BUMP = 16; // target scallop diameter in scale-1 PDF points
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

  // ---- overlay rendering ---------------------------------------------------

  function syncOverlays() {
    document.querySelectorAll("#viewer .page-wrap").forEach((wrap) => {
      const i = +wrap.dataset.index;
      const canvas = wrap.querySelector("canvas");
      if (!canvas) return;
      let layer = wrap.querySelector(".annot-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "annot-layer";
        wrap.appendChild(layer);
      }
      const cw = parseFloat(canvas.style.width) || canvas.width;
      const ch = parseFloat(canvas.style.height) || canvas.height;
      layer.style.width = cw + "px";
      layer.style.height = ch + "px";
      layer.dataset.index = String(i);
      layer.dataset.w = String(cw / state.scale);
      layer.dataset.h = String(ch / state.scale);
      renderLayer(layer, i);
    });
    document.body.classList.toggle("editing", ed.active);
  }

  function renderLayer(layer, i) {
    layer.innerHTML = "";
    const s = state.scale;
    for (const a of annotsFor(i)) layer.appendChild(renderAnnot(a, s));
    if (ed.watermark) layer.appendChild(renderWatermarkEl());
  }

  // Flatten a note + its replies into one text block (tooltip + PDF Contents).
  // Original text stays first; each reply is appended, never overwriting it.
  function noteThreadText(a) {
    let s = a.text || "";
    for (const r of a.replies || []) {
      const ts = r.ts ? new Date(r.ts).toLocaleString() : "";
      s += "\n\n— " + (ts ? "[" + ts + "] " : "") + (r.text || "");
    }
    return s;
  }

  function renderAnnot(a, s) {
    const el = document.createElement("div");
    el.className = "an an-" + a.kind;
    el.dataset.id = String(a.id);
    el.dataset.kind = a.kind;
    if (ed.sel === a.id) el.classList.add("sel");

    if (a.kind === "draw") {
      // SVG sized to the path's bounding box; coords relative to that box.
      const xs = a.pts.map((p) => p.x);
      const ys = a.pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - minX);
      const h = Math.max(1, Math.max(...ys) - minY);
      el.style.left = minX * s + "px";
      el.style.top = minY * s + "px";
      el.style.width = w * s + "px";
      el.style.height = h * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        a.pts.map((p, k) => (k ? "L" : "M") + (p.x - minX) + " " + (p.y - minY)).join(" ")
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", a.color);
      path.setAttribute("stroke-width", String(a.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      el.appendChild(svg);
      return el;
    }

    if (a.kind === "arrow") {
      // SVG over the arrow's bounding box; line + filled arrowhead.
      const minX = Math.min(a.x1, a.x2);
      const minY = Math.min(a.y1, a.y2);
      const w = Math.max(1, Math.abs(a.x2 - a.x1));
      const h = Math.max(1, Math.abs(a.y2 - a.y1));
      const pad = (a.width || 2) * 3 + 6; // room for the head
      el.style.left = (minX - pad) * s + "px";
      el.style.top = (minY - pad) * s + "px";
      el.style.width = (w + 2 * pad) * s + "px";
      el.style.height = (h + 2 * pad) * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w + 2 * pad} ${h + 2 * pad}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const sx = a.x1 - minX + pad;
      const sy = a.y1 - minY + pad;
      const ex = a.x2 - minX + pad;
      const ey = a.y2 - minY + pad;
      const ang = Math.atan2(ey - sy, ex - sx);
      const hl = Math.max(8, (a.width || 2) * 4); // head length
      const ha = Math.PI / 7; // half-angle
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", sx);
      line.setAttribute("y1", sy);
      line.setAttribute("x2", ex);
      line.setAttribute("y2", ey);
      line.setAttribute("stroke", a.color);
      line.setAttribute("stroke-width", String(a.width || 2));
      line.setAttribute("stroke-linecap", "round");
      const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      const p1 = [ex - hl * Math.cos(ang - ha), ey - hl * Math.sin(ang - ha)];
      const p2 = [ex - hl * Math.cos(ang + ha), ey - hl * Math.sin(ang + ha)];
      head.setAttribute("points", `${ex},${ey} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`);
      head.setAttribute("fill", a.color);
      svg.appendChild(line);
      svg.appendChild(head);
      // Optional head label: sits just beyond the tip along the arrow direction.
      // SVG overflow is visible (app.css) so it paints outside the padded box.
      if (a.label) {
        const fs = a.labelSize || 14;
        const gap = hl + fs * 0.6;
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", String(ex + Math.cos(ang) * gap));
        t.setAttribute("y", String(ey + Math.sin(ang) * gap));
        t.setAttribute("fill", a.color);
        t.setAttribute("font-size", String(fs));
        t.setAttribute("font-family", "system-ui, Arial, sans-serif");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.style.whiteSpace = "pre";
        t.textContent = a.label;
        svg.appendChild(t);
      }
      el.appendChild(svg);
      return el;
    }

    if (a.kind === "dim") {
      // Dimension line: a stroke between the two picked points, a perpendicular
      // tick at each end, and the measured value centred just off the midpoint.
      const minX = Math.min(a.x1, a.x2);
      const minY = Math.min(a.y1, a.y2);
      const w = Math.max(1, Math.abs(a.x2 - a.x1));
      const h = Math.max(1, Math.abs(a.y2 - a.y1));
      const fs = a.labelSize || 14;
      const pad = (a.width || 2) * 3 + fs + 8; // room for ticks + label
      el.style.left = (minX - pad) * s + "px";
      el.style.top = (minY - pad) * s + "px";
      el.style.width = (w + 2 * pad) * s + "px";
      el.style.height = (h + 2 * pad) * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w + 2 * pad} ${h + 2 * pad}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const sx = a.x1 - minX + pad;
      const sy = a.y1 - minY + pad;
      const ex = a.x2 - minX + pad;
      const ey = a.y2 - minY + pad;
      const ang = Math.atan2(ey - sy, ex - sx);
      const nx = -Math.sin(ang); // unit perpendicular
      const ny = Math.cos(ang);
      const tick = Math.max(5, (a.width || 2) * 3);
      const mkLine = (x1, y1, x2, y2) => {
        const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", x1);
        ln.setAttribute("y1", y1);
        ln.setAttribute("x2", x2);
        ln.setAttribute("y2", y2);
        ln.setAttribute("stroke", a.color);
        ln.setAttribute("stroke-width", String(a.width || 2));
        ln.setAttribute("stroke-linecap", "round");
        svg.appendChild(ln);
      };
      mkLine(sx, sy, ex, ey);
      mkLine(sx - nx * tick, sy - ny * tick, sx + nx * tick, sy + ny * tick);
      mkLine(ex - nx * tick, ey - ny * tick, ex + nx * tick, ey + ny * tick);
      if (a.text) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", String((sx + ex) / 2 + nx * (tick + fs * 0.7)));
        t.setAttribute("y", String((sy + ey) / 2 + ny * (tick + fs * 0.7)));
        t.setAttribute("fill", a.color);
        t.setAttribute("font-size", String(fs));
        t.setAttribute("font-family", "system-ui, Arial, sans-serif");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.style.whiteSpace = "pre";
        t.textContent = a.text;
        svg.appendChild(t);
      }
      el.appendChild(svg);
      return el;
    }

    if (a.kind === "cloud") {
      // The element covers the padded box (scallops included) so it renders and
      // hit-tests over the whole cloud, like the freehand/arrow overlays.
      const { d, pad, W, H } = cloudPath(a.w, a.h, CLOUD_BUMP);
      el.style.left = (a.x - pad) * s + "px";
      el.style.top = (a.y - pad) * s + "px";
      el.style.width = W * s + "px";
      el.style.height = H * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      const cloudFilled = a.fill && a.fill !== "none";
      path.setAttribute("fill", cloudFilled ? a.fill : "none");
      if (cloudFilled) path.setAttribute("fill-opacity", String(a.fillOpacity != null ? a.fillOpacity : 1));
      path.setAttribute("stroke", a.color);
      path.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      el.appendChild(svg);
      if (ed.sel === a.id) {
        const hnd = document.createElement("div");
        hnd.className = "handle";
        // Pin the resize grip to the true box corner, not the padded corner.
        hnd.style.cssText = `left:${(a.w + pad) * s}px; top:${(a.h + pad) * s}px; right:auto; bottom:auto;`;
        el.appendChild(hnd);
      }
      return el;
    }

    if (a.kind === "cloudpen") {
      if (a.closed) {
        const cp = cloudPathPoly(a.pts, CLOUD_BUMP);
        if (!cp) return el; // degenerate — render nothing (kept only until cleaned up)
        el.style.left = (cp.minX - cp.pad) * s + "px";
        el.style.top = (cp.minY - cp.pad) * s + "px";
        el.style.width = cp.W * s + "px";
        el.style.height = cp.H * s + "px";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${cp.W} ${cp.H}`);
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", cp.d);
        const filled = a.fill && a.fill !== "none";
        path.setAttribute("fill", filled ? a.fill : "none");
        if (filled) path.setAttribute("fill-opacity", String(a.fillOpacity != null ? a.fillOpacity : 1));
        path.setAttribute("stroke", a.color);
        path.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        el.appendChild(svg);
      } else {
        // In-progress polygon/freehand: plain guide polyline + vertex dots, plus a
        // rubber-band segment to the cursor while placing polygon vertices.
        const live = ed._poly && ed._poly.id === a.id && ed._poly.cx != null ? { x: ed._poly.cx, y: ed._poly.cy } : null;
        const chain = live ? a.pts.concat([live]) : a.pts.slice();
        const xs = chain.map((p) => p.x), ys = chain.map((p) => p.y);
        const pad = 6;
        const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
        const w = Math.max(1, Math.max(...xs) + pad - minX);
        const h = Math.max(1, Math.max(...ys) + pad - minY);
        el.style.left = minX * s + "px";
        el.style.top = minY * s + "px";
        el.style.width = w * s + "px";
        el.style.height = h * s + "px";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        if (chain.length > 1) {
          const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
          poly.setAttribute("points", chain.map((p) => `${p.x - minX},${p.y - minY}`).join(" "));
          poly.setAttribute("fill", "none");
          poly.setAttribute("stroke", a.color);
          poly.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
          poly.setAttribute("stroke-dasharray", "4 3");
          poly.setAttribute("stroke-linejoin", "round");
          svg.appendChild(poly);
        }
        a.pts.forEach((p, k) => {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          dot.setAttribute("cx", String(p.x - minX));
          dot.setAttribute("cy", String(p.y - minY));
          dot.setAttribute("r", k === 0 ? "5" : "3"); // first vertex = the close target
          dot.setAttribute("fill", k === 0 ? "#fff" : a.color);
          dot.setAttribute("stroke", a.color);
          dot.setAttribute("stroke-width", "1.5");
          svg.appendChild(dot);
        });
        el.appendChild(svg);
      }
      return el;
    }

    el.style.left = a.x * s + "px";
    el.style.top = a.y * s + "px";
    el.style.width = a.w * s + "px";
    el.style.height = a.h * s + "px";

    if (a.kind === "text") {
      el.style.fontSize = a.fontSize * s + "px";
      el.style.color = a.color;
      el.style.fontFamily = fontFamily(a.font);
      el.style.fontWeight = a.bold ? "700" : "400";
      el.style.fontStyle = a.italic ? "italic" : "normal";
      el.style.textDecoration = a.underline ? "underline" : "none";
      el.textContent = a.text;
    } else if (a.kind === "redact") {
      el.style.background = a.color || "#000";
    } else if (a.kind === "highlight") {
      el.style.background = a.color;
    } else if (a.kind === "box") {
      el.style.border = Math.max(1, (a.width || 2)) * s + "px solid " + a.color;
      if (a.fill && a.fill !== "none") el.style.background = hexToRgba(a.fill, a.fillOpacity != null ? a.fillOpacity : 1);
    } else if (a.kind === "ellipse") {
      el.style.border = Math.max(1, (a.width || 2)) * s + "px solid " + a.color;
      el.style.borderRadius = "50%";
      if (a.fill && a.fill !== "none") el.style.background = hexToRgba(a.fill, a.fillOpacity != null ? a.fillOpacity : 1);
    } else if (a.kind === "note") {
      el.style.background = a.color;
      el.title = noteThreadText(a) || "(ghi chú trống)";
      el.textContent = "💬";
      // Badge with the reply count so a thread is visible at a glance.
      const n = (a.replies || []).length;
      if (n) {
        const b = document.createElement("span");
        b.className = "note-badge";
        b.textContent = String(n);
        el.appendChild(b);
      }
    } else if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.draggable = false;
      el.appendChild(img);
    }
    // redact needs no extra content (solid black via CSS)

    if (ed.sel === a.id && (a.kind === "highlight" || a.kind === "redact" || a.kind === "image" || a.kind === "box" || a.kind === "ellipse")) {
      const h = document.createElement("div");
      h.className = "handle";
      el.appendChild(h);
    }
    return el;
  }

  function renderWatermarkEl() {
    const wm = ed.watermark;
    const el = document.createElement("div");
    el.className = "an an-watermark";
    el.textContent = wm.text;
    el.style.color = wm.color;
    el.style.opacity = String(wm.opacity);
    el.style.fontSize = wm.size * state.scale + "px";
    el.style.transform = `translate(-50%,-50%) rotate(${-wm.angle}deg)`;
    return el;
  }

  // ---- selection -----------------------------------------------------------

  function select(id) {
    ed.sel = id;
    syncOverlays();
    syncControls();
    if (ed.tool === "select") syncCtlVisibility("select");
  }
  function deselect() {
    if (ed.sel == null) return;
    ed.sel = null;
    syncOverlays();
    if (ed.tool === "select") syncCtlVisibility("select");
  }
  function deleteSelected() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit) return;
    pushEdUndo();
    ed.annots[hit.page] = ed.annots[hit.page].filter((x) => x.id !== ed.sel);
    ed.sel = null;
    syncOverlays();
    if (ed.tool === "select") syncCtlVisibility("select");
  }

  // Reflect the selected annotation's style in the palette controls.
  function syncControls() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit) return;
    const a = hit.a;
    if (a.kind === "redact") {
      $("ed-redact-color").value = toHex(a.color || "#000000");
    } else if (a.color) {
      $("ed-color").value = toHex(a.color);
    }
    if (a.kind === "text") {
      $("ed-fontsize").value = String(a.fontSize);
      $("ed-font").value = a.font || "sans";
      setFmtBtn("ed-bold", a.bold);
      setFmtBtn("ed-italic", a.italic);
      setFmtBtn("ed-underline", a.underline);
    }
    if (["draw", "box", "ellipse", "cloud", "cloudpen", "arrow"].includes(a.kind) && a.width) $("ed-penwidth").value = String(a.width);
    if (["box", "ellipse", "cloud", "cloudpen"].includes(a.kind)) {
      const none = !a.fill || a.fill === "none";
      $("ed-fill-none").checked = none;
      if (!none) $("ed-fill").value = a.fill;
      const op = a.fillOpacity != null ? a.fillOpacity : 1;
      $("ed-fill-opacity").value = String(Math.round(op * 100));
      $("ed-fill-opacity-val").textContent = Math.round(op * 100) + "%";
    }
  }
  function setFmtBtn(id, on) {
    const b = $(id);
    if (b) b.classList.toggle("active", !!on);
  }
  function toHex(c) {
    return /^#/.test(c) ? c : c;
  }

  // ---- pointer interaction (create / move / resize) ------------------------

  let drag = null; // { type, page, id, layer, sx, sy, orig }

  function onDown(e) {
    if (!ed.active || e.button !== 0) return;
    const layer = e.target.closest(".annot-layer");
    if (!layer) return;
    const i = +layer.dataset.index;
    const p = layerPoint(layer, e);

    if (e.target.classList.contains("handle")) {
      const id = +e.target.closest(".an").dataset.id;
      const a = findAnnot(id).a;
      pushEdUndo(); // one undo step per resize gesture
      drag = { type: "resize", page: i, id, layer, sx: p.x, sy: p.y, orig: { w: a.w, h: a.h } };
      e.preventDefault();
      return;
    }

    const anEl = e.target.closest(".an");

    if (ed.tool === "select") {
      if (anEl && anEl.dataset.kind !== "watermark") {
        const id = +anEl.dataset.id;
        select(id);
        const a = findAnnot(id).a;
        const orig =
          a.kind === "draw" || a.kind === "cloudpen"
            ? { pts: a.pts.map((q) => ({ ...q })) }
            : a.kind === "arrow" || a.kind === "dim"
            ? { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }
            : { x: a.x, y: a.y };
        pushEdUndo(); // one undo step per move gesture
        drag = { type: "move", page: i, id, layer, sx: p.x, sy: p.y, orig };
        e.preventDefault();
      } else {
        deselect();
      }
      return;
    }

    if (ed.tool === "text") {
      // Stop the mousedown's default focus shift, otherwise the freshly-focused
      // textarea blurs immediately → commits empty → vanishes before you can type.
      e.preventDefault();
      openTextEditor(layer, i, p, null);
      return;
    }

    if (ed.tool === "image") {
      if (!ed.pendingImage) {
        toast("Bấm lại công cụ Ảnh để chọn tệp ảnh trước.", "bad");
        return;
      }
      placeImage(i, p);
      return;
    }

    if (ed.tool === "highlight" || ed.tool === "redact" || ed.tool === "box" || ed.tool === "ellipse" || ed.tool === "cloud") {
      const col = ed.tool === "redact" ? ed.redactColor : ed.color;
      const a = { id: ed.seq++, kind: ed.tool, x: p.x, y: p.y, w: 1, h: 1, color: col, width: ed.penWidth };
      if (ed.tool === "box" || ed.tool === "ellipse" || ed.tool === "cloud") {
        a.fill = effFill();
        a.fillOpacity = ed.fillOpacity;
      }
      pushEdUndo(); // dropped again if the shape ends up tiny/cancelled
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "rect", page: i, id: a.id, layer, sx: p.x, sy: p.y };
      e.preventDefault();
      return;
    }

    if (ed.tool === "arrow") {
      const a = { id: ed.seq++, kind: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ed.color, width: ed.penWidth };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "arrow", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }

    if (ed.tool === "measure") {
      // Drag out the segment (like arrow). Its dim text is filled on mouseup:
      // the first segment calibrates (asks the real length), later ones are auto
      // numbered by the stored ratio. `text` is a live preview during the drag.
      const a = { id: ed.seq++, kind: "dim", x1: p.x, y1: p.y, x2: p.x, y2: p.y,
                  color: ed.color, width: ed.penWidth, text: "", labelSize: 14 };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "measure", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }

    if (ed.tool === "note") {
      e.preventDefault(); // keep focus on the note textarea (see text tool above)
      openNoteEditor(layer, i, p, null);
      return;
    }

    if (ed.tool === "draw") {
      const a = { id: ed.seq++, kind: "draw", pts: [p], color: ed.color, width: ed.penWidth };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "draw", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }

    if (ed.tool === "cloudpen") {
      // A polygon is being clicked out: only its own page is interactive. Add a
      // vertex, or close if the click lands on the first vertex (≥3 points).
      if (ed._poly) {
        e.preventDefault();
        if (ed._poly.layer !== layer) return; // ignore clicks on other pages
        const hit = findAnnot(ed._poly.id);
        if (hit) {
          const first = hit.a.pts[0];
          const near = first && Math.hypot(p.x - first.x, p.y - first.y) * state.scale < 12;
          if (near && hit.a.pts.length >= 3) {
            closePoly();
          } else {
            hit.a.pts.push(p);
            renderLayer(layer, i);
          }
        }
        return;
      }
      // New stroke: a drag turns freehand (closed on mouse-up); a plain click
      // (no drag) starts a click-to-add-vertex polygon.
      const a = {
        id: ed.seq++,
        kind: "cloudpen",
        pts: [p],
        closed: false,
        color: ed.color,
        width: ed.penWidth,
        fill: effFill(),
        fillOpacity: ed.fillOpacity,
      };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "cloudpen", page: i, id: a.id, layer, downX: p.x, downY: p.y, moved: false };
      e.preventDefault();
      return;
    }
  }

  function onMove(e) {
    // Polygon-in-progress rubber band: track the cursor so the open cloud shows a
    // provisional segment to where the next vertex would land. No active drag here.
    if (!drag && ed._poly) {
      const layer = e.target.closest(".annot-layer");
      if (layer && layer === ed._poly.layer) {
        const q = layerPoint(layer, e);
        ed._poly.cx = q.x;
        ed._poly.cy = q.y;
        renderLayer(layer, ed._poly.page);
      }
      return;
    }
    if (!drag) return;
    const p = layerPoint(drag.layer, e);
    const hit = findAnnot(drag.id);
    if (!hit) {
      drag = null;
      return;
    }
    const a = hit.a;

    if (drag.type === "move") {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      if (a.kind === "draw" || a.kind === "cloudpen") {
        a.pts = drag.orig.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      } else if (a.kind === "arrow" || a.kind === "dim") {
        a.x1 = drag.orig.x1 + dx;
        a.y1 = drag.orig.y1 + dy;
        a.x2 = drag.orig.x2 + dx;
        a.y2 = drag.orig.y2 + dy;
      } else {
        a.x = drag.orig.x + dx;
        a.y = drag.orig.y + dy;
      }
    } else if (drag.type === "arrow") {
      a.x2 = p.x;
      a.y2 = p.y;
    } else if (drag.type === "measure") {
      a.x2 = p.x;
      a.y2 = p.y;
      // Live preview: show the length while dragging once a scale is known.
      const d = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      a.text = ed.measureCal ? formatDim(d * ed.measureCal.unitsPerPoint) : "";
    } else if (drag.type === "resize") {
      a.w = Math.max(4, drag.orig.w + (p.x - drag.sx));
      a.h = Math.max(4, drag.orig.h + (p.y - drag.sy));
    } else if (drag.type === "rect") {
      a.x = Math.min(drag.sx, p.x);
      a.y = Math.min(drag.sy, p.y);
      a.w = Math.abs(p.x - drag.sx);
      a.h = Math.abs(p.y - drag.sy);
    } else if (drag.type === "draw") {
      a.pts.push(p);
    } else if (drag.type === "cloudpen") {
      // Past the click threshold this stroke is a freehand drag → collect points.
      if (!drag.moved && Math.hypot(p.x - drag.downX, p.y - drag.downY) * state.scale > 5) drag.moved = true;
      if (drag.moved) a.pts.push(p);
    }
    renderLayer(drag.layer, drag.page);
  }

  function onUp() {
    if (!drag) return;
    // A freehand cloud drag ends by closing the loop; a click (no drag) instead
    // arms polygon mode so further clicks add vertices.
    if (drag.type === "cloudpen") {
      const hit = findAnnot(drag.id);
      if (hit) {
        if (drag.moved) {
          if (cloudPathPoly(hit.a.pts, CLOUD_BUMP)) {
            hit.a.closed = true;
          } else {
            ed.annots[drag.page] = ed.annots[drag.page].filter((x) => x.id !== drag.id);
            ed.sel = null;
            dropLastEdUndo();
          }
        } else {
          ed._poly = { page: drag.page, id: drag.id, layer: drag.layer, cx: null, cy: null };
          $("ed-hint").textContent = "Bấm thêm điểm; bấm vào điểm đầu (hoặc nhấn Enter / bấm đúp) để đóng mây. Esc để huỷ.";
        }
      }
      const layer = drag.layer, page = drag.page;
      drag = null;
      renderLayer(layer, page);
      return;
    }
    const hit = findAnnot(drag.id);
    if (hit) {
      const a = hit.a;
      // Discard accidental zero-size rectangles / single-point scribbles.
      const tinyArrow = drag.type === "arrow" && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 6;
      const tinyDim = drag.type === "measure" && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 6;
      if ((drag.type === "rect" && (a.w < 4 || a.h < 4)) || (drag.type === "draw" && a.pts.length < 2) || tinyArrow || tinyDim) {
        ed.annots[drag.page] = ed.annots[drag.page].filter((x) => x.id !== drag.id);
        ed.sel = null;
        dropLastEdUndo(); // the creation was discarded — state is back at that snapshot
      }
    }
    // A freshly drawn arrow immediately offers a head label (blank/Esc = none).
    // The undo snapshot from creation already covers the label, so no extra push.
    if (drag.type === "arrow") {
      const still = findAnnot(drag.id);
      const la = drag.layer, pg = drag.page;
      drag = null;
      renderLayer(la, pg);
      if (still) openArrowLabelEditor(la, pg, still.a, false);
      return;
    }
    if (drag.type === "measure") {
      const still = findAnnot(drag.id);
      const la = drag.layer, pg = drag.page;
      drag = null;
      renderLayer(la, pg);
      if (still) {
        const a = still.a;
        const d = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
        if (!ed.measureCal) {
          // First segment sets the scale: ask its real length, then back-fill text.
          ed._dimPending = { id: a.id, page: pg, layer: la, pdfDist: d };
          openDimModal();
        } else {
          a.text = formatDim(d * ed.measureCal.unitsPerPoint);
          renderLayer(la, pg);
        }
      }
      return;
    }
    const layer = drag.layer;
    const page = drag.page;
    drag = null;
    renderLayer(layer, page);
  }

  // Finish a click-to-add-vertex cloud: needs ≥3 points, else it's discarded.
  function closePoly() {
    if (!ed._poly) return;
    const info = ed._poly;
    ed._poly = null;
    const hit = findAnnot(info.id);
    if (hit) {
      if (hit.a.pts.length >= 3 && cloudPathPoly(hit.a.pts, CLOUD_BUMP)) {
        hit.a.closed = true;
      } else {
        ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
        ed.sel = null;
        dropLastEdUndo();
      }
    }
    setTool("cloudpen"); // reset the hint text; stays on the tool for the next cloud
    renderLayer(info.layer, info.page);
  }

  // Abandon a click-to-add-vertex cloud without closing it (Esc).
  function cancelPoly() {
    if (!ed._poly) return;
    const info = ed._poly;
    ed._poly = null;
    ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
    ed.sel = null;
    dropLastEdUndo();
    setTool("cloudpen");
    renderLayer(info.layer, info.page);
  }

  // Esc mid-gesture: abort the in-progress create/move/resize and restore the
  // pre-drag state (the matching undo snapshot is dropped — nothing changed).
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const hit = findAnnot(d.id);
    if (hit) {
      const a = hit.a;
      if (d.type === "rect" || d.type === "draw" || d.type === "arrow" || d.type === "cloudpen") {
        // creation in progress → remove it entirely
        ed.annots[d.page] = ed.annots[d.page].filter((x) => x.id !== d.id);
        ed.sel = null;
      } else if (d.type === "move") {
        if (a.kind === "draw" || a.kind === "cloudpen") a.pts = d.orig.pts;
        else if (a.kind === "arrow") {
          a.x1 = d.orig.x1;
          a.y1 = d.orig.y1;
          a.x2 = d.orig.x2;
          a.y2 = d.orig.y2;
        } else {
          a.x = d.orig.x;
          a.y = d.orig.y;
        }
      } else if (d.type === "resize") {
        a.w = d.orig.w;
        a.h = d.orig.h;
      }
      dropLastEdUndo();
    }
    renderLayer(d.layer, d.page);
  }

  function onDblClick(e) {
    if (!ed.active) return;
    const layer = e.target.closest(".annot-layer");
    if (!layer) return;
    const i = +layer.dataset.index;
    // Double-click closes a polygon cloud in progress. The two mousedowns of the
    // dbl-click each pushed a vertex; drop the near-duplicate last one first.
    if (ed._poly) {
      e.preventDefault();
      const hit = findAnnot(ed._poly.id);
      if (hit && hit.a.pts.length > 3) hit.a.pts.pop();
      closePoly();
      return;
    }
    const noteEl = e.target.closest(".an-note");
    if (noteEl) {
      e.preventDefault();
      const a = findAnnot(+noteEl.dataset.id).a;
      openNoteEditor(layer, i, { x: a.x, y: a.y }, a);
      return;
    }
    const arrowEl = e.target.closest(".an-arrow");
    if (arrowEl) {
      e.preventDefault();
      openArrowLabelEditor(layer, i, findAnnot(+arrowEl.dataset.id).a, true);
      return;
    }
    const anEl = e.target.closest(".an-text");
    if (!anEl) return;
    e.preventDefault();
    const a = findAnnot(+anEl.dataset.id).a;
    openTextEditor(layer, i, { x: a.x, y: a.y }, a);
  }

  // ---- text editor (inline textarea; Electron has no window.prompt) --------

  function openTextEditor(layer, i, p, existing) {
    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit";
    const fs = existing ? existing.fontSize : ed.fontSize;
    const st = existing
      ? { font: existing.font, bold: existing.bold, italic: existing.italic, underline: existing.underline }
      : { font: ed.font, bold: ed.bold, italic: ed.italic, underline: ed.underline };
    ta.style.left = p.x * state.scale + "px";
    ta.style.top = p.y * state.scale + "px";
    ta.style.fontSize = fs * state.scale + "px";
    ta.style.color = existing ? existing.color : ed.color;
    ta.style.fontFamily = fontFamily(st.font);
    ta.style.fontWeight = st.bold ? "700" : "400";
    ta.style.fontStyle = st.italic ? "italic" : "normal";
    ta.style.textDecoration = st.underline ? "underline" : "none";
    ta.value = existing ? existing.text : "";
    layer.appendChild(ta);
    ta.focus();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const text = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (existing) {
        if (text && text !== existing.text) {
          pushEdUndo();
          existing.text = text;
          const m = measureText(text, existing.fontSize, textStyle(existing));
          existing.w = m.w;
          existing.h = m.h;
        }
      } else if (text) {
        pushEdUndo();
        const m = measureText(text, ed.fontSize, { font: ed.font, bold: ed.bold, italic: ed.italic });
        annotsFor(i).push({
          id: ed.seq++,
          kind: "text",
          x: p.x,
          y: p.y,
          w: m.w,
          h: m.h,
          text,
          fontSize: ed.fontSize,
          color: ed.color,
          font: ed.font,
          bold: ed.bold,
          italic: ed.italic,
          underline: ed.underline,
        });
      }
      renderLayer(layer, i);
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        done = true;
        ta.remove();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        commit();
      }
    });
  }

  // ---- note editor (comment anchored to a point) ---------------------------

  // A note is a small comment thread: the original text plus append-only
  // replies. New note → one textarea (create). Existing note → read-only thread
  // on top, a box to add a reply, and a "Sửa gốc" toggle to edit the original.
  function openNoteEditor(layer, i, p, existing) {
    const panel = document.createElement("div");
    panel.className = "annot-note-panel";
    panel.style.left = (p.x + 20) * state.scale + "px";
    panel.style.top = p.y * state.scale + "px";
    // Clicks inside the panel must not start a drag / new note on the layer.
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    if (existing) {
      const thread = document.createElement("div");
      thread.className = "note-thread";
      const orig = document.createElement("div");
      orig.className = "note-orig-line";
      orig.textContent = existing.text || "(ghi chú trống)";
      thread.appendChild(orig);
      for (const r of existing.replies || []) {
        const rd = document.createElement("div");
        rd.className = "note-reply-line";
        rd.textContent = "↳ " + (r.text || "");
        thread.appendChild(rd);
      }
      panel.appendChild(thread);
    }

    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit annot-note-edit";
    ta.placeholder = existing ? "Thêm bình luận…" : "Nội dung ghi chú…";
    panel.appendChild(ta);

    const row = document.createElement("div");
    row.className = "note-actions";
    const btnAdd = document.createElement("button");
    btnAdd.textContent = existing ? "Thêm bình luận" : "Lưu";
    row.appendChild(btnAdd);
    if (existing) {
      const btnEdit = document.createElement("button");
      btnEdit.textContent = "Sửa gốc";
      row.appendChild(btnEdit);
      btnEdit.addEventListener("click", () => {
        mode = "editOrig";
        ta.value = existing.text || "";
        ta.placeholder = "Sửa nội dung ghi chú gốc…";
        btnAdd.textContent = "Lưu ghi chú gốc";
        ta.focus();
      });
    }
    const btnClose = document.createElement("button");
    btnClose.textContent = "Đóng";
    row.appendChild(btnClose);
    panel.appendChild(row);

    layer.appendChild(panel);
    ta.focus();

    let mode = existing ? "reply" : "new"; // reply | new | editOrig
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      panel.remove();
      renderLayer(layer, i);
    };
    const save = () => {
      const text = ta.value.replace(/\s+$/, "");
      if (mode === "new") {
        if (text) {
          pushEdUndo();
          const a = { id: ed.seq++, kind: "note", x: p.x, y: p.y, w: 18, h: 18, text, color: ed.color, replies: [] };
          annotsFor(i).push(a);
          ed.sel = a.id;
        }
      } else if (mode === "editOrig") {
        if (text !== (existing.text || "")) {
          pushEdUndo();
          existing.text = text;
        }
      } else {
        // reply: append without touching the original or earlier replies
        if (text) {
          pushEdUndo();
          if (!existing.replies) existing.replies = [];
          existing.replies.push({ text, ts: Date.now() });
        }
      }
      close();
    };
    btnAdd.addEventListener("click", save);
    btnClose.addEventListener("click", close);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  }

  // ---- arrow head label (text anchored to the arrow tip) -------------------

  // `fresh=false` (just-drawn arrow): the label rides the creation undo snapshot,
  // so no extra push. `fresh=true` (double-click edit): push before changing.
  function openArrowLabelEditor(layer, i, a, editing) {
    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit annot-note-edit";
    ta.placeholder = "Nhãn mũi tên… (Enter xong, Esc bỏ qua)";
    ta.style.left = (a.x2 + 8) * state.scale + "px";
    ta.style.top = (a.y2 - 12) * state.scale + "px";
    ta.style.color = a.color;
    ta.value = a.label || "";
    layer.appendChild(ta);
    ta.focus();
    ta.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const text = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (text !== (a.label || "")) {
        if (editing) pushEdUndo();
        a.label = text || undefined;
      }
      renderLayer(layer, i);
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        done = true;
        ta.remove();
        renderLayer(layer, i);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      }
    });
  }

  // ---- image placement -----------------------------------------------------

  function chooseImage() {
    const inp = $("ed-file");
    inp.value = "";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        // Trust the bytes, not the MIME. PNG/JPEG embed directly; BMP/GIF/WebP
        // are re-encoded to PNG so they still work despite pdf-lib's PNG/JPEG-only limit.
        const emb = await toEmbeddable(reader.result);
        if (!emb) {
          toast("Không đọc được ảnh này — thử PNG, JPG hoặc BMP.", "bad");
          return;
        }
        ed.pendingImage = emb;
        if (emb.fmt === "jpg")
          toast("Đã chọn ảnh JPG (nền đặc) — chữ ký nên dùng PNG nền trong. Bấm lên trang để đặt.", "warn");
        else toast("Đã chọn ảnh — bấm lên trang để đặt.", "good");
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function placeImage(i, p) {
    const img = new Image();
    img.onload = () => {
      const maxW = 240; // points
      const ratio = img.naturalHeight / img.naturalWidth || 1;
      const w = Math.min(img.naturalWidth, maxW);
      const a = {
        id: ed.seq++,
        kind: "image",
        x: p.x,
        y: p.y,
        w,
        h: w * ratio,
        dataUrl: ed.pendingImage.dataUrl,
        fmt: ed.pendingImage.fmt,
      };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      setTool("select");
      syncOverlays();
    };
    img.src = ed.pendingImage.dataUrl;
  }

  // Paste an image (from the OS clipboard) onto a page. Enters edit mode if
  // needed, arms the image tool with the pasted bytes, then the next click on a
  // page places it — reusing the exact same path as the "Ảnh" tool. dataUrl must
  // be a PNG or JPEG data URL (pdf-lib can only embed those). Returns false if the
  // image can't be used (no doc open / unsupported format).
  async function beginImagePaste(dataUrl) {
    if (!state.bytes) {
      toast("Mở một PDF trước khi dán ảnh.", "bad");
      return false;
    }
    const emb = await toEmbeddable(dataUrl);
    if (!emb) {
      toast("Ảnh trong clipboard không dán được.", "bad");
      return false;
    }
    if (!ed.active) enter();
    ed.pendingImage = emb;
    setTool("image");
    toast("Bấm lên trang để dán ảnh.", "good");
    return true;
  }

  // Parse a page-range string like "1-3, 5, 8-10" into a Set of 0-based page
  // indices within [0, count). Returns null on any malformed token; out-of-range
  // numbers are silently dropped. Page numbers in the string are 1-based.
  function parsePageRanges(str, count) {
    const out = new Set();
    for (const partRaw of String(str || "").split(",")) {
      const part = partRaw.trim();
      if (!part) continue;
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (m) {
        let a = +m[1], b = +m[2];
        if (a > b) [a, b] = [b, a];
        for (let n = a; n <= b; n++) if (n >= 1 && n <= count) out.add(n - 1);
      } else if (/^\d+$/.test(part)) {
        const n = +part;
        if (n >= 1 && n <= count) out.add(n - 1);
      } else {
        return null;
      }
    }
    return out;
  }

  function openImgPages() {
    if (ed.sel == null) {
      toast("Chọn ảnh / chữ ký cần áp trước.", "bad");
      return;
    }
    const hit = findAnnot(ed.sel);
    if (!hit || hit.a.kind !== "image") {
      toast("Chỉ áp được cho ảnh / chữ ký đang chọn.", "bad");
      return;
    }
    const count = (state.pdf && state.pdf.numPages) || 0;
    $("imgpages-input").value = "";
    $("imgpages-hint").textContent = `Tài liệu có ${count} trang. Ảnh đang ở trang ${hit.page + 1}.`;
    $("imgpages-modal").hidden = false;
    setTimeout(() => $("imgpages-input").focus(), 0);
  }

  function applyImgPages() {
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    if (!hit || hit.a.kind !== "image") {
      $("imgpages-modal").hidden = true;
      return;
    }
    const count = (state.pdf && state.pdf.numPages) || 0;
    const set = parsePageRanges($("imgpages-input").value, count);
    if (set === null) {
      toast("Khoảng trang không hợp lệ. Ví dụ: 1-3, 5, 8-10", "bad");
      return;
    }
    set.delete(hit.page); // the source page already carries the image
    if (!set.size) {
      toast("Không có trang hợp lệ để áp (ngoài trang hiện tại).", "warn");
      return;
    }
    pushEdUndo();
    const src = hit.a;
    let added = 0;
    for (const idx of set) {
      annotsFor(idx).push({
        id: ed.seq++,
        kind: "image",
        x: src.x,
        y: src.y,
        w: src.w,
        h: src.h,
        dataUrl: src.dataUrl,
        fmt: src.fmt,
      });
      added++;
    }
    $("imgpages-modal").hidden = true;
    syncOverlays();
    toast(`Đã áp ảnh sang ${added} trang.`, "good");
  }

  // ---- PNG rasterisation for baking ---------------------------------------

  function renderTextPng(text, fontSizePt, colorHex, opts) {
    const RS = 3; // supersample for crisp text
    const lines = (text || "").split("\n");
    const ctx = measureCtx();
    const fpx = fontSizePt * RS;
    ctx.font = textFont(fpx, opts);
    let maxW = 1;
    for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln || " ").width);
    const lh = fpx * 1.3;
    const pad = Math.ceil(fpx * 0.15);
    const cw = Math.ceil(maxW) + pad * 2;
    const chh = Math.ceil(lh * lines.length) + pad * 2;
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = chh;
    const cx = c.getContext("2d");
    cx.font = textFont(fpx, opts);
    cx.fillStyle = colorHex;
    cx.textBaseline = "top";
    lines.forEach((ln, k) => cx.fillText(ln, pad, pad + k * lh));
    // Canvas has no underline — draw it manually under each line's glyphs.
    if (opts && opts.underline) {
      cx.strokeStyle = colorHex;
      cx.lineWidth = Math.max(1, fpx * 0.06);
      lines.forEach((ln, k) => {
        const w = ctx.measureText(ln || " ").width;
        const y = pad + k * lh + fpx * 1.02;
        cx.beginPath();
        cx.moveTo(pad, y);
        cx.lineTo(pad + w, y);
        cx.stroke();
      });
    }
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt: cw / RS, hPt: chh / RS };
  }

  function renderWatermarkPng(wm) {
    const RS = 2;
    const ctx = measureCtx();
    const fpx = wm.size * RS;
    ctx.font = textFont(fpx);
    const tw = Math.max(1, ctx.measureText(wm.text || " ").width);
    const th = fpx * 1.25;
    const ang = (-wm.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(ang));
    const sin = Math.abs(Math.sin(ang));
    const bw = Math.ceil(tw * cos + th * sin) + 4;
    const bh = Math.ceil(tw * sin + th * cos) + 4;
    const c = document.createElement("canvas");
    c.width = bw;
    c.height = bh;
    const cx = c.getContext("2d");
    cx.translate(bw / 2, bh / 2);
    cx.rotate(ang);
    cx.font = textFont(fpx);
    cx.fillStyle = wm.color;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(wm.text, 0, 0);
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt: bw / RS, hPt: bh / RS };
  }

  async function rasterRedacted(i, redacts, vp1) {
    const page = await state.pdf.getPage(i + 1);
    const RS = 2; // ~144 dpi
    const vp = page.getViewport({ scale: RS });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const cx = c.getContext("2d");
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    // Burn each box in *its own* colour so the original pixels are gone for good.
    for (const r of redacts) {
      cx.fillStyle = r.color || "#000";
      cx.fillRect(r.x * RS, r.y * RS, r.w * RS, r.h * RS);
    }
    return dataUrlToBytes(c.toDataURL("image/png"));
  }

  // ---- baking --------------------------------------------------------------

  function makeMap(vp1, mode) {
    if (mode === "image") return (x, y) => [x, vp1.height - y];
    return (x, y) => {
      const r = vp1.convertToPdfPoint(x, y);
      return [r[0], r[1]];
    };
  }

  // Pages with a /Rotate entry (common in scans) display rotated, but pdf-lib
  // draws images in *unrotated* user space. Without compensating, baked PNGs
  // (text comment, image, watermark) come out rotated 90/180/270°. We pin the
  // image's visual lower-left to the already-mapped anchor and spin the glyphs
  // back by the page rotation so they read upright after the viewer applies it.
  function pageRotate(page) {
    return degrees(page.getRotation().angle);
  }

  async function drawAnnots(doc, page, anns, vp1, mode) {
    const map = makeMap(vp1, mode);
    let failed = 0;
    for (const a of anns) {
      try {
        await drawOneAnnot(doc, page, a, map);
      } catch (err) {
        // Isolate failures: one bad annotation (e.g. a corrupt image) must not
        // wipe out every other pending edit in the same bake.
        failed++;
        console.error("drawAnnot failed:", a.kind, err);
      }
    }
    if (failed) toast(`Bỏ qua ${failed} mục lỗi khi áp dụng (ảnh hỏng?).`, "warn");
  }

  async function drawOneAnnot(doc, page, a, map) {
    if (a.kind === "highlight") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          color: hexRgb(a.color),
          opacity: 0.35,
        });
      } else if (a.kind === "draw") {
        const c = hexRgb(a.color);
        for (let k = 1; k < a.pts.length; k++) {
          const [sx, sy] = map(a.pts[k - 1].x, a.pts[k - 1].y);
          const [ex, ey] = map(a.pts[k].x, a.pts[k].y);
          page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color: c });
        }
      } else if (a.kind === "text") {
        const { bytes, wPt, hPt } = renderTextPng(a.text, a.fontSize, a.color, {
          font: a.font,
          bold: a.bold,
          italic: a.italic,
          underline: a.underline,
        });
        const img = await doc.embedPng(bytes);
        // The PNG carries ~0.15em padding; offset so the glyphs line up with
        // where the overlay (zero-padding) showed them.
        const padPt = a.fontSize * 0.15;
        const [bx, by] = map(a.x - padPt, a.y - padPt + hPt);
        page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
      } else if (a.kind === "box") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawRectangle(opts);
      } else if (a.kind === "ellipse") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2,
          xScale: Math.abs(x2 - x1) / 2,
          yScale: Math.abs(y2 - y1) / 2,
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawEllipse(opts);
      } else if (a.kind === "cloud") {
        // Scallop outline mapped like the freehand path: (0,0) of the SVG sits at
        // the padded top-left; drawSvgPath draws downward from there (it flips y),
        // so at rotation 0 the bake matches the overlay pixel-for-pixel.
        const { d, pad } = cloudPath(a.w, a.h, CLOUD_BUMP);
        const [bx, by] = map(a.x - pad, a.y - pad);
        const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2 };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawSvgPath(d, opts);
      } else if (a.kind === "cloudpen") {
        const cp = cloudPathPoly(a.pts, CLOUD_BUMP);
        if (cp) {
          const [bx, by] = map(cp.minX - cp.pad, cp.minY - cp.pad);
          const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2 };
          if (a.fill && a.fill !== "none") {
            opts.color = hexRgb(a.fill);
            opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
          }
          page.drawSvgPath(cp.d, opts);
        }
      } else if (a.kind === "arrow") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // arrowhead: two short strokes back from the tip
        const ang = Math.atan2(ey - sy, ex - sx);
        const hl = Math.max(8, w * 4);
        const ha = Math.PI / 7;
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang - ha), y: ey - hl * Math.sin(ang - ha) },
          thickness: w,
          color: c,
        });
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang + ha), y: ey - hl * Math.sin(ang + ha) },
          thickness: w,
          color: c,
        });
        // Head label — rendered to PNG (same path as text annots, so Vietnamese
        // diacritics embed reliably), centred on the point just beyond the tip.
        if (a.label) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.label, fs, a.color, {});
          // Anchor in overlay coords (y-down), matching the on-screen placement.
          const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
          const gap = hl + fs * 0.6;
          const cxO = a.x2 + Math.cos(angO) * gap;
          const cyO = a.y2 + Math.sin(angO) * gap;
          const img = await doc.embedPng(bytes);
          const [bx, by] = map(cxO - wPt / 2, cyO + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "dim") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // End ticks: perpendicular in overlay (y-down) space, endpoints mapped.
        const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const nxO = -Math.sin(angO);
        const nyO = Math.cos(angO);
        const tick = Math.max(5, w * 3);
        for (const pt of [[a.x1, a.y1], [a.x2, a.y2]]) {
          const [t1x, t1y] = map(pt[0] - nxO * tick, pt[1] - nyO * tick);
          const [t2x, t2y] = map(pt[0] + nxO * tick, pt[1] + nyO * tick);
          page.drawLine({ start: { x: t1x, y: t1y }, end: { x: t2x, y: t2y }, thickness: w, color: c });
        }
        // Measured value — PNG (same Vietnamese-safe path as text/arrow labels).
        if (a.text) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.text, fs, a.color, {});
          const img = await doc.embedPng(bytes);
          const mxO = (a.x1 + a.x2) / 2 + nxO * (tick + fs * 0.7);
          const myO = (a.y1 + a.y2) / 2 + nyO * (tick + fs * 0.7);
          const [bx, by] = map(mxO - wPt / 2, myO + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "note") {
        // 1. Visible marker square so the note shows in any viewer (incl. ours).
        const c = hexRgb(a.color);
        const [mx, my] = map(a.x, a.y + a.h);
        page.drawRectangle({
          x: mx,
          y: my,
          width: a.w,
          height: a.h,
          color: c,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 0.5,
        });
        // 2. Real PDF Text annotation (sticky note) carrying the comment text.
        const [rx1, ry1] = map(a.x, a.y + a.h);
        const [rx2, ry2] = map(a.x + a.w, a.y);
        const ctx = doc.context;
        const ann = ctx.obj({
          Type: "Annot",
          Subtype: "Text",
          Name: "Comment",
          Rect: [Math.min(rx1, rx2), Math.min(ry1, ry2), Math.max(rx1, rx2), Math.max(ry1, ry2)],
          Contents: PDFHexString.fromText(noteThreadText(a)),
          Open: false,
          C: [c.red, c.green, c.blue],
        });
        const ref = ctx.register(ann);
        let arr = page.node.Annots();
        if (!arr) {
          arr = ctx.obj([]);
          page.node.set(PDFName.of("Annots"), arr);
        }
        arr.push(ref);
      } else if (a.kind === "image") {
        const bytes = dataUrlToBytes(a.dataUrl);
        // fmt was sniffed from magic bytes at selection time; fall back to a byte
        // sniff for any older in-memory annotation that predates this field.
        const fmt = a.fmt || sniffImage(bytes);
        const img = fmt === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [bx, by] = map(a.x, a.y + a.h);
        page.drawImage(img, { x: bx, y: by, width: a.w, height: a.h, rotate: pageRotate(page) });
      }
  }

  async function drawWatermark(doc, page, vp1, mode) {
    const { bytes, wPt, hPt } = renderWatermarkPng(ed.watermark);
    const img = await doc.embedPng(bytes);
    const map = makeMap(vp1, mode);
    const cx = (vp1.width - wPt) / 2;
    const cy = (vp1.height - hPt) / 2;
    const [bx, by] = map(cx, cy + hPt);
    page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, opacity: ed.watermark.opacity, rotate: pageRotate(page) });
  }

  async function bakeInPlace() {
    const doc = await PDFDocument.load(state.bytes);
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const anns = annotsFor(i);
      if (!anns.length && !ed.watermark) continue;
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      await drawAnnots(doc, pages[i], anns, vp1, "orig");
      if (ed.watermark) await drawWatermark(doc, pages[i], vp1, "orig");
    }
    return await doc.save();
  }

  async function bakeWithRedaction() {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const n = state.numPages;
    for (let i = 0; i < n; i++) {
      const anns = annotsFor(i);
      const redacts = anns.filter((a) => a.kind === "redact");
      const others = anns.filter((a) => a.kind !== "redact");
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      let page;
      let mode;
      if (redacts.length) {
        const png = await rasterRedacted(i, redacts, vp1);
        const img = await out.embedPng(png);
        page = out.addPage([vp1.width, vp1.height]);
        page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        mode = "image";
      } else {
        const [cp] = await out.copyPages(src, [i]);
        out.addPage(cp);
        page = cp;
        mode = "orig";
      }
      if (others.length) await drawAnnots(out, page, others, vp1, mode);
      if (ed.watermark) await drawWatermark(out, page, vp1, mode);
    }
    return await out.save();
  }

  // Bake all pending overlay edits into state.bytes and re-render. Returns
  // whether anything was applied. Called by Save and on exit.
  async function bakePending() {
    if (!hasAny()) return false;
    showOverlay("Đang áp dụng chỉnh sửa…");
    try {
      const anyRedact = Object.values(ed.annots).some((a) => a.some((x) => x.kind === "redact"));
      const bytes = anyRedact ? await bakeWithRedaction() : await bakeInPlace();
      // Only the annotated pages change pixels (watermark hits every page) — so we
      // can repaint just those instead of reloading the whole document.
      let changed = null;
      if (!ed.watermark) {
        changed = new Set();
        for (const k of Object.keys(ed.annots)) if (ed.annots[k].length) changed.add(+k);
      }
      if (window.History) window.History.pushUndo(); // one doc-level undo step per bake
      state.bytes = bytes;
      ed.annots = {};
      ed.watermark = null;
      ed.sel = null;
      clearEdHistory(); // baked annotations can't be un-done at annotation level anymore
      await rerenderChanged(changed);
      toast("Đã áp dụng chỉnh sửa.", "good");
      return true;
    } catch (err) {
      toast("Lỗi áp dụng: " + (err.message || err), "bad");
      throw err;
    } finally {
      hideOverlay();
    }
  }

  // ---- watermark dialog ----------------------------------------------------

  function openWatermark() {
    $("wm-modal").hidden = false;
  }
  function applyWatermark() {
    const text = $("wm-text").value.trim();
    if (!text) {
      toast("Nhập nội dung watermark.", "bad");
      return;
    }
    pushEdUndo();
    ed.watermark = {
      text,
      size: Math.max(8, +$("wm-size").value || 56),
      angle: +$("wm-angle").value || 0,
      opacity: Math.min(1, Math.max(0.05, +$("wm-opacity").value || 0.22)),
      color: $("wm-color").value || "#888888",
    };
    $("wm-modal").hidden = true;
    syncOverlays();
    toast("Đã thêm watermark — bấm Áp dụng để ghi vào PDF.", "good");
  }

  // ---- measure / dimension tool -------------------------------------------

  // Format a measured value to the configured decimals, drop trailing zeros, and
  // append the unit ("10.00 m" → "10 m", "3.14159 m" → "3.14 m").
  function formatDim(value) {
    const dec = Math.max(0, Math.min(6, ed.measureDecimals | 0));
    let s = Number(value).toFixed(dec);
    if (dec > 0) s = s.replace(/\.?0+$/, "");
    return ed.measureUnit ? `${s} ${ed.measureUnit}`.trim() : s;
  }

  // Show the calibration dialog for the just-drawn known-length segment. Seeds the
  // inputs from the last-used unit/decimals so repeat calibrations are one keypress.
  function openDimModal() {
    $("dim-length").value = "";
    $("dim-unit").value = ed.measureUnit || "m";
    $("dim-decimals").value = String(ed.measureDecimals);
    $("dim-modal").hidden = false;
    setTimeout(() => $("dim-length").focus(), 0);
  }

  // OK on the calibration dialog: turn the entered real length into a scale ratio,
  // back-fill the pending segment's text, and keep the tool ready for the rest.
  function applyDim() {
    const p = ed._dimPending;
    if (!p) {
      $("dim-modal").hidden = true;
      return;
    }
    const real = parseFloat(String($("dim-length").value).replace(",", "."));
    if (!(real > 0)) {
      toast("Nhập chiều dài thật (số dương) của đoạn đã vẽ.", "bad");
      return;
    }
    ed.measureUnit = ($("dim-unit").value || "").trim();
    ed.measureDecimals = Math.max(0, Math.min(6, parseInt($("dim-decimals").value, 10) || 0));
    ed.measureCal = { unitsPerPoint: real / p.pdfDist };
    const hit = findAnnot(p.id);
    if (hit) hit.a.text = formatDim(real);
    ed._dimPending = null;
    $("dim-modal").hidden = true;
    renderLayer(p.layer, p.page);
    if (ed.tool === "measure") setTool("measure"); // refresh the hint to "calibrated"
    toast("Đã hiệu chuẩn tỷ lệ — kéo các đoạn khác để tự ghi kích thước.", "good");
  }

  // Cancel calibration: drop the pending (uncalibrated) segment entirely.
  function cancelDim() {
    const p = ed._dimPending;
    $("dim-modal").hidden = true;
    if (!p) return;
    ed.annots[p.page] = (ed.annots[p.page] || []).filter((x) => x.id !== p.id);
    if (ed.sel === p.id) ed.sel = null;
    dropLastEdUndo();
    ed._dimPending = null;
    renderLayer(p.layer, p.page);
  }

  // "Hiệu chuẩn lại": forget the scale so the next drawn segment recalibrates.
  function recalibrateMeasure() {
    ed.measureCal = null;
    if (ed.tool === "measure") setTool("measure");
    toast("Kéo một đoạn có kích thước đã biết để hiệu chuẩn lại.", "");
  }

  // ---- form fill -----------------------------------------------------------

  async function openForm() {
    showOverlay("Đang đọc biểu mẫu…");
    let doc;
    let fields;
    try {
      doc = await PDFDocument.load(state.bytes);
      fields = doc.getForm().getFields();
    } catch (e) {
      hideOverlay();
      toast("Không đọc được biểu mẫu: " + e.message, "bad");
      return;
    }
    hideOverlay();
    if (!fields.length) {
      toast("PDF này không có trường biểu mẫu (AcroForm).", "bad");
      return;
    }
    ed._formDoc = doc;
    buildFormUI(fields);
    $("form-modal").hidden = false;
  }

  function buildFormUI(fields) {
    const box = $("form-fields");
    box.innerHTML = "";
    ed._form = [];
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "form-row";
      const lab = document.createElement("label");
      lab.textContent = f.getName();
      let input;
      let kind;
      if (f instanceof PDFLib.PDFTextField) {
        kind = "text";
        input = document.createElement("input");
        input.type = "text";
        try {
          input.value = f.getText() || "";
        } catch (_) {}
      } else if (f instanceof PDFLib.PDFCheckBox) {
        kind = "check";
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = f.isChecked();
      } else if (f instanceof PDFLib.PDFDropdown) {
        kind = "dropdown";
        input = makeSelect(f.getOptions(), (f.getSelected() || [])[0]);
      } else if (f instanceof PDFLib.PDFRadioGroup) {
        kind = "radio";
        input = makeSelect(f.getOptions(), f.getSelected(), true);
      } else {
        kind = "skip";
        input = document.createElement("input");
        input.type = "text";
        input.disabled = true;
        input.placeholder = "(loại trường không hỗ trợ)";
      }
      row.appendChild(lab);
      row.appendChild(input);
      box.appendChild(row);
      ed._form.push({ f, kind, input });
    }
  }
  function makeSelect(options, selected, blank) {
    const sel = document.createElement("select");
    if (blank) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "—";
      sel.appendChild(o);
    }
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = o.textContent = opt;
      sel.appendChild(o);
    }
    if (selected) sel.value = selected;
    return sel;
  }

  async function applyForm() {
    showOverlay("Đang điền biểu mẫu…");
    try {
      for (const { f, kind, input } of ed._form) {
        if (kind === "text") f.setText(input.value);
        else if (kind === "check") input.checked ? f.check() : f.uncheck();
        else if (kind === "dropdown" && input.value) f.select(input.value);
        else if (kind === "radio" && input.value) f.select(input.value);
      }
      if ($("form-flatten").checked) ed._formDoc.getForm().flatten();
      if (window.History) window.History.pushUndo();
      state.bytes = await ed._formDoc.save();
      ed._form = null;
      ed._formDoc = null;
      $("form-modal").hidden = true;
      await renderAll();
      toast("Đã điền biểu mẫu.", "good");
    } catch (e) {
      toast("Lỗi điền biểu mẫu: " + e.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // ---- mode + palette wiring ----------------------------------------------

  // Which palette controls (data-ctl) are relevant per drawing tool.
  const TOOL_CTLS = {
    text: ["color", "font", "fontsize", "biu"],
    highlight: ["color"],
    draw: ["color", "penwidth"],
    box: ["color", "penwidth", "fill"],
    ellipse: ["color", "penwidth", "fill"],
    cloud: ["color", "penwidth", "fill"],
    cloudpen: ["color", "penwidth", "fill"],
    arrow: ["color", "penwidth"],
    note: ["color"],
    image: [],
    redact: ["redact"],
    measure: ["color", "penwidth", "measure"],
  };
  // Which controls an already-placed annotation of a given kind can tweak. Used
  // by the Select tool so the palette shows only what the *selected* item needs
  // (nothing when the selection is empty) instead of every control at once.
  const KIND_CTLS = {
    text: ["color", "font", "fontsize", "biu"],
    highlight: ["color"],
    draw: ["color", "penwidth"],
    box: ["color", "penwidth", "fill"],
    ellipse: ["color", "penwidth", "fill"],
    cloud: ["color", "penwidth", "fill"],
    cloudpen: ["color", "penwidth", "fill"],
    arrow: ["color", "penwidth"],
    note: ["color"],
    image: ["imgpages"],
    redact: ["redact"],
    dim: ["color", "penwidth"],
  };
  // Show the palette controls relevant to the current context: for a drawing
  // tool, the tool's controls; for Select, only the selected annotation's (or
  // none). Keeps the edit bar tidy instead of dumping every control under Select.
  function syncCtlVisibility(tool) {
    let show;
    if (tool === "select") {
      const hit = ed.sel != null ? findAnnot(ed.sel) : null;
      show = hit ? KIND_CTLS[hit.a.kind] || [] : [];
    } else {
      show = TOOL_CTLS[tool] || [];
    }
    document.querySelectorAll("#edit-bar [data-ctl]").forEach((el) => {
      el.hidden = !show.includes(el.dataset.ctl);
    });
  }

  function setTool(tool) {
    // Leaving the cloud-pen tool abandons a polygon still being clicked out.
    if (ed._poly && tool !== "cloudpen") {
      const info = ed._poly;
      ed._poly = null;
      ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
      if (ed.sel === info.id) ed.sel = null;
      dropLastEdUndo();
      renderLayer(info.layer, info.page);
    }
    ed.tool = tool;
    document.querySelectorAll("#ed-tools .tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    syncCtlVisibility(tool);
    const hints = {
      select: "Kéo để di chuyển; góc để đổi cỡ; Delete để xoá.",
      text: "Bấm lên trang để thêm hộp văn bản (Ctrl+Enter để xong).",
      highlight: "Kéo để tô sáng vùng.",
      draw: "Giữ chuột và kéo để vẽ.",
      box: "Kéo để khoanh một vùng (khung chữ nhật).",
      ellipse: "Kéo để khoanh vùng bằng elip / hình tròn.",
      cloud: "Kéo để khoanh mây (revision cloud) quanh vùng cần lưu ý.",
      cloudpen: "Giữ chuột kéo để vẽ mây tự do, hoặc bấm từng điểm rồi bấm điểm đầu / Enter / bấm đúp để đóng.",
      arrow: "Kéo từ gốc tới đích để vẽ mũi tên.",
      note: "Bấm lên trang để đặt ghi chú; gõ nội dung rồi Ctrl+Enter.",
      image: "Bấm lên trang để đặt ảnh đã chọn.",
      redact: "Kéo để che — nội dung gốc sẽ bị xoá khi áp dụng.",
      measure: ed.measureCal
        ? `Kéo một đoạn để tự ghi kích thước (tỷ lệ đã hiệu chuẩn, đơn vị ${ed.measureUnit}). Bấm "Hiệu chuẩn lại" để đổi.`
        : "Kéo đoạn có kích thước ĐÃ BIẾT rồi nhập số thật để hiệu chuẩn; sau đó các đoạn khác tự ra số.",
    };
    $("ed-hint").textContent = hints[tool] || "";
  }

  // Fill the text-box "Font máy" optgroup from the sidecar's /fonts list. Runs
  // once; silently no-ops if the engine isn't ready or the call fails (built-in
  // choices still work). Mirrors text-edit.js's loader but targets #ed-font.
  let fontsLoaded = false;
  async function loadSystemFonts() {
    if (fontsLoaded) return;
    const grp = $("ed-font-system");
    if (!grp || typeof sidecar === "undefined" || sidecar.state !== "ready" || !sidecar.base) return;
    try {
      const res = await sidecarFetch("/fonts", { method: "GET" });
      const data = await res.json();
      if (!data.success || !Array.isArray(data.families)) return;
      const frag = document.createDocumentFragment();
      for (const name of data.families) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        frag.appendChild(o);
      }
      grp.appendChild(frag);
      fontsLoaded = true;
    } catch (_) {
      /* keep built-in font choices */
    }
  }

  function enter() {
    if (!state.bytes) return;
    ed.active = true;
    ed.measureCal = null; // a different drawing has a different scale — recalibrate
    ed._dimPending = null;
    clearEdHistory(); // fresh annotation-undo timeline per session
    $("edit-bar").hidden = false;
    $("btn-edit").classList.add("active");
    setTool("select");
    updateToolbar();
    syncOverlays();
    syncUndoBtns();
    loadSystemFonts();
  }
  function leaveMode() {
    ed.active = false;
    ed.sel = null;
    $("edit-bar").hidden = true;
    $("btn-edit").classList.remove("active");
    updateToolbar();
    if (typeof updateUndoRedo === "function") updateUndoRedo(); // hand Ctrl+Z back to doc history
    syncOverlays();
  }
  // "Xong": bake every pending edit into the PDF, then leave edit mode.
  async function exit() {
    if (ed._poly) closePoly(); // finalize (or drop) a cloud still being drawn
    if (hasAny()) await bakePending();
    clearEdHistory();
    leaveMode();
  }
  // "Hủy bỏ": leave edit mode discarding everything not yet baked.
  function discardExit() {
    const n = countAnnots();
    if (n && !window.confirm(`Bỏ ${n} chỉnh sửa chưa ghi và thoát?`)) return;
    reset();
    clearEdHistory();
    leaveMode();
    if (n) toast("Đã bỏ các chỉnh sửa chưa ghi.", "");
  }

  function reset() {
    ed.annots = {};
    ed.watermark = null;
    ed.sel = null;
    ed.pendingImage = null;
    ed._poly = null;
    clearEdHistory();
  }

  // ---- listeners -----------------------------------------------------------

  const viewer = $("viewer");
  viewer.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  viewer.addEventListener("dblclick", onDblClick);

  $("btn-edit").onclick = () => (ed.active ? exit() : enter()); // toggle-off = Xong (bake)
  $("ed-apply").onclick = exit; // "Xong" = bake pending edits AND leave edit mode
  $("ed-exit").onclick = discardExit; // "Hủy bỏ" = drop pending edits AND leave
  $("ed-delete").onclick = deleteSelected;
  $("ed-watermark").onclick = openWatermark;
  $("ed-form").onclick = openForm;
  $("ed-img-pages").onclick = openImgPages;
  $("imgpages-ok").onclick = applyImgPages;
  $("imgpages-cancel").onclick = () => ($("imgpages-modal").hidden = true);
  $("imgpages-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyImgPages();
    }
  });

  // Measure/dimension calibration dialog + re-calibrate button.
  $("dim-ok").onclick = applyDim;
  $("dim-cancel").onclick = cancelDim;
  $("dim-length").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyDim();
    }
  });
  $("ed-recalibrate").onclick = recalibrateMeasure;

  document.querySelectorAll("#ed-tools .tool").forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.tool;
      setTool(t);
      if (t === "image") chooseImage();
    };
  });

  $("ed-color").oninput = (e) => {
    ed.color = e.target.value;
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.color !== undefined) {
        pushEdUndo("color:" + ed.sel); // a picker drag = one undo step
        hit.a.color = ed.color;
        syncOverlays();
      }
    }
  };
  $("ed-redact-color").oninput = (e) => {
    ed.redactColor = e.target.value;
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "redact") {
        pushEdUndo("rcolor:" + ed.sel);
        hit.a.color = ed.redactColor;
        syncOverlays();
      }
    }
  };
  $("ed-fontsize").oninput = (e) => {
    ed.fontSize = Math.max(6, +e.target.value || 16);
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "text") {
        pushEdUndo("fsize:" + ed.sel);
        hit.a.fontSize = ed.fontSize;
        const m = measureText(hit.a.text, ed.fontSize, textStyle(hit.a));
        hit.a.w = m.w;
        hit.a.h = m.h;
        syncOverlays();
      }
    }
  };
  $("ed-font").onchange = (e) => {
    ed.font = e.target.value || "sans";
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "text") {
        pushEdUndo();
        hit.a.font = ed.font;
        const m = measureText(hit.a.text, hit.a.fontSize, textStyle(hit.a));
        hit.a.w = m.w;
        hit.a.h = m.h;
        syncOverlays();
      }
    }
  };
  // B / I / U toggles. preventDefault on mousedown keeps an open text editor
  // focused; the click toggles the flag and (for the selected text) re-measures.
  [["ed-bold", "bold"], ["ed-italic", "italic"], ["ed-underline", "underline"]].forEach(([id, prop]) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => {
      b.classList.toggle("active");
      ed[prop] = b.classList.contains("active");
      if (ed.sel != null) {
        const hit = findAnnot(ed.sel);
        if (hit && hit.a.kind === "text") {
          pushEdUndo();
          hit.a[prop] = ed[prop];
          const m = measureText(hit.a.text, hit.a.fontSize, textStyle(hit.a));
          hit.a.w = m.w;
          hit.a.h = m.h;
          syncOverlays();
        }
      }
    });
  });
  $("ed-penwidth").oninput = (e) => {
    ed.penWidth = Math.max(1, +e.target.value || 2);
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && ["draw", "box", "ellipse", "cloud", "cloudpen", "arrow"].includes(hit.a.kind)) {
        pushEdUndo("pwidth:" + ed.sel);
        hit.a.width = ed.penWidth;
        syncOverlays();
      }
    }
  };
  // Interior fill: picking a colour turns fill on (and clears the transparent
  // toggle); the toggle turns it back off. Both update the selected shape live.
  function applyFillToSel() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (hit && ["box", "ellipse", "cloud", "cloudpen"].includes(hit.a.kind)) {
      pushEdUndo("fill:" + ed.sel);
      hit.a.fill = effFill();
      hit.a.fillOpacity = ed.fillOpacity;
      syncOverlays();
    }
  }
  $("ed-fill").oninput = (e) => {
    ed.fillColor = e.target.value;
    ed.fillOn = true;
    $("ed-fill-none").checked = false;
    applyFillToSel();
  };
  $("ed-fill-none").onchange = (e) => {
    ed.fillOn = !e.target.checked;
    applyFillToSel();
  };
  $("ed-fill-opacity").oninput = (e) => {
    const pct = Math.min(100, Math.max(0, +e.target.value || 0));
    ed.fillOpacity = pct / 100;
    $("ed-fill-opacity-val").textContent = pct + "%";
    // Adjusting opacity implies a fill is wanted — turn transparency off.
    if (ed.fillOn === false && pct > 0) {
      ed.fillOn = true;
      $("ed-fill-none").checked = false;
    }
    applyFillToSel();
  };

  $("wm-cancel").onclick = () => ($("wm-modal").hidden = true);
  $("wm-ok").onclick = applyWatermark;
  $("form-cancel").onclick = () => {
    ed._form = null;
    ed._formDoc = null;
    $("form-modal").hidden = true;
  };
  $("form-ok").onclick = applyForm;

  window.addEventListener("keydown", (e) => {
    if (!ed.active) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    // A polygon cloud in progress: Enter closes it; Esc / Delete abandon it.
    // Handle here before the generic ladders so they don't corrupt _poly state.
    if (ed._poly && !typing && ["Enter", "Escape", "Delete", "Backspace"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Enter") closePoly();
      else cancelPoly();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !typing && ed.sel != null) {
      e.preventDefault();
      deleteSelected();
    }
    // Esc ladder: abort the drag in progress → deselect → back to the Select
    // tool. (Open textareas handle their own Esc and stopPropagation.) Never
    // auto-exits the mode — that would bake/discard without the user asking.
    if (e.key === "Escape" && !typing) {
      if (drag) {
        e.preventDefault();
        cancelDrag();
      } else if (ed.sel != null) {
        e.preventDefault();
        deselect();
      } else if (ed.tool !== "select") {
        e.preventDefault();
        ed.pendingImage = null; // a pending image placement is cancelled too
        setTool("select");
      }
    }
  });

  // ---- public surface (consumed by app.js) ---------------------------------

  window.Editor = {
    get active() {
      return ed.active;
    },
    syncOverlays,
    bakePending,
    reset,
    beginImagePaste, // paste an OS-clipboard image onto a page (Ctrl+V)
    undo: edUndo, // annotation-level (pre-bake) — routed from Ctrl+Z while active
    redo: edRedo,
  };
})();
