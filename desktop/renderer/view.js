"use strict";

/**
 * Nabu PDF — READ-ONLY split-view pane (renderer/view.html).
 *
 * What this is: a second, deliberately small PDF viewer that can sit beside the
 * editable renderer so the user can read page 40 while editing page 5 — of the SAME
 * file, or of another one (docs/RESEARCH-2026-09-08-split-view.md).
 *
 * What it is NOT: a copy of app.js. It has no undo history, no autosave, no editor
 * overlay, no thumbnails, no sidecar. That is not an omission — it is the whole
 * design. Two consequences:
 *
 *  1. ONE FILE, ONE WRITER. The pane shows the document as it is ON DISK. Only the
 *     editable renderer ever writes, so "the same file open twice" cannot become
 *     "the second save silently ate the first". Main reloads the pane after a save,
 *     and the header says which save you are looking at.
 *  2. It is measurably cheaper: holding the same document costs ≤53% of a full
 *     renderer for a 300-page drawing set, ≤81% for a 120 MB image-heavy file
 *     (measured, §10.4 of that doc). The four things it drops — undo snapshots,
 *     autosave copies, thumbnails, the editor layer — are exactly the four the
 *     memory study named (docs/PERF-MEMORY.md §3).
 *
 * Two protections are carried over from app.js ON PURPOSE, and losing either is a
 * silent failure, not a crash:
 *  · window.RasterCap.viewRasterDpr — BI-78. Past ~268 MP Chromium paints NOTHING
 *    and throws nothing, so an A0 sheet just goes white. Shared module, never a copy.
 *  · free page bitmaps once they drift out of view, so RAM stays flat over a
 *    300-page document instead of growing with it.
 *
 * Runs under the same sandbox as the document renderer: contextIsolation, no node.
 * Its whole bridge is `window.viewPane` (src/view-preload.js, six methods).
 */
