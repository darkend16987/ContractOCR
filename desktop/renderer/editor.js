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
    annots: {}, // pageIndex -> [annot]
    watermark: null, // { text, size, angle, opacity, color }
    seq: 1,
    sel: null, // selected annot id (numbers are unique across pages)
    pendingImage: null, // { dataUrl, mime } awaiting a placement click
    _form: null,
    _formDoc: null,
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
      el.appendChild(svg);
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
    } else if (a.kind === "ellipse") {
      el.style.border = Math.max(1, (a.width || 2)) * s + "px solid " + a.color;
      el.style.borderRadius = "50%";
    } else if (a.kind === "note") {
      el.style.background = a.color;
      el.title = a.text || "(ghi chú trống)";
      el.textContent = "💬";
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
  }
  function deselect() {
    if (ed.sel == null) return;
    ed.sel = null;
    syncOverlays();
  }
  function deleteSelected() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit) return;
    ed.annots[hit.page] = ed.annots[hit.page].filter((x) => x.id !== ed.sel);
    ed.sel = null;
    syncOverlays();
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
    if (["draw", "box", "ellipse", "arrow"].includes(a.kind) && a.width) $("ed-penwidth").value = String(a.width);
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
          a.kind === "draw"
            ? { pts: a.pts.map((q) => ({ ...q })) }
            : a.kind === "arrow"
            ? { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }
            : { x: a.x, y: a.y };
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

    if (ed.tool === "highlight" || ed.tool === "redact" || ed.tool === "box" || ed.tool === "ellipse") {
      const col = ed.tool === "redact" ? ed.redactColor : ed.color;
      const a = { id: ed.seq++, kind: ed.tool, x: p.x, y: p.y, w: 1, h: 1, color: col, width: ed.penWidth };
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "rect", page: i, id: a.id, layer, sx: p.x, sy: p.y };
      e.preventDefault();
      return;
    }

    if (ed.tool === "arrow") {
      const a = { id: ed.seq++, kind: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ed.color, width: ed.penWidth };
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "arrow", page: i, id: a.id, layer };
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
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "draw", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }
  }

  function onMove(e) {
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
      if (a.kind === "draw") {
        a.pts = drag.orig.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      } else if (a.kind === "arrow") {
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
    }
    renderLayer(drag.layer, drag.page);
  }

  function onUp() {
    if (!drag) return;
    const hit = findAnnot(drag.id);
    if (hit) {
      const a = hit.a;
      // Discard accidental zero-size rectangles / single-point scribbles.
      const tinyArrow = drag.type === "arrow" && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 6;
      if ((drag.type === "rect" && (a.w < 4 || a.h < 4)) || (drag.type === "draw" && a.pts.length < 2) || tinyArrow) {
        ed.annots[drag.page] = ed.annots[drag.page].filter((x) => x.id !== drag.id);
        ed.sel = null;
      }
    }
    const layer = drag.layer;
    const page = drag.page;
    drag = null;
    renderLayer(layer, page);
  }

  function onDblClick(e) {
    if (!ed.active) return;
    const layer = e.target.closest(".annot-layer");
    if (!layer) return;
    const i = +layer.dataset.index;
    const noteEl = e.target.closest(".an-note");
    if (noteEl) {
      e.preventDefault();
      const a = findAnnot(+noteEl.dataset.id).a;
      openNoteEditor(layer, i, { x: a.x, y: a.y }, a);
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
        if (text) {
          existing.text = text;
          const m = measureText(text, existing.fontSize, textStyle(existing));
          existing.w = m.w;
          existing.h = m.h;
        }
      } else if (text) {
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

  function openNoteEditor(layer, i, p, existing) {
    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit annot-note-edit";
    ta.placeholder = "Nội dung ghi chú…";
    ta.style.left = (p.x + 20) * state.scale + "px";
    ta.style.top = p.y * state.scale + "px";
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
        if (text) existing.text = text;
        else {
          // cleared note text -> remove the note
          ed.annots[i] = annotsFor(i).filter((x) => x.id !== existing.id);
          ed.sel = null;
        }
      } else if (text) {
        const a = { id: ed.seq++, kind: "note", x: p.x, y: p.y, w: 18, h: 18, text, color: ed.color };
        annotsFor(i).push(a);
        ed.sel = a.id;
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

  // ---- image placement -----------------------------------------------------

  function chooseImage() {
    const inp = $("ed-file");
    inp.value = "";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        // Trust the bytes, not the MIME: only PNG/JPEG can be embedded.
        const fmt = sniffImage(dataUrlToBytes(reader.result));
        if (!fmt) {
          toast("Định dạng ảnh không hỗ trợ — chỉ nhận PNG hoặc JPG.", "bad");
          return;
        }
        ed.pendingImage = { dataUrl: reader.result, fmt };
        if (fmt === "jpg")
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
      annotsFor(i).push(a);
      ed.sel = a.id;
      setTool("select");
      syncOverlays();
    };
    img.src = ed.pendingImage.dataUrl;
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
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        });
      } else if (a.kind === "ellipse") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        page.drawEllipse({
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2,
          xScale: Math.abs(x2 - x1) / 2,
          yScale: Math.abs(y2 - y1) / 2,
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        });
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
          Contents: PDFHexString.fromText(a.text || ""),
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
      if (window.History) window.History.pushUndo(); // one undo step per Áp dụng
      state.bytes = bytes;
      ed.annots = {};
      ed.watermark = null;
      ed.sel = null;
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

  // Which palette controls (data-ctl) are relevant per tool. `select` shows them
  // all so any selected annotation stays editable.
  const TOOL_CTLS = {
    select: ["color", "redact", "font", "fontsize", "biu", "penwidth"],
    text: ["color", "font", "fontsize", "biu"],
    highlight: ["color"],
    draw: ["color", "penwidth"],
    box: ["color", "penwidth"],
    ellipse: ["color", "penwidth"],
    arrow: ["color", "penwidth"],
    note: ["color"],
    image: [],
    redact: ["redact"],
  };
  function syncCtlVisibility(tool) {
    const show = TOOL_CTLS[tool] || [];
    document.querySelectorAll("#edit-bar [data-ctl]").forEach((el) => {
      el.hidden = !show.includes(el.dataset.ctl);
    });
  }

  function setTool(tool) {
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
      arrow: "Kéo từ gốc tới đích để vẽ mũi tên.",
      note: "Bấm lên trang để đặt ghi chú; gõ nội dung rồi Ctrl+Enter.",
      image: "Bấm lên trang để đặt ảnh đã chọn.",
      redact: "Kéo để che — nội dung gốc sẽ bị xoá khi áp dụng.",
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
    $("edit-bar").hidden = false;
    $("btn-edit").classList.add("active");
    setTool("select");
    updateToolbar();
    syncOverlays();
    loadSystemFonts();
  }
  async function exit() {
    if (hasAny()) await bakePending();
    ed.active = false;
    ed.sel = null;
    $("edit-bar").hidden = true;
    $("btn-edit").classList.remove("active");
    updateToolbar();
    syncOverlays();
  }

  function reset() {
    ed.annots = {};
    ed.watermark = null;
    ed.sel = null;
    ed.pendingImage = null;
  }

  // ---- listeners -----------------------------------------------------------

  const viewer = $("viewer");
  viewer.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  viewer.addEventListener("dblclick", onDblClick);

  $("btn-edit").onclick = () => (ed.active ? exit() : enter());
  $("ed-exit").onclick = exit;
  $("ed-apply").onclick = exit; // Áp dụng = bake pending edits AND leave edit mode
  $("ed-delete").onclick = deleteSelected;
  $("ed-watermark").onclick = openWatermark;
  $("ed-form").onclick = openForm;

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
      if (hit && ["draw", "box", "ellipse", "arrow"].includes(hit.a.kind)) {
        hit.a.width = ed.penWidth;
        syncOverlays();
      }
    }
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
    if ((e.key === "Delete" || e.key === "Backspace") && !typing && ed.sel != null) {
      e.preventDefault();
      deleteSelected();
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
  };
})();
