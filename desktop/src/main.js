"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");

let mainWindow = null;
let sidecar = null;

const RENDERER = path.join(__dirname, "..", "renderer");

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "ContractOCR",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show a loading screen immediately — the sidecar takes a while to load the
  // OCR models (torch + paddle), so we must not block on a blank window.
  await mainWindow.loadFile(path.join(RENDERER, "loading.html"));

  try {
    sidecar = await startSidecar();
    await mainWindow.loadFile(path.join(RENDERER, "index.html"), {
      query: { port: String(sidecar.port) },
    });
  } catch (err) {
    const message = (err && err.message) || String(err);
    await mainWindow.loadFile(path.join(RENDERER, "error.html"), {
      query: { message },
    });
  }
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  stopSidecar(sidecar);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopSidecar(sidecar));
