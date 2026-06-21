"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");

let mainWindow = null;
let sidecar = null;

// Per-launch shared secret. Passed to the sidecar (env) and to the renderer (in
// the status payload below) so only our renderer can call the loopback OCR server.
const SIDECAR_TOKEN = crypto.randomBytes(24).toString("hex");

// Sidecar lifecycle state, surfaced to the renderer so OCR features can show a
// "starting / ready / error" badge without blocking the PDF UI (DESIGN D5).
// `token` lets the renderer authenticate its sidecar requests.
let sidecarState = { state: "starting", port: null, error: null, token: SIDECAR_TOKEN };

const RENDERER = path.join(__dirname, "..", "renderer");

function setSidecarState(next) {
  sidecarState = { ...sidecarState, ...next };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sidecar:status", sidecarState);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "ContractOCR — PDF Suite",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Load the PDF UI immediately — no waiting on the heavy OCR sidecar.
  mainWindow.loadFile(path.join(RENDERER, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Spawn the Python sidecar in the background. OCR-dependent UI stays disabled
// until this resolves; the rest of the app works without it.
function bootSidecar() {
  setSidecarState({ state: "starting", port: null, error: null });
  startSidecar(SIDECAR_TOKEN)
    .then((sc) => {
      sidecar = sc;
      setSidecarState({ state: "ready", port: sc.port, error: null });
    })
    .catch((err) => {
      const message = (err && err.message) || String(err);
      setSidecarState({ state: "error", port: null, error: message });
    });
}

app.whenReady().then(() => {
  createWindow();
  bootSidecar();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---- IPC: sidecar status -------------------------------------------------

ipcMain.handle("sidecar:status", () => sidecarState);

ipcMain.handle("sidecar:restart", () => {
  stopSidecar(sidecar);
  sidecar = null;
  bootSidecar();
  return sidecarState;
});

// ---- IPC: file dialogs ---------------------------------------------------

ipcMain.handle("dialog:open-pdf", async (_e, { multi = false } = {}) => {
  const props = ["openFile"];
  if (multi) props.push("multiSelections");
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Mở PDF",
    properties: props,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled) return [];
  return res.filePaths.map((fp) => ({
    path: fp,
    name: path.basename(fp),
    data: fs.readFileSync(fp),
  }));
});

ipcMain.handle("dialog:save-pdf", async (_e, { data, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Lưu PDF",
    defaultPath: defaultName || "output.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled || !res.filePath) return { saved: false };
  fs.writeFileSync(res.filePath, Buffer.from(data));
  return { saved: true, path: res.filePath };
});

// Generic save for non-PDF exports (xlsx/csv/json). `filters` is an array of
// { name, extensions } passed straight to the native dialog.
ipcMain.handle("dialog:save-file", async (_e, { data, defaultName, filters }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Lưu file",
    defaultPath: defaultName || "export.txt",
    filters: filters && filters.length ? filters : [{ name: "Tất cả", extensions: ["*"] }],
  });
  if (res.canceled || !res.filePath) return { saved: false };
  fs.writeFileSync(res.filePath, Buffer.from(data));
  return { saved: true, path: res.filePath };
});

// ---- shutdown ------------------------------------------------------------

app.on("window-all-closed", () => {
  stopSidecar(sidecar);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopSidecar(sidecar));
