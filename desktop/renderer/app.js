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
  dirty: false, // true when the canonical bytes have changed since the last real save
  docId: null, // per-open-document id keying its crash-recovery snapshot slot
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
// Non-blocking confirm dialog — the drop-in replacement for window.confirm().
// The native confirm() blocks Electron's renderer thread for as long as it is
// open AND, when dismissed, blurs the window: document.hasFocus() goes false and
// stays false, so the next textarea we .focus() shows no caret (the annotation
// text-box "no cursor after Hủy bỏ" bug). This in-DOM modal never touches OS
// focus and never blocks. Returns a Promise<boolean> (true = OK/Enter).
function uiConfirm(message, opts) {
  const { okText = "OK", cancelText = "Hủy", title = "Xác nhận" } = opts || {};
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const okBtn = $("confirm-ok");
    const cancelBtn = $("confirm-cancel");
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = message || "";
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
    modal.hidden = false;
    okBtn.focus();
  });
}
window.uiConfirm = uiConfirm; // shared with editor.js / text-edit.js (same window scope)
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
// Second, INDEPENDENT cap — by total bytes. HISTORY_LIMIT alone bounds the step
// COUNT, not the memory: each snapshot is a full copy, so 30 steps on a 128 MB
// scan is ~3.8 GB in one tab (and every tab is its own renderer process). This
// budget is what actually keeps a heavy document from eating the machine; for
// ordinary files (<~17 MB) it never kicks in and undo depth stays the full 30.
const HISTORY_BYTES_BUDGET = 512 * 1024 * 1024;
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
function historyBytes() {
  let n = 0;
  for (const s of history.undo) n += s.bytes ? s.bytes.length : 0;
  for (const s of history.redo) n += s.bytes ? s.bytes.length : 0;
  return n;
}
// Drop the OLDEST steps until the history fits HISTORY_BYTES_BUDGET. Always keeps
// at least one undo step, so Ctrl+Z is never a no-op straight after an edit even
// when a single snapshot is bigger than the whole budget.
function trimHistoryToBudget() {
  while (history.undo.length > 1 && historyBytes() > HISTORY_BYTES_BUDGET) history.undo.shift();
  while (history.redo.length && historyBytes() > HISTORY_BYTES_BUDGET) history.redo.shift();
}
// Call BEFORE mutating state.bytes. Captures the pre-op document.
function pushUndo() {
  if (!state.bytes) return;
  history.undo.push(snapshot());
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  trimHistoryToBudget();
  updateUndoRedo();
  // Every canonical-bytes mutation routes through here → the document now has
  // changes not yet written to its real file; flag it and schedule a background
  // recovery snapshot (see autosave below).
  markDirty();
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
//
// NOT `window.History`: that name is the DOM's own History constructor, so it is
// always truthy — `if (window.History)` was a guard that could never fail, and a
// typo'd or missing export would have surfaced as a TypeError inside a try/catch
// (the edit silently not applying) instead of a skipped call. BI-14 in
// docs/REGRESSION-GUARD.md is about exactly this class of silent break.
window.DocHistory = { pushUndo };

// ---- unsaved-changes tracking + crash recovery ---------------------------
//
// Three problems, one safety net (Word-style AutoRecover):
//   1. power loss / OS reset   2. app crash   3. forgot to save + closed
// (1)+(2): a background snapshot of the canonical bytes is written to a private
// recovery folder; a session that ends cleanly (save or a confirmed close) clears
// it, so anything left behind on the next launch is a crash remnant we can offer
// to restore. (3): closing a window with unsaved changes prompts Save/Don't/Cancel,
// and opening another file over an unsaved one asks first.
//
// v1 snapshots only the CANONICAL bytes (everything already "Áp dụng"/structural).
// Overlay annotations not yet applied are transient (like an open textarea) and are
// not captured — same contract as the text/label inline editors.

const AUTOSAVE_INTERVAL_MS = 120000; // periodic snapshot cadence while dirty
const AUTOSAVE_DEBOUNCE_MS = 15000; // quick snapshot this long after the last edit
let autosaveDebounceTimer = null;
let lastAutosaveLen = -1; // byte length of the last snapshot (cheap "changed?" guard)

// True when there is work that would be lost on close: canonical bytes changed
// since the last real save, OR the overlay editor holds un-applied annotations.
function docHasUnsavedChanges() {
  return (
    !!state.dirty ||
    !!(window.Editor && window.Editor.active && window.Editor.hasUnsaved && window.Editor.hasUnsaved())
  );
}

function updateDirtyIndicator() {
  // A leading dot on the window title is the unobtrusive "unsaved" cue; the app
  // name stays visible after the filename.
  const dot = state.dirty ? "● " : "";
  document.title = state.bytes ? `${dot}${state.name || "document.pdf"} — Nabu PDF` : "Nabu PDF";
  // Mirror this tab's label + unsaved state onto the window's tab strip.
  if (window.desktop && window.desktop.setTabMeta) {
    window.desktop.setTabMeta({
      title: state.bytes ? state.name || "document.pdf" : "Trang mới",
      dirty: !!state.dirty,
      // Lets main remember this tab for the next launch. A document with no path
      // (new / never saved) reports null and is simply not part of the session.
      path: state.path || null,
    });
  }
}

function markDirty() {
  state.dirty = true;
  updateDirtyIndicator();
  scheduleAutosave();
}

// Called after a successful real save (Ctrl+S / Save As): the on-disk file now
// matches, so drop the recovery snapshot and the dirty flag.
function markClean() {
  state.dirty = false;
  lastAutosaveLen = -1; // a later edit re-triggers a fresh snapshot
  updateDirtyIndicator();
  clearTimeout(autosaveDebounceTimer);
  if (state.docId && window.desktop.recovery) window.desktop.recovery.clear(state.docId);
}

function scheduleAutosave() {
  clearTimeout(autosaveDebounceTimer);
  autosaveDebounceTimer = setTimeout(autosaveTick, AUTOSAVE_DEBOUNCE_MS);
}

// Write a recovery snapshot if the doc is dirty and its bytes changed since the
// last one. Cheap: reads state.bytes (atomic reference), copies, hands to main.
async function autosaveTick() {
  try {
    if (!state.bytes || !state.dirty || !state.docId || !window.desktop.recovery) return;
    if (state.bytes.length === lastAutosaveLen) return; // nothing new since last snapshot
    const bytes = state.bytes.slice();
    const r = await window.desktop.recovery.save({
      docId: state.docId,
      bytes,
      name: state.name,
      srcPath: state.path,
    });
    if (r && r.saved) lastAutosaveLen = bytes.length;
  } catch (_) {
    /* recovery is best-effort — never let it disrupt the session */
  }
}
if (window.desktop.recovery) setInterval(autosaveTick, AUTOSAVE_INTERVAL_MS);

// On startup, offer to restore anything a previous session left behind (crash /
// power loss). Runs only in a still-empty window and only once per app launch
// (main returns the orphan list to the first asker), so it never fights a window
// that's opening a real file.
// Set when main tells us this tab is earmarked for a document (an "Open with"
// file, or one parked by session restore). Such a tab must not offer to restore
// a crash snapshot into itself: the document is on its way and would overwrite
// it, and the prompt belongs to a tab that is genuinely empty.
let tabReserved = false;
if (window.desktop.onTabReserved) window.desktop.onTabReserved(() => (tabReserved = true));

async function checkRecovery() {
  if (!window.desktop.recovery || state.bytes || tabReserved) return;
  let orphans = [];
  try {
    orphans = (await window.desktop.recovery.scan()) || [];
  } catch (_) {
    return;
  }
  if (!orphans.length || state.bytes) return; // a file may have loaded meanwhile
  const top = orphans[0]; // most recent
  const when = top.savedAt ? new Date(top.savedAt).toLocaleString() : "";
  const extra = orphans.length > 1 ? `\n(và ${orphans.length - 1} tài liệu khác — sẽ hỏi lại lần sau)` : "";
  const ok = await uiConfirm(
    `Tìm thấy tài liệu chưa lưu từ phiên trước:\n"${top.name}"${when ? " — " + when : ""}\n\nKhôi phục?${extra}`,
    { okText: "Khôi phục", cancelText: "Bỏ qua" }
  );
  if (!ok) return; // leave the snapshots for a later launch
  try {
    const rec = await window.desktop.recovery.read(top.docId);
    if (!rec || !rec.ok) {
      toast("Không đọc được bản khôi phục.", "bad");
      return;
    }
    // Restore into this window. Keep the original path so Ctrl+S writes back, but
    // stay dirty: the recovered content differs from whatever is on disk.
    await loadBytes(toU8(rec.bytes), rec.name, rec.srcPath || null);
    await window.desktop.recovery.clear(top.docId); // consumed
    markDirty();
    toast("Đã khôi phục tài liệu chưa lưu — hãy Lưu để ghi vào file.", "good");
  } catch (e) {
    toast("Lỗi khôi phục: " + (e && e.message ? e.message : e), "bad");
  }
}

// ---- breadcrumb (open file path) -----------------------------------------

// Whether the path bar is shown at all (Settings). Default ON: the path is how
// you tell two files with the same name apart. Stored renderer-side like the
// theme, because nothing outside this window needs to know.
const BREADCRUMB_KEY = "nabu-breadcrumb";
function breadcrumbEnabled() {
  try {
    return localStorage.getItem(BREADCRUMB_KEY) !== "0"; // absent = on
  } catch (_) {
    return true; // unreadable storage must not hide the path bar
  }
}
function setBreadcrumbEnabled(on) {
  try {
    localStorage.setItem(BREADCRUMB_KEY, on ? "1" : "0");
  } catch (_) {
    /* the toggle still applies to this session, it just won't be remembered */
  }
  renderBreadcrumb();
}

function renderBreadcrumb() {
  const bar = $("breadcrumb");
  if (!bar) return;
  if (!state.bytes || !breadcrumbEnabled()) {
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
  // Replacing an unsaved document would silently drop its changes — ask first.
  // (First load / recovery restore are clean, so this never fires there.)
  if (docHasUnsavedChanges() && !(await uiConfirm("Tài liệu hiện tại có thay đổi chưa lưu. Bỏ các thay đổi đó và mở tài liệu khác?", { okText: "Bỏ & mở", cancelText: "Ở lại" }))) {
    return;
  }
  state.bytes = toU8(bytes);
  if (name) state.name = name;
  state.path = fullPath || null;
  state.selected.clear();
  state.lastClicked = null;
  // A freshly loaded document is clean and gets its own recovery slot.
  state.dirty = false;
  state.docId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  lastAutosaveLen = -1;
  clearTimeout(autosaveDebounceTimer);
  updateDirtyIndicator();
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
  updateComments(); // refresh the comments badge/panel for the new document
  updateStatusBar();
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
        body: pdfJsonBody(u8, { password: pw }),
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
      return b64ToU8(data.data_b64);
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
  // The .current marker lived on a thumb that innerHTML just deleted, so force
  // syncThumbFocus to re-apply it instead of short-circuiting on a stale index.
  // It is NOT called here: renderAll runs renderThumbs BEFORE renderViewer, so
  // #viewer still holds the previous document's pages and currentPageIndex() would
  // answer for those. renderViewer marks it once its own pages are in place.
  thumbFocusIdx = -1;
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
  // Every page below is built at the current scale, so a zoom repaint still queued
  // from before this rebuild has nothing left to do.
  clearTimeout(scaleCommitTimer);
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

  // Pages are in place now, so "which page am I on" finally has a real answer —
  // mark it in the page list (see the note in renderThumbs about the ordering).
  thumbFocusIdx = -1;
  syncThumbFocus();

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
  const pw = Math.floor(cw * dpr);
  const ph = Math.floor(ch * dpr);
  // While the editor is open, the round-trip text boxes / notes are lifted into
  // the live overlay, so hide their baked PDF appearance here (and let the overlay
  // own the note markers) to avoid drawing them twice.
  const editing = !!(window.Editor && window.Editor.active);
  try {
    // Rasterise into an OFF-SCREEN canvas first, then blit onto the visible one
    // only after render succeeds. Assigning canvas.width clears the canvas, so
    // painting the visible canvas up-front and then failing (e.g. a transient
    // allocation failure after a large edit) used to leave the page blank with no
    // sign of the error. Rendering off-screen keeps the previous bitmap on failure.
    const off = document.createElement("canvas");
    off.width = pw;
    off.height = ph;
    await page.render({
      canvasContext: off.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      annotationMode: editing ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE,
    }).promise;
    canvas.width = pw;
    canvas.height = ph;
    canvas.getContext("2d").drawImage(off, 0, 0);
    // The scale these pixels (and the layers below) were built at. commitScale
    // compares it against state.scale to know which pages are still stretched, and
    // applyScaleToDom scales the note/find layers relative to it.
    m.paintScale = state.scale;
    await addTextLayer(i, m);  // selectable/​highlightable text for text-based pages
    if (!editing) await addNoteMarkers(i, m); // surface baked sticky-note comments (readable in-app)
    if (search.matches.length) drawSearchLayer(i); // repaint find highlights on (re)render
  } catch (err) {
    m.wrap.dataset.rendered = "0"; // let it retry on the next intersection
    // Don't fail silently: a swallowed render error looked exactly like "the page
    // vanished". The visible canvas still holds its previous bitmap (we never
    // cleared it), so the page shows stale-but-present rather than blank.
    console.error("renderPageCanvas: page " + (i + 1) + " render failed", err);
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
  layer.dataset.pscale = String(state.scale); // read by applyScaleToDom during a zoom
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
    // Round-trip notes no longer bake a coloured square into page content, so the
    // marker itself carries the note's colour (from the annotation's /C).
    const col = an.color;
    el.style.background = (col && col.length >= 3)
      ? `rgb(${col[0]|0}, ${col[1]|0}, ${col[2]|0})`
      : "var(--accent)";
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

// ---- comments / notes panel ----------------------------------------------

// Every note in the document. While the overlay editor is active, its live notes
// are the source (unsaved comments included); otherwise the baked PDF Text
// annotations are read per page (their /Contents already folds in replies).
async function collectComments() {
  if (window.Editor && window.Editor.active && window.Editor.getComments) {
    return window.Editor.getComments();
  }
  const out = [];
  if (!state.pdf) return out;
  for (let i = 0; i < state.numPages; i++) {
    let anns;
    try {
      anns = await (await state.pdf.getPage(i + 1)).getAnnotations();
    } catch (_) {
      continue;
    }
    for (const a of anns || []) {
      if (a.subtype !== "Text") continue;
      const text = (a.contentsObj && a.contentsObj.str) || a.contents || "";
      if (!text) continue;
      const col = a.color;
      out.push({
        id: a.id,
        page: i,
        text,
        color: col && col.length >= 3 ? `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})` : null,
      });
    }
  }
  return out;
}

function renderCommentsList(items) {
  const list = $("comments-list");
  const emptyEl = $("comments-empty");
  const countEl = $("comments-count");
  if (!list) return;
  list.innerHTML = "";
  if (countEl) countEl.textContent = items.length ? `(${items.length})` : "";
  if (emptyEl) emptyEl.hidden = items.length > 0;
  for (const it of items) {
    const el = document.createElement("button");
    el.className = "comment-item";
    el.type = "button";
    const meta = document.createElement("div");
    meta.className = "cmt-meta";
    if (it.color) {
      const d = document.createElement("span");
      d.className = "cmt-dot";
      d.style.background = it.color;
      meta.appendChild(d);
    }
    const pg = document.createElement("span");
    pg.className = "cmt-page";
    pg.textContent = "Trang " + (it.page + 1);
    meta.appendChild(pg);
    const rc = (it.replies || []).length;
    if (rc) {
      const r = document.createElement("span");
      r.className = "cmt-replies";
      r.textContent = rc + " trả lời";
      meta.appendChild(r);
    }
    el.appendChild(meta);
    const txt = document.createElement("div");
    txt.className = "cmt-text";
    txt.textContent = it.text || "(ghi chú trống)";
    el.appendChild(txt);
    el.onclick = () => {
      if (window.Editor && window.Editor.active && window.Editor.focusNote) window.Editor.focusNote(it.id);
      else scrollToPage(it.page);
    };
    list.appendChild(el);
  }
}

// Refresh the toolbar count badge and, if the panel is open, its list. Cheap to
// call after any note change / doc load (pdf.js caches getAnnotations per page).
async function updateComments() {
  const items = await collectComments();
  const bb = $("btn-comments-count");
  if (bb) {
    bb.hidden = !items.length;
    bb.textContent = String(items.length);
  }
  const panel = $("comments-panel");
  if (panel && !panel.hidden) renderCommentsList(items);
}
// editor.js calls this (via window) after a note is added/edited/baked.
window.updateComments = updateComments;

function toggleComments(force) {
  const panel = $("comments-panel");
  const btn = $("btn-comments");
  if (!panel) return;
  const show = force !== undefined ? force : panel.hidden;
  panel.hidden = !show;
  if (btn) btn.classList.toggle("active", show);
  if (show) {
    if (!$("ext-panel").hidden) $("ext-panel").hidden = true; // don't stack the two right panels
    updateComments();
  }
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
  layer.dataset.pscale = String(state.scale); // read by applyScaleToDom during a zoom
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

// Repaint every on-screen page in place — used by the editor when entering/leaving
// edit mode, where the same bytes must be re-rasterised with annotations toggled
// (managed text/notes are hidden while editing, shown in view mode). Off-screen
// pages repaint lazily when scrolled to, so this stays bounded.
async function repaintRenderedPages() {
  if (!state.pageMetas) return;
  for (let i = 0; i < state.numPages; i++) {
    const m = state.pageMetas[i];
    if (m && m.wrap && m.wrap.dataset.rendered === "1") {
      m.wrap.dataset.rendered = "0";
      await renderPageCanvas(i);
    }
  }
}
window.repaintRenderedPages = repaintRenderedPages;

// Repaint a single thumbnail in place (used by the targeted re-render above).
async function refreshThumb(i) {
  const div = $("thumbs").querySelector(`.thumb[data-index="${i}"]`);
  if (!div) return;
  div.dataset.rendered = "0"; // force a repaint of the (possibly stale) thumbnail
  await renderThumbCanvas(i);
}

// Index of the page currently occupying the top of the viewport — the topmost
// page whose top edge has reached (scrolled at/above) the viewport top. Used by
// the ↑/↓ page-jump keys. Falls back to 0 when scrolled above the first page.
function currentPageIndex() {
  const v = $("viewer");
  const vr = v.getBoundingClientRect();
  let cur = 0;
  for (const w of v.querySelectorAll(".page-wrap")) {
    if (w.getBoundingClientRect().top - vr.top <= 2) cur = +w.dataset.index;
    else break;
  }
  return cur;
}

function scrollToPage(i) {
  // Eager-render the jump target so a sidebar click feels instant instead of
  // waiting for the observer to catch up.
  renderPageCanvas(i);
  const el = $("viewer").querySelector(`.page-wrap[data-index="${i}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- sidebar follows the page you are reading ----------------------------
//
// Acrobat/Foxit both keep the page list in step with the view: scroll the document
// and the matching thumbnail highlights and slides into the panel. This is the
// read-only half of that contract — it marks the CURRENT page but never touches
// `state.selected`, so scrolling past a page can't quietly re-aim "Xoá trang" /
// "Tách trang" at it (BI-26). Selection stays a thing you do with a click.

// How far a scroll container must move (px, positive = down) for `el` to sit fully
// inside it, "nearest"-style: 0 when it already does. Deliberately arithmetic
// rather than el.scrollIntoView() — that also scrolls ANCESTORS and animates, so it
// fought both the viewer's own smooth scroll and the thumbnail reorder drag.
function nearestScrollDelta(viewTop, viewBottom, elTop, elBottom, pad) {
  const p = pad || 0;
  if (elTop < viewTop + p) return elTop - (viewTop + p);
  if (elBottom > viewBottom - p) return elBottom - (viewBottom - p);
  return 0;
}

let thumbFocusIdx = -1;

// Highlight the thumbnail of the page at the top of the viewport and bring it into
// the panel. Cheap enough for the scroll path: it exits on the first line unless
// the page actually changed.
function syncThumbFocus() {
  if (!state.numPages) return;
  const i = currentPageIndex();
  if (i === thumbFocusIdx) return;
  thumbFocusIdx = i;
  const wrap = $("thumbs");
  if (!wrap) return;
  const prev = wrap.querySelector(".thumb.current");
  if (prev) prev.classList.remove("current");
  const el = wrap.querySelector(`.thumb[data-index="${i}"]`);
  if (!el) return;
  el.classList.add("current");
  // Never move the list out from under a reorder drag — wireThumb picks the insert
  // gap from the cursor's Y against a thumb's midpoint (BI-33), and scrolling
  // mid-drag would change which gap that is.
  if (state.dragSrc != null) return;
  const wr = wrap.getBoundingClientRect();
  if (!wr.height) return; // panel collapsed / hidden — nothing to scroll
  const er = el.getBoundingClientRect();
  const d = nearestScrollDelta(wr.top, wr.bottom, er.top, er.bottom, 12);
  if (d) wrap.scrollTop += d;
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

  div.addEventListener("contextmenu", (e) => openThumbMenu(e, i));

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

// ---- thumbnail right-click menu ------------------------------------------
//
// Page management where the pages actually are, so the common operations don't
// need a trip to the toolbar. It reuses the ONE in-page menu widget owned by
// capture.js (window.Capture.showMenu) — same look, same dismiss rules, and
// opening this one closes the page menu and vice versa.
//
// Licence gating here is at the FUNCTION level (addBlankPageAt / insertFileAt /
// extractSelected / openSplit all call gateProFeature() themselves). These are
// generated <div>s, not <button id=…>, so the GATED_BTNS capture guard cannot
// see them — same arrangement as drag-drop insert. See BI-26.
function openThumbMenu(e, i) {
  if (!state.bytes || !state.numPages) return;
  // Page structure is frozen while annotating / text-editing, exactly as the
  // toolbar is (updateToolbar) — offering the commands here would be a lie.
  if ((window.Editor && window.Editor.active) || (window.TextEdit && window.TextEdit.active)) return;
  if (!(window.Capture && window.Capture.showMenu)) return; // capture.js absent → native menu
  e.preventDefault();
  e.stopPropagation();

  // Right-clicking OUTSIDE the current selection acts on that one page (the
  // convention everywhere from Explorer to Acrobat); right-clicking INSIDE it
  // keeps the multi-page selection intact.
  if (!state.selected.has(i)) {
    state.selected.clear();
    state.selected.add(i);
    state.lastClicked = i;
    refreshSelectionUI();
    updateToolbar();
  }

  const sel = [...state.selected].sort((a, b) => a - b);
  const many = sel.length > 1;
  const tr = (vi, params) => (window.t ? window.t(vi, params) : vi);
  // Deleting every page is refused by deletePages(); grey it out up front rather
  // than letting the user pick a command that can only fail.
  const canDelete = sel.length < state.numPages;

  window.Capture.showMenu(e.clientX, e.clientY, [
    {
      header: many
        ? tr("{n} trang đang chọn", { n: sel.length })
        : tr("Trang {n}", { n: i + 1 }),
    },
    { label: tr("Xoay trái 90°"), onClick: () => rotateSelected(-90) },
    { label: tr("Xoay phải 90°"), onClick: () => rotateSelected(90) },
    { separator: true },
    { label: tr("Thêm trang trắng phía trên"), onClick: () => addBlankPageAt(i) },
    { label: tr("Thêm trang trắng phía dưới"), onClick: () => addBlankPageAt(i + 1) },
    { label: tr("Chèn PDF khác phía dưới…"), onClick: () => insertFileAt(i + 1) },
    { separator: true },
    {
      label: many ? tr("Tách các trang đang chọn ra file mới…") : tr("Tách trang này ra file mới…"),
      onClick: () => extractSelected(),
    },
    { label: tr("Tách thành nhiều file…"), onClick: () => openSplit() },
    { separator: true },
    {
      label: many ? tr("Xoá các trang đang chọn") : tr("Xoá trang này"),
      enabled: canDelete,
      danger: true,
      onClick: () => deleteSelected(),
    },
    {
      label: tr("Xoá nhiều trang theo khoảng…"),
      danger: true,
      onClick: () => openDeleteRange(),
    },
  ]);
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

// Core page removal, shared by the sidebar selection / Delete key (deleteSelected),
// the thumbnail page menu, and "Xoá nhiều trang theo khoảng". `indices` are 0-based
// in any order; duplicates and out-of-range values are dropped. Returns true when
// the document actually changed. Removal runs high→low so earlier removals can't
// shift the indices still to be removed.
async function deletePages(indices) {
  if (!state.bytes) return false;
  const uniq = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < state.numPages);
  if (!uniq.length) {
    toast("Không có trang nào để xóa.", "bad");
    return false;
  }
  if (uniq.length >= state.numPages) {
    toast("Không thể xóa tất cả trang.", "bad");
    return false;
  }
  showOverlay("Đang xóa…");
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes);
    uniq.sort((a, b) => b - a).forEach((i) => doc.removePage(i));
    state.bytes = await doc.save();
    state.selected.clear();
    await renderAll();
    return true;
  } finally {
    hideOverlay();
  }
}

async function deleteSelected() {
  if (state.selected.size === 0) {
    toast("Tick chọn trang cần xóa trước.", "bad");
    return;
  }
  await deletePages([...state.selected]);
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

// Same as insertFile, minus the position dialog: the page menu already knows
// where the user right-clicked, so asking again would be a pointless step.
async function insertFileAt(at) {
  if (gateProFeature()) return;
  const files = await window.desktop.openPdf({ multi: false });
  if (!files.length) return;
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
  await addBlankPageAt(at);
}

// Insert one blank page at a known index (0 = before page 1). Split out of
// addBlankPage so the thumbnail page menu can drop a page directly above/below
// the page under the cursor without going through the position dialog.
async function addBlankPageAt(at) {
  if (gateProFeature()) return;
  if (!state.bytes) return;
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
    // Naming every page is unbounded — ~80 pages already exceeds the 255-character
    // limit Windows puts on a filename, and this string becomes the Save dialog's
    // defaultPath. extractFileName keeps the explicit list while it fits and falls
    // back to a summary; covered by desktop/test/page-range.test.js.
    const name = window.PageRange.extractFileName(baseName(state.name), order);
    const res = await window.desktop.savePdf(bytes, name);
    if (res.saved) toast("Đã lưu: " + res.path, "good");
  } finally {
    hideOverlay();
  }
}

// ---- delete a page range, minus exceptions -------------------------------
//
// "Xoá từ trang X đến trang Y, trừ Z" — for the common case of dropping a long
// stretch of pages, where ticking 60 checkboxes is the wrong interaction. The
// arithmetic lives in page-range.js (DOM-free, covered by
// desktop/test/page-range.test.js) because an off-by-one here deletes the wrong
// page of a real document.

function openDeleteRange() {
  if (!state.bytes || !state.numPages) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  const from = $("delrange-from");
  const to = $("delrange-to");
  const ex = $("delrange-except");
  from.max = to.max = String(state.numPages);
  // Seed from the current selection: right-clicking page 12 and choosing this
  // should start at page 12, not page 1.
  const sel = [...state.selected].sort((a, b) => a - b);
  from.value = String(sel.length ? sel[0] + 1 : 1);
  to.value = String(sel.length ? sel[sel.length - 1] + 1 : state.numPages);
  ex.value = "";
  syncDeleteRange();
  $("delrange-modal").hidden = false;
  from.focus();
  from.select();
}

// Live summary under the fields + the OK gate. Returns the computed result so
// runDeleteRange acts on exactly what the user was shown.
function syncDeleteRange() {
  const el = $("delrange-preview");
  const ok = $("delrange-ok");
  const r = window.PageRange.computeRange(
    $("delrange-from").value,
    $("delrange-to").value,
    $("delrange-except").value,
    state.numPages
  );
  ok.disabled = !!r.error;
  el.classList.toggle("is-bad", !!r.error);
  if (r.error === "all") {
    el.textContent = t("Không thể xoá tất cả trang — phải giữ lại ít nhất 1 trang.");
  } else if (r.error) {
    el.textContent = t("Không có trang nào để xoá — kiểm tra lại khoảng trang.");
  } else {
    el.textContent = t("Sẽ xoá {n} trang: {list} · còn lại {kept} trang.", {
      n: r.indices.length,
      list: window.PageRange.formatList(r.indices),
      kept: r.kept,
    });
  }
  return r;
}

async function runDeleteRange() {
  const r = syncDeleteRange();
  if (r.error) return; // the preview already says why; leave the dialog open
  const n = r.indices.length;
  $("delrange-modal").hidden = true;
  if (await deletePages(r.indices)) {
    toast(`Đã xóa ${n} trang. Ctrl+Z để hoàn tác.`, "good");
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
      markClean();
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
    markClean();
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

// Large-format guard. For normal source pages 150 DPI is cheap (A4 ≈ 2.2 MP), but
// a large-format *source* PDF — the actual A0–A2 use case (CAD drawings, posters)
// — explodes: an A0 page at 150 DPI is ~35 MP ≈ 140 MB of canvas, and EVERY page
// is held in #print-root at once → renderer OOM on multi-page jobs. So we cap each
// page's raster by a pixel-area budget: pages under budget (A5–A2) render at the
// full 150 DPI unchanged; only larger sheets have their DPI eased down enough to
// stay memory-safe (A1 ≈ 124 DPI, A0 ≈ 88 DPI — still crisp at large-sheet viewing
// distance). MAX_PRINT_SIDE_PX is a second guard against Chromium's canvas
// dimension limit / toDataURL failures on extreme aspect ratios.
const MAX_PRINT_MEGAPIXELS = 12;
const MAX_PRINT_SIDE_PX = 10000;

// Render scale for a page whose size (at scale 1) is vpW1×vpH1 CSS px (== PDF pt):
// the smallest of the 150-DPI scale, the area-budget scale, and the side-cap scale.
// Never upscales beyond 150 DPI.
function printScaleFor(vpW1, vpH1) {
  const baseScale = PRINT_DPI / 72;
  const areaScale = Math.sqrt((MAX_PRINT_MEGAPIXELS * 1e6) / (vpW1 * vpH1));
  const sideScale = MAX_PRINT_SIDE_PX / Math.max(vpW1, vpH1);
  return Math.min(baseScale, areaScale, sideScale);
}

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
  const total = doc.numPages;
  try {
    for (let i = 1; i <= total; i++) {
      // Show progress so multi-page large-format jobs don't look frozen. Let the
      // overlay repaint before the (main-thread) render/encode work of this page.
      showOverlay(t("Đang chuẩn bị in… (trang {n}/{total})", { n: i, total }));
      await new Promise((r) => setTimeout(r, 0));

      const page = await doc.getPage(i);
      // Base viewport (scale 1) → page size in pt; pick a memory-safe raster scale.
      const vp1 = page.getViewport({ scale: 1 }); // honours page rotation
      const scale = printScaleFor(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const img = document.createElement("img");
      img.className = "print-page";
      img.src = canvas.toDataURL("image/png");
      root.appendChild(img);
      // Release the canvas backing store now (up to `total` of these, each up to
      // ~48 MB for a capped large sheet) — don't wait for GC while we build the rest.
      canvas.width = canvas.height = 0;
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
//
// See `applyScaleToDom` / `commitScale` further down for how a zoom is applied.

// Reflect state.scale in the editable zoom box (unless the user is mid-typing).
function syncZoomInput() {
  const z = $("zoom-input");
  if (z && document.activeElement !== z) z.value = Math.round(state.scale * 100) + "%";
  updateStatusBar();
}

// Reflect the current page (topmost in the viewport) in the page-nav box, and the
// total in the "/ N" readout. Skipped while the input is focused (user is typing).
function syncPageInput() {
  const pi = $("page-input");
  const pt = $("page-total");
  const total = state.numPages || 0;
  if (pt) pt.textContent = "/ " + total;
  if (pi && document.activeElement !== pi) pi.value = total ? String(currentPageIndex() + 1) : "1";
  updateStatusBar();
}

// Jump to a 1-based page number, clamped to the document.
function gotoPageNumber(n) {
  const total = state.numPages || 0;
  if (!total) return;
  const i = Math.max(0, Math.min(total - 1, (n | 0) - 1));
  scrollToPage(i);
}

// Bottom status bar: current page · page size (mm) · zoom. Cheap; called from
// the same scroll/zoom paths that refresh the page & zoom inputs.
function updateStatusBar() {
  const sb = $("statusbar");
  if (!sb) return;
  const has = !!state.bytes && state.numPages > 0;
  sb.hidden = !has;
  if (!has) return;
  const i = currentPageIndex();
  const p = $("sb-page");
  if (p) p.textContent = `Trang ${i + 1} / ${state.numPages}`;
  const z = $("sb-zoom");
  if (z) z.textContent = Math.round(state.scale * 100) + "%";
  const m = state.pageMetas && state.pageMetas[i];
  const sz = $("sb-size");
  if (sz && m && m.vp) {
    const wmm = Math.round((m.vp.width * 25.4) / 72);
    const hmm = Math.round((m.vp.height * 25.4) / 72);
    sz.textContent = `${wmm} × ${hmm} mm`;
  } else if (sz) {
    sz.textContent = "";
  }
}

// ---- sidebar width (drag to resize) --------------------------------------
//
// Acrobat/Foxit both let you widen the page list; a fixed 180px is the one place
// this viewer was plainly behind them. Widening it makes the thumbnails big
// enough to actually read a page from, which is the whole point of the panel.
//
// Deliberately single-column at every width. Reflowing into a grid (what Acrobat
// does) would break the drag-to-insert cue: `wireThumb`'s dragover picks
// above-vs-below from `e.clientY` against the thumb's vertical midpoint, and a
// grid makes "above/below" the wrong question. Getting that wrong inserts pages
// at the wrong index — see BI-26/BI-27 on how expensive page-position bugs are.
const SIDEBAR_W_KEY = "nabu-sidebar-w";
const SIDEBAR_W_DEFAULT = 180;
const SIDEBAR_W_MIN = 130; // below this a thumbnail is too small to recognise
// The ceiling is set by the THUMBNAIL RASTER, not by taste: renderThumbCanvas
// rasterises every thumbnail 150px wide, so a wider panel just upscales that one
// bitmap. At 300px the thumb draws ~252px (1.7× — soft but perfectly readable for
// telling pages apart); much past that it turns mushy.
// Raising the raster instead is NOT free: thumbnails are rendered lazily but are
// never freed, so a doc with hundreds of pages pays for every one it has scrolled
// past. Widening the raster to match a 420px panel would roughly quadruple that
// bill. Sharper thumbnails at wide panels = re-rasterise on resize, deliberately
// left as a follow-up rather than bundled into a layout change.
const SIDEBAR_W_MAX = 300;

// Clamp a requested width. The window ceiling matters on small laptops: a 420px
// panel on a 1280px screen would leave the page a slot it can't be read in.
function clampSidebarWidth(px) {
  const ceiling = Math.min(SIDEBAR_W_MAX, Math.round(window.innerWidth * 0.4));
  return Math.max(SIDEBAR_W_MIN, Math.min(ceiling, Math.round(px)));
}

function applySidebarWidth(px, persist) {
  const w = clampSidebarWidth(px);
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(w));
    } catch (_) {
      /* the width still applies to this session, it just won't be remembered */
    }
  }
  return w;
}

// Restore on start. A stored width that is now too wide (smaller screen than last
// time) is clamped rather than honoured, so the panel can never open bigger than
// the window it has to fit in.
function initSidebarWidth() {
  let saved = null;
  try {
    saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || "", 10);
  } catch (_) {
    /* unreadable storage — fall through to the default */
  }
  applySidebarWidth(saved && !isNaN(saved) ? saved : SIDEBAR_W_DEFAULT, false);
}

// Collapse / expand the thumbnail sidebar (toggle, or force a state).
function toggleSidebar(collapse) {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  const c = collapse !== undefined ? collapse : !ws.classList.contains("sidebar-collapsed");
  ws.classList.toggle("sidebar-collapsed", c);
  const exp = $("sidebar-expand");
  if (exp) exp.hidden = !c;
}

// Floor for the "fit …" commands only. Free zoom keeps its 40% floor (typing 10%
// by accident should not be possible), but a fit is an explicit request for a
// computed scale: on A0/A1 drawings the whole page simply does not fit above 40%,
// and clamping there silently failed to do what the button says.
const FIT_MIN_SCALE = 0.08;

// Free-zoom floor / ceiling (the zoom box advertises 40–300%).
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;

// ---- how a zoom is applied (two halves) ----------------------------------
//
// Zooming used to be one call to renderViewer(), which removes EVERY .page-wrap,
// rebuilds each canvas, reconnects both IntersectionObservers and re-rasterises —
// per wheel notch. That is what made zoom feel like it stuttered: each notch paid
// an O(pages) DOM rebuild *before* anything moved on screen, and the old `zooming`
// re-entrancy guard silently dropped every notch that arrived while it ran, so a
// fast scroll-wheel turn also lost steps.
//
// Acrobat/Foxit split the job in two, and so do we now:
//   1. applyScaleToDom() — SYNCHRONOUS and cheap: only the CSS box of each page
//      (and of the overlay layers) is resized, so the compositor stretches the
//      bitmap that is already on screen. The page tracks the wheel with no
//      per-pixel work — slightly soft mid-gesture, exactly like the reference apps.
//   2. commitScale() — DEBOUNCED by SCALE_COMMIT_MS: once the user pauses (i.e. has
//      settled on a zoom level) the pages inside the keep window are re-rasterised
//      at the true scale, which is also what rebuilds their text / note / find
//      layers crisply.
// Nothing here creates or destroys a .page-wrap, so the annotation overlay, an open
// inline text editor, the find highlights and the scroll geometry all survive a
// zoom untouched — which the old teardown could not promise.
const SCALE_COMMIT_MS = 160;
let scaleCommitTimer = null;
let scaleCommitting = false;
let scaleCommitPending = false;

// Resize every page (and its overlays) to state.scale without rasterising anything.
function applyScaleToDom() {
  const metas = state.pageMetas;
  if (!metas || !metas.length) return;
  const s = state.scale;
  for (const m of metas) {
    if (!m || !m.page || !m.wrap) continue;
    m.vp = m.page.getViewport({ scale: s }); // synchronous — the page dict is parsed already
    m.cw = Math.floor(m.vp.width);
    m.ch = Math.floor(m.vp.height);
    m.canvas.style.width = m.cw + "px";
    m.canvas.style.height = m.ch + "px"; // stretches the existing bitmap; commitScale repaints it
    // pdf.js 3.x writes span positions as `calc(var(--scale-factor) * Npx)`, so the
    // whole text layer re-lays itself out from this one variable — selection and
    // Ctrl+F highlighting stay aligned mid-gesture with no re-render.
    const tl = m.wrap.querySelector(".text-layer");
    if (tl) {
      tl.style.width = m.cw + "px";
      tl.style.height = m.ch + "px";
      tl.style.setProperty("--scale-factor", String(s));
    }
    // Note markers and find highlights are positioned in absolute px derived from
    // the viewport they were painted with, so they cannot follow a CSS variable.
    // Scale them from that paint scale instead — deliberately WITHOUT touching
    // width/height, because the transform already resizes the box. commitScale
    // rebuilds them exactly and the transform dies with the replaced element.
    for (const sel of [".note-layer", ".search-layer"]) {
      const l = m.wrap.querySelector(sel);
      if (!l) continue;
      // Each layer carries the scale IT was built at — not the page's, because
      // gotoMatch can rebuild the find layer on its own between two zoom steps.
      const built = +l.dataset.pscale || m.paintScale || s;
      const k = s / built;
      l.style.transformOrigin = "0 0";
      l.style.transform = k === 1 ? "" : "scale(" + k + ")";
    }
  }
  // Both redraw their own boxes from state.scale, synchronously.
  if (window.Editor) window.Editor.syncOverlays();
  if (window.TextEdit) window.TextEdit.syncOverlays();
}

// Re-rasterise the pages that are currently painted, at the settled scale. Pages
// outside the keep window are skipped: they hold no bitmap and repaint lazily.
async function commitScale() {
  if (scaleCommitting) {
    scaleCommitPending = true; // the running pass will loop again
    return;
  }
  scaleCommitting = true;
  try {
    do {
      scaleCommitPending = false;
      const metas = state.pageMetas;
      if (!metas) break;
      for (let i = 0; i < metas.length; i++) {
        const m = metas[i];
        if (!m || !m.wrap || m.wrap.dataset.rendered !== "1") continue;
        if (m.paintScale === state.scale) continue; // already crisp at this scale
        m.wrap.dataset.rendered = "0";
        await renderPageCanvas(i); // reads the m.vp applyScaleToDom just set
      }
    } while (scaleCommitPending);
  } finally {
    scaleCommitting = false;
  }
}

function scheduleScaleCommit() {
  clearTimeout(scaleCommitTimer);
  scaleCommitTimer = setTimeout(commitScale, SCALE_COMMIT_MS);
}

// One wheel notch in Chromium is deltaY ≈ ±100. The step is MULTIPLICATIVE, like
// Acrobat/Foxit and every browser: the old fixed ±0.1 was a 25% jump at 40% zoom
// and a 3% nudge at 300%, which is most of why zooming felt uneven. Clamped to ±3
// notches so one violent fling cannot teleport across the range, and kept
// proportional to |deltaY| so a trackpad pinch (many small deltas) stays smooth.
const ZOOM_WHEEL_BASE = 1.1;
function wheelZoomFactor(deltaY) {
  const notches = Math.max(-3, Math.min(3, -(+deltaY || 0) / 100));
  return Math.pow(ZOOM_WHEEL_BASE, notches);
}

// Zoom to an absolute scale. `anchor` = client {x,y} to keep visually fixed
// (Ctrl+wheel zooms toward the cursor); defaults to the viewer centre.
// `opts.min` lowers the floor for the fit commands (see FIT_MIN_SCALE).
// Stays `async` on purpose: ~10 call sites await it (BI-14).
async function zoomTo(next, anchor, opts) {
  if (!state.bytes) return;
  const min = opts && opts.min ? opts.min : ZOOM_MIN;
  // Quantised to 3 decimals, not 2: the wheel steps multiplicatively now, and a
  // 2-decimal floor swallowed the small steps a trackpad pinch sends (they
  // rounded straight back to the current scale, so the gesture felt dead).
  next = Math.min(ZOOM_MAX, Math.max(min, Math.round(+next * 1000) / 1000));
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
  if (!state.pageMetas || !state.pageMetas.length) return; // nothing rendered yet
  applyScaleToDom();
  // Keep the document point that was under the anchor in place. Assigning scroll
  // flushes layout, so the resize above is already in effect.
  v.scrollLeft = (sl + ax) * ratio - ax;
  v.scrollTop = (st + ay) * ratio - ay;
  scheduleScaleCommit();
}

async function zoom(delta) {
  await zoomTo(state.scale + delta);
}

// Reset zoom to 100% (Ctrl+0).
async function zoomReset() {
  await zoomTo(1);
}

// Largest page dimensions at scale 1 ({w,h}), or null when nothing is loaded.
// pageMetas holds viewports at the CURRENT scale, hence the division.
function maxPageSize1() {
  if (!state.bytes || !state.pageMetas || !state.pageMetas.length) return null;
  let w = 0;
  let h = 0;
  for (const m of state.pageMetas) {
    w = Math.max(w, m.vp.width / state.scale);
    h = Math.max(h, m.vp.height / state.scale);
  }
  return w && h ? { w, h } : null;
}

// Fit the widest page to the viewer width (like the compare view).
async function fitWidth() {
  const m = maxPageSize1();
  if (!m) return;
  const pad = 48; // page margins + scrollbar allowance
  await zoomTo(($("viewer").clientWidth - pad) / m.w, null, { min: FIT_MIN_SCALE });
}

// Fit the tallest page to the viewer height (handy for landscape docs).
async function fitHeight() {
  const m = maxPageSize1();
  if (!m) return;
  const pad = 48; // top/bottom margins allowance
  await zoomTo(($("viewer").clientHeight - pad) / m.h, null, { min: FIT_MIN_SCALE });
}

// Fit a WHOLE page inside the viewer — both dimensions, so nothing is cut off.
// This is what "xem trọn trang" means, and what full-screen reading mode uses.
async function fitPage() {
  const m = maxPageSize1();
  if (!m) return;
  const v = $("viewer");
  const cs = getComputedStyle(v);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 8;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + 8;
  const s = Math.min((v.clientWidth - padX) / m.w, (v.clientHeight - padY) / m.h);
  await zoomTo(s, null, { min: FIT_MIN_SCALE });
}

// ---- full-screen reading mode -------------------------------------------
//
// Two halves that must stay in step:
//   • main (src/tabs.js) puts the WINDOW full screen and collapses the tab strip;
//   • this file hides the in-page chrome and fits a whole page on screen.
// Main is the single source of truth — every entry point asks main to toggle, and
// only main's reply flips the class here. That way leaving full screen by any
// other route (window controls, OS gesture) can't leave the UI stranded with its
// toolbar hidden.
const present = { on: false, prevScale: null };

function presentAvailable() {
  const editing =
    !!(window.Editor && window.Editor.active) || !!(window.TextEdit && window.TextEdit.active);
  return !!state.bytes && state.numPages > 0 && !editing;
}

// Ask main to toggle. Returns silently when the bridge is missing (browser tests).
async function togglePresentation(on) {
  const want = on === undefined ? !present.on : !!on;
  if (want && !presentAvailable()) return;
  if (!window.desktop || !window.desktop.setPresentation) {
    applyPresentation(want); // no main process (test harness) — do it locally
    return;
  }
  try {
    await window.desktop.setPresentation(want);
  } catch (_) {
    /* main will not answer; leave the UI as it is rather than guessing */
  }
}

// Apply what main says the window is doing now.
async function applyPresentation(on) {
  if (present.on === !!on) return;
  present.on = !!on;
  document.body.classList.toggle("presenting", present.on);
  const hud = $("present-hud");
  if (hud) hud.hidden = !present.on;
  const btn = $("btn-presentation");
  if (btn) btn.classList.toggle("active", present.on);
  if (present.on) {
    present.prevScale = state.scale;
    // The sidebar is deliberately NOT collapsed here any more: in this mode the
    // CSS turns it into an off-screen overlay (position:absolute + transform), so
    // it costs no layout width and fitPage() still measures the full window —
    // while the page list stays one mouse-move away at the left edge.
    await fitPage();
    updatePresentHud();
  } else {
    document.body.classList.remove("rail-open", "rail-pinned");
    const back = present.prevScale;
    present.prevScale = null;
    if (back) await zoomTo(back);
  }
}

// Page counter inside the floating chip (the status bar is hidden in this mode).
function updatePresentHud() {
  if (!present.on) return;
  const el = $("present-page");
  if (el) el.textContent = `${currentPageIndex() + 1} / ${state.numPages}`;
}

// Parse whatever is in the zoom box ("150", "150%", " 150 ") and apply it.
function applyZoomInput() {
  const n = parseInt(($("zoom-input").value || "").replace(/[^\d]/g, ""), 10);
  if (!n) {
    syncZoomInput();
    return;
  }
  // Already showing the current scale (the box was focused and left untouched):
  // do nothing. Without this, a "fit" that landed below the typed floor of 40%
  // would be snapped back up by a stray blur.
  if (n === Math.round(state.scale * 100)) return;
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
  // Claim the slot BEFORE awaiting. applySidecar() runs twice at boot (the initial
  // getSidecarStatus and the pushed status event), and a guard that is only set
  // after the await lets both calls through — two /templates round-trips for one
  // list. Cleared again on failure so a later open still retries.
  templatesLoaded = true;
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
  } catch (_) {
    templatesLoaded = false; // sidecar may not be ready; retry on next open
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
    const bytes = b64ToU8(data.data_b64);
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

// pdfJsonBody / binArrayJsonBody / b64ToU8 — and the 3-byte chunk rule behind
// them — moved to renderer/wire.js so they could get an automated grid. Same
// shared script scope, so the bare names used below are the same functions they
// always were (BI-14/BI-24).

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
      body: pdfJsonBody(state.bytes, {}),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tạo searchable lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = b64ToU8(data.data_b64);
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
      body: pdfJsonBody(state.bytes, {
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
    const bytes = b64ToU8(data.data_b64);
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

// ---- PDF -> Office (Word/Excel/CSV) --------------------------------------

function openOffice() {
  if (sidecar.state !== "ready" || !sidecar.base) {
    toast("Engine chưa sẵn sàng.", "bad");
    return;
  }
  if (!state.bytes) {
    toast("Mở PDF trước.", "bad");
    return;
  }
  // "Selected pages" only makes sense when a selection exists; default to all.
  const sc = $("office-scope");
  const selOpt = sc && sc.querySelector('option[value="selected"]');
  if (selOpt) selOpt.disabled = state.selected.size === 0;
  if (sc && state.selected.size === 0) sc.value = "all";
  $("office-modal").hidden = false;
}

async function runOffice() {
  $("office-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending(); // fold pending annotations in first

  const fmt = $("office-format").value || "xlsx";
  const scopeKind = $("office-scope").value || "all";
  let scope = "all";
  if (scopeKind === "selected" && state.selected.size > 0) {
    scope = Array.from(state.selected).sort((a, b) => a - b);
  }

  showOverlay("Đang chuyển sang Office…");
  try {
    const res = await sidecarFetch("/pdf-to-office", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: pdfJsonBody(state.bytes, { format: fmt, scope }),
    });
    const data = await res.json();
    if (!data.success) {
      const msg = data.is_scan
        ? 'PDF này là bản scan (không có text thật) — hãy chạy "OCR văn bản" trong Công cụ trước rồi thử lại.'
        : "Xuất Office lỗi: " + (data.error || data.detail || "không rõ");
      toast(msg, "bad");
      return;
    }
    const bytes = b64ToU8(data.data_b64);
    const name = `${baseName(state.name)}.${fmt}`;
    const r = await window.desktop.saveFile(bytes, name, [{ name: fmt.toUpperCase(), extensions: [fmt] }]);
    if (r.saved) toast("Đã xuất: " + r.path, "good");
  } catch (err) {
    toast("Lỗi xuất Office: " + err.message, "bad");
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
      body: pdfJsonBody(state.bytes, { preset }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Nén lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const pct = data.original_size
      ? Math.round((100 * data.compressed_size) / data.original_size)
      : 100;
    const bytes = b64ToU8(data.data_b64);
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
      body: pdfJsonBody(state.bytes, {
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
    const bytes = b64ToU8(data.data_b64);
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
      body: pdfJsonBody(state.bytes, {}),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Xuất ảnh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = b64ToU8(data.data_b64);
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
      body: pdfJsonBody(state.bytes, { dpi, format }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Chuyển ảnh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = b64ToU8(data.data_b64);
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
  // Options only. The bytes are read AFTER bakePending() below — reading them here
  // would split the document as it was before the pending annotations were baked in.
  const fields = { mode };
  if (mode === "ranges") {
    const ranges = ($("split-ranges").value || "").trim();
    if (!ranges) {
      toast("Nhập khoảng trang (vd: 1-3,5,8-10).", "bad");
      return;
    }
    fields.ranges = ranges;
  } else {
    fields.size = Math.max(1, parseInt($("split-size").value, 10) || 1);
  }
  $("split-modal").hidden = true;
  if (window.Editor) await window.Editor.bakePending();
  showOverlay("Đang tách PDF…");
  try {
    const res = await sidecarFetch("/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: pdfJsonBody(state.bytes, fields),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tách PDF lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    const bytes = b64ToU8(data.data_b64);
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
// Picked images, in order. Held as RAW BYTES, not base64: the dialog can stay
// open for a while, and base64 is 4/3 the size for no benefit until send time.
let i2pImages = []; // [{ name, data: Uint8Array }]

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
    i2pImages.push({ name: f.name, data: toU8(f.data) });
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
      body: binArrayJsonBody("images", i2pImages.map((x) => x.data), { page_size }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Tạo PDF lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return; // keep the picked images so the user can just retry
    }
    const bytes = b64ToU8(data.data_b64);
    const r = await window.desktop.savePdf(bytes, "images-to-pdf.pdf");
    if (r.saved) toast(`Đã tạo PDF ${data.pages} trang từ ảnh: ` + r.path, "good");
    // Done with them — a photo batch is hundreds of MB to sit on until the
    // dialog is next opened (which is the only other place this is reset).
    i2pImages = [];
    updateI2pUI();
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
      body: pdfJsonBody(state.bytes, { fmt, position, start_at, skip_first, font_size, color }),
    });
    const data = await res.json();
    if (!data.success) {
      toast("Đánh số lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    // Apply to the open document so it shows immediately; one undo step, then save.
    pushUndo();
    state.bytes = b64ToU8(data.data_b64);
    await renderAll();
    toast("Đã đánh số trang — bấm Lưu để ghi ra file.", "good");
  } catch (err) {
    toast("Lỗi đánh số trang: " + err.message, "bad");
  } finally {
    hideOverlay();
  }
}

// Toolbar dropdowns (Trang ▾ / Công cụ ▾): only one open at a time; closed on
// outside-click/Escape (wired below). A trigger button toggles the sibling menu.
function closeAllMenus() {
  document.querySelectorAll(".dropdown-menu").forEach((m) => (m.hidden = true));
}
function wireDropdown(triggerId) {
  const btn = $(triggerId);
  if (!btn) return;
  const menu = btn.parentElement.querySelector(".dropdown-menu");
  btn.onclick = (e) => {
    e.stopPropagation();
    const show = menu.hidden;
    closeAllMenus();
    menu.hidden = !show;
  };
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
  if ($("set-breadcrumb")) $("set-breadcrumb").checked = breadcrumbEnabled();
  // "Reopen last session" lives in main (it has to be readable before any
  // renderer exists), so read it back rather than assuming a default.
  const restoreBox = $("set-restore-session");
  if (restoreBox && window.desktop.session) {
    window.desktop.session
      .getRestore()
      .then((on) => (restoreBox.checked = !!on))
      .catch(() => {});
  }
  // Same deal for "Mở file mới trong" — main owns it (prefs.json), so read it
  // back rather than assuming. On failure the select keeps its markup default
  // ("tab"), which is also what main falls back to.
  const openInSel = $("set-open-in");
  if (openInSel && window.desktop.prefs) {
    window.desktop.prefs
      .getOpenIn()
      .then((v) => (openInSel.value = v === "window" ? "window" : "tab"))
      .catch(() => {});
  }
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
    setApiBadge(!!data.gemini_configured); // same fetch feeds the toolbar badge
    status.textContent = data.gemini_configured
      ? `Đã có key: ${data.gemini_key_masked}. Nhập key mới để thay.`
      : "Chưa có key. Bóc tách và Dịch (AI) sẽ không chạy cho tới khi bạn nhập.";
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
      setApiBadge(!!data.gemini_configured); // POST returns the new state — no refetch
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
  "btn-tools",
  // Both were reachable only through the gated "Công cụ ▾" before they were
  // promoted to the toolbar — without these two entries the promotion would have
  // silently opened a hole in the license gate.
  "btn-export",
  "btn-sign",
  "btn-edit",
  "btn-text-edit",
  "btn-merge",
  "btn-insert",
  "btn-blank",
  "btn-extract",
  // Toolbar shortcuts for the same commands. A second entry point to a paid
  // feature needs its own id here or it walks straight through the gate (BI-9).
  // Rotate/delete have no entry because basic page ops stay free.
  "btn-tb-blank",
  "btn-tb-extract",
  "btn-tb-split",
  // Split was already gated inside openSplit() (convertReady → gateProFeature);
  // listing it here only adds the matching "locked" affordance so both entry
  // points to it look the same.
  "mi-split",
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
  sidecar.error = s.error || null;
  renderSidecarBadge();
  if (s.state === "ready") {
    loadTemplates();
    refreshApiBadge();
  } else {
    setApiBadge(null); // engine down ⇒ the key state can't be read
  }
  updateToolbar();
}

// Paint the engine badge from `sidecar`. Split out of applySidecar so a language
// switch can repaint it without re-running the side effects (template reload,
// /config refetch) that arriving status does.
function renderSidecarBadge() {
  const b = $("sidecar-badge");
  if (!b) return;
  b.className = "badge dot " + sidecar.state;
  b.textContent = t(
    sidecar.state === "ready"
      ? "OCR: sẵn sàng"
      : sidecar.state === "error"
        ? "OCR: lỗi"
        : "OCR: đang tải…",
  );
  // The tooltip has to spell out the LIMIT of this badge: it only covers the local
  // engine. Reading "OCR: sẵn sàng" as "everything works" is exactly the confusion
  // the API badge next to it exists to clear up.
  b.title =
    sidecar.state === "error"
      ? sidecar.error || t("Engine xử lý trên máy gặp lỗi.")
      : t(
          "Engine xử lý trên máy: OCR, nén, tách, so sánh, sửa chữ. KHÔNG gồm tính năng AI — xem badge API bên cạnh.",
        );
}

// ---- API key status ------------------------------------------------------
//
// The AI features (Bóc tách, Dịch) need a Gemini API key ON TOP of the local
// engine, so readiness is two independent facts and gets two badges. `configured`
// is a tri-state: true / false / null = "not known yet" (engine still starting,
// or /config unreachable) — null must not be rendered as "missing", that would
// nag about a key the user may well have.
const apiKey = { configured: null };

function setApiBadge(configured) {
  apiKey.configured = configured;
  const b = $("api-badge");
  if (!b) return;
  if (configured === true) {
    b.className = "badge badge-btn dot ready";
    b.textContent = t("API: đã có key");
    b.title = t("Đã có API key — Bóc tách và Dịch (AI) dùng được. Bấm để đổi key.");
  } else if (configured === false) {
    b.className = "badge badge-btn dot starting";
    b.textContent = t("API: chưa có key");
    b.title = t("Chưa có API key — Bóc tách và Dịch (AI) sẽ không chạy. Bấm để nhập key.");
  } else {
    b.className = "badge badge-btn dot off";
    b.textContent = "API: …";
    b.title = t("Chưa đọc được trạng thái API key — cần engine chạy trước. Bấm để mở Cài đặt.");
  }
}

// Both badges live in SKIP_IDS (their text is runtime state, BI-10), so the i18n
// registry can't repaint them on a language switch — they have to repaint
// themselves or the toolbar ends up half Vietnamese, half English.
window.addEventListener("i18n:changed", () => {
  renderSidecarBadge();
  setApiBadge(apiKey.configured);
});

// Ask the sidecar whether a key is stored. Never throws: an unreachable /config
// leaves the badge in the "unknown" state rather than claiming there's no key.
async function refreshApiBadge() {
  if (sidecar.state !== "ready" || !sidecar.base) {
    setApiBadge(null);
    return;
  }
  try {
    const res = await sidecarFetch("/config");
    const data = await res.json();
    setApiBadge(!!data.gemini_configured);
  } catch (_) {
    setApiBadge(null);
  }
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
  const bto = $("btn-to-office");
  if (bto) bto.disabled = !(ready && has) || editing;
  const bc = $("btn-compress");
  if (bc) bc.disabled = !(ready && has) || editing;
  // "Tách thành nhiều file" runs on the sidecar (/split), so BOTH of its entry
  // points follow the same rule as the other engine-backed buttons: dim until the
  // engine is up instead of letting the click fail with a toast. The
  // [data-needs-doc] sweep above already covers the "no document / editing" half.
  for (const id of ["btn-tb-split", "mi-split"]) {
    const b = $(id);
    if (b) b.disabled = !(ready && has) || editing;
  }
  // Compare picks its own two files, so it only needs the engine ready (no open doc).
  const bd = $("btn-diff");
  if (bd) bd.disabled = !ready || editing;
  // Copy-image works on the open doc, purely client-side (no engine). Disabled
  // while editing; if capture mode is on when it gets disabled, leave it.
  const bci = $("btn-copy-img");
  if (bci) bci.disabled = !has || editing;
  if ((!has || editing) && window.Capture && window.Capture.active) window.Capture.exit();
  // Comments panel works in both view and edit mode (live notes while editing).
  const bcm = $("btn-comments");
  if (bcm) bcm.disabled = !has;
  // "Công cụ ▾" opens when a doc is open OR the engine is ready (Compare/Ảnh→PDF
  // need only the engine; Copy ảnh needs only a doc). Per-item disables below and
  // per-handler guards enforce the finer "open a PDF first / engine ready" rules.
  const bcv = $("btn-tools");
  if (bcv) bcv.disabled = (!has && !ready) || editing;
  // "Xuất ▾" follows the same rule as "Công cụ ▾": Ảnh → PDF needs only the engine,
  // the rest need an open doc; per-item handlers enforce the finer rules.
  const bex = $("btn-export");
  if (bex) bex.disabled = (!has && !ready) || editing;
  // Ký số always needs an open document.
  const bsg = $("btn-sign");
  if (bsg) bsg.disabled = !has || editing;
  if (editing) closeAllMenus();
  // Annotating / text-editing needs its toolbar, which full-screen reading mode
  // hides — so the two modes can't overlap. Editing wins (it may be mid-edit).
  if (editing && present.on) togglePresentation(false);
  // Contextual bars (#edit-bar / #tedit-bar) REPLACE the tools row rather than
  // stacking above it — everything in that row is disabled while editing anyway,
  // so keeping it visible only costs vertical space. Ghi chú deliberately lives in
  // row 1 (it stays usable while annotating), so hiding this row loses nothing.
  const toolsRow = document.querySelector(".tb-row.tb-tools");
  if (toolsRow) toolsRow.hidden = editing;
  // Overlay edit must not run while text-editing, and vice versa.
  const be = $("btn-edit");
  if (be) be.disabled = !has || textEditing;
  const bt = $("btn-text-edit");
  if (bt) bt.disabled = !(ready && has) || overlayEditing;
  // Zoom & page inputs are <input>s, so the [data-needs-doc] button sweep misses them.
  const zi = $("zoom-input");
  if (zi) zi.disabled = !has;
  const pi = $("page-input");
  if (pi) pi.disabled = !has;
  syncZoomInput();
  syncPageInput();
  // Visual cue for the license gate: a lock class on gated buttons. The actual
  // block happens in the capture guard; this is just a hover hint + CSS hook.
  const blocked = licBlocked();
  for (const id of GATED_BTNS) {
    const b = $(id);
    if (b) b.classList.toggle("locked", blocked);
  }
  // The hand cursor must disappear the moment a mode takes the left button back
  // (and reappear on the way out). This is the one place that runs on every such
  // change, so the pan module is re-synced from here rather than subscribing to
  // four different mode toggles. Guarded call — see BI-14.
  if (window.Pan && window.Pan.sync) window.Pan.sync();
}

// ---- wiring --------------------------------------------------------------

async function openDialog() {
  // Open into NEW tabs so the current document is never replaced/lost. If this
  // tab is still empty, the first file fills it instead of leaving a blank tab.
  const paths = await window.desktop.pickPdfs();
  if (!paths || !paths.length) return;
  await window.desktop.openPaths(paths, !state.bytes);
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
// Toolbar shortcuts — same handlers as the Trang ▾ items above, no second copy
// of the logic. (Different ids because ids must be unique.)
$("btn-tb-rotate-l").onclick = () => rotateSelected(-90);
$("btn-tb-rotate-r").onclick = () => rotateSelected(90);
$("btn-tb-blank").onclick = addBlankPage;
$("btn-tb-extract").onclick = extractSelected;
$("btn-tb-split").onclick = openSplit;
$("btn-zoom-in").onclick = () => zoom(0.2);
$("btn-zoom-out").onclick = () => zoom(-0.2);
$("btn-fit-width").onclick = fitWidth;
$("btn-fit-height").onclick = fitHeight;
$("btn-fit-page").onclick = fitPage;
$("btn-presentation").onclick = () => togglePresentation();
$("present-exit").onclick = () => togglePresentation(false);
// Main is the authority on whether the window is full screen (it can also leave
// via the window controls), so the class is only ever flipped from its message.
if (window.desktop && window.desktop.onPresentation) {
  window.desktop.onPresentation((on) => applyPresentation(!!on));
}
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
    zoomTo(state.scale * wheelZoomFactor(e.deltaY), { x: e.clientX, y: e.clientY });
  },
  { passive: false }
);
// Page navigation (‹ [N] / total ›). The box tracks the topmost visible page as
// the user scrolls; typing a number + Enter (or the arrows) jumps there.
let pageScrollTimer;
$("viewer").addEventListener("scroll", () => {
  clearTimeout(pageScrollTimer);
  pageScrollTimer = setTimeout(() => {
    syncPageInput();
    syncThumbFocus(); // page list follows the view (highlight + auto-scroll)
    updatePresentHud(); // the status bar is hidden in full screen; the chip isn't
  }, 80);
});
$("btn-page-prev").onclick = () => gotoPageNumber(currentPageIndex());       // 1-based (idx)+1-1
$("btn-page-next").onclick = () => gotoPageNumber(currentPageIndex() + 2);   // (idx)+1+1
$("page-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const n = parseInt($("page-input").value, 10);
    if (!isNaN(n)) gotoPageNumber(n);
    $("page-input").blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    syncPageInput();
    $("page-input").blur();
  }
});
$("page-input").addEventListener("blur", syncPageInput);

// Comments/notes list panel.
$("btn-comments").onclick = () => toggleComments();
$("comments-close").onclick = () => toggleComments(false);

// Thumbnail sidebar collapse/expand (button + F4).
$("btn-sidebar").onclick = () => toggleSidebar(true);
$("sidebar-expand").onclick = () => toggleSidebar(false);

// Sidebar resize handle. Pointer capture keeps the drag alive when the cursor
// runs past the handle (which it always does) and guarantees the pointerup even
// if it happens outside the window.
initSidebarWidth();
if ($("sidebar-resizer")) {
  const grip = $("sidebar-resizer");
  let resizing = null; // { id, startX, startW }
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sb = $("sidebar");
    resizing = { id: e.pointerId, startX: e.clientX, startW: sb ? sb.getBoundingClientRect().width : SIDEBAR_W_DEFAULT };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture unavailable — the window listeners below still finish the drag */
    }
    document.body.classList.add("resizing-sidebar");
  });
  window.addEventListener("pointermove", (e) => {
    if (!resizing || e.pointerId !== resizing.id) return;
    // Persist only at the end: a write per mouse-move would hammer localStorage.
    applySidebarWidth(resizing.startW + (e.clientX - resizing.startX), false);
  });
  const endResize = (e) => {
    if (!resizing || (e && e.pointerId != null && e.pointerId !== resizing.id)) return;
    try {
      grip.releasePointerCapture(resizing.id);
    } catch (_) {
      /* already released */
    }
    resizing = null;
    document.body.classList.remove("resizing-sidebar");
    const sb = $("sidebar");
    applySidebarWidth(sb ? sb.getBoundingClientRect().width : SIDEBAR_W_DEFAULT, true);
  };
  window.addEventListener("pointerup", endResize);
  window.addEventListener("pointercancel", endResize);
  grip.addEventListener("dblclick", () => applySidebarWidth(SIDEBAR_W_DEFAULT, true));
}

// Full-screen page list: the left-edge strip slides the thumbnail sidebar in over
// the page, and it slides back out when the pointer leaves. The close is delayed
// because the pointer has to cross the gap between the strip and the panel; a
// zero delay makes the panel flicker shut in that gap. F4 pins it (see keydown).
let railHideTimer = null;
function showRail(on) {
  clearTimeout(railHideTimer);
  if (on) document.body.classList.add("rail-open");
  else railHideTimer = setTimeout(() => document.body.classList.remove("rail-open"), 220);
}
if ($("present-rail")) $("present-rail").addEventListener("pointerenter", () => showRail(true));
if ($("sidebar")) {
  $("sidebar").addEventListener("pointerenter", () => showRail(true));
  $("sidebar").addEventListener("pointerleave", () => showRail(false));
}

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
$("btn-to-office").onclick = openOffice;
$("office-cancel").onclick = () => ($("office-modal").hidden = true);
$("office-ok").onclick = runOffice;

// Toolbar dropdowns (Trang ▾ / Công cụ ▾) — triggers toggle their menu; each item
// runs its tool and the menu closes. Outside-click / Escape close any open menu.
wireDropdown("btn-pages");
wireDropdown("btn-tools");
wireDropdown("btn-export");
const ddRun = (fn) => () => {
  closeAllMenus();
  fn();
};
$("mi-encrypt").onclick = ddRun(openEncrypt);
$("mi-split").onclick = ddRun(openSplit);
$("mi-delete-range").onclick = ddRun(openDeleteRange);
$("mi-page-numbers").onclick = ddRun(openPageNumbers);
$("pgnum-cancel").onclick = () => ($("pgnum-modal").hidden = true);
$("pgnum-ok").onclick = runPageNumbers;
$("mi-extract-images").onclick = ddRun(extractImages);
$("mi-pdf-to-images").onclick = ddRun(openPdfToImages);
$("mi-images-to-pdf").onclick = ddRun(openImagesToPdf);
// Page-management items keep their existing onclick (wired below); close the menu
// after any item click so a chosen action doesn't leave the menu hanging open.
document.querySelectorAll(".dropdown-menu").forEach((menu) => {
  menu.addEventListener("click", (e) => {
    if (e.target.closest(".dd-item")) closeAllMenus();
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown")) closeAllMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllMenus();
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
$("delrange-cancel").onclick = () => ($("delrange-modal").hidden = true);
$("delrange-ok").onclick = runDeleteRange;
for (const id of ["delrange-from", "delrange-to", "delrange-except"]) {
  $(id).addEventListener("input", syncDeleteRange);
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("delrange-ok").disabled) runDeleteRange();
  });
}
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
// The API badge is a shortcut into the same dialog — openSettings() focuses the
// key field once the engine is up, so "chưa có key → bấm → gõ key" is one hop.
$("api-badge").onclick = openSettings;
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
// Path-bar visibility. Applies immediately so the checkbox shows its own effect
// with the dialog still open.
if ($("set-breadcrumb")) {
  $("set-breadcrumb").onchange = (e) => setBreadcrumbEnabled(e.target.checked);
}
// "Mở file mới trong" — persisted by main, which is also the side that acts on
// it: this renderer only asks to open a path, main decides tab vs window (see
// tabs:open-paths / openPathInApp). Settle the select on what main stored, so a
// rejected value doesn't leave the dialog showing something untrue.
if ($("set-open-in")) {
  $("set-open-in").onchange = (e) => {
    if (!window.desktop.prefs) return;
    const sel = e.target;
    window.desktop.prefs
      .setOpenIn(sel.value)
      .then((v) => (sel.value = v === "window" ? "window" : "tab"))
      .catch(() => {});
  };
}
// Reopen-last-session toggle. Persisted by main, which is the only side that can
// act on it (it reads the flag at launch, before any renderer exists).
if ($("set-restore-session")) {
  $("set-restore-session").onchange = (e) => {
    if (window.desktop.session) window.desktop.session.setRestore(e.target.checked).catch(() => {});
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
  // F4 toggles the thumbnail sidebar (Foxit-style), unless typing. In full screen
  // the sidebar is a hover-out overlay instead of a column, so the same key pins
  // it open there — same intent ("show me the page list"), same key.
  if (e.key === "F4" && !isTyping()) {
    e.preventDefault();
    if (present.on) {
      // Pinning must also un-collapse: a sidebar the user had put away before
      // going full screen is `display:none`, so pinning it alone would be a key
      // that visibly does nothing — and the hover rail can't rescue it either.
      const pin = !document.body.classList.contains("rail-pinned");
      if (pin) toggleSidebar(false);
      document.body.classList.toggle("rail-pinned", pin);
    } else {
      toggleSidebar();
    }
    return;
  }
  // F11 = full-screen reading mode (also on the View menu). Handled here rather
  // than as a menu accelerator so it can't fire twice.
  if (e.key === "F11" && !isTyping()) {
    e.preventDefault();
    togglePresentation();
    return;
  }
  // Esc leaves full screen — but only when nothing nearer owns the key: the
  // compare/overlay views, modals and the editors all close on Esc first, and
  // they stop propagation or are checked here. Copy-image mode is checked
  // explicitly: its listener is on the CAPTURE phase and only preventDefaults,
  // so without this one Esc would exit both modes at once.
  if (
    e.key === "Escape" &&
    present.on &&
    !isTyping() &&
    !(window.Capture && window.Capture.active) &&
    $("overlay").hidden &&
    !document.querySelector(".modal:not([hidden])") &&
    ($("compare-view") ? $("compare-view").hidden : true) &&
    ($("overlay-view") ? $("overlay-view").hidden : true)
  ) {
    e.preventDefault();
    togglePresentation(false);
    return;
  }
  // ↑/↓ and PageUp/PageDown jump to the previous/next page (instead of the
  // browser's tiny scroll), but only in the plain page view — never while typing,
  // in an editor overlay, or with a modal open (those own these keys themselves).
  const cmpView = $("compare-view");
  const ovView = $("overlay-view");
  const isPrev = e.key === "ArrowUp" || e.key === "PageUp";
  const isNext = e.key === "ArrowDown" || e.key === "PageDown";
  if (
    (isPrev || isNext) &&
    state.numPages &&
    !isTyping() &&
    $("overlay").hidden &&
    (!cmpView || cmpView.hidden) &&
    (!ovView || ovView.hidden) &&
    $("viewer").offsetParent !== null &&
    // `Editor.active` is a boolean GETTER (editor.js), NOT a method. It used to be
    // called — `window.Editor.active()` — which threw a TypeError on every one of
    // these keypresses while annotating and aborted the rest of this handler. Use
    // the same property form as updateToolbar(). Text-edit mode needs no check of
    // its own here: isTyping() already covers it via the body.text-editing class.
    !(window.Editor && window.Editor.active)
  ) {
    e.preventDefault();
    const cur = currentPageIndex();
    const next = isNext ? Math.min(state.numPages - 1, cur + 1) : Math.max(0, cur - 1);
    if (next !== cur) scrollToPage(next);
    return;
  }
  // Delete removes the selected pages — but never while typing or in an editor
  // (the overlay/text editors own Delete for their own selection).
  if (
    e.key === "Delete" &&
    !isTyping() &&
    !(window.Editor && window.Editor.active) && // property, not a method — see above
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
    presentation: () => togglePresentation(),
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
    // Electron exposes the dropped file's real path via file.path. If this tab
    // already holds a document, open the drop as a NEW tab (never clobber the
    // current one); if the tab is empty, or the path is unavailable (secured
    // build), load it here.
    if (f.path && state.bytes) {
      await window.desktop.openPaths([f.path], false);
    } else {
      const buf = await f.arrayBuffer();
      await loadBytes(new Uint8Array(buf), f.name, f.path || null);
    }
  }
});

// "Open with Nabu PDF" / double-click a .pdf / drag onto the app icon: the main
// process opens a window and pushes the file here once the renderer is ready.
if (window.desktop.onOpenFile) {
  window.desktop.onOpenFile((file) => {
    if (file && file.data) loadBytes(toU8(file.data), file.name, file.path || null);
  });
}

// Window close with unsaved changes: main intercepts the close, we decide here.
// A clean doc closes immediately; a dirty one prompts Save / Don't save / Cancel.
function finishClose() {
  if (state.docId && window.desktop.recovery) window.desktop.recovery.clear(state.docId);
  if (window.desktop.forceCloseWindow) window.desktop.forceCloseWindow();
}
if (window.desktop.onCloseRequest) {
  let deciding = false;
  // In tabbed mode main awaits this tab's close decision; tell it we cancelled so
  // a whole-window close aborts cleanly instead of hanging.
  const cancelClose = () => {
    if (window.desktop.cancelClose) window.desktop.cancelClose();
  };
  window.desktop.onCloseRequest(async () => {
    if (deciding) return;
    if (!docHasUnsavedChanges()) {
      finishClose();
      return;
    }
    deciding = true;
    let choice;
    try {
      choice = await window.desktop.confirmClose();
    } finally {
      deciding = false;
    }
    if (choice === 2 || choice == null) {
      cancelClose(); // Huỷ — keep the tab open
      return;
    }
    if (choice === 0) {
      // Lưu: saveDoc bakes pending edits + writes (may prompt Save As). If it's
      // still dirty afterwards (user cancelled Save As), abort the close.
      await saveDoc();
      if (docHasUnsavedChanges()) {
        cancelClose();
        return;
      }
    }
    finishClose(); // saved (0) or discarded (1)
  });
}

// After giving "Open with" a moment to deliver a file, offer to restore anything a
// previous session left behind. No-op if a document is already loaded here.
setTimeout(checkRecovery, 1200);

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