(function () {
  const $ = (id) => document.getElementById(id);

  // Zoom range and stepping are DECLARED here but must stay equal to app.js's —
  // a pane that zooms differently from the viewer beside it reads as a bug. They
  // are not shared through a module because they are plain bounds, not arithmetic;
  // instead test/viewer-geom.test.js lifts BOTH files and fails if they diverge.
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 5;
  const ZOOM_STEP_BASE = 1.25;
  const ZOOM_WHEEL_BASE = 1.1;
  // Floor for the fit commands only: a fit is a measurement, not a user intent, and
  // an A0 sheet in a 300px pane legitimately lands below the manual floor.
  const FIT_MIN_SCALE = 0.08;
  // How far outside the viewport a page keeps its bitmap. Smaller than app.js's
  // 1500px on purpose: this pane is narrower, so the same margin buys fewer pages.
  const KEEP_MARGIN_PX = 1200;
  const RENDER_MARGIN_PX = 400;

  const st = {
    pdf: null,
    metas: [], // { page, vp, wrap, canvas, rendering }
    obsRender: null, // inner band: paint
    obsKeep: null, // outer band: release the bitmap again
    scale: 1,
    fit: "width", // "width" | "page" | null — what the LAST zoom action meant
    name: "",
    path: null,
    savedAt: 0,
    token: 0, // bumped on every open/clear so a slow render can't paint a stale doc
  };

  // ---- chrome ------------------------------------------------------------

  function note(msg) {
    const el = $("vw-note");
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function setControlsEnabled(on) {
    for (const id of ["vw-prev", "vw-next", "vw-page", "vw-zoom", "vw-zoom-out", "vw-zoom-in", "vw-fit-w", "vw-fit-p"]) {
      const el = $(id);
      if (el) el.disabled = !on;
    }
  }

  // "lúc 14:05" — the pane shows the last SAVE, so it has to say which one, or the
  // user reads a stale page as the current one and trusts it.
  function stamp(ts) {
    const el = $("vw-saved");
    if (!ts) {
      el.hidden = true;
      return;
    }
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    el.hidden = false;
    el.textContent = "· bản lưu " + p(d.getHours()) + ":" + p(d.getMinutes());
    el.title = "Khung xem hiển thị bản đã lưu trên đĩa. Lưu ở khung chính để cập nhật.";
  }

  function syncZoomInput() {
    $("vw-zoom").value = String(Math.round(st.scale * 100));
  }

  function syncPageInput() {
    $("vw-page").value = String(currentPageIndex() + 1);
    $("vw-total").textContent = "/ " + (st.metas.length || "–");
    $("vw-prev").disabled = !st.metas.length || currentPageIndex() <= 0;
    $("vw-next").disabled = !st.metas.length || currentPageIndex() >= st.metas.length - 1;
  }

  // ---- document ----------------------------------------------------------

  function teardown() {
    st.token++;
    if (st.obsRender) {
      try { st.obsRender.disconnect(); } catch (_) {}
      st.obsRender = null;
    }
    if (st.obsKeep) {
      try { st.obsKeep.disconnect(); } catch (_) {}
      st.obsKeep = null;
    }
    for (const m of st.metas) freeCanvas(m);
    if (st.pdf) {
      try { st.pdf.destroy(); } catch (_) {}
      st.pdf = null;
    }
    st.metas = [];
    $("vw-body").textContent = "";
  }

  function showEmpty(msg) {
    const d = document.createElement("div");
    d.className = "vw-empty";
    d.textContent = msg;
    $("vw-body").appendChild(d);
  }

  // Where the reader was, so a reload after the other pane saves does not throw it
  // back to page 1 at a different zoom. Captured BEFORE teardown, applied after the
  // rebuild — this is the difference between "the pane refreshed" and "the pane
  // lost my place", and the main pane saves often.
  function place() {
    return { fit: st.fit, scale: st.scale, page: currentPageIndex() };
  }

  async function open({ data, name, path, savedAt }, keep) {
    teardown();
    const mine = st.token;
    st.name = name || "";
    st.path = path || null;
    st.savedAt = savedAt || 0;
    $("vw-name").textContent = (st.name || "Chưa chọn tài liệu") + " ▾";
    $("vw-name").title = st.path || "Chọn tài liệu cho khung xem";
    stamp(st.savedAt);
    note("");
    setControlsEnabled(false);

    if (!data || !data.length) {
      showEmpty("Khung xem — chưa chọn tài liệu.");
      return;
    }
    try {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      st.pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      if (mine !== st.token) return; // superseded while we were parsing
    } catch (err) {
      st.pdf = null;
      // A password-protected file is the one failure with a real answer for the
      // user: the editable renderer CAN open it (it asks the sidecar to decrypt),
      // this pane deliberately cannot and must not learn how.
      const isPw = err && (err.name === "PasswordException" || /password/i.test(err.message || ""));
      note(isPw ? "Tài liệu có mật khẩu — hãy mở ở khung chính." : "Không đọc được tài liệu này.");
      showEmpty(isPw ? "Tài liệu có mật khẩu." : "Không đọc được tài liệu này.");
      return;
    }
    await build(mine);
    if (mine !== st.token) return;
    setControlsEnabled(true);
    if (!keep) {
      await fitWidth();
      return;
    }
    // Put the reader back. A fit is re-APPLIED rather than restored as a number:
    // the saved file may have a different page size, and "vừa bề ngang" has to keep
    // meaning that. A manual zoom is restored exactly, because it was a choice.
    if (keep.fit === "width") fitWidth();
    else if (keep.fit === "page") fitPage();
    else {
      st.fit = null;
      zoomTo(keep.scale);
    }
    gotoPage(keep.page); // clamped inside: the reload may have fewer pages
  }

  async function build(mine) {
    const body = $("vw-body");
    body.textContent = "";
    st.metas = [];
    for (let i = 0; i < st.pdf.numPages; i++) {
      const page = await st.pdf.getPage(i + 1);
      if (mine !== st.token) return;
      const vp = page.getViewport({ scale: st.scale });
      const wrap = document.createElement("div");
      wrap.className = "vw-pw";
      wrap.dataset.index = String(i);
      wrap.style.width = Math.round(vp.width) + "px";
      wrap.style.height = Math.round(vp.height) + "px";
      body.appendChild(wrap);
      st.metas.push({ page, vp, wrap, canvas: null, rendering: false });
    }
    // Two bands, exactly the shape app.js uses: the inner one paints, the outer one
    // releases. Keeping BOTH observers attached (no unobserve) is what lets a
    // released page come back when the user scrolls to it again.
    st.obsRender = new IntersectionObserver(
      (es) => { for (const e of es) if (e.isIntersecting) renderPage(+e.target.dataset.index); },
      { root: body, rootMargin: RENDER_MARGIN_PX + "px 0px" }
    );
    st.obsKeep = new IntersectionObserver(
      (es) => { for (const e of es) if (!e.isIntersecting) freeCanvas(st.metas[+e.target.dataset.index]); },
      { root: body, rootMargin: KEEP_MARGIN_PX + "px 0px" }
    );
    for (const m of st.metas) {
      st.obsRender.observe(m.wrap);
      st.obsKeep.observe(m.wrap);
    }
    syncPageInput();
  }

  async function renderPage(i) {
    const m = st.metas[i];
    if (!m || m.canvas || m.rendering) return;
    const mine = st.token;
    m.rendering = true;
    try {
      const cw = m.vp.width;
      const ch = m.vp.height;
      // BI-78. Shared with index.html — never a local copy of these numbers.
      const rd = window.RasterCap.viewRasterDpr(cw, ch, window.devicePixelRatio || 1);
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.floor(cw * rd));
      off.height = Math.max(1, Math.floor(ch * rd));
      await m.page.render({
        canvasContext: off.getContext("2d", { alpha: false }),
        viewport: m.vp,
        transform: rd !== 1 ? [rd, 0, 0, rd, 0, 0] : undefined,
        // Same value app.js uses outside edit mode: baked annotations (/AP vectors,
        // BI-64) MUST show, or the pane silently hides what the user just saved.
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      }).promise;
      if (mine !== st.token || m.canvas) return; // document swapped mid-render
      m.wrap.appendChild(off);
      m.canvas = off;
    } catch (_) {
      // One bad page must not take the pane down; it stays blank and the rest works.
    } finally {
      m.rendering = false;
    }
  }

  function freeCanvas(m) {
    if (!m || !m.canvas) return;
    // Zeroing before removing is what actually hands the bitmap back; dropping the
    // node alone leaves it alive until GC decides otherwise.
    m.canvas.width = 0;
    m.canvas.height = 0;
    m.canvas.remove();
    m.canvas = null;
  }

  // ---- zoom --------------------------------------------------------------

  function nearViewport(el) {
    const a = el.getBoundingClientRect();
    const b = $("vw-body").getBoundingClientRect();
    return a.bottom > b.top - RENDER_MARGIN_PX && a.top < b.bottom + RENDER_MARGIN_PX;
  }

  // Absolute zoom. `anchor` is a client point to keep visually fixed (Ctrl+wheel);
  // without one the pane's centre stays put. Same two-half shape as the viewer:
  // resize the boxes now, repaint after — so a zoom never blocks on rasterising.
  function zoomTo(next, anchor, opts) {
    if (!st.metas.length) return;
    const min = opts && opts.min ? opts.min : ZOOM_MIN;
    next = Math.min(ZOOM_MAX, Math.max(min, Math.round(+next * 1000) / 1000));
    if (!next || next === st.scale) {
      syncZoomInput();
      return;
    }
    const body = $("vw-body");
    const r = body.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : r.width / 2;
    const ay = anchor ? anchor.y - r.top : r.height / 2;
    const ratio = next / st.scale;
    const sl = body.scrollLeft;
    const sTop = body.scrollTop;

    st.scale = next;
    for (const m of st.metas) {
      m.vp = m.page.getViewport({ scale: st.scale });
      m.wrap.style.width = Math.round(m.vp.width) + "px";
      m.wrap.style.height = Math.round(m.vp.height) + "px";
      freeCanvas(m); // its pixels are for the old scale
    }
    // Assigning scroll flushes layout, so the resize above is already in effect.
    body.scrollLeft = (sl + ax) * ratio - ax;
    body.scrollTop = (sTop + ay) * ratio - ay;
    syncZoomInput();
    for (const m of st.metas) if (nearViewport(m.wrap)) renderPage(+m.wrap.dataset.index);
    syncPageInput();
  }

  function maxPageSize1() {
    if (!st.metas.length) return null;
    let w = 0;
    let h = 0;
    for (const m of st.metas) {
      w = Math.max(w, m.vp.width / st.scale);
      h = Math.max(h, m.vp.height / st.scale);
    }
    return w && h ? { w, h } : null;
  }

  function fitWidth() {
    const m = maxPageSize1();
    if (!m) return;
    st.fit = "width";
    const body = $("vw-body");
    const cs = getComputedStyle(body);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 16;
    zoomTo((body.clientWidth - pad) / m.w, null, { min: FIT_MIN_SCALE });
  }

  function fitPage() {
    const m = maxPageSize1();
    if (!m) return;
    st.fit = "page";
    const body = $("vw-body");
    const cs = getComputedStyle(body);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 16;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + 16;
    zoomTo(Math.min((body.clientWidth - padX) / m.w, (body.clientHeight - padY) / m.h), null, { min: FIT_MIN_SCALE });
  }

  // Unlike the viewer, a fit here is a MODE, not a one-off command: the pane is
  // resized every time the user drags the divider, and re-fitting is the whole
  // point of having asked for "fit width" in a pane whose width keeps changing.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!st.metas.length) return;
      if (st.fit === "width") fitWidth();
      else if (st.fit === "page") fitPage();
      else for (const m of st.metas) if (nearViewport(m.wrap)) renderPage(+m.wrap.dataset.index);
    }, 120);
  });

  // ---- paging ------------------------------------------------------------

  function currentPageIndex() {
    if (!st.metas.length) return 0;
    const top = $("vw-body").scrollTop;
    let cur = 0;
    for (let i = 0; i < st.metas.length; i++) {
      if (st.metas[i].wrap.offsetTop - 24 <= top) cur = i;
      else break;
    }
    return cur;
  }

  function gotoPage(i) {
    const m = st.metas[Math.max(0, Math.min(st.metas.length - 1, i))];
    if (!m) return;
    $("vw-body").scrollTop = m.wrap.offsetTop - 10;
    syncPageInput();
  }

  // ---- wiring ------------------------------------------------------------

  $("vw-body").addEventListener("scroll", syncPageInput, { passive: true });
  $("vw-prev").onclick = () => gotoPage(currentPageIndex() - 1);
  $("vw-next").onclick = () => gotoPage(currentPageIndex() + 1);
  $("vw-page").addEventListener("change", () => {
    const n = parseInt(($("vw-page").value || "").replace(/[^\d]/g, ""), 10);
    if (n) gotoPage(n - 1);
    else syncPageInput();
  });
  $("vw-zoom-in").onclick = () => { st.fit = null; zoomTo(st.scale * ZOOM_STEP_BASE); };
  $("vw-zoom-out").onclick = () => { st.fit = null; zoomTo(st.scale / ZOOM_STEP_BASE); };
  $("vw-zoom").addEventListener("change", () => {
    const n = parseInt(($("vw-zoom").value || "").replace(/[^\d]/g, ""), 10);
    st.fit = null;
    if (n) zoomTo(n / 100);
    else syncZoomInput();
  });
  $("vw-fit-w").onclick = fitWidth;
  $("vw-fit-p").onclick = fitPage;
  $("vw-close").onclick = () => window.viewPane.close();
  // Both of these are QUESTIONS for main, not actions taken here: which documents
  // exist and which pane may edit one are facts this renderer is deliberately not
  // told (BI-55). It asks; main pops the menu, opens the tab, pushes the answer.
  $("vw-name").onclick = () => window.viewPane.pickSource();
  $("vw-edit").onclick = () => window.viewPane.editThis();

  $("vw-body").addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !st.metas.length) return;
      e.preventDefault();
      st.fit = null;
      const notches = Math.max(-3, Math.min(3, -(+e.deltaY || 0) / 100));
      zoomTo(st.scale * Math.pow(ZOOM_WHEEL_BASE, notches), { x: e.clientX, y: e.clientY });
    },
    { passive: false }
  );

  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!st.metas.length) return;
    if (e.key === "PageDown") { gotoPage(currentPageIndex() + 1); e.preventDefault(); }
    else if (e.key === "PageUp") { gotoPage(currentPageIndex() - 1); e.preventDefault(); }
    else if (e.key === "Home" && e.ctrlKey) { gotoPage(0); e.preventDefault(); }
    else if (e.key === "End" && e.ctrlKey) { gotoPage(st.metas.length - 1); e.preventDefault(); }
  });

  // ---- main -> pane ------------------------------------------------------

  window.viewPane.onOpen((p) => { open(p || {}); });
  // A reload is the SAME document, one save later — so it keeps the reader's place.
  // An open is a different document, where restoring a scroll position would be
  // restoring somebody else's.
  window.viewPane.onReload((p) => { open(p || {}, place()); });
  window.viewPane.onState((s) => {
    $("vw-edit").hidden = !(s && s.canEdit);
  });
  window.viewPane.onClear((p) => {
    teardown();
    st.name = "";
    st.path = null;
    $("vw-name").textContent = "Chưa chọn tài liệu ▾";
    $("vw-name").title = "Chọn tài liệu cho khung xem";
    $("vw-edit").hidden = true;
    stamp(0);
    setControlsEnabled(false);
    note((p && p.reason) || "");
    showEmpty("Khung xem — chưa chọn tài liệu.");
    syncPageInput();
  });

  window.viewPane.ready();
})();
