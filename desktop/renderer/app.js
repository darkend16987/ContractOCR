"use strict";

/**
 * Nabu PDF — renderer (Phase 1: PDF core).
 *
 * Pure renderer-side PDF work (DESIGN D5): pdf.js renders, pdf-lib edits. The
 * canonical document is `state.bytes` (Uint8Array); every structural op rebuilds
 * those bytes with pdf-lib and re-renders. The OCR sidecar is only touched for
 * the OCR action and may be unavailable — PDF features never depend on it.
 *
 * Globals (vendored, offline): pdfjsLib (pdf.js v3 UMD), PDFLib (pdf-lib UMD).
 */

const $ = (id) => document.getElementById(id);

const pdfjsLib = window.pdfjsLib;
const { PDFDocument, degrees } = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const state = {
  bytes: null, // Uint8Array — canonical PDF
  name: "document.pdf",
  path: null, // full filesystem path of the open file (null = unsaved / drag-drop)
  pdf: null, // pdfjs document proxy
  numPages: 0,
  scale: 1.0, // viewer zoom (1.0 = 100%)
  selected: new Set(), // selected page indices (0-based, current order)
  lastClicked: null,
  dragSrc: null,
};

// Find-in-document state. `docItems` caches each page's text runs (str + folded
// + geometry) so re-searching is instant; it's keyed to the loaded pdf so a
// reload/edit rebuilds it. `matches` is a flat, reading-order list.
const search = {
  query: "",
  docItems: null,
  docToken: null,
  matches: [],
  current: -1,
};

const sidecar = { state: "starting", base: null, token: null };

// fetch() against the sidecar, carrying the per-launch auth token. Use this for
// every sidecar call so requests aren't rejected with 401.
function sidecarFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (sidecar.token) headers["X-Sidecar-Token"] = sidecar.token;
  return fetch(sidecar.base + path, { ...opts, headers });
}

// ---- small UI helpers ----------------------------------------------------

let toastTimer;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}
function showOverlay(msg) {
  $("overlay-msg").textContent = msg || "Đang xử lý…";
  $("overlay").hidden = false;
}
function hideOverlay() {
  $("overlay").hidden = true;
}
function toU8(d) {
  return d instanceof Uint8Array ? d : new Uint8Array(d);
}
function baseName(n) {
  return (n || "document.pdf").replace(/\.pdf$/i, "");
}
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

// ---- undo / redo ---------------------------------------------------------
// Document-level history: each entry snapshots the canonical bytes (+ name/path)
// before a mutating op (rotate/delete/merge/insert/reorder/edit-bake/form/
// text-edit). Annotation edits while in edit mode aren't individually undoable;
// they collapse into one history step when baked. Snapshots are full copies —
// fine for a desktop app; capped at HISTORY_LIMIT to bound memory.
const HISTORY_LIMIT = 30;
const history = { undo: [], redo: [] };

function snapshot() {
  return {
    bytes: state.bytes ? state.bytes.slice() : null,
    name: state.name,
    path: state.path,
  };
}
function resetHistory() {
  history.undo.length = 0;
  history.redo.length = 0;
  updateUndoRedo();
}
// Call BEFORE mutating state.bytes. Captures the pre-op document.
function pushUndo() {
  if (!state.bytes) return;
  history.undo.push(snapshot());
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  updateUndoRedo();
}
async function restoreSnapshot(s) {
  state.bytes = s.bytes;
  state.name = s.name;
  state.path = s.path;
  state.selected.clear();
  state.lastClicked = null;
  if (window.Editor) window.Editor.reset();
  if (window.TextEdit) window.TextEdit.reset();
  await renderAll();
  renderBreadcrumb();
  updateUndoRedo();
}
async function undo() {
  if (!history.undo.length) return;
  history.redo.push(snapshot());
  await restoreSnapshot(history.undo.pop());
  toast("Đã hoàn tác.", "");
}
async function redo() {
  if (!history.redo.length) return;
  history.undo.push(snapshot());
  await restoreSnapshot(history.redo.pop());
  toast("Đã làm lại.", "");
}
function updateUndoRedo() {
  const u = $("btn-undo");
  const r = $("btn-redo");
  if (u) u.disabled = !history.undo.length;
  if (r) r.disabled = !history.redo.length;
}

// Expose pushUndo so the editor / text-edit modules (separate scripts that also
// reassign state.bytes) record a history step before their own mutations.
window.History = { pushUndo };

// ---- breadcrumb (open file path) -----------------------------------------

function renderBreadcrumb() {
  const bar = $("breadcrumb");
  if (!bar) return;
  if (!state.bytes) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = "";

  const folderIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  folderIcon.setAttribute("class", "ic");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#ic-folder");
  folderIcon.appendChild(use);
  bar.appendChild(folderIcon);

  // Drag-dropped files (and never-saved docs) carry no path — show name only.
  if (!state.path) {
    const tag = document.createElement("span");
    tag.className = "crumb-tag";
    tag.textContent = "Chưa lưu";
    bar.appendChild(tag);
    bar.appendChild(sepEl());
    bar.appendChild(fileCrumb(state.name));
    return;
  }

  // Split on both separators so Windows + POSIX paths both render.
  const parts = state.path.split(/[\\/]/).filter(Boolean);
  const fileName = parts.pop();
  const sepChar = state.path.includes("\\") ? "\\" : "/";
  let acc = "";
  parts.forEach((seg, idx) => {
    acc = acc ? acc + sepChar + seg : seg + sepChar; // keep drive root "D:\"
    const target = acc;
    const btn = document.createElement("button");
    btn.className = "crumb";
    btn.textContent = seg;
    btn.title = "Mở thư mục: " + target;
    btn.onclick = () => window.desktop.showInFolder && window.desktop.showInFolder(target);
    bar.appendChild(btn);
    bar.appendChild(sepEl());
  });
  bar.appendChild(fileCrumb(fileName, state.path));

  function sepEl() {
    const s = document.createElement("span");
    s.className = "crumb-sep";
    s.textContent = "›";
    return s;
  }
}
function fileCrumb(name, fullPath) {
  const f = document.createElement("button");
  f.className = "crumb file";
  f.textContent = name || state.name;
  if (fullPath) {
    f.title = "Hiện file trong thư mục: " + fullPath;
    f.onclick = () => window.desktop.showInFolder && window.desktop.showInFolder(fullPath);
  } else {
    f.title = name || state.name;
  }
  return f;
}

// ---- loading + rendering -------------------------------------------------

async function loadBytes(bytes, name, fullPath) {
  state.bytes = toU8(bytes);
  if (name) state.name = name;
  state.path = fullPath || null;
  state.selected.clear();
  state.lastClicked = null;
  resetHistory(); // a new document starts a fresh undo timeline
  renderBreadcrumb();
  if (window.Editor) window.Editor.reset(); // drop annotations from any previous doc
  if (window.TextEdit) window.TextEdit.reset(); // drop any in-progress text edits
  try {
    await renderAll();
  } catch (err) {
    if (err && err.code === "NEEDS_PASSWORD") {
      const decrypted = await unlockEncrypted(state.bytes);
      if (!decrypted) return; // user cancelled or unlock failed (already toasted)
      state.bytes = decrypted;
      await renderAll();
    } else {
      return; // renderAll already toasted the failure
    }
  }
  toast("Đã mở: " + state.name, "good");
}

// Decrypt a password-protected PDF into plaintext bytes the rest of the app can
// edit. Needs the sidecar (PyMuPDF); re-prompts on a wrong password. Returns the
// decrypted Uint8Array, or null on cancel/failure.
async function unlockEncrypted(u8) {
  for (;;) {
    const pw = await promptPassword();
    if (pw == null) return null; // cancelled
    if (sidecar.state !== "ready" || !sidecar.base) {
      toast("Cần engine để mở PDF có mật khẩu — chờ badge 'OCR: sẵn sàng' rồi mở lại.", "bad");
      return null;
    }
    showOverlay("Đang mở khoá PDF…");
    try {
      const res = await sidecarFetch("/decrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_b64: u8ToB64(u8), password: pw }),
      });
      if (res.status === 401) {
        toast("Sai mật khẩu — thử lại.", "bad");
        continue;
      }
      const data = await res.json();
      if (!data.success) {
        toast("Không mở khoá được: " + (data.error || data.detail || "không rõ"), "bad");
        return null;
      }
      return Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    } catch (err) {
      toast("Lỗi mở khoá: " + err.message, "bad");
      return null;
    } finally {
      hideOverlay();
    }
  }
}

// Modal password prompt. Resolves to the entered string, or null if cancelled.
function promptPassword() {
  return new Promise((resolve) => {
    const modal = $("pw-modal");
    const input = $("pw-input");
    input.value = "";
    input.type = "password";
    modal.hidden = false;
    input.focus();
    const done = (val) => {
      modal.hidden = true;
      $("pw-ok").onclick = null;
      $("pw-cancel").onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    $("pw-ok").onclick = () => done(input.value);
    $("pw-cancel").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") done(input.value);
      else if (e.key === "Escape") done(null);
    };
  });
}

async function renderAll() {
  showOverlay("Đang tải tài liệu…");
  closeFind(); // a fresh document invalidates any open search
  try {
    if (state.pdf) {
      try { await state.pdf.destroy(); } catch (_) {}
    }
    // pdf.js may detach the buffer it's given — hand it a copy. Timeout so a
    // worker/load failure surfaces as an error instead of an endless spinner.
    const task = pdfjsLib.getDocument({
      data: state.bytes.slice(),
      isEvalSupported: false,
    });
    state.pdf = await withTimeout(
      task.promise,
      25000,
      "Tải PDF quá lâu — worker pdf.js có thể không khởi động được."
    );
    state.numPages = state.pdf.numPages;
    if (state.selected.size === 0 && state.numPages > 0) state.selected.add(0);
    await renderThumbs();
    await renderViewer();
    $("empty-state").style.display = "none";
    updateToolbar();
  } catch (err) {
    // Encrypted PDF: let loadBytes prompt for a password + decrypt, then retry.
    if (err && err.name === "PasswordException") {
      const e = new Error("PDF có mật khẩu");
      e.code = "NEEDS_PASSWORD";
      throw e;
    }
    toast("Không mở được PDF: " + err.message, "bad");
    throw err;
  } finally {
    hideOverlay();
  }
}

let thumbObserver = null;

async function renderThumbs() {
  const wrap = $("thumbs");
  wrap.innerHTML = "";
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  // Lazy: size every thumbnail's canvas up front (cheap — getPage only parses the
  // page dict, no rasterisation) but defer the expensive render until it nears the
  // sidebar viewport. Re-rendering ALL thumbnails was the main cost on reload after
  // a structural edit (reorder/insert/merge) on a multi-page doc.
  for (let i = 0; i < state.numPages; i++) {
    const page = await state.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 150 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height); // reserves layout; stays blank until drawn

    const div = document.createElement("div");
    div.className = "thumb" + (state.selected.has(i) ? " selected" : "");
    div.dataset.index = String(i);
    div.dataset.rendered = "0";
    div.draggable = true;
    div.appendChild(canvas);
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "thumb-check";
    check.checked = state.selected.has(i);
    check.title = "Chọn trang (để xóa / tách nhiều trang)";
    div.appendChild(check);
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);
    div.appendChild(num);
    wireThumb(div);
    wrap.appendChild(div);
  }

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        renderThumbCanvas(+e.target.dataset.index);
        thumbObserver.unobserve(e.target);
      }
    },
    { root: wrap, rootMargin: "300px 0px" }
  );
  wrap.querySelectorAll(".thumb").forEach((d) => thumbObserver.observe(d));
  updatePageCount();
}

// Rasterise one thumbnail into its (already-sized) canvas. Idempotent via the
// data-rendered guard so the observer + refreshThumb don't double-draw.
async function renderThumbCanvas(i) {
  const div = $("thumbs").querySelector(`.thumb[data-index="${i}"]`);
  if (!div || div.dataset.rendered === "1") return;
  div.dataset.rendered = "1";
  const canvas = div.querySelector("canvas");
  if (!canvas) return;
  try {
    const page = await state.pdf.getPage(i + 1); // cached by pdf.js after renderThumbs
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 150 / base.width });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  } catch (_) {
    div.dataset.rendered = "0"; // let it retry on the next intersection
  }
}

