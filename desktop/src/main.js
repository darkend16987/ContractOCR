"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");
const { initAutoUpdate } = require("./updater");
const { initLicense } = require("./license");

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
    title: "Nabu PDF",
    icon: path.join(__dirname, "..", "build", "icon.png"),
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

  // Navigation hardening: this is a single local page. Block any attempt to
  // navigate away or open new windows (defence-in-depth if the renderer is ever
  // compromised, e.g. via a crafted PDF). External http(s) links go through the
  // explicit shell:open-external IPC instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url !== mainWindow.webContents.getURL()) e.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Native application menu. File/Save accelerators are registered by Electron;
// editing/zoom/page shortcuts are flagged registerAccelerator:false so the
// renderer's keydown handler owns them (it can check focus to avoid hijacking
// keys while the user types in a field). All custom items relay a command to the
// renderer over the "menu:cmd" channel.
function buildMenu() {
  const send = (cmd) => () => {
    const wc =
      (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) ||
      (BrowserWindow.getFocusedWindow() && BrowserWindow.getFocusedWindow().webContents);
    if (wc) wc.send("menu:cmd", cmd);
  };
  const isDev = !app.isPackaged;
  const template = [
    {
      label: "Tập tin",
      submenu: [
        { label: "Mở…", accelerator: "CmdOrCtrl+O", click: send("open") },
        { type: "separator" },
        { label: "Lưu", accelerator: "CmdOrCtrl+S", click: send("save") },
        { label: "Lưu thành…", accelerator: "CmdOrCtrl+Shift+S", click: send("saveAs") },
        { type: "separator" },
        { role: "close", label: "Đóng cửa sổ" },
        { role: "quit", label: "Thoát" },
      ],
    },
    {
      label: "Chỉnh sửa",
      submenu: [
        { label: "Hoàn tác", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: send("undo") },
        { label: "Làm lại", accelerator: "CmdOrCtrl+Y", registerAccelerator: false, click: send("redo") },
        { type: "separator" },
        { role: "cut", label: "Cắt" },
        { role: "copy", label: "Sao chép" },
        { role: "paste", label: "Dán" },
        { role: "selectAll", label: "Chọn tất cả" },
      ],
    },
    {
      label: "Trang",
      submenu: [
        { label: "Xoay trái 90°", click: send("rotateL") },
        { label: "Xoay phải 90°", click: send("rotateR") },
        { label: "Xóa trang đang chọn", accelerator: "Delete", registerAccelerator: false, click: send("delete") },
        { type: "separator" },
        { label: "Ghép PDF…", click: send("merge") },
        { label: "Chèn trang…", click: send("insert") },
        { label: "Tách trang đang chọn…", click: send("extract") },
      ],
    },
    {
      label: "Chuyển đổi",
      submenu: [
        { label: "Khoá file (đặt mật khẩu)…", click: send("encrypt") },
        { type: "separator" },
        { label: "Xuất ảnh trong PDF…", click: send("extractImages") },
        { label: "Trang PDF → ảnh…", click: send("pdfToImages") },
        { label: "Ảnh → PDF…", click: send("imagesToPdf") },
      ],
    },
    {
      label: "Hiển thị",
      submenu: [
        { label: "Phóng to", accelerator: "CmdOrCtrl+=", registerAccelerator: false, click: send("zoomIn") },
        { label: "Thu nhỏ", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: send("zoomOut") },
        { label: "Cỡ gốc (100%)", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: send("zoomReset") },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toàn màn hình" },
        ...(isDev ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: "Trợ giúp",
      submenu: [{ label: "Cài đặt…", click: send("settings") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

// Single-instance: a second launch focuses the existing window instead of
// spawning another app + sidecar (each instance would bind its own port and
// load the OCR models again).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Content-Security-Policy for the local renderer (defence-in-depth). Scripts/
    // styles are 'self'; inline styles are used heavily so style-src needs
    // 'unsafe-inline'. connect-src must allow the loopback sidecar; worker-src
    // covers the pdf.js worker.
    const csp =
      "default-src 'self'; " +
      "script-src 'self' 'wasm-unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' http://127.0.0.1:* http://localhost:*; " +
      "worker-src 'self' blob:; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });

    buildMenu();
    createWindow();
    bootSidecar();
    initAutoUpdate(mainWindow);
    initLicense();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---- IPC: sidecar status -------------------------------------------------

ipcMain.handle("sidecar:status", () => sidecarState);

ipcMain.handle("sidecar:restart", () => {
  stopSidecar(sidecar);
  sidecar = null;
  bootSidecar();
  return sidecarState;
});

// App version + build channel, for the Settings "Cập nhật" section.
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
}));

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

// Generic open for non-PDF inputs (images → PDF). `filters`/`multi` come from the
// renderer; defaults to common image types with multi-selection.
ipcMain.handle("dialog:open-files", async (_e, { multi = true, filters } = {}) => {
  const props = ["openFile"];
  if (multi) props.push("multiSelections");
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn tệp",
    properties: props,
    filters:
      filters && filters.length
        ? filters
        : [{ name: "Ảnh", extensions: ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp", "gif"] }],
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

// Silent save (no dialog) to a path the document already has — backs "Lưu"
// (Ctrl+S) once the file has a known location. Falls back to {saved:false} on
// any write error so the renderer can surface it / prompt Save As instead.
ipcMain.handle("file:write-pdf", async (_e, { path: fp, data }) => {
  try {
    if (!fp) return { saved: false };
    fs.writeFileSync(fp, Buffer.from(data));
    return { saved: true, path: fp };
  } catch (e) {
    return { saved: false, error: String((e && e.message) || e) };
  }
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

// Reveal a path in the OS file manager (Explorer/Finder). Used by the
// breadcrumb: click a folder segment → open that folder; the filename → select
// the file. Falls back to opening the path if it's a directory.
ipcMain.handle("shell:show-in-folder", (_e, fullPath) => {
  if (!fullPath || typeof fullPath !== "string") return false;
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      shell.openPath(fullPath);
    } else {
      shell.showItemInFolder(fullPath);
    }
    return true;
  } catch {
    return false;
  }
});

// Open an http(s) link in the user's default browser. Used by the About
// section (license + source-repo links). Restricted to http/https so a
// compromised renderer can't open arbitrary local files/protocols.
ipcMain.handle("shell:open-external", (_e, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

// Open a bundled license file (AGPL text or third-party notices) in the OS
// default text viewer. Only these two fixed files — no renderer-supplied paths.
ipcMain.handle("licenses:open", (_e, which) => {
  const names = { agpl: "LICENSE.txt", thirdParty: "THIRD-PARTY-LICENSES.txt" };
  const name = names[which];
  if (!name) return false;
  // Packaged: extraResources land in resourcesPath. Dev: read from the repo root.
  const file = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, "..", "..", which === "agpl" ? "LICENSE" : "THIRD-PARTY-LICENSES.txt");
  shell.openPath(file);
  return true;
});

// ---- shutdown ------------------------------------------------------------

app.on("window-all-closed", () => {
  stopSidecar(sidecar);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopSidecar(sidecar));
