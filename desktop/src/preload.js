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
  },

  // --- native file dialogs ---
  // Returns [{ path, name, data: Uint8Array }, ...] (empty if cancelled).
  openPdf: (opts) => ipcRenderer.invoke("dialog:open-pdf", opts || {}),
  // data: Uint8Array | ArrayBuffer. Returns { saved, path? }.
  savePdf: (data, defaultName) =>
    ipcRenderer.invoke("dialog:save-pdf", { data, defaultName }),
  // Generic save for exports. filters: [{ name, extensions: [...] }].
  saveFile: (data, defaultName, filters) =>
    ipcRenderer.invoke("dialog:save-file", { data, defaultName, filters }),
});