function updatePageCount() {
  const sel = state.selected.size;
  $("page-count").textContent =
    state.numPages + " trang" + (sel ? ` · ${sel} chọn` : "");
}

let pageObserver = null;
let keepObserver = null;

// Windowing: keep a page's rasterised bitmap only while it's within this many
// pixels of the viewport; past it the bitmap is released (and repainted on
// return). The gap above the render margin (500px) is hysteresis so a slow
// scroll back and forth across the edge doesn't thrash render↔free.
const KEEP_MARGIN_PX = 1500;

async function renderViewer() {
  const v = $("viewer");
  v.querySelectorAll(".page-wrap").forEach((e) => e.remove());
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  if (keepObserver) {
    keepObserver.disconnect();
    keepObserver = null;
  }
  const dpr = window.devicePixelRatio || 1;

  // Lazy render: create every page's wrapper + canvas at the correct CSS size up
  // front (cheap — the bitmap stays tiny until drawn), but defer the expensive
  // rasterisation until the page nears the viewport. Overlay editors read
  // canvas.style.* so they keep working before any pixels are drawn.
  const metas = [];
  for (let i = 0; i < state.numPages; i++) {
    const page = await state.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: state.scale });
    const cw = Math.floor(vp.width);
    const ch = Math.floor(vp.height);
    const canvas = document.createElement("canvas");
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.index = String(i);
    wrap.dataset.rendered = "0";
    wrap.appendChild(canvas);
    v.appendChild(wrap);
    metas[i] = { page, vp, cw, ch, canvas, wrap, dpr };
  }
  state.pageMetas = metas;

  // Start rendering ~500px before a page scrolls into view so it's usually ready
  // by the time it's visible.
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) renderPageCanvas(+e.target.dataset.index);
      }
    },
    { root: v, rootMargin: "500px 0px" }
  );
  // Second, wider band: once a page drifts past KEEP_MARGIN_PX its bitmap is
  // released so RAM stays flat regardless of page count. We keep observing with
  // pageObserver (no unobserve) so a released page is repainted when it returns.
  keepObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) freePageCanvas(+e.target.dataset.index);
      }
    },
    { root: v, rootMargin: KEEP_MARGIN_PX + "px 0px" }
  );
  metas.forEach((m) => {
    pageObserver.observe(m.wrap);
    keepObserver.observe(m.wrap);
  });

  // Draw the first page(s) immediately so the viewer is never blank on open.
  for (let i = 0; i < Math.min(2, metas.length); i++) await renderPageCanvas(i);

  // Let the overlay editor (P4) re-attach its annotation layers, if loaded.
  if (window.Editor) window.Editor.syncOverlays();
  // Let the native text editor (P6) re-place its span boxes, if active.
  if (window.TextEdit) window.TextEdit.syncOverlays();
}

// Rasterise one page into its (already-placed) canvas. Idempotent: the
// data-rendered guard stops the observer + sidebar-jump from double-drawing.
async function renderPageCanvas(i) {
  const m = state.pageMetas && state.pageMetas[i];
  if (!m || m.rendering || m.wrap.dataset.rendered === "1") return;
  m.wrap.dataset.rendered = "1";
  m.rendering = true; // guards against a concurrent free() while rasterising
  const { page, vp, cw, ch, canvas, dpr } = m;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  try {
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    await addTextLayer(i, m);  // selectable/​highlightable text for text-based pages
    await addNoteMarkers(i, m); // surface baked sticky-note comments (readable in-app)
    if (search.matches.length) drawSearchLayer(i); // repaint find highlights on (re)render
  } catch (_) {
    m.wrap.dataset.rendered = "0"; // let it retry on the next intersection
  } finally {
    m.rendering = false;
    // If the page scrolled far away while we were rasterising (fast fling), the
    // keepObserver's free event was skipped mid-render — reclaim the bitmap now.
    if (m.wrap.dataset.rendered === "1" && pageFarFromViewport(m.wrap)) freePageCanvas(i);
  }
}

// Release a page's backing bitmap — the dominant per-page RAM cost — when it
// scrolls out of the keep window. Only the canvas pixels are dropped; the wrap,
// its CSS size and every overlay layer (annotations, text, search, notes) stay,
// so scroll geometry and in-progress edits are untouched. renderPageCanvas
// repaints it idempotently when it scrolls back into view.
function freePageCanvas(i) {
  const m = state.pageMetas && state.pageMetas[i];
  if (!m || m.rendering || m.wrap.dataset.rendered !== "1") return;
  m.canvas.width = 0;
  m.canvas.height = 0; // frees the bitmap; canvas.style.* keeps the box sized
  m.wrap.dataset.rendered = "0";
}

// True when a page-wrap sits more than KEEP_MARGIN_PX above or below the viewport.
function pageFarFromViewport(wrap) {
  const v = $("viewer");
  if (!v) return false;
  const vr = v.getBoundingClientRect();
  const r = wrap.getBoundingClientRect();
  if (r.bottom < vr.top) return vr.top - r.bottom > KEEP_MARGIN_PX;
  if (r.top > vr.bottom) return r.top - vr.bottom > KEEP_MARGIN_PX;
  return false;
}

// Overlay a transparent, selectable pdf.js text layer on a page that has real
// (digital) text. Scanned pages return no text content → no layer (correct: you
// can't select pixels). Lets the user drag-select / Ctrl+F-style highlight like
// Foxit. The layer sits above the canvas but below the note markers; it's
// disabled (pointer-events:none) while annotating or text-editing so it never
// fights those tools. pdf.js 3.x positions spans via the `--scale-factor` var.
async function addTextLayer(i, m) {
  const { page, vp, wrap, canvas, cw, ch } = m;
  const existing = wrap.querySelector(".text-layer");
  if (existing) existing.remove();
  let tc;
  try {
    tc = await page.getTextContent();
  } catch (_) {
    return;
  }
  if (!tc || !tc.items || !tc.items.length) return; // scanned/empty page
  const layer = document.createElement("div");
  layer.className = "text-layer";
  layer.style.width = (parseFloat(canvas.style.width) || cw) + "px";
  layer.style.height = (parseFloat(canvas.style.height) || ch) + "px";
  layer.style.setProperty("--scale-factor", String(state.scale));
  try {
    await pdfjsLib.renderTextLayer({
      textContentSource: tc,
      container: layer,
      viewport: vp,
    }).promise;
  } catch (_) {
    return;
  }
  wrap.appendChild(layer);
}

// Baked notes (from the editor) are real PDF `Text` annotations — pdf.js paints
// the page canvas but NOT the annotation text, so in our own viewer the comment
// was invisible (only readable in Foxit/Acrobat). Place an invisible clickable
// hotspot over each one that reveals its text on hover/click.
async function addNoteMarkers(i, m) {
  const { page, vp, wrap, canvas, cw, ch } = m;
  const existing = wrap.querySelector(".note-layer");
  if (existing) existing.remove();
  let annots;
  try {
    annots = await page.getAnnotations();
  } catch (_) {
    return;
  }
  // pdf.js ≥3.x exposes a markup annotation's text as `contentsObj.str`
  // ({str, dir}); the old plain `contents` string was removed. Reading the old
  // field made `notes` always empty, so comments stayed invisible in our viewer.
  const noteText = (a) => (a.contentsObj && a.contentsObj.str) || a.contents || "";
  const notes = (annots || []).filter((a) => a.subtype === "Text" && noteText(a));
  if (!notes.length) return;
  const layer = document.createElement("div");
  layer.className = "note-layer";
  layer.style.width = (parseFloat(canvas.style.width) || cw) + "px";
  layer.style.height = (parseFloat(canvas.style.height) || ch) + "px";
  for (const an of notes) {
    const text = noteText(an);
    const r = vp.convertToViewportRectangle(an.rect);
    const x = Math.min(r[0], r[2]);
    const y = Math.min(r[1], r[3]);
    const el = document.createElement("div");
    el.className = "note-marker";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = Math.max(16, Math.abs(r[2] - r[0])) + "px";
    el.style.height = Math.max(16, Math.abs(r[3] - r[1])) + "px";
    el.title = text;
    el.onclick = (e) => {
      e.stopPropagation();
      showNotePopup(text, e.clientX, e.clientY);
    };
    layer.appendChild(el);
  }
  wrap.appendChild(layer);
}

// Floating reader for a sticky-note's text (Electron has no annotation UI).
function showNotePopup(text, cx, cy) {
  let pop = $("note-popup");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "note-popup";
    pop.className = "note-popup";
    document.body.appendChild(pop);
    document.addEventListener("mousedown", (e) => {
      if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.classList.contains("note-marker")) {
        pop.hidden = true;
      }
    });
  }
  pop.textContent = text;
  pop.hidden = false;
  pop.style.left = Math.min(cx + 8, window.innerWidth - 280) + "px";
  pop.style.top = Math.min(cy + 8, window.innerHeight - 140) + "px";
}

// ---- find in document (Ctrl+F) -------------------------------------------

