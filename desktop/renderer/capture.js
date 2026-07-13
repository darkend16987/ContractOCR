"use strict";

/**
 * Copy an image out of a PDF page (Feature: "Copy ảnh").
 *
 * Two modes, both entirely client-side (no sidecar/Python):
 *   - Object: hover a real embedded image → click → copy that image, rendered at
 *     high resolution. Image placements are located by walking the page's pdf.js
 *     operator list and tracking the current transform matrix (CTM), so the hit
 *     boxes are exact and honour page rotation.
 *   - Region: drag a marquee anywhere on a page → copy those pixels.
 *
 * Both paths rasterise the chosen rectangle to PNG (via pdf.js, into an offscreen
 * canvas) and hand the bytes to the main process, which writes them to the OS
 * clipboard. Pasting is handled separately (a DOM 'paste' listener → Editor).
 *
 * Shares app.js globals (classic scripts, one lexical scope): state, pdfjsLib,
 * toast, $.
 */
(function () {
  const OPS = pdfjsLib.OPS;
  const U = pdfjsLib.Util;

  const cap = {
    active: false,
    docToken: null, // state.pdf when the CTM cache was built; clears on doc change
    ctms: new Map(), // pageIndex -> array of image CTMs (user-space, scale-free)
    pending: new Map(), // pageIndex -> Promise while getOperatorList is in flight
    hi: null, // hover highlight element
    hiPage: null, // page index the highlight currently belongs to
    drag: null, // { page, canvas, sx, sy, el } while marquee-dragging
    busy: false, // a copy render is in progress (ignore new clicks)
  };

  const MIN_OBJECT_PX = 8; // ignore image placements smaller than this on screen
  const DRAG_THRESHOLD = 5; // px of movement before a click becomes a marquee
  const MAX_OUTPUT_SIDE = 4000; // clamp the copied bitmap so RAM stays bounded

  // ---- geometry ------------------------------------------------------------

  // Bounding box (canvas CSS px) of a unit square transformed by `ctm`, mapped to
  // device space through the page viewport. Honours rotation via the viewport.
  function bboxFromCtm(vp, ctm) {
    const full = U.transform(vp.transform, ctm);
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map((pt) => U.applyTransform(pt, full));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---- image-object discovery ---------------------------------------------

  // Walk a page's operator list, tracking the CTM, and collect the transform at
  // every image-paint op. Cached per page; cache invalidated when the document
  // changes. Returns an array of CTMs (may be empty).
  async function imageCtms(pageIndex) {
    if (cap.docToken !== state.pdf) {
      cap.ctms.clear();
      cap.pending.clear();
      cap.docToken = state.pdf;
    }
    if (cap.ctms.has(pageIndex)) return cap.ctms.get(pageIndex);
    if (cap.pending.has(pageIndex)) return cap.pending.get(pageIndex);

    const m = state.pageMetas && state.pageMetas[pageIndex];
    if (!m || !m.page) return [];

    const p = (async () => {
      let opList;
      try {
        opList = await m.page.getOperatorList();
      } catch (_) {
        return [];
      }
      const out = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const { fnArray, argsArray } = opList;
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        if (fn === OPS.save) {
          stack.push(ctm);
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (fn === OPS.transform) {
          ctm = U.transform(ctm, argsArray[i]);
        } else if (fn === OPS.paintFormXObjectBegin) {
          // A form XObject brackets nested ops with its own matrix; treat like an
          // implicit save+transform so images inside it land in the right place.
          stack.push(ctm);
          const mtx = argsArray[i] && argsArray[i][0];
          if (mtx) ctm = U.transform(ctm, mtx);
        } else if (fn === OPS.paintFormXObjectEnd) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (
          fn === OPS.paintImageXObject ||
          fn === OPS.paintImageXObjectRepeat ||
          fn === OPS.paintInlineImageXObject ||
          fn === OPS.paintImageMaskXObject
        ) {
          out.push(ctm.slice());
        }
      }
      cap.ctms.set(pageIndex, out);
      cap.pending.delete(pageIndex);
      return out;
    })();
    cap.pending.set(pageIndex, p);
    return p;
  }

  // Topmost image rect (canvas CSS px) under a point, or null. Later paints draw
  // on top, so we scan from the end.
  function objectRectAt(pageIndex, x, y) {
    const m = state.pageMetas && state.pageMetas[pageIndex];
    if (!m) return null;
    const ctms = cap.ctms.get(pageIndex);
    if (!ctms || !ctms.length) return null;
    for (let i = ctms.length - 1; i >= 0; i--) {
      const r = bboxFromCtm(m.vp, ctms[i]);
      if (r.w < MIN_OBJECT_PX || r.h < MIN_OBJECT_PX) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  // ---- overlay helpers -----------------------------------------------------

  function canvasOf(pageIndex) {
    const m = state.pageMetas && state.pageMetas[pageIndex];
    return (m && m.canvas) || null;
  }

  // Local coords (CSS px, origin = canvas top-left) for a mouse event over a page.
  function localCoords(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
  }

  function clearHighlight() {
    if (cap.hi && cap.hi.parentNode) cap.hi.parentNode.removeChild(cap.hi);
    cap.hi = null;
    cap.hiPage = null;
  }

  function showHighlight(pageIndex, r) {
    const m = state.pageMetas && state.pageMetas[pageIndex];
    if (!m) return;
    if (!cap.hi) {
      cap.hi = document.createElement("div");
      cap.hi.className = "cap-hi";
    }
    if (cap.hi.parentNode !== m.wrap) m.wrap.appendChild(cap.hi);
    cap.hiPage = pageIndex;
    cap.hi.style.left = r.x + "px";
    cap.hi.style.top = r.y + "px";
    cap.hi.style.width = r.w + "px";
    cap.hi.style.height = r.h + "px";
  }

  // ---- render + clipboard --------------------------------------------------

  // Rasterise a rectangle of a page (given in canvas CSS px at the current zoom)
  // to a PNG Uint8Array. `kind` picks the target resolution: 'object' aims for a
  // crisp copy of an embedded image; 'region' matches the on-screen sharpness.
  async function renderRegionPng(pageIndex, cssRect, kind) {
    const m = state.pageMetas && state.pageMetas[pageIndex];
    if (!m || !m.page) return null;
    const sx = state.scale || 1;
    // Device coords are linear in the viewport scale, so dividing the CSS rect by
    // the current scale gives scale-free page geometry we can re-scale freely.
    const freeW = cssRect.w / sx;
    const freeH = cssRect.h / sx;
    if (freeW < 1 || freeH < 1) return null;

    const dpr = window.devicePixelRatio || 1;
    let rscale;
    if (kind === "object") {
      const longSide = Math.max(freeW, freeH);
      rscale = Math.min(8, Math.max(2, 2200 / longSide)); // upscale small, cap large
    } else {
      rscale = Math.min(6, sx * dpr * 1.5);
    }
    // Clamp so neither output side exceeds MAX_OUTPUT_SIDE.
    const longFree = Math.max(freeW, freeH);
    if (longFree * rscale > MAX_OUTPUT_SIDE) rscale = MAX_OUTPUT_SIDE / longFree;

    const outW = Math.max(1, Math.round(freeW * rscale));
    const outH = Math.max(1, Math.round(freeH * rscale));
    const offX = (cssRect.x / sx) * rscale;
    const offY = (cssRect.y / sx) * rscale;

    const vp = m.page.getViewport({ scale: rscale });
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    // White backing so JPEG-in-PDF regions with no alpha don't come out black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    try {
      await m.page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: [1, 0, 0, 1, -offX, -offY], // shift so the region aligns to (0,0)
      }).promise;
    } catch (_) {
      return null;
    }
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function copyRect(pageIndex, cssRect, kind) {
    if (cap.busy) return;
    cap.busy = true;
    try {
      toast("Đang copy ảnh…", "");
      const bytes = await renderRegionPng(pageIndex, cssRect, kind);
      if (!bytes) {
        toast("Không copy được vùng này.", "bad");
        return;
      }
      const res = await window.desktop.writeClipboardImage(bytes);
      if (res && res.ok) {
        toast("Đã copy ảnh vào clipboard — dán (Ctrl+V) vào nơi khác hoặc vào trang.", "good");
      } else {
        toast("Không copy được: " + ((res && res.reason) || "lỗi clipboard"), "bad");
      }
    } finally {
      cap.busy = false;
    }
  }

  // ---- mouse interaction ---------------------------------------------------

  function onMove(e) {
    if (!cap.active) return;
    // Marquee in progress: resize the box.
    if (cap.drag) {
      const c = localCoords(cap.drag.canvas, e);
      const x0 = Math.min(cap.drag.sx, c.x);
      const y0 = Math.min(cap.drag.sy, c.y);
      const w = Math.abs(c.x - cap.drag.sx);
      const h = Math.abs(c.y - cap.drag.sy);
      cap.drag.el.style.left = x0 + "px";
      cap.drag.el.style.top = y0 + "px";
      cap.drag.el.style.width = w + "px";
      cap.drag.el.style.height = h + "px";
      cap.drag.moved = cap.drag.moved || w > DRAG_THRESHOLD || h > DRAG_THRESHOLD;
      return;
    }
    // Hover: highlight the image object under the cursor, if any.
    const wrap = e.target.closest && e.target.closest(".page-wrap");
    if (!wrap) {
      clearHighlight();
      return;
    }
    const pageIndex = +wrap.dataset.index;
    const canvas = canvasOf(pageIndex);
    if (!canvas) {
      clearHighlight();
      return;
    }
    const { x, y } = localCoords(canvas, e);
    // Kick off (cached) discovery; highlight once it's ready.
    imageCtms(pageIndex).then(() => {
      if (!cap.active || cap.drag) return;
      const r = objectRectAt(pageIndex, x, y);
      if (r) showHighlight(pageIndex, r);
      else if (cap.hiPage === pageIndex) clearHighlight();
    });
  }

  function onDown(e) {
    if (!cap.active || e.button !== 0) return;
    const wrap = e.target.closest && e.target.closest(".page-wrap");
    if (!wrap) return;
    e.preventDefault();
    const pageIndex = +wrap.dataset.index;
    const canvas = canvasOf(pageIndex);
    if (!canvas) return;
    const { x, y } = localCoords(canvas, e);
    const el = document.createElement("div");
    el.className = "cap-marquee";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = "0px";
    el.style.height = "0px";
    wrap.appendChild(el);
    cap.drag = { page: pageIndex, canvas, sx: x, sy: y, el, moved: false };
    clearHighlight();
  }

  async function onUp(e) {
    if (!cap.active || !cap.drag) return;
    const d = cap.drag;
    cap.drag = null;
    const { x, y, rect } = localCoords(d.canvas, e);
    if (d.el.parentNode) d.el.parentNode.removeChild(d.el);

    const moved = d.moved && Math.abs(x - d.sx) > DRAG_THRESHOLD && Math.abs(y - d.sy) > DRAG_THRESHOLD;
    if (moved) {
      // Marquee → region copy. Clamp to the visible page so a drag past the edge
      // doesn't pull in white margin outside the page.
      const clamp = (v, hi) => Math.max(0, Math.min(v, hi));
      const x0 = clamp(Math.min(x, d.sx), rect.width);
      const y0 = clamp(Math.min(y, d.sy), rect.height);
      const x1 = clamp(Math.max(x, d.sx), rect.width);
      const y1 = clamp(Math.max(y, d.sy), rect.height);
      await copyRect(d.page, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, "region");
      return;
    }
    // A click (no real drag): copy the image object under the point, if any.
    const r = objectRectAt(d.page, d.sx, d.sy);
    if (r) {
      await copyRect(d.page, r, "object");
    } else {
      toast("Không có ảnh ở đây — kéo chọn một vùng để copy.", "");
    }
  }

  function onKey(e) {
    if (cap.active && e.key === "Escape") {
      e.preventDefault();
      exit();
    }
  }

  // ---- mode toggle ---------------------------------------------------------

  function enter() {
    if (cap.active) return;
    if (!state.bytes) {
      toast("Mở một PDF trước.", "bad");
      return;
    }
    cap.active = true;
    const v = $("viewer");
    v.classList.add("capture-mode");
    const btn = $("btn-copy-img");
    if (btn) btn.classList.add("active");
    v.addEventListener("mousemove", onMove, true);
    v.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    toast("Chế độ Copy ảnh: bấm vào ảnh để copy, hoặc kéo chọn vùng. Esc để thoát.", "");
  }

  function exit() {
    if (!cap.active) return;
    cap.active = false;
    const v = $("viewer");
    v.classList.remove("capture-mode");
    const btn = $("btn-copy-img");
    if (btn) btn.classList.remove("active");
    v.removeEventListener("mousemove", onMove, true);
    v.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    clearHighlight();
    if (cap.drag && cap.drag.el && cap.drag.el.parentNode) cap.drag.el.parentNode.removeChild(cap.drag.el);
    cap.drag = null;
  }

  function toggle() {
    if (cap.active) exit();
    else enter();
  }

  // ---- paste (image from OS clipboard → onto a page) -----------------------

  // Route a pasted image into the editor's image-placement flow. Ignores pastes
  // aimed at text fields so Ctrl+V still works normally there.
  document.addEventListener("paste", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let file = null;
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        file = it.getAsFile();
        break;
      }
    }
    if (!file) return;
    if (!state.bytes) {
      toast("Mở một PDF trước khi dán ảnh.", "bad");
      return;
    }
    if (!(window.Editor && window.Editor.beginImagePaste)) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      // Copying out of a page enters capture mode; leave it so the placement click
      // isn't swallowed by the marquee handler.
      if (cap.active) exit();
      window.Editor.beginImagePaste(reader.result);
    };
    reader.readAsDataURL(file);
  });

  // Wire the toolbar button (self-contained; app.js owns enable/disable state).
  const btn = document.getElementById("btn-copy-img");
  if (btn) btn.addEventListener("click", toggle);

  window.Capture = {
    get active() {
      return cap.active;
    },
    enter,
    exit,
    toggle,
  };
})();
