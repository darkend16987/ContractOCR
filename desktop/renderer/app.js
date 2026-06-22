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

async function renderThumbs() {
  const wrap = $("thumbs");
  wrap.innerHTML = "";
  for (let i = 0; i < state.numPages; i++) {
    const page = await state.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = 150 / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

    const div = document.createElement("div");
    div.className = "thumb" + (state.selected.has(i) ? " selected" : "");
    div.dataset.index = String(i);
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
  updatePageCount();
}

function updatePageCount() {
  const sel = state.selected.size;
  $("page-count").textContent =
    state.numPages + " trang" + (sel ? ` · ${sel} chọn` : "");
}

let pageObserver = null;

async function renderViewer() {
  const v = $("viewer");
  v.querySelectorAll(".page-wrap").forEach((e) => e.remove());
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
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
        if (!e.isIntersecting) continue;
        renderPageCanvas(+e.target.dataset.index);
        pageObserver.unobserve(e.target);
      }
    },
    { root: v, rootMargin: "500px 0px" }
  );
  metas.forEach((m) => pageObserver.observe(m.wrap));

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
  if (!m || m.wrap.dataset.rendered === "1") return;
  m.wrap.dataset.rendered = "1";
  const { page, vp, cw, ch, canvas, dpr } = m;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  try {
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    await addNoteMarkers(i, m); // surface baked sticky-note comments (readable in-app)
  } catch (_) {
    m.wrap.dataset.rendered = "0"; // let it retry on the next intersection
  }
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
  const notes = (annots || []).filter((a) => a.subtype === "Text" && a.contents);
  if (!notes.length) return;
  const layer = document.createElement("div");
  layer.className = "note-layer";
  layer.style.width = (parseFloat(canvas.style.width) || cw) + "px";
  layer.style.height = (parseFloat(canvas.style.height) || ch) + "px";
  for (const an of notes) {
    const r = vp.convertToViewportRectangle(an.rect);
    const x = Math.min(r[0], r[2]);
    const y = Math.min(r[1], r[3]);
    const el = document.createElement("div");
    el.className = "note-marker";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = Math.max(16, Math.abs(r[2] - r[0])) + "px";
    el.style.height = Math.max(16, Math.abs(r[3] - r[1])) + "px";
    el.title = an.contents;
    el.onclick = (e) => {
      e.stopPropagation();
      showNotePopup(an.contents, e.clientX, e.clientY);
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
      if (wasRendered || !changed) await renderPageCanvas(i); // repaint now if it was on screen
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
  const canvas = div && div.querySelector("canvas");
  if (!canvas) return;
  const page = state.pageMetas[i].page;
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 150 / base.width });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
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
  div.addEventListener("dragover", (e) => {
    if (state.dragSrc == null) return;
    e.preventDefault();
    div.classList.add("drag-over");
  });
  div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
  div.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    div.classList.remove("drag-over");
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

async function mergeFiles() {
  const files = await window.desktop.openPdf({ multi: true });
  if (!files.length) return;
  showOverlay("Đang ghép…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    let added = 0;
    for (const f of files) {
      const other = await PDFDocument.load(toU8(f.data));
      const pages = await doc.copyPages(other, other.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
      added += pages.length;
    }
    state.bytes = await doc.save();
    await renderAll();
    toast(`Đã ghép ${files.length} file (+${added} trang).`, "good");
  } finally {
    hideOverlay();
  }
}

async function insertFile() {
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
  const at = state.selected.size ? Math.max(...state.selected) + 1 : state.numPages;
  showOverlay("Đang chèn…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    const other = await PDFDocument.load(toU8(files[0].data));
    const pages = await doc.copyPages(other, other.getPageIndices());
    pages.forEach((p, k) => doc.insertPage(at + k, p));
    state.bytes = await doc.save();
    state.selected.clear();
    await renderAll();
    toast(`Đã chèn ${pages.length} trang sau trang ${at}.`, "good");
  } finally {
    hideOverlay();
  }
}

async function extractSelected() {
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

async function saveDoc() {
  if (!state.bytes) return;
  // Bake any unapplied overlay edits into the bytes first (P4).
  if (window.Editor) await window.Editor.bakePending();
  const res = await window.desktop.savePdf(state.bytes, state.name);
  if (res.saved) toast("Đã lưu: " + res.path, "good");
}

// ---- zoom ----------------------------------------------------------------

let zooming = false;
async function zoom(delta) {
  if (zooming || !state.bytes) return;
  const next = Math.min(3, Math.max(0.4, +(state.scale + delta).toFixed(2)));
  if (next === state.scale) return;
  state.scale = next;
  $("zoom-label").textContent = Math.round(state.scale * 100) + "%";
  zooming = true;
  try {
    await renderViewer();
  } finally {
    zooming = false;
  }
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
    templatesLoaded = true;
  } catch (_) {
    /* sidecar may not be ready; retry on next open */
  }
}

function openExtractPanel() {
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
  showOverlay(`Đang OCR + bóc tách ${indices.length} trang…`);
  try {
    const { imgs, nums } = await rasterize(indices);
    const res = await sidecarFetch("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: imgs, page_numbers: nums, template }),
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
    if (r.saved) toast(`Đã lưu PDF tìm-kiếm-được (${data.words} cụm text): ` + r.path, "good");
  } catch (err) {
    toast("Lỗi tạo searchable: " + err.message, "bad");
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

// ---- settings (API key) --------------------------------------------------

async function openSettings() {
  // The dialog opens regardless of engine state: the license + update sections
  // never need the OCR sidecar, and only the API-key part waits for it.
  $("set-modal").hidden = false;
  $("set-update-status").textContent = "";
  $("set-theme").value =
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
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
  } catch (err) {
    status.textContent = "Không đọc được cấu hình: " + err.message;
  }
}

async function saveSettings() {
  const key = $("set-gemini-key").value.trim();
  if (!key) {
    toast("Hãy dán API key trước khi lưu.", "bad");
    return;
  }
  try {
    const res = await sidecarFetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gemini_api_key: key }),
    });
    const data = await res.json();
    if (data.success && data.gemini_configured) {
      $("set-modal").hidden = true;
      toast("Đã lưu API key.", "good");
    } else {
      toast("Lưu không thành công.", "bad");
    }
  } catch (err) {
    toast("Lỗi lưu cài đặt: " + err.message, "bad");
  }
}

