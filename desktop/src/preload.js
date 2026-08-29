"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Safe, minimal surface exposed to the renderer. No Node, no fs — just the few
// main-process capabilities the PDF UI needs.
contextBridge.exposeInMainWorld("desktop", {
  // --- OCR sidecar status (lazy; PDF features don't depend on it) ---
  getSidecarStatus: () => ipcRenderer.invoke("sidecar:status"),
  restartSidecar: () => ipcRenderer.invoke("sidecar:restart"),
  onSidecarStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on("sidecar:status", handler);
    return () => ipcRenderer.removeListener("sidecar:status", handler);
  },

  // --- auto-update status (NSIS install only; no-op for portable/dev) ---
  onUpdateStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  // Manual "Kiểm tra cập nhật". Resolves to an immediate { state, version };
  // a real check streams further results through onUpdateStatus.
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  // App version + build channel for the Settings dialog.
  appInfo: () => ipcRenderer.invoke("app:info"),

  // --- license (offline Ed25519; see src/license.js) ---
  license: {
    get: () => ipcRenderer.invoke("license:get"),
    activate: (key) => ipcRenderer.invoke("license:activate", key),
    deactivate: () => ipcRenderer.invoke("license:deactivate"),
    hwid: () => ipcRenderer.invoke("license:hwid"),
  },

  // --- unsaved-changes close guard ---
  // Main intercepts the window's close and fires this so the renderer can decide.
  onCloseRequest: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("window:before-close", handler);
    return () => ipcRenderer.removeListener("window:before-close", handler);
  },
  // Show the native Save / Don't save / Cancel dialog. Resolves to 0 / 1 / 2.
  confirmClose: () => ipcRenderer.invoke("window:confirm-close"),
  // Proceed to actually close this tab/window (bypasses the guard once).
  forceCloseWindow: () => ipcRenderer.invoke("window:force-close"),
  // Tell main the close was cancelled, so a whole-window close aborts instead of
  // hanging while it waits for this tab's decision.
  cancelClose: () => ipcRenderer.invoke("window:close-cancelled"),

  // --- session restore (which documents were open last time) ---
  session: {
    // Is "reopen last session" on? Lives in main (session.json), not
    // localStorage, because main must read it before any renderer exists.
    getRestore: () => ipcRenderer.invoke("session:get-restore"),
    setRestore: (on) => ipcRenderer.invoke("session:set-restore", !!on),
  },

  // --- main-side preferences (prefs.json) ---
  prefs: {
    // Where a newly opened file lands: "tab" | "window". Main-side for the same
    // reason as getRestore — a file arriving from Explorer has no renderer to
    // ask. Both calls resolve to the value main actually stored.
    getOpenIn: () => ipcRenderer.invoke("prefs:get-open-in"),
    setOpenIn: (v) => ipcRenderer.invoke("prefs:set-open-in", String(v)),
  },
  // Main has earmarked this tab for a document it is about to send. The renderer
  // uses it to stand down from the crash-recovery prompt, which belongs to a tab
  // that is genuinely empty (see checkRecovery).
  onTabReserved: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("tab:reserved", handler);
    return () => ipcRenderer.removeListener("tab:reserved", handler);
  },

  // --- crash recovery (AutoRecover-style snapshots) ---
  recovery: {
    // Write/refresh this document's recovery snapshot. payload:
    // { docId, bytes: Uint8Array, name, srcPath }. Returns { saved }.
    save: (payload) => ipcRenderer.invoke("recovery:save", payload),
    // Drop a document's snapshot (clean close / successful save).
    clear: (docId) => ipcRenderer.invoke("recovery:clear", docId),
    // Orphaned snapshots left by a previous (crashed) session, newest first.
    // Returns them to the FIRST caller per app launch only. [{docId,name,srcPath,savedAt}].
    scan: () => ipcRenderer.invoke("recovery:scan"),
    // Read one snapshot back: { ok, bytes: Uint8Array, name, srcPath }.
    read: (docId) => ipcRenderer.invoke("recovery:read", docId),
  },

  // --- digital signing (PKI; USB token via Windows Certificate Store) ---
  signing: {
    // Enumerate signing certificates (VNPT/Viettel/FPT… tokens). Returns
    // { ok, certs: [{thumbprint, subject, cn, org, notAfter, expired, ...}] } or
    // { ok:false, reason, error }.
    listCerts: () => ipcRenderer.invoke("sign:list-certs"),
    // Sign a PDF. payload: { bytes, thumbprint, tsaUrl?, meta, appearance? }.
    // Returns { ok, bytes: Uint8Array } or { ok:false, reason, error }.
    apply: (payload) => ipcRenderer.invoke("sign:apply", payload),
  },

  // --- full-screen reading mode ---
  // Ask main to put THIS tab's window in (or out of) full screen. Main also
  // collapses the tab strip, then broadcasts the new state back through
  // onPresentation — the renderer never assumes it succeeded.
  setPresentation: (on) => ipcRenderer.invoke("window:set-presentation", !!on),
  // Current full-screen state of this tab's window. Fires on our own toggle AND
  // when the window leaves full screen by any other route (window controls, OS).
  onPresentation: (cb) => {
    const handler = (_e, on) => cb(on);
    ipcRenderer.on("window:presentation", handler);
    return () => ipcRenderer.removeListener("window:presentation", handler);
  },

  // --- multi-window / tabs ---
  // Open a new empty document window.
  newWindow: () => ipcRenderer.invoke("window:new"),
  // Report this tab's label + unsaved state to the tab strip. meta: { title, dirty }.
  setTabMeta: (meta) => ipcRenderer.send("tab:meta", meta),
  // Pick PDF paths (no bytes read) for the tab layer to open by path.
  // Returns string[] absolute paths, [] if cancelled.
  pickPdfs: () => ipcRenderer.invoke("dialog:pick-pdfs"),
  // Open PDF paths as new tabs in this window. fillCurrent=true reuses THIS tab
  // for paths[0] when it's still empty (so no stray blank tab is left behind).
  openPaths: (paths, fillCurrent) => ipcRenderer.invoke("tabs:open-paths", { paths, fillCurrent }),
  // A file was handed to this window to open ("Open with" / drag-onto-icon).
  // cb receives { path, name, data: Uint8Array }.
  onOpenFile: (cb) => {
    const handler = (_e, file) => cb(file);
    ipcRenderer.on("file:open", handler);
    return () => ipcRenderer.removeListener("file:open", handler);
  },
  // A BATCH was handed to this tab by Explorer's "Gộp bằng Nabu PDF" verb: pre-fill
  // the merge dialog, do not open anything. cb receives
  // { files: [{ path, name, data: Uint8Array }], dropped }, where `dropped` is how
  // many the batch cap removed so the dialog can say so out loud.
  onCombinePrefill: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("combine:prefill", handler);
    return () => ipcRenderer.removeListener("combine:prefill", handler);
  },

  // --- moving pages between documents (docs/SPEC-page-drag.md) ---
  // This tab never names another tab: it either throws pages at a screen position
  // (main resolves which window is there) or picks a destination id main handed it
  // in the first place. Bytes only ever travel source → main → target (BI-52).
  pages: {
    // A page drag began here. Cheap and fire-and-forget — this also fires for a
    // plain same-document reorder, which main answers with silence.
    dragStart: () => ipcRenderer.send("pages:drag-start", {}),
    // The drag ended. Main pairs it with the real cursor position and, if it landed
    // in another window, runs the whole transfer before resolving:
    // { action: "self"|"send"|"none", ok, inserted?, target?, reason? }.
    dragEnd: () => ipcRenderer.invoke("pages:drag-end"),
    // Destinations for "Chuyển trang tới…":
    // [{ id, title, window, sameWindow, accepts, block }].
    targets: () => ipcRenderer.invoke("pages:targets"),
    // Send the pages this tab is offering to a destination from targets().
    // Returns { ok, inserted?, target?, reason? }.
    sendTo: (tabId) => ipcRenderer.invoke("pages:send-to", { tabId }),
    // Answer a request from main. Every handler below is a QUESTION and must reply
    // exactly once with the reqId it was given, or main times out and treats the
    // whole transfer as "did not happen".
    reply: (msg) => ipcRenderer.send("pages:reply", msg),
    // Main asks: are you able to take pages right now? Reply { reqId, ok, block }.
    onCanAccept: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("pages:can-accept", handler);
      return () => ipcRenderer.removeListener("pages:can-accept", handler);
    },
    // Main asks the SOURCE: hand over the pages you are offering.
    // Reply { reqId, ok, bytes, count, name, block }.
    onExport: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("pages:export", handler);
      return () => ipcRenderer.removeListener("pages:export", handler);
    },
    // Main asks the TARGET: insert these pages. msg: { reqId, bytes, count, from,
    // at: {x,y}|null }. `at` is a point in THIS view's client coordinates (a
    // hand-thrown page) or null (append at the end). Reply { reqId, ok, inserted }.
    onReceive: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("pages:receive", handler);
      return () => ipcRenderer.removeListener("pages:receive", handler);
    },
    // Pages are being dragged over this window: {x,y} in client coordinates, ~12/s.
    onHover: (cb) => {
      const handler = (_e, at) => cb(at);
      ipcRenderer.on("pages:hover", handler);
      return () => ipcRenderer.removeListener("pages:hover", handler);
    },
    // They left, or the drag ended. Drop every cue.
    onHoverEnd: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("pages:hover-end", handler);
      return () => ipcRenderer.removeListener("pages:hover-end", handler);
    },
  },

  // --- clipboard (write an image out of a page) ---
  // bytes: Uint8Array PNG. Returns { ok, reason? }.
  writeClipboardImage: (bytes) => ipcRenderer.invoke("clipboard:write-image", bytes),
  // Read an image off the OS clipboard as a PNG data URL, or null if none.
  readClipboardImage: () => ipcRenderer.invoke("clipboard:read-image"),

  // --- object clipboard (annotations, shared across tabs and windows) ---
  // Mirror this tab's object clip so OTHER tabs can paste it. The caller does
  // NOT await: the copy gesture has to stay synchronous (BI-77), and a failed
  // mirror only costs cross-tab paste, never the local one.
  writeAnnotClip: (payload) => ipcRenderer.invoke("annots:clip-write", payload),
  // The shared clip as it stands, for a tab that loaded after the copy. Startup
  // path only — never called while handling a paste.
  readAnnotClip: () => ipcRenderer.invoke("annots:clip-read"),
  // Another tab copied (or cleared). Payload is { items, srcPage } or null.
  onAnnotClipChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("annots:clip-changed", handler);
    return () => ipcRenderer.removeListener("annots:clip-changed", handler);
  },

  // The real filesystem path of a dropped File, or null.
  //
  // `webUtils.getPathForFile()` is the supported way to do this from Electron 32 on;
  // Electron's own typings say it "superseded the previous augmentation to the File
  // object with the `path` property". The renderer keeps a `file.path` fallback so it
  // works either way and cannot regress if one of them goes away.
  //
  // Why the path matters at all: with it, dropping a PDF onto a tab that already holds
  // a document opens a NEW tab through main's routing (BI-8 / BI-35). Without it the
  // renderer can only load the bytes into THIS tab, i.e. displace what is open.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch (_) {
      return null; // not a real on-disk File, or the API is unavailable
    }
  },

  // --- native file dialogs ---
  // Returns [{ path, name, data: Uint8Array }, ...] (empty if cancelled).
  openPdf: (opts) => ipcRenderer.invoke("dialog:open-pdf", opts || {}),
  // Generic open for non-PDF inputs (e.g. images → PDF). opts: { multi, filters }.
  // Returns [{ path, name, data: Uint8Array }, ...] (empty if cancelled).
  openFiles: (opts) => ipcRenderer.invoke("dialog:open-files", opts || {}),
  // data: Uint8Array | ArrayBuffer. Returns { saved, path? }. Always prompts.
  savePdf: (data, defaultName) =>
    ipcRenderer.invoke("dialog:save-pdf", { data, defaultName }),
  // Silent write to an existing path (Ctrl+S on an already-saved doc). { saved, path? }.
  writePdf: (path, data) => ipcRenderer.invoke("file:write-pdf", { path, data }),
  // List available printers (name + isDefault). Returns [] on failure.
  getPrinters: () => ipcRenderer.invoke("print:printers"),
  // Print the current window (its #print-root images) with the given options:
  // { deviceName, pageSize, duplexMode, landscape, copies, systemDialog }.
  // Returns { ok, reason }.
  printPage: (opts) => ipcRenderer.invoke("print:page", opts || {}),
  // Tell the main process the current UI language so the native menu matches
  // the in-app toggle. lang: "vi" | "en".
  setMenuLang: (lang) => ipcRenderer.invoke("menu:set-lang", lang),
  // Native menu commands (File/Edit/Page/View). cb receives the command string.
  onMenuCommand: (cb) => {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on("menu:cmd", handler);
    return () => ipcRenderer.removeListener("menu:cmd", handler);
  },
  // Generic save for exports. filters: [{ name, extensions: [...] }].
  saveFile: (data, defaultName, filters) =>
    ipcRenderer.invoke("dialog:save-file", { data, defaultName, filters }),

  // Reveal a file/folder in the OS file manager (breadcrumb navigation).
  showInFolder: (fullPath) => ipcRenderer.invoke("shell:show-in-folder", fullPath),

  // Open an http(s) URL in the default browser (About: license + source links).
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),

  // Open a bundled license file: which = "agpl" | "thirdParty".
  openLicenses: (which) => ipcRenderer.invoke("licenses:open", which),
});
