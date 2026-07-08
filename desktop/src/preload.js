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