// ---- license (offline Ed25519) -------------------------------------------

async function loadLicense() {
  if (!window.desktop.license) return;
  try {
    renderLicense(await window.desktop.license.get());
  } catch (err) {
    $("lic-status").textContent = "Không đọc được trạng thái bản quyền.";
  }
}

function licReason(r) {
  return (
    {
      format: "sai định dạng key",
      signature: "chữ ký không hợp lệ",
      expired: "key đã hết hạn",
      payload: "dữ liệu key hỏng",
      store: "không lưu được key",
    }[r] || "không rõ"
  );
}

function renderLicense(s) {
  const badge = $("lic-badge");
  const status = $("lic-status");
  const inputRow = $("lic-input-row");
  const remove = $("lic-remove");
  const licensed = s.state === "licensed";
  badge.className =
    "badge " + (licensed ? "ready" : s.state === "unlicensed" ? "starting" : "error");
  badge.textContent = licensed
    ? "Đã kích hoạt"
    : s.state === "expired"
      ? "Hết hạn"
      : s.state === "invalid"
        ? "Không hợp lệ"
        : "Chưa kích hoạt";
  if (licensed) {
    const exp = s.exp ? "hạn " + new Date(s.exp * 1000).toLocaleDateString("vi-VN") : "vĩnh viễn";
    const who = s.name || s.email || "—";
    status.textContent = `${who} · gói ${s.plan || "—"} · ${exp}`;
    inputRow.hidden = true;
    remove.hidden = false;
  } else {
    status.textContent =
      s.state === "expired"
        ? "Key đã hết hạn — nhập key mới."
        : s.state === "invalid"
          ? "Key không hợp lệ — nhập lại key."
          : "Chưa kích hoạt bản quyền. Dán key để kích hoạt.";
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
  document
    .querySelectorAll("[data-needs-doc] button")
    .forEach((b) => (b.disabled = !has || editing));
  $("btn-select-all").disabled = !has || editing;
  $("btn-ocr").disabled = !(ready && has) || editing;
  const bs = $("btn-searchable");
  if (bs) bs.disabled = !(ready && has) || editing;
  const bc = $("btn-compress");
  if (bc) bc.disabled = !(ready && has) || editing;
  // Overlay edit must not run while text-editing, and vice versa.
  const be = $("btn-edit");
  if (be) be.disabled = !has || textEditing;
  const bt = $("btn-text-edit");
  if (bt) bt.disabled = !(ready && has) || overlayEditing;
  $("zoom-label").textContent = Math.round(state.scale * 100) + "%";
}

// ---- wiring --------------------------------------------------------------

async function openDialog() {
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
  await loadBytes(toU8(files[0].data), files[0].name, files[0].path);
}

$("btn-open").onclick = openDialog;
$("btn-save").onclick = saveDoc;
$("btn-undo").onclick = undo;
$("btn-redo").onclick = redo;
$("btn-merge").onclick = mergeFiles;
$("btn-insert").onclick = insertFile;
$("btn-extract").onclick = extractSelected;
$("btn-rotate-l").onclick = () => rotateSelected(-90);
$("btn-rotate-r").onclick = () => rotateSelected(90);
$("btn-delete").onclick = deleteSelected;
$("btn-zoom-in").onclick = () => zoom(0.2);
$("btn-zoom-out").onclick = () => zoom(-0.2);
$("btn-ocr").onclick = openExtractPanel;
$("btn-searchable").onclick = makeSearchable;
$("btn-compress").onclick = openCompress;
$("cmp-cancel").onclick = () => ($("cmp-modal").hidden = true);
$("cmp-ok").onclick = runCompress;
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

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // Don't hijack shortcuts while typing in an input/textarea/select.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    saveDoc();
  } else if (k === "z" && !e.shiftKey && !typing) {
    e.preventDefault();
    undo();
  } else if (((k === "z" && e.shiftKey) || k === "y") && !typing) {
    e.preventDefault();
    redo();
  }
});

// drag-drop a PDF file onto the window to open it
window.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  $("viewer").classList.add("dropping");
});
window.addEventListener("dragleave", (e) => {
  if (e.target === document.documentElement) $("viewer").classList.remove("dropping");
});
window.addEventListener("drop", async (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  $("viewer").classList.remove("dropping");
  const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith(".pdf"));
  if (f) {
    const buf = await f.arrayBuffer();
    // Electron exposes the dropped file's real path via file.path; use it for the
    // breadcrumb when present (older/secured builds may omit it).
    await loadBytes(new Uint8Array(buf), f.name, f.path || null);
  }
});

// sidecar status: get current + subscribe to updates
window.desktop.onSidecarStatus(applySidecar);
window.desktop.getSidecarStatus().then(applySidecar);
updateToolbar();

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
      text = "Bản portable không tự cập nhật. Tải bản mới thủ công từ trang Releases trên GitHub.";
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
