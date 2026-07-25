"use strict";

const { contextBridge, ipcRenderer } = require("electron");

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

  // --- multi-window / tabs ---
  // Open a new empty document window.
  newWindow: () => ipcRenderer.invoke("window:new"),
  // Report this tab's label + unsaved state to the tab strip. meta: { title, dirty }.
  setTabMeta: (meta) => ipcRenderer.send("tab:meta", meta),
  // A file was handed to this window to open ("Open with" / drag-onto-icon).
  // cb receives { path, name, data: Uint8Array }.
  onOpenFile: (cb) => {
    const handler = (_e, file) => cb(file);
    ipcRenderer.on("file:open", handler);
    return () => ipcRenderer.removeListener("file:open", handler);
  },

  // --- clipboard (write an image out of a page) ---
  // bytes: Uint8Array PNG. Returns { ok, reason? }.
  writeClipboardImage: (bytes) => ipcRenderer.invoke("clipboard:write-image", bytes),
  // Read an image off the OS clipboard as a PNG data URL, or null if none.
  readClipboardImage: () => ipcRenderer.invoke("clipboard:read-image"),

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