// Fold to a case- AND diacritic-insensitive form so "dieu khoan" finds "Điều
// khoản" (very handy when typing Vietnamese without dấu). NFD splits the base
// letter from its combining marks, which we strip; đ/Đ don't decompose so they're
// mapped by hand.
function foldText(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

// Build (once per loaded document) each page's text runs with the geometry needed
// to draw highlight boxes: pdf.js text items carry `transform` (baseline origin in
// unscaled PDF space) and `width` (advance, unscaled), which we project per zoom.
async function ensureSearchIndex() {
  if (search.docItems && search.docToken === state.pdf) return search.docItems;
  const docItems = [];
  for (let i = 0; i < state.numPages; i++) {
    const page =
      (state.pageMetas && state.pageMetas[i] && state.pageMetas[i].page) ||
      (await state.pdf.getPage(i + 1));
    let tc;
    try {
      tc = await page.getTextContent();
    } catch (_) {
      tc = { items: [] };
    }
    const items = [];
    for (const it of tc.items || []) {
      if (typeof it.str !== "string" || !it.str) continue;
      items.push({ folded: foldText(it.str), transform: it.transform, width: it.width });
    }
    docItems.push(items);
  }
  search.docItems = docItems;
  search.docToken = state.pdf;
  return docItems;
}

async function runSearch(q) {
  search.query = q || "";
  const matches = [];
  const fq = foldText((q || "").trim());
  if (fq) {
    const docItems = await ensureSearchIndex();
    for (let i = 0; i < docItems.length; i++) {
      for (const it of docItems[i]) {
        const hay = it.folded;
        const L = hay.length || 1;
        let from = 0;
        let idx;
        while ((idx = hay.indexOf(fq, from)) !== -1) {
          matches.push({
            page: i,
            transform: it.transform,
            width: it.width,
            fracStart: idx / L,
            fracEnd: (idx + fq.length) / L,
          });
          from = idx + Math.max(1, fq.length);
        }
      }
    }
  }
  search.matches = matches;
  search.current = matches.length ? 0 : -1;
  // Repaint highlights on every page already on screen.
  if (state.pageMetas) {
    for (let i = 0; i < state.numPages; i++) {
      if (state.pageMetas[i].wrap.dataset.rendered === "1") drawSearchLayer(i);
    }
  }
  updateFindCount();
  if (search.current >= 0) await gotoMatch(0);
  $("find-input").classList.toggle("no-hit", !!fq && !matches.length);
}

// Paint (or clear) the highlight boxes for one page from the current matches.
function drawSearchLayer(i) {
  const m = state.pageMetas && state.pageMetas[i];
  if (!m) return;
  const { wrap, vp, canvas, cw, ch } = m;
  const old = wrap.querySelector(".search-layer");
  if (old) old.remove();
  const here = [];
  for (let gi = 0; gi < search.matches.length; gi++) {
    if (search.matches[gi].page === i) here.push(gi);
  }
  if (!here.length) return;
  const layer = document.createElement("div");
  layer.className = "search-layer";
  layer.style.width = (parseFloat(canvas.style.width) || cw) + "px";
  layer.style.height = (parseFloat(canvas.style.height) || ch) + "px";
  for (const gi of here) {
    const mt = search.matches[gi];
    const tx = pdfjsLib.Util.transform(vp.transform, mt.transform);
    const fontH = Math.hypot(tx[2], tx[3]);
    const wdev = mt.width * vp.scale;
    const el = document.createElement("div");
    el.className = "search-hl" + (gi === search.current ? " current" : "");
    el.dataset.mi = String(gi);
    el.style.left = tx[4] + mt.fracStart * wdev + "px";
    el.style.top = tx[5] - fontH + "px";
    el.style.width = Math.max(2, (mt.fracEnd - mt.fracStart) * wdev) + "px";
    el.style.height = fontH + "px";
    layer.appendChild(el);
  }
  wrap.appendChild(layer);
}

// Move to the n-th match (wraps around), rendering its page if needed, then
// scroll the highlight into view and mark it as current.
async function gotoMatch(idx) {
  const n = search.matches.length;
  if (!n) return;
  search.current = ((idx % n) + n) % n;
  const page = search.matches[search.current].page;
  await renderPageCanvas(page); // no-op if already drawn; also (re)draws its layer
  drawSearchLayer(page);
  document.querySelectorAll(".search-hl.current").forEach((e) => e.classList.remove("current"));
  const el = document.querySelector(`.search-layer .search-hl[data-mi="${search.current}"]`);
  if (el) {
    el.classList.add("current");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    scrollToPage(page);
  }
  updateFindCount();
}

function updateFindCount() {
  const c = $("find-count");
  if (c) c.textContent = search.matches.length ? `${search.current + 1}/${search.matches.length}` : "0/0";
}

// The find box lives permanently in the toolbar; Ctrl+F just focuses it.
function openFind() {
  if (!state.pdf) return;
  const inp = $("find-input");
  inp.focus();
  inp.select();
  if (inp.value.trim()) runSearch(inp.value);
}

// Escape (or a fresh document) clears the query + highlights but leaves the box
// in place — it's part of the toolbar now, not a dismissible popover.
function closeFind() {
  const inp = $("find-input");
  if (inp) {
    inp.value = "";
    inp.classList.remove("no-hit");
    inp.blur();
  }
  search.matches = [];
  search.current = -1;
  search.query = "";
  document.querySelectorAll(".search-layer").forEach((e) => e.remove());
  updateFindCount();
}

// Re-render after an in-place edit (overlay bake / native text edit) WITHOUT the
// full-document teardown `renderAll` does. The bytes changed so pdf.js must reload
// the document, but baking never changes the page count — so we keep the existing
// page-wrap DOM + every unchanged page's bitmap, and only repaint the pages whose
// pixels actually changed. `changed` is a Set of 0-based indices (null = all).
async function rerenderChanged(changed) {
  if (!state.pageMetas || !state.pdf) return renderAll();
  showOverlay("Đang cập nhật trang…");
  try {
    try { await state.pdf.destroy(); } catch (_) {}
    const task = pdfjsLib.getDocument({ data: state.bytes.slice(), isEvalSupported: false });
    state.pdf = await withTimeout(task.promise, 25000, "Tải PDF quá lâu.");
    // Page count shifted (shouldn't for bake/edit) → safest to do the full path.
    if (state.pdf.numPages !== state.numPages) {
      hideOverlay();
      return renderAll();
    }
    for (let i = 0; i < state.numPages; i++) {
      const m = state.pageMetas[i];
      const wasRendered = m.wrap.dataset.rendered === "1";
      m.page = await state.pdf.getPage(i + 1); // refresh ref so later lazy redraws use new doc
      m.vp = m.page.getViewport({ scale: state.scale });
      if (changed && !changed.has(i)) continue; // unchanged: keep its bitmap as-is
      m.wrap.dataset.rendered = "0";
      // Repaint only pages that were on screen (within the window). Off-screen
      // changed pages keep the refreshed m.page and lazy-repaint when scrolled
      // to — this is what stops a watermark-all (changed=null) from rasterising
      // every page of a large document at once.
      if (wasRendered) await renderPageCanvas(i);
      await refreshThumb(i);
    }
    if (window.Editor) window.Editor.syncOverlays();
    if (window.TextEdit) window.TextEdit.syncOverlays();
  } finally {
    hideOverlay();
  }
}

// Repaint a single thumbnail in place (used by the targeted re-render above).
async function refreshThumb(i) {
  const div = $("thumbs").querySelector(`.thumb[data-index="${i}"]`);
  if (!div) return;
  div.dataset.rendered = "0"; // force a repaint of the (possibly stale) thumbnail
  await renderThumbCanvas(i);
}

function scrollToPage(i) {
  // Eager-render the jump target so a sidebar click feels instant instead of
  // waiting for the observer to catch up.
  renderPageCanvas(i);
  const el = $("viewer").querySelector(`.page-wrap[data-index="${i}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshSelectionUI() {
  document.querySelectorAll(".thumb").forEach((d) => {
    const idx = +d.dataset.index;
    d.classList.toggle("selected", state.selected.has(idx));
    const c = d.querySelector(".thumb-check");
    if (c) c.checked = state.selected.has(idx);
  });
  updatePageCount();
}

// ---- thumbnail interaction (select + drag reorder) -----------------------

function wireThumb(div) {
  const i = +div.dataset.index;

  // Checkbox = explicit multi-select (no modifier key needed).
  const check = div.querySelector(".thumb-check");
  if (check) {
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) state.selected.add(i);
      else state.selected.delete(i);
      state.lastClicked = i;
      refreshSelectionUI();
      updateToolbar();
    });
  }

  div.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey) {
      state.selected.has(i) ? state.selected.delete(i) : state.selected.add(i);
    } else if (e.shiftKey && state.lastClicked != null) {
      const [a, b] = [state.lastClicked, i].sort((x, y) => x - y);
      state.selected.clear();
      for (let k = a; k <= b; k++) state.selected.add(k);
    } else {
      state.selected.clear();
      state.selected.add(i);
      scrollToPage(i);
    }
    state.lastClicked = i;
    refreshSelectionUI();
    updateToolbar();
  });

  div.addEventListener("dragstart", (e) => {
    state.dragSrc = i;
    div.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Mark as an internal move so the window file-drop handler ignores it.
    e.dataTransfer.setData("application/x-thumb", String(i));
  });
  div.addEventListener("dragend", () => div.classList.remove("dragging"));
  // Drop targets: internal reorder (state.dragSrc set) OR an external PDF file
  // dragged from the OS. For files we pick the gap above/below the hovered thumb
  // by cursor position so the user drops "between" pages, like reorder.
  const clearCues = () =>
    div.classList.remove("drag-over", "insert-before", "insert-after");
  const fileDrag = (e) =>
    e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  div.addEventListener("dragover", (e) => {
    if (fileDrag(e)) {
      e.preventDefault();
      e.stopPropagation(); // keep the window "open fresh" handler from firing
      e.dataTransfer.dropEffect = "copy";
      const r = div.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      div.classList.toggle("insert-after", after);
      div.classList.toggle("insert-before", !after);
      return;
    }
    if (state.dragSrc == null) return;
    e.preventDefault();
    div.classList.add("drag-over");
  });
  div.addEventListener("dragleave", clearCues);
  div.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearDropCue(); // stopPropagation hides this drop from the window handler
    if (fileDrag(e)) {
      const r = div.getBoundingClientRect();
      const at = e.clientY > r.top + r.height / 2 ? i + 1 : i;
      clearCues();
      const buffers = [];
      for (const f of e.dataTransfer.files) {
        if (f.name.toLowerCase().endsWith(".pdf"))
          buffers.push(new Uint8Array(await f.arrayBuffer()));
      }
      if (buffers.length) await insertBuffersAt(buffers, at);
      return;
    }
    clearCues();
    const from = state.dragSrc;
    const to = i;
    state.dragSrc = null;
    if (from != null && from !== to) reorderPage(from, to);
  });
}

// ---- structural operations (pdf-lib) -------------------------------------

async function reorderPage(from, to) {
  const order = [...Array(state.numPages).keys()];
  const [m] = order.splice(from, 1);
  order.splice(to, 0, m);
  showOverlay("Đang sắp xếp…");
  pushUndo();
  try {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, order);
    pages.forEach((p) => out.addPage(p));
    state.bytes = await out.save();
    state.selected = new Set([order.indexOf(from)]);
    await renderAll();
  } finally {
    hideOverlay();
  }
}

async function rotateSelected(delta) {
  if (state.selected.size === 0) return;
  showOverlay("Đang xoay…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    const pages = doc.getPages();
    for (const i of state.selected) {
      const p = pages[i];
      const cur = p.getRotation().angle;
      p.setRotation(degrees((((cur + delta) % 360) + 360) % 360));
    }
    state.bytes = await doc.save();
    await renderAll();
  } finally {
    hideOverlay();
  }
}

async function deleteSelected() {
  if (state.selected.size === 0) {
    toast("Tick chọn trang cần xóa trước.", "bad");
    return;
  }
  if (state.selected.size >= state.numPages) {
    toast("Không thể xóa tất cả trang.", "bad");
    return;
  }
  showOverlay("Đang xóa…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    [...state.selected].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
    state.bytes = await doc.save();
    state.selected.clear();
    await renderAll();
  } finally {
    hideOverlay();
  }
}

// Modal position picker shared by Merge + Insert. Resolves to a 0-based insertion
// index (0 = before page 1, numPages = after the last page), or null if cancelled.
function choosePosition(title) {
  return new Promise((resolve) => {
    const modal = $("pos-modal");
    const mode = $("pos-mode");
    const afterRow = $("pos-after-row");
    const afterInp = $("pos-after");
    $("pos-title").textContent = title;
    afterInp.max = String(state.numPages);
    // Default to "after the currently-selected page" when a page is selected.
    if (state.selected.size) {
      mode.value = "after";
      afterInp.value = String(Math.max(...state.selected) + 1);
    } else {
      mode.value = "end";
    }
    const syncRow = () => {
      afterRow.hidden = mode.value !== "after";
      $("pos-hint").textContent = `Tài liệu hiện có ${state.numPages} trang.`;
    };
    syncRow();
    mode.onchange = syncRow;
    modal.hidden = false;
    const done = (val) => {
      modal.hidden = true;
      mode.onchange = null;
      $("pos-ok").onclick = null;
      $("pos-cancel").onclick = null;
      resolve(val);
    };
    $("pos-cancel").onclick = () => done(null);
    $("pos-ok").onclick = () => {
      if (mode.value === "start") return done(0);
      if (mode.value === "end") return done(state.numPages);
      const n = Math.min(state.numPages, Math.max(1, parseInt(afterInp.value, 10) || 1));
      done(n); // "after page n" (1-based) → insertion index n
    };
  });
}

// Describe an insertion index for toast feedback.
function posLabel(at) {
  if (at <= 0) return "vào đầu tài liệu";
  if (at >= state.numPages) return "vào cuối tài liệu";
  return "sau trang " + at;
}

async function mergeFiles() {
  if (gateProFeature()) return;
  const files = await window.desktop.openPdf({ multi: true });
  if (!files.length) return;
  const at = await choosePosition("Ghép PDF — chọn vị trí");
  if (at == null) return; // cancelled
  const where = posLabel(at);
  showOverlay("Đang ghép…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    let pos = at;
    let added = 0;
    for (const f of files) {
      const other = await PDFDocument.load(toU8(f.data));
      const pages = await doc.copyPages(other, other.getPageIndices());
      pages.forEach((p) => doc.insertPage(pos++, p));
      added += pages.length;
    }
    state.bytes = await doc.save();
    state.selected = new Set([at]); // land on the first merged page
    await renderAll();
    toast(`Đã ghép ${files.length} file (+${added} trang) ${where}.`, "good");
  } finally {
    hideOverlay();
  }
}

async function insertFile() {
  if (gateProFeature()) return;
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
  const at = await choosePosition("Chèn trang — chọn vị trí");
  if (at == null) return; // cancelled
  await insertBuffersAt([toU8(files[0].data)], at);
}

// Core insert shared by the picker (insertFile) and drag-drop onto the thumbnail
// strip. `buffers` = list of PDF byte arrays inserted in order at index `at`.
async function insertBuffersAt(buffers, at) {
  if (gateProFeature()) return; // also covers drag-drop onto the thumbnail strip
  if (!state.bytes || !buffers.length) return;
  const where = posLabel(at);
  showOverlay("Đang chèn…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    let pos = at;
    let added = 0;
    for (const b of buffers) {
      const other = await PDFDocument.load(b);
      const pages = await doc.copyPages(other, other.getPageIndices());
      pages.forEach((p) => doc.insertPage(pos++, p));
      added += pages.length;
    }
    state.bytes = await doc.save();
    state.selected = new Set([at]); // land on the first inserted page
    await renderAll();
    toast(`Đã chèn ${added} trang ${where}.`, "good");
  } finally {
    hideOverlay();
  }
}

async function addBlankPage() {
  if (gateProFeature()) return;
  if (!state.bytes) return;
  const at = await choosePosition("Thêm trang trắng — chọn vị trí");
  if (at == null) return; // cancelled
  const where = posLabel(at);
  showOverlay("Đang thêm trang trắng…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    // Size the blank page like the page it follows so it blends in (fallback A4).
    const pages = doc.getPages();
    const refIdx = Math.min(Math.max(at - 1, 0), pages.length - 1);
    const ref = pages[refIdx];
    const size = ref ? ref.getSize() : { width: 595.28, height: 841.89 };
    doc.insertPage(at, [size.width, size.height]);
    state.bytes = await doc.save();
    state.selected = new Set([at]); // land on the new blank page
    await renderAll();
    toast(`Đã thêm 1 trang trắng ${where}.`, "good");
  } finally {
    hideOverlay();
  }
}

async function extractSelected() {
  if (gateProFeature()) return;
  if (state.selected.size === 0) {
    toast("Chọn ít nhất 1 trang để tách.", "bad");
    return;
  }
  const order = [...state.selected].sort((a, b) => a - b);
  showOverlay("Đang tách…");
  try {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, order);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    const name = `${baseName(state.name)}-trang-${order.map((i) => i + 1).join("_")}.pdf`;
    const res = await window.desktop.savePdf(bytes, name);
    if (res.saved) toast("Đã lưu: " + res.path, "good");
  } finally {
    hideOverlay();
  }
}

// Save: write silently to the document's existing path; prompt (Save As) only
// when it has none (drag-dropped / never-saved doc) or a silent write fails.
async function saveDoc() {
  if (!state.bytes) return;
  if (window.Editor) await window.Editor.bakePending();
  if (state.path) {
    const res = await window.desktop.writePdf(state.path, state.bytes);
    if (res.saved) {
      toast("Đã lưu: " + res.path, "good");
      return;
    }
    if (res.error) toast("Lưu lỗi: " + res.error + " — chọn nơi lưu khác.", "bad");
  }
  await saveAsDoc();
}

// Save As: always prompt, then adopt the chosen path as the document's location.
async function saveAsDoc() {
  if (!state.bytes) return;
  if (window.Editor) await window.Editor.bakePending();
  const res = await window.desktop.savePdf(state.bytes, state.name);
  if (res.saved) {
    state.path = res.path;
    state.name = res.path.split(/[\\/]/).pop() || state.name;
    renderBreadcrumb();
    toast("Đã lưu: " + res.path, "good");
  }
}

// ---- print ---------------------------------------------------------------

// Print the current document. We rasterise every page with pdf.js into a
// print-only container of <img>s, then call window.print() (which Electron maps
// to the OS print dialog — printer, range, copies). This is deliberately NOT
// done by loading the PDF into a hidden BrowserWindow and calling
// webContents.print(): Chromium renders PDFs in a PDFium *plugin* frame that the
// host page's print path doesn't capture, so that route prints a blank page.
// Rasterising to real DOM images prints reliably (same approach pdf.js viewers
// use for print). ~150 DPI keeps text crisp without exploding memory.
const PRINT_DPI = 150;
let printing = false;

function ensurePrintRoot() {
  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.appendChild(root);
  }
  return root;
}

function clearPrintPages() {
  const root = document.getElementById("print-root");
  if (root) root.innerHTML = "";
}

// Render each page of the canonical bytes into #print-root as a full-page image.
async function buildPrintPages() {
  const root = ensurePrintRoot();
  root.innerHTML = "";
  // Copy the bytes: pdf.js may transfer/neuter the buffer it's handed, and
  // state.bytes must stay intact for the live viewer / saving.
  const doc = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
  try {
    const scale = PRINT_DPI / 72;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale }); // honours page rotation
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const img = document.createElement("img");
      img.className = "print-page";
      img.src = canvas.toDataURL("image/png");
      root.appendChild(img);
      // Ensure the image is actually decoded before we hand off to the print
      // dialog — otherwise the sheet can come out blank. decode() may reject on
      // some engines; fall back to a load event / small wait.
      try {
        await img.decode();
      } catch (_) {
        await new Promise((r) => {
          img.onload = img.onerror = r;
          setTimeout(r, 500);
        });
      }
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
}

// Prepare the print images, then open the Print Options dialog. Actual printing
// happens in runPrint() (main-process webContents.print with the chosen options).
async function printDoc() {
  if (!state.bytes || printing) return;
  printing = true;
  try {
    if (window.Editor) await window.Editor.bakePending();
    showOverlay(t("Đang chuẩn bị in…"));
    await buildPrintPages();
    await populatePrinters();
    hideOverlay();
    $("print-modal").hidden = false;
  } catch (e) {
    hideOverlay();
    clearPrintPages();
    toast(t("In lỗi:") + " " + (e && e.message ? e.message : e), "bad");
  } finally {
    printing = false;
  }
}

// Fill the printer dropdown; preselect the system default.
async function populatePrinters() {
  const sel = $("print-printer");
  if (!sel || !window.desktop.getPrinters) return;
  let printers = [];
  try {
    printers = (await window.desktop.getPrinters()) || [];
  } catch (_) {}
  sel.innerHTML = "";
  if (!printers.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = t("Máy in mặc định");
    sel.appendChild(o);
    return;
  }
  for (const p of printers) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.displayName || p.name;
    if (p.isDefault) o.selected = true;
    sel.appendChild(o);
  }
}

function closePrintModal() {
  $("print-modal").hidden = true;
  clearPrintPages();
}

// Print the prepared images with the options chosen in the dialog.
async function runPrint() {
  const opts = {
    deviceName: $("print-printer") ? $("print-printer").value : "",
    pageSize: $("print-size") ? $("print-size").value : "A4",
    duplexMode: $("print-duplex") ? $("print-duplex").value : "simplex",
    landscape: $("print-orient") ? $("print-orient").value === "landscape" : false,
    copies: $("print-copies") ? parseInt($("print-copies").value, 10) || 1 : 1,
    systemDialog: $("print-system-dialog") ? $("print-system-dialog").checked : false,
  };
  $("print-modal").hidden = true;
  try {
    const res = await window.desktop.printPage(opts);
    if (res && res.ok) {
      toast(t("Đã gửi lệnh in."), "good");
    } else if (res && res.reason && !/cancel/i.test(String(res.reason))) {
      toast(t("In lỗi:") + " " + res.reason, "bad");
    }
  } catch (e) {
    toast(t("In lỗi:") + " " + (e && e.message ? e.message : e), "bad");
  } finally {
    clearPrintPages();
  }
}

// ---- zoom ----------------------------------------------------------------

let zooming = false;

// Reflect state.scale in the editable zoom box (unless the user is mid-typing).
function syncZoomInput() {
  const z = $("zoom-input");
  if (z && document.activeElement !== z) z.value = Math.round(state.scale * 100) + "%";
}

// Zoom to an absolute scale. `anchor` = client {x,y} to keep visually fixed
// (Ctrl+wheel zooms toward the cursor); defaults to the viewer centre.
async function zoomTo(next, anchor) {
  if (zooming || !state.bytes) return;
  next = Math.min(3, Math.max(0.4, +(+next).toFixed(2)));
  if (!next || next === state.scale) {
    syncZoomInput();
    return;
  }
  const v = $("viewer");
  const r = v.getBoundingClientRect();
  const ax = anchor ? anchor.x - r.left : r.width / 2;
  const ay = anchor ? anchor.y - r.top : r.height / 2;
  const ratio = next / state.scale;
  const sl = v.scrollLeft;
  const st = v.scrollTop;
  state.scale = next;
  syncZoomInput();
  zooming = true;
  try {
    await renderViewer();
    // Keep the document point that was under the anchor in place.
    v.scrollLeft = (sl + ax) * ratio - ax;
    v.scrollTop = (st + ay) * ratio - ay;
  } finally {
    zooming = false;
  }
}

async function zoom(delta) {
  await zoomTo(state.scale + delta);
}

// Reset zoom to 100% (Ctrl+0).
async function zoomReset() {
  await zoomTo(1);
}

// Fit the widest page to the viewer width (like the compare view).
async function fitWidth() {
  if (!state.bytes || !state.pageMetas || !state.pageMetas.length) return;
  let maxW1 = 0; // widest page at scale 1
  for (const m of state.pageMetas) maxW1 = Math.max(maxW1, m.vp.width / state.scale);
  if (!maxW1) return;
  const pad = 48; // page margins + scrollbar allowance
  await zoomTo(($("viewer").clientWidth - pad) / maxW1);
}

// Parse whatever is in the zoom box ("150", "150%", " 150 ") and apply it.
function applyZoomInput() {
  const n = parseInt(($("zoom-input").value || "").replace(/[^\d]/g, ""), 10);
  if (!n) {
    syncZoomInput();
    return;
  }
  zoomTo(n / 100);
}

// ---- OCR + field extraction (sidecar; P2) --------------------------------

let templatesLoaded = false;
let lastLabels = {}; // field key -> header, from the last extraction

// Rasterize the given page indices to base64 PNGs for the OCR backend.
async function rasterize(indices, scale = 2) {
  const imgs = [];
  const nums = [];
  for (const i of indices) {
    const page = await state.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    imgs.push(c.toDataURL("image/png").split(",")[1]);
    nums.push(i + 1);
  }
  return { imgs, nums };
}

async function loadTemplates() {
  if (templatesLoaded || sidecar.state !== "ready" || !sidecar.base) return;
  try {
    const res = await sidecarFetch("/templates");
    const data = await res.json();
    const sel = $("ext-template");
    sel.innerHTML = "";
    (data.templates || []).forEach((t) => {
      const o = document.createElement("option");
      o.value = t.name;
      o.textContent = t.label;
      sel.appendChild(o);
    });
    const co = document.createElement("option");
    co.value = "custom";
    co.textContent = "Tùy chỉnh…";
    sel.appendChild(co);
    templatesLoaded = true;
  } catch (_) {
    /* sidecar may not be ready; retry on next open */
  }
}

const CUSTOM_FIELDS_KEY = "ext.customFields";

// Turn a Vietnamese label into a safe JSON key: strip diacritics, non-word -> _.
function slugifyField(label) {
  const base = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "truong";
}

function addCustomFieldRow(value = "") {
  const rows = $("ext-custom-rows");
  const row = document.createElement("div");
  row.className = "ext-custom-row";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "Ví dụ: Số tài khoản ngân hàng";
  inp.value = value;
  inp.addEventListener("input", saveCustomFields);
  const del = document.createElement("button");
  del.className = "link";
  del.textContent = "✕";
  del.title = "Xóa trường";
  del.onclick = () => {
    row.remove();
    if (!$("ext-custom-rows").children.length) addCustomFieldRow();
    saveCustomFields();
  };
  row.appendChild(inp);
  row.appendChild(del);
  rows.appendChild(row);
  return inp;
}

function customFieldLabels() {
  return [...document.querySelectorAll("#ext-custom-rows input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

// Build {key: label} for the backend; de-duplicate keys with a numeric suffix.
function buildCustomFields() {
  const out = {};
  const seen = {};
  for (const label of customFieldLabels()) {
    let key = slugifyField(label);
    if (seen[key]) key = `${key}_${++seen[key]}`;
    else seen[key] = 1;
    out[key] = label;
  }
  return out;
}

function saveCustomFields() {
  try {
    localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(customFieldLabels()));
  } catch (_) {}
}

function loadCustomFields() {
  let labels = [];
  try {
    labels = JSON.parse(localStorage.getItem(CUSTOM_FIELDS_KEY) || "[]");
  } catch (_) {}
  $("ext-custom-rows").innerHTML = "";
  if (labels.length) labels.forEach((l) => addCustomFieldRow(l));
  else addCustomFieldRow();
}

function syncCustomPanel() {
  const isCustom = $("ext-template").value === "custom";
  $("ext-custom").hidden = !isCustom;
  if (isCustom && !$("ext-custom-rows").children.length) loadCustomFields();
}

function openExtractPanel() {
  if (gateProFeature()) return;
  $("ext-panel").hidden = false;
  loadTemplates();
}

async function runExtract() {
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine OCR chưa sẵn sàng.", "bad");
    return;
  }
  if (!state.bytes) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  const scope = $("ext-scope").value;
  let indices;
  if (scope === "selected") {
    indices = [...state.selected].sort((a, b) => a - b);
    if (!indices.length) {
      toast("Chưa tick chọn trang nào.", "bad");
      return;
    }
  } else {
    indices = [...Array(state.numPages).keys()];
  }
  if (indices.length > 50) {
    toast("Tối đa 50 trang mỗi lần bóc tách.", "bad");
    return;
  }
  const template = $("ext-template").value || "default";
  const body = { };
  if (template === "custom") {
    const customFields = buildCustomFields();
    if (!Object.keys(customFields).length) {
      toast("Chưa khai báo trường tùy chỉnh nào.", "bad");
      return;
    }
    body.custom_fields = customFields;
  } else {
    body.template = template;
  }
  showOverlay(`Đang OCR + bóc tách ${indices.length} trang…`);
  try {
    const { imgs, nums } = await rasterize(indices);
    const res = await sidecarFetch("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: imgs, page_numbers: nums, ...body }),
    });
    const data = await res.json();
    if (!data.success) {
      $("ext-raw-out").textContent = data.full_text || "";
      toast("Bóc tách lỗi: " + data.error, "bad");
      return;
    }
    renderExtract(data);
    toast("Bóc tách xong.", "good");
  } catch (err) {
    toast("Lỗi bóc tách: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

function renderExtract(data) {
  lastLabels = data.field_labels || {};
  const cl = data.classification || {};
  $("ext-class").textContent = cl.loai_van_ban
    ? `Loại: ${cl.loai_van_ban}${cl.do_tin_cay ? " · tin cậy: " + cl.do_tin_cay : ""}`
    : "";

  const box = $("ext-fields");
  box.innerHTML = "";
  const fields = data.fields || {};
  const keys = [
    ...Object.keys(lastLabels),
    ...Object.keys(fields).filter((k) => !(k in lastLabels)),
  ];
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "ext-row";
    const lab = document.createElement("label");
    lab.textContent = lastLabels[k] || k;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.dataset.key = k;
    const v = fields[k];
    inp.value = v == null ? "" : String(v);
    row.appendChild(lab);
    row.appendChild(inp);
    box.appendChild(row);
  }
  $("ext-raw-out").textContent = data.full_text || "";
  $("ext-export").hidden = keys.length === 0;
}

async function runExport(fmt) {
  const inputs = [...document.querySelectorAll("#ext-fields input")];
  if (!inputs.length) {
    toast("Chưa có dữ liệu để xuất.", "bad");
    return;
  }
  const record = {};
  inputs.forEach((i) => (record[i.dataset.key] = i.value));
  showOverlay("Đang xuất…");
  try {
    const res = await sidecarFetch("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [record],
        field_labels: lastLabels,
        format: fmt,
        source_file: state.name,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Xuất lỗi: " + data.error, "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const ext = fmt === "excel" ? "xlsx" : fmt;
    const r = await window.desktop.saveFile(bytes, data.filename, [
      { name: fmt.toUpperCase(), extensions: [ext] },
    ]);
    if (r.saved) toast("Đã lưu: " + r.path, "good");
  } catch (err) {
    toast("Lỗi xuất: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// ---- searchable PDF (sidecar; P3) ----------------------------------------

// Encode a Uint8Array to base64 without blowing the call stack on big PDFs.
function u8ToB64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function makeSearchable() {
  if (gateProFeature()) return;
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine OCR chưa sẵn sàng.", "bad");
    return;
  }
  if (!state.bytes) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  if (window.Editor) await window.Editor.bakePending();
  showOverlay("Đang OCR tạo lớp text tìm kiếm… (tài liệu nhiều trang sẽ lâu)");
  try {
    const res = await sidecarFetch("/searchable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes) }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tạo searchable lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-searchable.pdf`;
    const r = await window.desktop.savePdf(bytes, name);
    if (r.saved) {
      const skip = data.skipped_pages
        ? ` · bỏ qua ${data.skipped_pages} trang đã có text`
        : "";
      toast(`Đã lưu PDF tìm-kiếm-được (OCR ${data.ocr_pages || 0} trang, ${data.words} cụm text${skip}): ` + r.path, "good");
    }
  } catch (err) {
    toast("Lỗi tạo searchable: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// ---- translate PDF (sidecar + Gemini; keep layout, new file) -------------

function openTranslate() {
  if (gateProFeature()) return;
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine chưa sẵn sàng.", "bad");
    return;
  }
  if (!state.bytes) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  // "Selected pages" only makes sense when a selection exists; default to all.
  const sc = $("tr-scope");
  const selOpt = sc && sc.querySelector('option[value="selected"]');
  if (selOpt) selOpt.disabled = state.selected.size === 0;
  if (sc && state.selected.size === 0) sc.value = "all";
  $("tr-modal").hidden = false;
}

async function runTranslate() {
  $("tr-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();

  const target = $("tr-tgt").value || "en";
  const source = $("tr-src").value || "auto";
  const scopeKind = $("tr-scope").value || "all";
  const keepNumbers = $("tr-keep-numbers").checked;

  let scope = "all";
  if (scopeKind === "selected" && state.selected.size > 0) {
    scope = Array.from(state.selected).sort((a, b) => a - b);
  }

  showOverlay("Đang dịch bằng AI… (tài liệu nhiều trang sẽ lâu)");
  try {
    const res = await sidecarFetch("/translate-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_b64: u8ToB64(state.bytes),
        source_lang: source,
        target_lang: target,
        scope,
        keep_numbers: keepNumbers,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      const msg = data.is_scan
        ? "PDF này là bản scan (không có text thật) — tính năng dịch giữ layout chỉ hỗ trợ PDF có text. Hãy chạy Searchable/OCR trước."
        : "Dịch lỗi: " + (data.error || data.detail || "không rõ");
      toast(msg, "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-dich-${target}.pdf`;
    const r = await window.desktop.savePdf(bytes, name);
    if (r.saved) {
      toast(
        `Đã dịch ${data.blocks_translated || 0} đoạn trên ${data.pages_changed || 0} trang → ${r.path}`,
        "good",
      );
    }
  } catch (err) {
    toast("Lỗi dịch: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// ---- compress PDF (sidecar; P3) ------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function openCompress() {
  if (gateProFeature()) return;
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine chưa sẵn sàng.", "bad");
    return;
  }
  if (!state.bytes) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  $("cmp-modal").hidden = false;
}

async function runCompress() {
  $("cmp-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  const preset = $("cmp-preset").value || "ebook";
  showOverlay("Đang nén PDF…");
  try {
    const res = await sidecarFetch("/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes), preset }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Nén lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const pct = data.original_size
      ? Math.round((100 * data.compressed_size) / data.original_size)
      : 100;
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-nen.pdf`;
    const r = await window.desktop.savePdf(bytes, name);
    if (r.saved) {
      const msg = `Đã nén: ${fmtBytes(data.original_size)} → ${fmtBytes(data.compressed_size)} (${pct}%)`;
      toast(pct >= 100 ? "Không giảm thêm được — đã lưu bản gốc tối ưu." : msg, "good");
    }
  } catch (err) {
    toast("Lỗi nén: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// ---- P7: convert tools (lock / extract images / image↔pdf) ---------------
//
// All four share the established sidecar pattern: bake pending edits, POST to a
// PyMuPDF endpoint, then save the returned bytes via a native dialog. PDF outputs
// use savePdf; image bundles come back as a .zip saved via saveFile.

// Guard shared by every convert tool: pro-gate + engine-ready + a doc is open.
function convertReady(needDoc = true) {
  if (gateProFeature()) return false;
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine chưa sẵn sàng.", "bad");
    return false;
  }
  if (needDoc && !state.bytes) {
    toast("Mở PDF trước.", "bad");
    return false;
  }
  return true;
}

// --- lock PDF (set password) ---
function openEncrypt() {
  if (!convertReady()) return;
  $("enc-pw").value = "";
  $("enc-pw2").value = "";
  $("enc-pw").type = "password";
  $("enc-modal").hidden = false;
  $("enc-pw").focus();
}

async function runEncrypt() {
  const pw = $("enc-pw").value;
  const pw2 = $("enc-pw2").value;
  if (!pw) {
    toast("Nhập mật khẩu trước.", "bad");
    return;
  }
  if (pw !== pw2) {
    toast("Hai lần nhập mật khẩu không khớp.", "bad");
    return;
  }
  $("enc-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  showOverlay("Đang khoá file…");
  try {
    const res = await sidecarFetch("/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_b64: u8ToB64(state.bytes),
        user_password: pw,
        allow_print: $("enc-print").checked,
        allow_copy: $("enc-copy").checked,
        allow_modify: $("enc-modify").checked,
        allow_annotate: $("enc-annotate").checked,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Khoá file lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-locked.pdf`;
    const r = await window.desktop.savePdf(bytes, name);
    if (r.saved) toast("Đã khoá file bằng mật khẩu: " + r.path, "good");
  } catch (err) {
    toast("Lỗi khoá file: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- extract embedded images → zip ---
async function extractImages() {
  if (!convertReady()) return;
  if (window.Editor) await window.Editor.bakePending();
  showOverlay("Đang tìm và trích ảnh trong PDF…");
  try {
    const res = await sidecarFetch("/extract-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes) }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Xuất ảnh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-images.zip`;
    const r = await window.desktop.saveFile(bytes, name, [{ name: "ZIP", extensions: ["zip"] }]);
    if (r.saved) toast(`Đã xuất ${data.count} ảnh: ` + r.path, "good");
  } catch (err) {
    toast("Lỗi xuất ảnh: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- PDF pages → images zip ---
function openPdfToImages() {
  if (!convertReady()) return;
  $("p2i-modal").hidden = false;
}

async function runPdfToImages() {
  $("p2i-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  const format = $("p2i-format").value || "png";
  const dpi = parseInt($("p2i-dpi").value, 10) || 150;
  showOverlay("Đang chuyển trang PDF thành ảnh…");
  try {
    const res = await sidecarFetch("/pdf-to-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes), dpi, format }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Chuyển ảnh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-pages.zip`;
    const r = await window.desktop.saveFile(bytes, name, [{ name: "ZIP", extensions: ["zip"] }]);
    if (r.saved) toast(`Đã xuất ${data.count} trang thành ảnh: ` + r.path, "good");
  } catch (err) {
    toast("Lỗi chuyển ảnh: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- split one PDF into many (zip) ---
function openSplit() {
  if (!convertReady()) return;
  const mode = $("split-mode");
  if (mode) {
    mode.value = "every";
    $("split-size-wrap").hidden = false;
    $("split-ranges-wrap").hidden = true;
  }
  $("split-modal").hidden = false;
}

async function runSplit() {
  const mode = $("split-mode").value || "every";
  const body = { pdf_b64: u8ToB64(state.bytes), mode };
  if (mode === "ranges") {
    const ranges = ($("split-ranges").value || "").trim();
    if (!ranges) {
      toast("Nhập khoảng trang (vd: 1-3,5,8-10).", "bad");
      return;
    }
    body.ranges = ranges;
  } else {
    body.size = Math.max(1, parseInt($("split-size").value, 10) || 1);
  }
  $("split-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  showOverlay("Đang tách PDF…");
  try {
    const res = await sidecarFetch("/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tách PDF lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const name = `${baseName(state.name)}-split.zip`;
    const r = await window.desktop.saveFile(bytes, name, [{ name: "ZIP", extensions: ["zip"] }]);
    if (r.saved) toast(`Đã tách thành ${data.count} file: ` + r.path, "good");
  } catch (err) {
    toast("Lỗi tách PDF: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- images → PDF ---
let i2pImages = []; // [{ name, b64 }] picked by the user, in order

function openImagesToPdf() {
  if (!convertReady(false)) return; // no open doc needed — we build a new PDF
  i2pImages = [];
  updateI2pUI();
  $("i2p-modal").hidden = false;
}

function updateI2pUI() {
  const n = i2pImages.length;
  $("i2p-count").textContent = n
    ? `Đã chọn ${n} ảnh — sẽ tạo PDF ${n} trang (theo thứ tự chọn).`
    : "Chọn các ảnh để gộp thành một PDF (theo đúng thứ tự chọn).";
  $("i2p-ok").disabled = n === 0;
}

async function pickI2pImages() {
  const files = await window.desktop.openFiles({ multi: true });
  if (!files || !files.length) return;
  for (const f of files) {
    i2pImages.push({ name: f.name, b64: u8ToB64(toU8(f.data)) });
  }
  updateI2pUI();
}

async function runImagesToPdf() {
  if (!i2pImages.length) {
    toast("Chọn ít nhất một ảnh.", "bad");
    return;
  }
  $("i2p-modal").hidden = true;
  const page_size = $("i2p-size").value || "fit";
  showOverlay("Đang tạo PDF từ ảnh…");
  try {
    const res = await sidecarFetch("/images-to-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: i2pImages.map((x) => x.b64), page_size }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tạo PDF lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    const r = await window.desktop.savePdf(bytes, "images-to-pdf.pdf");
    if (r.saved) toast(`Đã tạo PDF ${data.pages} trang từ ảnh: ` + r.path, "good");
  } catch (err) {
    toast("Lỗi tạo PDF: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- combine multiple PDFs into one (standalone — no open document needed) ---
// Fully client-side (pdf-lib), so it works before any file is opened and never
// touches the currently-open document until the user saves the result.
let combineList = []; // [{ name, bytes: Uint8Array, pages }] in output order
let combineDragIdx = null;

function openCombine() {
  combineList = [];
  renderCombineList();
  $("combine-modal").hidden = false;
}

async function addCombinePdfs() {
  const files = await window.desktop.openPdf({ multi: true });
  if (!files || !files.length) return;
  for (const f of files) {
    const bytes = toU8(f.data);
    let pages = 0;
    try {
      const doc = await PDFDocument.load(bytes);
      pages = doc.getPageCount();
    } catch (err) {
      toast(`Bỏ qua "${f.name}" — không đọc được (có thể có mật khẩu).`, "bad");
      continue;
    }
    combineList.push({ name: f.name, bytes, pages });
  }
  renderCombineList();
}

function renderCombineList() {
  const ol = $("combine-list");
  ol.innerHTML = "";
  combineList.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = "combine-item";
    li.draggable = true;
    li.dataset.idx = String(i);
    li.innerHTML =
      '<span class="combine-grip" title="Kéo để sắp xếp"><svg class="ic"><use href="#ic-grip"/></svg></span>' +
      `<span class="combine-idx">${i + 1}.</span>` +
      '<span class="combine-name"></span>' +
      `<span class="combine-pages">${it.pages} trang</span>` +
      `<button class="icon-only" data-act="up" title="Lên"${i === 0 ? " disabled" : ""}>↑</button>` +
      `<button class="icon-only" data-act="down" title="Xuống"${i === combineList.length - 1 ? " disabled" : ""}>↓</button>` +
      '<button class="icon-only" data-act="rm" title="Bỏ khỏi danh sách"><svg class="ic"><use href="#ic-trash"/></svg></button>';
    li.querySelector(".combine-name").textContent = it.name; // textContent = safe vs odd filenames
    li.querySelector(".combine-name").title = it.name;
    ol.appendChild(li);
  });
  const n = combineList.length;
  const total = combineList.reduce((s, x) => s + x.pages, 0);
  $("combine-summary").textContent = n
    ? `${n} file · ${total} trang — sẽ gộp theo thứ tự từ trên xuống.`
    : "Chưa chọn file nào.";
  $("combine-ok").disabled = n < 2;
}

function moveCombine(from, to) {
  if (to < 0 || to >= combineList.length) return;
  const [it] = combineList.splice(from, 1);
  combineList.splice(to, 0, it);
  renderCombineList();
}

function wireCombineList() {
  const ol = $("combine-list");
  ol.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const li = btn.closest(".combine-item");
    const i = parseInt(li.dataset.idx, 10);
    const act = btn.dataset.act;
    if (act === "up") moveCombine(i, i - 1);
    else if (act === "down") moveCombine(i, i + 1);
    else if (act === "rm") {
      combineList.splice(i, 1);
      renderCombineList();
    }
  });
  // Drag-to-reorder: track the dragged row, drop onto another row to reinsert.
  ol.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".combine-item");
    if (!li) return;
    combineDragIdx = parseInt(li.dataset.idx, 10);
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  ol.addEventListener("dragend", () => {
    combineDragIdx = null;
    ol.querySelectorAll(".combine-item").forEach((el) =>
      el.classList.remove("dragging", "drop-target"),
    );
  });
  ol.addEventListener("dragover", (e) => {
    if (combineDragIdx == null) return;
    e.preventDefault();
    const li = e.target.closest(".combine-item");
    ol.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
    if (li) li.classList.add("drop-target");
  });
  ol.addEventListener("drop", (e) => {
    if (combineDragIdx == null) return;
    e.preventDefault();
    const li = e.target.closest(".combine-item");
    if (li) moveCombine(combineDragIdx, parseInt(li.dataset.idx, 10));
    combineDragIdx = null;
  });
}

async function runCombine() {
  if (combineList.length < 2) {
    toast("Chọn ít nhất 2 file để gộp.", "bad");
    return;
  }
  $("combine-modal").hidden = true;
  showOverlay("Đang gộp file…");
  try {
    const out = await PDFDocument.create();
    let total = 0;
    for (const it of combineList) {
      const src = await PDFDocument.load(it.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      total += pages.length;
    }
    const bytes = await out.save();
    const count = combineList.length;
    const r = await window.desktop.savePdf(bytes, "gop-nhieu-file.pdf");
    if (r.saved) {
      const nm = r.path.split(/[\\/]/).pop() || "gop-nhieu-file.pdf";
      await loadBytes(bytes, nm, r.path); // open the result so the user can review it
      toast(`Đã gộp ${count} file (${total} trang) → ${r.path}`, "good");
    } else {
      // Save cancelled — still open the merged result so the work isn't lost.
      await loadBytes(bytes, "gop-nhieu-file.pdf", null);
      toast(`Đã gộp ${count} file (${total} trang) — chưa lưu, bấm Ctrl+S để lưu.`, "good");
    }
  } catch (err) {
    toast("Lỗi gộp file: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// --- add page numbers (applies in place, with undo) ---
function openPageNumbers() {
  if (!convertReady()) return;
  $("pgnum-modal").hidden = false;
}

async function runPageNumbers() {
  $("pgnum-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  const fmt = $("pgnum-fmt").value || "n";
  const position = $("pgnum-pos").value || "bottom-center";
  const start_at = Math.max(1, parseInt($("pgnum-start").value, 10) || 1);
  const skip_first = Math.max(0, parseInt($("pgnum-skip").value, 10) || 0);
  const font_size = Math.min(72, Math.max(6, parseFloat($("pgnum-size").value) || 11));
  const color = $("pgnum-color").value || "#000000";
  showOverlay("Đang đánh số trang…");
  try {
    const res = await sidecarFetch("/add-page-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes), fmt, position, start_at, skip_first, font_size, color }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Đánh số lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    // Apply to the open document so it shows immediately; one undo step, then save.
    pushUndo();
    state.bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
    await renderAll();
    toast("Đã đánh số trang — bấm Lưu để ghi ra file.", "good");
  } catch (err) {
    toast("Lỗi đánh số trang: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// Dropdown open/close: toggle the menu; closed on outside-click/Escape (wired below).
function toggleConvertMenu(force) {
  const menu = $("convert-menu");
  const show = force !== undefined ? force : menu.hidden;
  menu.hidden = !show;
}

// ---- settings (API key) --------------------------------------------------

async function openSettings() {
  // The dialog opens regardless of engine state: the license + update sections
  // never need the OCR sidecar, and only the API-key part waits for it.
  $("set-modal").hidden = false;
  $("set-update-status").textContent = "";
  $("set-theme").value =
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  if ($("set-lang") && window.I18N) $("set-lang").value = window.I18N.getLang();
  loadLicense();
  if (window.desktop.appInfo) {
    window.desktop
      .appInfo()
      .then((info) => ($("set-version").textContent = "Phiên bản " + info.version))
      .catch(() => {});
  }

  const input = $("set-gemini-key");
  const status = $("set-status");
  const ok = $("set-ok");
  input.value = "";
  input.type = "password";

  if (sidecar.state !== "ready" || !sidecar.base) {
    status.textContent = "Engine đang khởi động — phần nhập API key sẽ sẵn sàng khi badge hiện 'OCR: sẵn sàng'.";
    input.disabled = true;
    ok.disabled = true;
    return;
  }
  input.disabled = false;
  ok.disabled = false;
  status.textContent = "Đang tải…";
  input.focus();
  try {
    const res = await sidecarFetch("/config");
    const data = await res.json();
    status.textContent = data.gemini_configured
      ? `Đã có key: ${data.gemini_key_masked}. Nhập key mới để thay.`
      : "Chưa có key. Bóc tách sẽ không chạy cho tới khi bạn nhập.";
    // Populate the model picker: current value + suggested choices.
    const mi = $("set-gemini-model");
    if (mi) {
      mi.value = data.gemini_model || "";
      mi.placeholder = data.gemini_model_default || "gemini-3.1-flash-lite";
      const dl = $("gemini-model-list");
      if (dl && Array.isArray(data.gemini_model_choices)) {
        dl.innerHTML = "";
        for (const m of data.gemini_model_choices) {
          const o = document.createElement("option");
          o.value = m;
          dl.appendChild(o);
        }
      }
    }
  } catch (err) {
    status.textContent = "Không đọc được cấu hình: " + err.message;
  }
}

async function saveSettings() {
  const key = $("set-gemini-key").value.trim();
  const model = ($("set-gemini-model") ? $("set-gemini-model").value : "").trim();
  // Nothing to persist: no new key AND no model field → ask for a key.
  const body = {};
  if (key) body.gemini_api_key = key;
  if ($("set-gemini-model")) body.gemini_model = model; // "" = revert to default
  if (!("gemini_api_key" in body) && !("gemini_model" in body)) {
    toast("Hãy dán API key trước khi lưu.", "bad");
    return;
  }
  try {
    const res = await sidecarFetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) {
      $("set-modal").hidden = true;
      toast(key ? "Đã lưu cài đặt." : "Đã lưu model: " + (data.gemini_model || ""), "good");
    } else {
      toast("Lưu không thành công.", "bad");
    }
  } catch (err) {
    toast("Lỗi lưu cài đặt: " + err.message, "bad");
  }
}

// ---- license (offline Ed25519) -------------------------------------------

// Live license status, kept in sync by renderLicense(). Pro features are gated
// against this when `enforce` is on (see licBlocked + the capture guard below).
// Defaults fail-open so nothing is locked during the brief window before the
// first status load returns.
let licState = { state: "unlicensed", enforce: false };

// Pro features locked behind a valid license. Basic page ops (open/save/rotate/
// delete/zoom/undo/redo) stay free.
const GATED_BTNS = [
  "btn-ocr",
  "btn-searchable",
  "btn-translate",
  "btn-compress",
  "btn-convert",
  "btn-edit",
  "btn-text-edit",
  "btn-merge",
  "btn-insert",
  "btn-blank",
  "btn-extract",
];

function licBlocked() {
  return licState.enforce && licState.state !== "licensed";
}

// Guard for pro-feature entry points reachable outside a plain button click
// (native menu, keyboard, drag-drop). Returns true — and steers the user to the
// activation dialog — when the feature must be blocked. Button clicks are caught
// separately by installLicenseGuard().
function gateProFeature() {
  if (!licBlocked()) return false;
  toast("Tính năng này cần kích hoạt bản quyền.", "bad");
  openSettings();
  return true;
}

// Document-level capture guard: fires during the capture phase (root → target),
// so it pre-empts the per-button onclick handlers wired in editor.js/text-edit.js
// regardless of registration order. When blocked, swallow the click and steer
// the user to the activation dialog.
function installLicenseGuard() {
  document.addEventListener(
    "click",
    (e) => {
      if (!licBlocked()) return;
      const btn = e.target.closest && e.target.closest("button");
      if (!btn || !GATED_BTNS.includes(btn.id)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toast("Tính năng này cần kích hoạt bản quyền.", "bad");
      openSettings();
    },
    true,
  );
}

async function loadLicense() {
  if (!window.desktop.license) return;
  try {
    renderLicense(await window.desktop.license.get());
  } catch (err) {
    $("lic-status").textContent = "Không đọc được trạng thái bản quyền.";
  }
  // Machine id (HWID) for binding keys to this device. Shown so the user can
  // send it to the vendor when buying a machine-locked key.
  if (window.desktop.license.hwid) {
    try {
      const el = $("lic-hwid");
      if (el) el.textContent = await window.desktop.license.hwid();
    } catch {
      /* leave placeholder */
    }
  }
}

function licReason(r) {
  return (
    {
      format: "sai định dạng key",
      signature: "chữ ký không hợp lệ",
      expired: "key đã hết hạn",
      hwid: "key dành cho máy khác",
      payload: "dữ liệu key hỏng",
      store: "không lưu được key",
      network: "không kết nối được máy chủ — cần internet để kích hoạt lần đầu",
      seat_limit: "key đã đạt giới hạn số máy",
      revoked: "key đã bị thu hồi",
      suspended: "key đang bị tạm khóa",
      deactivated: "máy này đã bị gỡ kích hoạt từ xa",
      unknown: "không tìm thấy key trên máy chủ",
      not_configured: "chưa cấu hình máy chủ license",
    }[r] || "không rõ"
  );
}

// Badge label + CSS class per status state.
const LIC_BADGE = {
  licensed: ["Đã kích hoạt", "ready"],
  unlicensed: ["Chưa kích hoạt", "starting"],
  expired: ["Hết hạn", "error"],
  machine: ["Sai máy", "error"],
  revoked: ["Bị thu hồi", "error"],
  suspended: ["Tạm khóa", "error"],
  deactivated: ["Gỡ từ xa", "error"],
  seat: ["Hết slot máy", "error"],
  invalid: ["Không hợp lệ", "error"],
};

// Status-line text for non-licensed states.
const LIC_MSG = {
  expired: "Bản quyền đã hết hạn — nhập key mới.",
  machine: "Key này được khóa cho máy khác. Dùng đúng máy đã đăng ký, hoặc xin cấp lại theo mã máy bên dưới.",
  revoked: "Key đã bị thu hồi. Liên hệ nhà phát hành.",
  suspended: "Key đang bị tạm khóa. Liên hệ nhà phát hành.",
  deactivated: "Máy này đã bị gỡ kích hoạt từ xa. Liên hệ nhà phát hành hoặc kích hoạt lại.",
  seat: "Key đã đạt giới hạn số máy. Gỡ bớt một máy hoặc nâng số máy.",
  invalid: "Key không hợp lệ — nhập lại key.",
  unlicensed: "Chưa kích hoạt bản quyền. Dán key để kích hoạt.",
};

function renderLicense(s) {
  licState = s;
  updateToolbar();
  // Free/open build (enforce off): hide the whole activation block — there is no
  // license to manage.
  const sec = $("lic-section");
  if (sec) sec.hidden = !s.enforce;
  if (!s.enforce) return;
  const badge = $("lic-badge");
  const status = $("lic-status");
  const inputRow = $("lic-input-row");
  const remove = $("lic-remove");
  const licensed = s.state === "licensed";
  const [label, cls] = LIC_BADGE[s.state] || LIC_BADGE.unlicensed;
  badge.className = "badge " + cls;
  badge.textContent = label;
  if (licensed) {
    const exp = s.exp ? "hạn " + new Date(s.exp * 1000).toLocaleDateString("vi-VN") : "vĩnh viễn";
    const who = s.name || s.email || "—";
    const grace = s.grace ? " · (ngoại tuyến — sẽ đồng bộ khi có mạng)" : "";
    status.textContent = `${who} · gói ${s.plan || "—"} · ${exp}${grace}`;
    inputRow.hidden = true;
    remove.hidden = false;
  } else {
    status.textContent = LIC_MSG[s.state] || LIC_MSG.unlicensed;
    inputRow.hidden = false;
    remove.hidden = true;
  }
}

// ---- sidecar status ------------------------------------------------------

function applySidecar(s) {
  sidecar.state = s.state;
  sidecar.base = s.port ? "http://127.0.0.1:" + s.port : null;
  sidecar.token = s.token || null;
  const b = $("sidecar-badge");
  b.className = "badge " + s.state;
  b.textContent =
    s.state === "ready" ? "OCR: sẵn sàng" : s.state === "error" ? "OCR: lỗi" : "OCR: đang tải…";
  b.title = s.state === "error" ? s.error || "" : "Trạng thái engine OCR";
  if (s.state === "ready") loadTemplates();
  updateToolbar();
}

// ---- toolbar state -------------------------------------------------------

function updateToolbar() {
  const has = !!state.bytes && state.numPages > 0;
  // While editing (P4 overlay or P6 text-edit), page-structure ops are locked to
  // keep page indices stable under the overlay; Save/zoom stay available.
  const overlayEditing = !!(window.Editor && window.Editor.active);
  const textEditing = !!(window.TextEdit && window.TextEdit.active);
  const editing = overlayEditing || textEditing;
  const ready = sidecar.state === "ready";
  $("btn-save").disabled = !has;
  const bp = $("btn-print");
  if (bp) bp.disabled = !has;
  document
    .querySelectorAll("[data-needs-doc] button")
    .forEach((b) => (b.disabled = !has || editing));
  $("btn-select-all").disabled = !has || editing;
  // Find box: the [data-needs-doc] sweep only touches <button>s, so toggle the
  // <input> (and the box's dimmed look) explicitly.
  const fi = $("find-input");
  if (fi) fi.disabled = !has || editing;
  const fb = $("find-box");
  if (fb) fb.classList.toggle("is-disabled", !has || editing);
  $("btn-ocr").disabled = !(ready && has) || editing;
  const bs = $("btn-searchable");
  if (bs) bs.disabled = !(ready && has) || editing;
  const btr = $("btn-translate");
  if (btr) btr.disabled = !(ready && has) || editing;
  const bc = $("btn-compress");
  if (bc) bc.disabled = !(ready && has) || editing;
  // Compare picks its own two files, so it only needs the engine ready (no open doc).
  const bd = $("btn-diff");
  if (bd) bd.disabled = !ready || editing;
  // Copy-image works on the open doc, purely client-side (no engine). Disabled
  // while editing; if capture mode is on when it gets disabled, leave it.
  const bci = $("btn-copy-img");
  if (bci) bci.disabled = !has || editing;
  if ((!has || editing) && window.Capture && window.Capture.active) window.Capture.exit();
  // Convert dropdown: enabled whenever the engine is ready (Ảnh→PDF works with no
  // doc open); per-item guards enforce the "open a PDF first" rule where needed.
  const bcv = $("btn-convert");
  if (bcv) bcv.disabled = !ready || editing;
  if (editing) toggleConvertMenu(false);
  // Overlay edit must not run while text-editing, and vice versa.
  const be = $("btn-edit");
  if (be) be.disabled = !has || textEditing;
  const bt = $("btn-text-edit");
  if (bt) bt.disabled = !(ready && has) || overlayEditing;
  // Zoom input is an <input>, so the [data-needs-doc] button sweep misses it.
  const zi = $("zoom-input");
  if (zi) zi.disabled = !has;
  syncZoomInput();
  // Visual cue for the license gate: a lock class on gated buttons. The actual
  // block happens in the capture guard; this is just a hover hint + CSS hook.
  const blocked = licBlocked();
  for (const id of GATED_BTNS) {
    const b = $(id);
    if (b) b.classList.toggle("locked", blocked);
  }
}

// ---- wiring --------------------------------------------------------------

async function openDialog() {
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
  await loadBytes(toU8(files[0].data), files[0].name, files[0].path);
}

$("btn-open").onclick = openDialog;
$("btn-combine").onclick = openCombine;
$("btn-save").onclick = saveDoc;
$("btn-print").onclick = printDoc;
// Toolbar undo/redo route to the annotation stack while the editor is open
// (same rule as Ctrl+Z/Y — doc-level undo under a live overlay would desync it).
$("btn-undo").onclick = () => (window.Editor && window.Editor.active ? window.Editor.undo() : undo());
$("btn-redo").onclick = () => (window.Editor && window.Editor.active ? window.Editor.redo() : redo());
$("btn-merge").onclick = mergeFiles;
$("btn-insert").onclick = insertFile;
$("btn-blank").onclick = addBlankPage;
$("btn-extract").onclick = extractSelected;
$("btn-rotate-l").onclick = () => rotateSelected(-90);
$("btn-rotate-r").onclick = () => rotateSelected(90);
$("btn-delete").onclick = deleteSelected;
$("btn-zoom-in").onclick = () => zoom(0.2);
$("btn-zoom-out").onclick = () => zoom(-0.2);
$("btn-fit-width").onclick = fitWidth;
// Editable zoom %: Enter/blur applies, Escape reverts.
$("zoom-input").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    applyZoomInput();
    e.target.blur();
  } else if (e.key === "Escape") {
    e.target.value = Math.round(state.scale * 100) + "%"; // revert (blur re-applies the same value → no-op)
    e.target.blur();
  }
});
$("zoom-input").addEventListener("blur", applyZoomInput);
$("zoom-input").addEventListener("focus", (e) => e.target.select());
// Ctrl+wheel zooms toward the cursor (like Foxit/Acrobat/browsers).
$("viewer").addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); // stop the browser's own pinch-zoom
    if (!state.bytes) return;
    zoomTo(state.scale + (e.deltaY < 0 ? 0.1 : -0.1), { x: e.clientX, y: e.clientY });
  },
  { passive: false }
);
$("btn-ocr").onclick = openExtractPanel;
$("btn-searchable").onclick = makeSearchable;
$("btn-translate").onclick = openTranslate;
$("btn-compress").onclick = openCompress;
$("btn-diff").onclick = () => window.Compare && window.Compare.open();

// ---- find-in-document controls ----
let findTimer;
$("find-input").addEventListener("input", (e) => {
  clearTimeout(findTimer);
  const v = e.target.value;
  findTimer = setTimeout(() => runSearch(v), 180);
});
$("find-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gotoMatch(search.current + (e.shiftKey ? -1 : 1));
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
$("find-next").onclick = () => gotoMatch(search.current + 1);
$("find-prev").onclick = () => gotoMatch(search.current - 1);
$("cmp-cancel").onclick = () => ($("cmp-modal").hidden = true);
$("cmp-ok").onclick = runCompress;
$("tr-cancel").onclick = () => ($("tr-modal").hidden = true);
$("tr-ok").onclick = runTranslate;

// Convert dropdown — trigger toggles the menu; each item runs its tool and
// closes the menu. Outside-click / Escape close it (handlers further below).
$("btn-convert").onclick = (e) => {
  e.stopPropagation();
  toggleConvertMenu();
};
const ddRun = (fn) => () => {
  toggleConvertMenu(false);
  fn();
};
$("mi-encrypt").onclick = ddRun(openEncrypt);
$("mi-split").onclick = ddRun(openSplit);
$("mi-page-numbers").onclick = ddRun(openPageNumbers);
$("pgnum-cancel").onclick = () => ($("pgnum-modal").hidden = true);
$("pgnum-ok").onclick = runPageNumbers;
$("mi-extract-images").onclick = ddRun(extractImages);
$("mi-pdf-to-images").onclick = ddRun(openPdfToImages);
$("mi-images-to-pdf").onclick = ddRun(openImagesToPdf);
document.addEventListener("click", (e) => {
  if (!$("convert-dd").contains(e.target)) toggleConvertMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleConvertMenu(false);
});
// Convert modals.
$("print-ok").onclick = runPrint;
$("print-cancel").onclick = closePrintModal;
$("enc-cancel").onclick = () => ($("enc-modal").hidden = true);
$("enc-ok").onclick = runEncrypt;
$("enc-pw-toggle").onclick = () => {
  const i = $("enc-pw");
  i.type = i.type === "password" ? "text" : "password";
};
$("split-cancel").onclick = () => ($("split-modal").hidden = true);
$("split-ok").onclick = runSplit;
$("split-mode").onchange = () => {
  const isRanges = $("split-mode").value === "ranges";
  $("split-size-wrap").hidden = isRanges;
  $("split-ranges-wrap").hidden = !isRanges;
};
$("p2i-cancel").onclick = () => ($("p2i-modal").hidden = true);
$("p2i-ok").onclick = runPdfToImages;
$("i2p-cancel").onclick = () => ($("i2p-modal").hidden = true);
$("i2p-pick").onclick = pickI2pImages;
$("i2p-ok").onclick = runImagesToPdf;
// Combine-PDFs modal.
$("empty-combine").onclick = openCombine;
$("combine-add").onclick = addCombinePdfs;
$("combine-cancel").onclick = () => ($("combine-modal").hidden = true);
$("combine-ok").onclick = runCombine;
wireCombineList();

$("btn-settings").onclick = openSettings;
$("set-cancel").onclick = () => ($("set-modal").hidden = true);
$("set-ok").onclick = saveSettings;
$("set-key-toggle").onclick = () => {
  const i = $("set-gemini-key");
  i.type = i.type === "password" ? "text" : "password";
};
$("pw-toggle").onclick = () => {
  const i = $("pw-input");
  i.type = i.type === "password" ? "text" : "password";
};
// Theme (light/dark) — persisted in localStorage, applied early in <head> too.
function applyTheme(t) {
  const theme = t === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("nabu-theme", theme);
  } catch (_) {}
}
$("set-theme").onchange = (e) => applyTheme(e.target.value);
// UI language toggle — swaps chrome labels + native menu immediately.
if ($("set-lang")) {
  $("set-lang").onchange = (e) => {
    if (window.I18N) window.I18N.setLang(e.target.value);
  };
}
$("set-gemini-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveSettings();
});
$("lic-activate").onclick = async () => {
  const key = $("lic-key").value.trim();
  if (!key) {
    toast("Dán license key trước khi kích hoạt.", "bad");
    return;
  }
  try {
    const res = await window.desktop.license.activate(key);
    if (res.ok) {
      toast("Kích hoạt bản quyền thành công.", "good");
      $("lic-key").value = "";
    } else {
      toast("Kích hoạt thất bại: " + licReason(res.reason), "bad");
    }
    renderLicense(res);
  } catch (err) {
    toast("Lỗi kích hoạt: " + err.message, "bad");
  }
};
$("lic-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("lic-activate").click();
});
const licHwidCopy = $("lic-hwid-copy");
if (licHwidCopy) {
  licHwidCopy.onclick = async () => {
    const id = $("lic-hwid").textContent.trim();
    if (!id || id === "…") return;
    try {
      await navigator.clipboard.writeText(id);
      toast("Đã sao chép mã máy.", "good");
    } catch {
      toast("Không sao chép được — chép tay giúp nhé.", "bad");
    }
  };
}
$("lic-remove").onclick = async () => {
  try {
    renderLicense(await window.desktop.license.deactivate());
    toast("Đã gỡ bản quyền khỏi máy này.");
  } catch (err) {
    toast("Lỗi gỡ bản quyền: " + err.message, "bad");
  }
};
$("set-check-update").onclick = async () => {
  if (!window.desktop.checkUpdate) return;
  manualUpdateCheck = true;
  $("set-check-update").disabled = true;
  $("set-update-status").textContent = "Đang kiểm tra…";
  try {
    setUpdateStatusText(await window.desktop.checkUpdate());
  } catch (err) {
    setUpdateStatusText({ state: "error", error: err.message });
  }
};
$("ext-close").onclick = () => ($("ext-panel").hidden = true);
$("ext-run").onclick = runExtract;
$("ext-template").addEventListener("change", syncCustomPanel);
$("ext-custom-add").onclick = () => {
  addCustomFieldRow().focus();
  saveCustomFields();
};
$("ext-export").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-fmt]");
  if (b) runExport(b.dataset.fmt);
});

$("btn-select-all").onclick = () => {
  if (state.selected.size === state.numPages) {
    state.selected.clear();
    if (state.numPages) state.selected.add(0);
  } else {
    state.selected.clear();
    for (let i = 0; i < state.numPages; i++) state.selected.add(i);
  }
  refreshSelectionUI();
  updateToolbar();
};

// Whether the user is typing in a field or mid-edit (so we don't hijack keys).
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  if (document.body.classList.contains("text-editing")) return true;
  return false;
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    // Open / Save / Save As are registered as native menu accelerators (main.js),
    // so they're intentionally NOT handled here (would fire twice).
    // While the overlay editor is open, Ctrl+Z/Y must act on the *annotations*,
    // never on the document bytes (undoing pages under a live overlay would
    // desync every pending edit).
    const overlayEd = window.Editor && window.Editor.active;
    if (k === "z" && !e.shiftKey && !isTyping()) {
      e.preventDefault();
      overlayEd ? window.Editor.undo() : undo();
    } else if (((k === "z" && e.shiftKey) || k === "y") && !isTyping()) {
      e.preventDefault();
      overlayEd ? window.Editor.redo() : redo();
    } else if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      zoom(0.2);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoom(-0.2);
    } else if (e.key === "0") {
      e.preventDefault();
      zoomReset();
    } else if (k === "f") {
      e.preventDefault();
      openFind();
    } else if (k === "p") {
      // Ctrl+P: print. Registered as a menu accelerator with
      // registerAccelerator:false, so the renderer owns it (avoids double-fire
      // and lets us skip Chromium's own print path).
      e.preventDefault();
      printDoc();
    }
    return;
  }
  // Delete removes the selected pages — but never while typing or in an editor
  // (the overlay/text editors own Delete for their own selection).
  if (
    e.key === "Delete" &&
    !isTyping() &&
    !(window.Editor && window.Editor.active && window.Editor.active()) &&
    state.selected &&
    state.selected.size
  ) {
    e.preventDefault();
    deleteSelected();
  }
});

// Native menu (File/Edit/Page/View) → same actions as the toolbar buttons.
window.desktop.onMenuCommand((cmd) => {
  const actions = {
    open: openDialog,
    save: saveDoc,
    saveAs: saveAsDoc,
    print: printDoc,
    // Same routing as Ctrl+Z/Y: annotation-level undo while the editor is open.
    undo: () => (window.Editor && window.Editor.active ? window.Editor.undo() : undo()),
    redo: () => (window.Editor && window.Editor.active ? window.Editor.redo() : redo()),
    rotateL: () => rotateSelected(-90),
    rotateR: () => rotateSelected(90),
    delete: deleteSelected,
    merge: mergeFiles,
    insert: insertFile,
    extract: extractSelected,
    zoomIn: () => zoom(0.2),
    zoomOut: () => zoom(-0.2),
    zoomReset,
    settings: openSettings,
    encrypt: openEncrypt,
    extractImages: extractImages,
    pdfToImages: openPdfToImages,
    imagesToPdf: openImagesToPdf,
  };
  const fn = actions[cmd];
  if (fn) fn();
});

// drag-drop a PDF file onto the window to open it
const clearDropCue = () => $("viewer").classList.remove("dropping");
window.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  $("viewer").classList.add("dropping");
});
// Clear the cue whenever the drag truly leaves the window (relatedTarget null in
// Chromium) or the drag ends/cancels anywhere. The old check only matched
// document.documentElement, so leaving via a child element or cancelling left
// the dashed outline stuck forever.
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) clearDropCue();
});
window.addEventListener("dragend", clearDropCue);
window.addEventListener("drop", async (e) => {
  // Always clear the cue first — even for internal/non-file drops, or drops a
  // child handler stopped propagating, so the outline never gets stranded.
  clearDropCue();
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith(".pdf"));
  if (f) {
    const buf = await f.arrayBuffer();
    // Electron exposes the dropped file's real path via file.path; use it for the
    // breadcrumb when present (older/secured builds may omit it).
    await loadBytes(new Uint8Array(buf), f.name, f.path || null);
  }
});

// "Open with Nabu PDF" / double-click a .pdf / drag onto the app icon: the main
// process opens a window and pushes the file here once the renderer is ready.
if (window.desktop.onOpenFile) {
  window.desktop.onOpenFile((file) => {
    if (file && file.data) loadBytes(toU8(file.data), file.name, file.path || null);
  });
}

// sidecar status: get current + subscribe to updates
window.desktop.onSidecarStatus(applySidecar);
window.desktop.getSidecarStatus().then(applySidecar);
updateToolbar();

// license: install the pro-feature gate, then load current status
installLicenseGuard();
loadLicense();

// About: open the license text in the default browser. (Source repo is no longer
// linked in-app; corresponding source is offered on request per AGPL-3.0 §6b.)
for (const [id, url] of [
  ["about-license-link", "https://www.gnu.org/licenses/agpl-3.0.html"],
]) {
  const a = $(id);
  if (a)
    a.addEventListener("click", (e) => {
      e.preventDefault();
      window.desktop.openExternal(url);
    });
}
// About: open the bundled license notice files in the OS text viewer.
for (const [id, which] of [
  ["about-thirdparty-link", "thirdParty"],
  ["about-agpl-file-link", "agpl"],
]) {
  const a = $(id);
  if (a && window.desktop.openLicenses)
    a.addEventListener("click", (e) => {
      e.preventDefault();
      window.desktop.openLicenses(which);
    });
}

// ---- auto-update status --------------------------------------------------
// Only fires for the installed (NSIS) build; portable/dev stay silent. The
// badge appears only during update activity; "downloaded" pairs with the native
// restart dialog raised by the main process (src/updater.js).
// Set true while a manual "Kiểm tra cập nhật" is in flight so streamed results
// (checking → current/available/error) get echoed into the Settings dialog.
let manualUpdateCheck = false;

// Human-readable line for the Settings update section. Terminal states clear the
// manual-check flag and re-enable the button.
function setUpdateStatusText(s) {
  const el = $("set-update-status");
  const btn = $("set-check-update");
  let text = "";
  let done = true;
  switch (s.state) {
    case "checking":
      text = "Đang kiểm tra…";
      done = false;
      break;
    case "available":
      text = "Đã có bản mới" + (s.version ? " " + s.version : "") + " — đang tải…";
      done = false;
      break;
    case "downloading":
      text = "Đang tải bản mới: " + (s.percent != null ? s.percent : 0) + "%";
      done = false;
      break;
    case "downloaded":
      text = "Đã tải xong — khởi động lại để cài (xem hộp thoại).";
      break;
    case "current":
      text = "Bạn đang dùng bản mới nhất" + (s.version ? " (" + s.version + ")" : "") + ".";
      break;
    case "portable":
      text = "Bản portable không tự cập nhật. Dùng bản cài đặt (.exe) để bật tự cập nhật, hoặc tải bản mới từ trang Releases trên GitHub.";
      break;
    case "dev":
      text = "Bản chạy thử (dev) không hỗ trợ tự cập nhật.";
      break;
    case "error":
      text = "Lỗi kiểm tra cập nhật: " + (s.error || "không rõ") + ".";
      break;
    default: // unsupported and anything else
      text = "Bản này không hỗ trợ tự cập nhật.";
  }
  if (el) el.textContent = text;
  if (done) {
    manualUpdateCheck = false;
    if (btn) btn.disabled = false;
  }
}

function applyUpdate(s) {
  if (manualUpdateCheck) setUpdateStatusText(s);
  const b = $("update-badge");
  if (!b) return;
  const show = (text, cls, title) => {
    b.hidden = false;
    b.className = "badge " + cls;
    b.textContent = text;
    b.title = title || "Trạng thái cập nhật";
  };
  switch (s.state) {
    case "available":
      show("Cập nhật: đang tải…", "update", "Đã có bản " + (s.version || "mới"));
      toast("Đang tải bản cập nhật" + (s.version ? " " + s.version : "") + "…");
      break;
    case "downloading":
      show("Cập nhật: " + (s.percent != null ? s.percent : 0) + "%", "update");
      break;
    case "downloaded":
      show("Đã tải bản mới ✓", "done", "Khởi động lại để cài (xem hộp thoại)");
      break;
    default: // checking / current / error: nothing to show
      b.hidden = true;
  }
}
if (window.desktop.onUpdateStatus) window.desktop.onUpdateStatus(applyUpdate);
