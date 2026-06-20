"use strict";

/**
 * ContractOCR — PDF Suite renderer (Phase 1: PDF core).
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
  pdf: null, // pdfjs document proxy
  numPages: 0,
  scale: 1.0, // viewer zoom (1.0 = 100%)
  selected: new Set(), // selected page indices (0-based, current order)
  lastClicked: null,
  dragSrc: null,
};

const sidecar = { state: "starting", base: null };

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

// ---- loading + rendering -------------------------------------------------

async function loadBytes(bytes, name) {
  state.bytes = toU8(bytes);
  if (name) state.name = name;
  state.selected.clear();
  state.lastClicked = null;
  if (window.Editor) window.Editor.reset(); // drop annotations from any previous doc
  await renderAll();
  toast("Đã mở: " + state.name, "good");
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

async function renderViewer() {
  const v = $("viewer");
  v.querySelectorAll(".page-wrap").forEach((e) => e.remove());
  const dpr = window.devicePixelRatio || 1;
  for (let i = 0; i < state.numPages; i++) {
    const page = await state.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: state.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + "px";
    canvas.style.height = Math.floor(vp.height) + "px";
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.index = String(i);
    wrap.appendChild(canvas);
    v.appendChild(wrap);
  }
  // Let the overlay editor (P4) re-attach its annotation layers, if loaded.
  if (window.Editor) window.Editor.syncOverlays();
}

function scrollToPage(i) {
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
    const res = await fetch(sidecar.base + "/templates");
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
    const res = await fetch(sidecar.base + "/extract", {
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
    const res = await fetch(sidecar.base + "/export", {
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
    const res = await fetch(sidecar.base + "/searchable", {
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
    const res = await fetch(sidecar.base + "/compress", {
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

// ---- sidecar status ------------------------------------------------------

function applySidecar(s) {
  sidecar.state = s.state;
  sidecar.base = s.port ? "http://127.0.0.1:" + s.port : null;
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
  // While editing (P4), page-structure ops are locked to keep page indices
  // stable under the annotation overlay; Save/zoom stay available.
  const editing = !!(window.Editor && window.Editor.active);
  $("btn-save").disabled = !has;
  document
    .querySelectorAll("[data-needs-doc] button")
    .forEach((b) => (b.disabled = !has || editing));
  $("btn-select-all").disabled = !has || editing;
  $("btn-ocr").disabled = !(sidecar.state === "ready" && has) || editing;
  const bs = $("btn-searchable");
  if (bs) bs.disabled = !(sidecar.state === "ready" && has) || editing;
  const bc = $("btn-compress");
  if (bc) bc.disabled = !(sidecar.state === "ready" && has) || editing;
  const be = $("btn-edit");
  if (be) be.disabled = !has;
  $("zoom-label").textContent = Math.round(state.scale * 100) + "%";
}

// ---- wiring --------------------------------------------------------------

async function openDialog() {
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
  await loadBytes(toU8(files[0].data), files[0].name);
}

$("btn-open").onclick = openDialog;
$("btn-save").onclick = saveDoc;
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDoc();
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
    await loadBytes(new Uint8Array(buf), f.name);
  }
});

// sidecar status: get current + subscribe to updates
window.desktop.onSidecarStatus(applySidecar);
window.desktop.getSidecarStatus().then(applySidecar);
updateToolbar();
