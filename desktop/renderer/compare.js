"use strict";

/**
 * Nabu PDF — PDF compare view (word-stream model).
 *
 * The sidecar /compare endpoint diffs the two documents as one continuous word
 * stream (not page-by-page), so a change is reported on whatever page it truly
 * lands on in each file — robust to inserted/removed content shifting pages.
 *
 * This view renders both documents in their own lazily-rendered scroll pane,
 * highlights each changed word on its page (red = removed, green = added, yellow
 * = changed), and lists the changes in document order. Picking a change jumps
 * both panes to the pages it touches.
 *
 * Reuses globals from app.js (classic scripts share global scope): sidecarFetch,
 * toast, showOverlay, hideOverlay, u8ToB64, toU8, sidecar, pdfjsLib. Nothing here
 * touches the main viewer `state`, so existing tools are unaffected.
 */
(function () {
  const el = (id) => document.getElementById(id);

  const cmp = {
    a: null, // { name, bytes: Uint8Array }
    b: null,
    report: null,
    changes: null,
    aBoxes: null, // { "pageIndex": [[x0,y0,x1,y1,kind], ...] }
    bBoxes: null,
    pdfA: null,
    pdfB: null,
    mode: "auto",
    scale: 1.1,
    fit: true, // auto fit-to-width until the user zooms manually
    changeIdx: -1,
    wrapsA: [], // per-page slot elements
    wrapsB: [],
    obsA: null,
    obsB: null,
  };

  function reset() {
    if (cmp.obsA) { try { cmp.obsA.disconnect(); } catch (_) {} cmp.obsA = null; }
    if (cmp.obsB) { try { cmp.obsB.disconnect(); } catch (_) {} cmp.obsB = null; }
    if (cmp.pdfA) { try { cmp.pdfA.destroy(); } catch (_) {} cmp.pdfA = null; }
    if (cmp.pdfB) { try { cmp.pdfB.destroy(); } catch (_) {} cmp.pdfB = null; }
    cmp.a = cmp.b = cmp.report = cmp.changes = cmp.aBoxes = cmp.bBoxes = null;
    cmp.mode = "auto";
    cmp.fit = true;
    cmp.changeIdx = -1;
    cmp.wrapsA = [];
    cmp.wrapsB = [];
  }

  // ---- pick-files modal ----------------------------------------------------

  function open() {
    if (typeof sidecar !== "undefined" && sidecar.state !== "ready") {
      toast("Engine chưa sẵn sàng.", "bad");
      return;
    }
    reset();
    el("cmp2-a-name").textContent = "Chưa chọn";
    el("cmp2-b-name").textContent = "Chưa chọn";
    el("cmp2-mode").value = "auto";
    el("cmp2-sens").value = "normal";
    el("cmp2-sens-wrap").hidden = true;
    updateRunBtn();
    el("cmp2-modal").hidden = false;
  }

  function updateRunBtn() {
    el("cmp2-run").disabled = !(cmp.a && cmp.b);
  }

  async function pick(which) {
    const files = await window.desktop.openPdf({ multi: false });
    if (!files.length) return;
    const f = files[0];
    const entry = { name: f.name, bytes: toU8(f.data) };
    if (which === "a") {
      cmp.a = entry;
      el("cmp2-a-name").textContent = f.name;
    } else {
      cmp.b = entry;
      el("cmp2-b-name").textContent = f.name;
    }
    updateRunBtn();
  }

  async function run() {
    if (!cmp.a || !cmp.b) return;
    const mode = el("cmp2-mode").value || "auto";
    cmp.mode = mode;
    if (mode === "overlay") {
      await runOverlay();
      return;
    }
    el("cmp2-modal").hidden = true;
    showOverlay(
      mode === "drawing"
        ? "Đang so sánh bản vẽ (ghép trang + diff hình ảnh)…"
        : mode === "text"
          ? "Đang so sánh văn bản…"
          : "Đang so sánh (có thể OCR — tài liệu nhiều trang sẽ lâu)…"
    );
    try {
      const endpoint = mode === "drawing" ? "/compare-drawings" : "/compare";
      const body =
        mode === "drawing"
          ? {
              pdf_a_b64: u8ToB64(cmp.a.bytes),
              pdf_b_b64: u8ToB64(cmp.b.bytes),
              sensitivity: el("cmp2-sens").value || "normal",
            }
          : {
              pdf_a_b64: u8ToB64(cmp.a.bytes),
              pdf_b_b64: u8ToB64(cmp.b.bytes),
              mode,
            };
      const res = await sidecarFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // The server may return a non-JSON body on an unexpected 500; read text
      // first and parse defensively so the user sees a real reason, not a raw
      // "Unexpected token" JSON-parse error.
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        toast("So sánh lỗi (máy chủ " + res.status + "): " + (raw || "không rõ").slice(0, 120), "bad");
        return;
      }
      if (!data.success) {
        toast("So sánh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
        return;
      }
      cmp.report = data;
      cmp.changes = data.changes || [];
      cmp.aBoxes = data.a_boxes || {};
      cmp.bBoxes = data.b_boxes || {};
      // Copy the bytes for pdf.js — getDocument may detach the passed buffer.
      cmp.pdfA = await pdfjsLib.getDocument({ data: cmp.a.bytes.slice(), isEvalSupported: false }).promise;
      cmp.pdfB = await pdfjsLib.getDocument({ data: cmp.b.bytes.slice(), isEvalSupported: false }).promise;
      await openView();
    } catch (err) {
      toast("Lỗi so sánh: " + err.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // ---- result view ---------------------------------------------------------

  async function openView() {
    el("compare-view").hidden = false;
    el("compare-a-h").textContent = "A · " + cmp.a.name;
    el("compare-b-h").textContent = "B · " + cmp.b.name;
    // Marked-up export only makes sense for the drawing diff (region boxes).
    el("compare-export").hidden = !(cmp.mode === "drawing" && !cmp.report.summary.identical);
    renderSummary();
    renderChangeList();
    // Start at a scale that fits the page width to the pane (the view is now
    // laid out, so the scroll panes have their real width).
    cmp.fit = true;
    cmp.scale = await fitScale();
    updateZoomReadout();
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    buildPane("b", cmp.pdfB, cmp.bBoxes);
    if (cmp.changes.length) {
      cmp.changeIdx = 0;
      jumpToChange(0, false);
    } else {
      el("compare-pagenum").textContent = "0 thay đổi";
    }
  }

  // ---- zoom / fit ----------------------------------------------------------

  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4;

  // Scale that makes the widest first page fill the (narrower) pane's width.
  // Shared across both panes so A and B stay visually the same size.
  async function fitScale() {
    const host = el("compare-a");
    const other = el("compare-b");
    const avail = Math.max(
      200,
      Math.min(host.clientWidth || 0, other.clientWidth || 0) - 40 // 16px padding each side + slack
    );
    let maxW = 0;
    for (const pdf of [cmp.pdfA, cmp.pdfB]) {
      if (!pdf) continue;
      try {
        const p = await pdf.getPage(1);
        maxW = Math.max(maxW, p.getViewport({ scale: 1 }).width);
      } catch (_) {}
    }
    if (!maxW) return cmp.scale;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, avail / maxW));
  }

  function updateZoomReadout() {
    const r = el("compare-zoom");
    if (r) r.textContent = Math.round(cmp.scale * 100) + "%";
  }

  // Re-render both panes at the current scale, keeping the user on the same
  // change so zooming does not lose their place.
  function rerenderPanes() {
    if (!cmp.pdfA || !cmp.pdfB) return;
    updateZoomReadout();
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    buildPane("b", cmp.pdfB, cmp.bBoxes);
    if (cmp.changeIdx >= 0) jumpToChange(cmp.changeIdx, false);
  }

  function setScale(scale) {
    cmp.fit = false;
    cmp.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
    rerenderPanes();
  }

  function zoomBy(factor) {
    setScale(cmp.scale * factor);
  }

  async function fitToWidth() {
    cmp.scale = await fitScale();
    cmp.fit = true;
    rerenderPanes();
  }

  function closeView() {
    el("compare-view").hidden = true;
    reset();
  }

  function renderSummary() {
    const s = cmp.report.summary;
    let t = s.identical
      ? "Hai tài liệu giống nhau."
      : `${s.changes} thay đổi · A: ${s.pages_a} trang (${s.changed_pages_a.length} trang sửa) · B: ${s.pages_b} trang (${s.changed_pages_b.length} trang sửa)`;
    if (s.truncated) t += " · (tài liệu rất lớn — đã cắt bớt)";
    el("compare-summary").textContent = t;
  }

  function changeLabel(c) {
    if (c.type === "delete") return { cls: "del", txt: "− " + (c.a_text || "(trống)") };
    if (c.type === "insert") return { cls: "ins", txt: "+ " + (c.b_text || "(trống)") };
    // Drawing regions carry one label on both sides — show it once.
    if (c.a_text && c.a_text === c.b_text) return { cls: "rep", txt: "≠ " + c.a_text };
    return { cls: "rep", txt: (c.a_text || "∅") + "  →  " + (c.b_text || "∅") };
  }

  function renderChangeList() {
    const box = el("compare-changes");
    box.innerHTML = "";
    if (!cmp.changes.length) {
      box.innerHTML = '<p class="cmp-nodiff">Không có khác biệt.</p>';
      return;
    }
    const head = document.createElement("div");
    head.className = "cmp-diffs-head";
    head.textContent = cmp.changes.length + " thay đổi";
    box.appendChild(head);

    cmp.changes.forEach((c, i) => {
      const { cls, txt } = changeLabel(c);
      const b = document.createElement("button");
      b.className = "cmp-change " + cls;
      b.dataset.i = String(i);
      const t = document.createElement("div");
      t.className = "cmp-change-t";
      t.textContent = txt;
      const l = document.createElement("div");
      l.className = "cmp-change-l";
      l.textContent =
        "A " + (c.a_page != null ? "tr " + (c.a_page + 1) : "—") +
        " · B " + (c.b_page != null ? "tr " + (c.b_page + 1) : "—");
      b.appendChild(t);
      b.appendChild(l);
      b.onclick = () => {
        cmp.changeIdx = i;
        jumpToChange(i, true);
      };
      box.appendChild(b);
    });
  }

  function markActiveChange() {
    for (const b of el("compare-changes").querySelectorAll(".cmp-change")) {
      b.classList.toggle("active", Number(b.dataset.i) === cmp.changeIdx);
    }
  }

  // Build a pane: one slot per page, lazily rendered as it scrolls into view.
  function buildPane(side, pdf, boxesMap) {
    const host = el(side === "a" ? "compare-a" : "compare-b");
    // Tear down a previous observer (rebuild on zoom) so it stops firing on the
    // detached slots we are about to replace.
    const prevObs = side === "a" ? cmp.obsA : cmp.obsB;
    if (prevObs) { try { prevObs.disconnect(); } catch (_) {} }
    host.innerHTML = "";
    const wraps = [];
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const w = e.target;
            obs.unobserve(w);
            renderPage(side, pdf, Number(w.dataset.p), w, boxesMap);
          }
        }
      },
      { root: host, rootMargin: "400px" }
    );
    for (let i = 0; i < pdf.numPages; i++) {
      const w = document.createElement("div");
      w.className = "cmp-page-slot";
      w.dataset.p = String(i);
      w.style.minHeight = "300px";
      host.appendChild(w);
      wraps.push(w);
      obs.observe(w);
    }
    if (side === "a") { cmp.wrapsA = wraps; cmp.obsA = obs; }
    else { cmp.wrapsB = wraps; cmp.obsB = obs; }
  }

  async function renderPage(side, pdf, i, slot, boxesMap) {
    if (slot.dataset.rendered === "1") return;
    slot.dataset.rendered = "1";
    let page;
    try {
      page = await pdf.getPage(i + 1);
    } catch (_) {
      slot.dataset.rendered = "0";
      return;
    }
    const vp = page.getViewport({ scale: cmp.scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    const pageDiv = document.createElement("div");
    pageDiv.className = "cmp-page";
    pageDiv.style.width = vp.width + "px";
    pageDiv.style.height = vp.height + "px";
    pageDiv.appendChild(canvas);
    const label = document.createElement("div");
    label.className = "cmp-page-label";
    label.textContent = "Trang " + (i + 1);
    slot.style.minHeight = "";
    slot.innerHTML = "";
    slot.appendChild(label);
    slot.appendChild(pageDiv);
    try {
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
    } catch (_) {
      return;
    }
    const boxes = boxesMap[String(i)];
    if (boxes) drawBoxes(pageDiv, boxes);
  }

  // Boxes are in scale-1 PDF-point space → on screen it's just bbox * scale.
  function drawBoxes(pageDiv, boxes) {
    const s = cmp.scale;
    for (const b of boxes) {
      const [x0, y0, x1, y1, kind] = b;
      const d = document.createElement("div");
      d.className =
        "cmp-box " +
        (kind === "del" ? "cmp-box-del" : kind === "ins" ? "cmp-box-ins" : "cmp-box-replace");
      d.style.left = x0 * s + "px";
      d.style.top = y0 * s + "px";
      d.style.width = Math.max(3, x1 - x0) * s + "px";
      d.style.height = Math.max(6, y1 - y0) * s + "px";
      pageDiv.appendChild(d);
    }
  }

  // ---- export marked-up B ---------------------------------------------------

  // Save a copy of file B with a revision cloud around every changed region.
  // The clouds are real PDF annotations — any viewer can move/delete them.
  async function exportMarked() {
    if (!cmp.b || !cmp.bBoxes) return;
    showOverlay("Đang tạo bản B có đánh dấu…");
    try {
      const res = await sidecarFetch("/compare-drawings/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_b64: u8ToB64(cmp.b.bytes),
          boxes: cmp.bBoxes,
          style: "cloud",
        }),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        toast("Xuất lỗi (máy chủ " + res.status + "): " + (raw || "không rõ").slice(0, 120), "bad");
        return;
      }
      if (!data.success) {
        toast("Xuất lỗi: " + (data.error || data.detail || "không rõ"), "bad");
        return;
      }
      const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
      const name = cmp.b.name.replace(/\.pdf$/i, "") + "-danh-dau.pdf";
      const r = await window.desktop.savePdf(bytes, name);
      if (r.saved) toast("Đã lưu bản B có đánh dấu: " + r.path, "good");
    } catch (err) {
      toast("Lỗi xuất bản đánh dấu: " + err.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // ---- navigation ----------------------------------------------------------

  function jumpToChange(i, smooth) {
    const c = cmp.changes[i];
    if (!c) return;
    if (c.a_page != null) scrollPaneTo("a", c.a_page, smooth);
    if (c.b_page != null) scrollPaneTo("b", c.b_page, smooth);
    // Readout shows both the change index and the page it lands on, so the user
    // always knows which page each side is pointing at.
    const pg = (p) => (p != null ? "tr " + (p + 1) : "—");
    el("compare-pagenum").textContent =
      `Thay đổi ${i + 1}/${cmp.changes.length} · A ${pg(c.a_page)} · B ${pg(c.b_page)}`;
    markActiveChange();
  }

  async function scrollPaneTo(side, pageIdx, smooth) {
    const wraps = side === "a" ? cmp.wrapsA : cmp.wrapsB;
    const w = wraps[pageIdx];
    if (!w) return;
    // Force-render the target page even if it hasn't scrolled into view yet,
    // then scroll to the actual changed region on it (not just the page top) so
    // the difference is centered and visible without extra scrolling.
    const pdf = side === "a" ? cmp.pdfA : cmp.pdfB;
    const boxesMap = side === "a" ? cmp.aBoxes : cmp.bBoxes;
    await renderPage(side, pdf, pageIdx, w, boxesMap);
    const behavior = smooth ? "smooth" : "auto";
    const box = w.querySelector(".cmp-box");
    if (box) {
      box.scrollIntoView({ behavior, block: "center", inline: "nearest" });
      pulseBoxes(w);
    } else {
      w.scrollIntoView({ behavior, block: "start" });
    }
  }

  // Briefly flash the changed regions on a page so the eye lands on them.
  function pulseBoxes(slot) {
    for (const b of slot.querySelectorAll(".cmp-box")) {
      b.classList.remove("cmp-box-pulse");
      // reflow to restart the animation if it was already applied
      void b.offsetWidth;
      b.classList.add("cmp-box-pulse");
    }
  }

  function nextChange(dir) {
    if (!cmp.changes.length) {
      toast("Không có khác biệt.", "");
      return;
    }
    let i = cmp.changeIdx + dir;
    if (i < 0) i = cmp.changes.length - 1;
    if (i >= cmp.changes.length) i = 0;
    cmp.changeIdx = i;
    jumpToChange(i, true);
  }

  // ---- overlay (onion-skin of two aligned drawings) ------------------------

  const ov = {
    pairs: [], // [{a, b, similarity, dx, dy}] from /overlay-drawings
    idx: 0,
    scale: 1.1,
    fit: true,
    dx: 0, dy: 0,   // auto align offset (PDF points) for the current pair
    mdx: 0, mdy: 0, // manual nudge (PDF points) on top of the auto offset
  };
  const OV_ZOOM_MIN = 0.2;
  const OV_ZOOM_MAX = 4;

  async function runOverlay() {
    el("cmp2-modal").hidden = true;
    showOverlay("Đang căn chỉnh 2 bản vẽ…");
    try {
      const res = await sidecarFetch("/overlay-drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_a_b64: u8ToB64(cmp.a.bytes), pdf_b_b64: u8ToB64(cmp.b.bytes) }),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        toast("Chồng lớp lỗi (máy chủ " + res.status + "): " + (raw || "không rõ").slice(0, 120), "bad");
        return;
      }
      if (!data.success) {
        toast("Chồng lớp lỗi: " + (data.error || data.detail || "không rõ"), "bad");
        return;
      }
      if (!data.pairs || !data.pairs.length) {
        toast("Không ghép được cặp trang nào giữa 2 bản vẽ.", "bad");
        return;
      }
      cmp.report = data;
      cmp.pdfA = await pdfjsLib.getDocument({ data: cmp.a.bytes.slice(), isEvalSupported: false }).promise;
      cmp.pdfB = await pdfjsLib.getDocument({ data: cmp.b.bytes.slice(), isEvalSupported: false }).promise;
      ov.pairs = data.pairs;
      ov.idx = 0;
      await openOverlay();
    } catch (err) {
      toast("Lỗi chồng lớp: " + err.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  async function openOverlay() {
    el("overlay-view").hidden = false;
    const s = cmp.report.summary || {};
    el("overlay-summary").textContent =
      `${ov.pairs.length} cặp trang khớp · A: ${s.pages_a || "?"} trang · B: ${s.pages_b || "?"} trang`;
    ov.fit = true;
    await loadPair(0);
  }

  async function loadPair(k) {
    ov.idx = Math.max(0, Math.min(ov.pairs.length - 1, k));
    const p = ov.pairs[ov.idx];
    ov.dx = p.dx || 0;
    ov.dy = p.dy || 0;
    ov.mdx = 0;
    ov.mdy = 0; // fresh manual offset per pair
    el("overlay-pagenum").textContent =
      `Cặp ${ov.idx + 1}/${ov.pairs.length} · A tr ${p.a + 1} ↔ B tr ${p.b + 1}`;
    if (ov.fit) ov.scale = await ovFitScale(p);
    await renderOverlay();
  }

  async function ovFitScale(pair) {
    const stage = el("overlay-stage");
    const avail = Math.max(200, (stage.clientWidth || 0) - 32);
    let maxW = 1;
    for (const [pdf, idx] of [[cmp.pdfA, pair.a], [cmp.pdfB, pair.b]]) {
      try {
        const pg = await pdf.getPage(idx + 1);
        maxW = Math.max(maxW, pg.getViewport({ scale: 1 }).width);
      } catch (_) {}
    }
    return Math.min(OV_ZOOM_MAX, Math.max(OV_ZOOM_MIN, avail / maxW));
  }

  // Render one page onto a canvas. `tint` (a CSS colour) recolours the ink and
  // leaves the background transparent, so stacked layers reveal each other.
  async function ovRenderPage(pdf, i, canvas, tint) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: ov.scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); // transparent background
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    if (tint) {
      // Keep the ink's alpha (antialiased edges included), replace its colour.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    return { w: vp.width, h: vp.height };
  }

  async function renderOverlay() {
    const p = ov.pairs[ov.idx];
    const tint = el("overlay-tint").checked;
    const base = el("overlay-base");
    const top = el("overlay-top");
    const da = await ovRenderPage(cmp.pdfA, p.a, base, tint ? "#e01010" : null);
    const db = await ovRenderPage(cmp.pdfB, p.b, top, tint ? "#1060e0" : null);
    const stack = el("overlay-stack");
    stack.style.width = Math.max(da.w, db.w) + "px";
    stack.style.height = Math.max(da.h, db.h) + "px";
    applyOverlayView();
  }

  // Cheap updates (no re-raster): top-layer offset, opacity and blend mode.
  function applyOverlayView() {
    const top = el("overlay-top");
    const useAlign = el("overlay-align").checked;
    const tint = el("overlay-tint").checked;
    const tx = ((useAlign ? ov.dx : 0) + ov.mdx) * ov.scale;
    const ty = ((useAlign ? ov.dy : 0) + ov.mdy) * ov.scale;
    top.style.transform = `translate(${tx}px, ${ty}px)`;
    top.style.opacity = String((+el("overlay-opacity").value || 0) / 100);
    top.style.mixBlendMode = tint ? "multiply" : "normal";
    el("overlay-zoom").textContent = Math.round(ov.scale * 100) + "%";
  }

  function ovNudge(ddxPx, ddyPx) {
    // Nudge in screen pixels → convert to points so it holds across zoom.
    ov.mdx += ddxPx / ov.scale;
    ov.mdy += ddyPx / ov.scale;
    applyOverlayView();
  }

  async function ovZoomBy(f) {
    ov.scale = Math.min(OV_ZOOM_MAX, Math.max(OV_ZOOM_MIN, ov.scale * f));
    ov.fit = false;
    await renderOverlay();
  }

  async function ovFit() {
    ov.fit = true;
    ov.scale = await ovFitScale(ov.pairs[ov.idx]);
    await renderOverlay();
  }

  function closeOverlay() {
    el("overlay-view").hidden = true;
    ov.pairs = [];
    reset();
  }

  // ---- wiring --------------------------------------------------------------

  function init() {
    const on = (id, fn) => {
      const e = el(id);
      if (e) e.onclick = fn;
    };
    on("cmp2-pick-a", () => pick("a"));
    on("cmp2-pick-b", () => pick("b"));
    on("cmp2-cancel", () => (el("cmp2-modal").hidden = true));
    on("cmp2-run", run);
    const modeSel = el("cmp2-mode");
    if (modeSel) {
      modeSel.onchange = () => {
        el("cmp2-sens-wrap").hidden = modeSel.value !== "drawing";
      };
    }
    // Overlay controls
    on("overlay-close", closeOverlay);
    on("overlay-prev", () => loadPair(ov.idx - 1));
    on("overlay-next", () => loadPair(ov.idx + 1));
    on("overlay-zoom-in", () => ovZoomBy(1.2));
    on("overlay-zoom-out", () => ovZoomBy(1 / 1.2));
    on("overlay-fit", () => ovFit());
    on("overlay-nudge-l", () => ovNudge(-2, 0));
    on("overlay-nudge-r", () => ovNudge(2, 0));
    on("overlay-nudge-u", () => ovNudge(0, -2));
    on("overlay-nudge-d", () => ovNudge(0, 2));
    on("overlay-nudge-reset", () => { ov.mdx = 0; ov.mdy = 0; applyOverlayView(); });
    const oOpacity = el("overlay-opacity");
    if (oOpacity) oOpacity.oninput = applyOverlayView;
    const oAlign = el("overlay-align");
    if (oAlign) oAlign.onchange = applyOverlayView;
    const oTint = el("overlay-tint");
    if (oTint) oTint.onchange = () => renderOverlay(); // recolour needs a re-raster
    document.addEventListener("keydown", (e) => {
      if (el("overlay-view").hidden) return;
      if (e.key === "Escape") { closeOverlay(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); ovZoomBy(1.2); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); ovZoomBy(1 / 1.2); }
      else if (e.key === "0") { e.preventDefault(); ovFit(); }
      else if (e.key === "PageDown") { e.preventDefault(); loadPair(ov.idx + 1); }
      else if (e.key === "PageUp") { e.preventDefault(); loadPair(ov.idx - 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); ovNudge(-2, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); ovNudge(2, 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); ovNudge(0, -2); }
      else if (e.key === "ArrowDown") { e.preventDefault(); ovNudge(0, 2); }
    });
    const oStage = el("overlay-stage");
    if (oStage) {
      oStage.addEventListener("wheel", (e) => {
        if (el("overlay-view").hidden) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        ovZoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }, { passive: false });
    }
    on("compare-export", exportMarked);
    on("compare-close", closeView);
    on("compare-prev", () => nextChange(-1));
    on("compare-next", () => nextChange(1));
    on("compare-zoom-in", () => zoomBy(1.2));
    on("compare-zoom-out", () => zoomBy(1 / 1.2));
    on("compare-fit", () => fitToWidth());
    document.addEventListener("keydown", (e) => {
      if (el("compare-view").hidden) return;
      if (e.key === "Escape") closeView();
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.2); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.2); }
      else if (e.key === "0") { e.preventDefault(); fitToWidth(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); nextChange(1); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); nextChange(-1); }
    });
    // Ctrl/Cmd + wheel = zoom (matches every PDF viewer's muscle memory).
    const body = el("compare-body") || el("compare-view");
    if (body) {
      body.addEventListener(
        "wheel",
        (e) => {
          if (el("compare-view").hidden) return;
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        },
        { passive: false }
      );
    }
    // Keep pages fitted to the pane while the user hasn't manually zoomed.
    let rz;
    window.addEventListener("resize", () => {
      if (el("compare-view").hidden || !cmp.fit || !cmp.pdfA) return;
      clearTimeout(rz);
      rz = setTimeout(() => { fitToWidth(); }, 150);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.Compare = { open };
})();
