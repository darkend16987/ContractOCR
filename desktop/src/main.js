"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, clipboard, nativeImage } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");
const { initAutoUpdate } = require("./updater");
const { initLicense } = require("./license");

// All open document windows. Each BrowserWindow runs its own renderer with its
// own single-doc state, but every window shares the ONE Python sidecar (same
// port + token) so OCR models are loaded once regardless of window count.
const windows = new Set();
let sidecar = null;

// The primary window = first still-alive window. Used as a default parent for
// app-level dialogs (updater) and as a fallback when no window has focus.
function primaryWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  for (const w of windows) if (!w.isDestroyed()) return w;
  return null;
}

// The window that sent an IPC message (correct parent for its dialogs / target
// for its print job). Falls back to the primary window.
function senderWindow(e) {
  const w = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
  return w && !w.isDestroyed() ? w : primaryWindow();
}

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
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send("sidecar:status", sidecarState);
  }
}

// Create a document window. `openPath` (optional) is an absolute path to a PDF
// to load once the renderer is ready (used by "Open with" / drag-onto-icon and
// the second-instance handler).
function createWindow(openPath) {
  const win = new BrowserWindow({
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
  windows.add(win);

  // Load the PDF UI immediately — no waiting on the heavy OCR sidecar.
  win.loadFile(path.join(RENDERER, "index.html"));

  // Hand the renderer a file to open once it has finished loading. Read here in
  // the main process (renderer has no fs) and push the bytes over IPC.
  if (openPath) {
    win.webContents.once("did-finish-load", () => sendFileToWindow(win, openPath));
  }

  // Navigation hardening: this is a single local page. Block any attempt to
  // navigate away or open new windows (defence-in-depth if the renderer is ever
  // compromised, e.g. via a crafted PDF). External http(s) links go through the
  // explicit shell:open-external IPC instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  win.on("closed", () => {
    windows.delete(win);
  });
  return win;
}

// Read a PDF off disk and push it to a window's renderer to open. Guards the
// path so only real .pdf files are read (defence against a bogus argv entry).
function sendFileToWindow(win, filePath) {
  try {
    if (!win || win.isDestroyed()) return;
    if (!filePath || !/\.pdf$/i.test(filePath)) return;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
    const data = fs.readFileSync(filePath);
    win.webContents.send("file:open", {
      path: filePath,
      name: path.basename(filePath),
      data,
    });
  } catch (_) {
    /* ignore unreadable file — the empty window is still usable */
  }
}

// Pull the first existing *.pdf path out of a process argv list. Windows passes
// the file to "Open with" as a bare argument. Skips flags and the app path.
function pdfPathFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv.slice(1)) {
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (!/\.pdf$/i.test(a)) continue;
    try {
      if (fs.existsSync(a) && fs.statSync(a).isFile()) return path.resolve(a);
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

// Native application menu. File/Save accelerators are registered by Electron;
// editing/zoom/page shortcuts are flagged registerAccelerator:false so the
// renderer's keydown handler owns them (it can check focus to avoid hijacking
// keys while the user types in a field). All custom items relay a command to the
// renderer over the "menu:cmd" channel.
// Native-menu label tables. Keyed by the current UI language; the renderer tells
// us its language over "menu:set-lang" (persisted in its localStorage) so the
// native menu matches the in-app language toggle.
const MENU_STR = {
  vi: {
    file: "Tập tin",
    newWindow: "Cửa sổ mới",
    open: "Mở…",
    print: "In…",
    save: "Lưu",
    saveAs: "Lưu thành…",
    close: "Đóng cửa sổ",
    quit: "Thoát",
    edit: "Chỉnh sửa",
    undo: "Hoàn tác",
    redo: "Làm lại",
    cut: "Cắt",
    copy: "Sao chép",
    paste: "Dán",
    selectAll: "Chọn tất cả",
    page: "Trang",
    rotateL: "Xoay trái 90°",
    rotateR: "Xoay phải 90°",
    deletePage: "Xóa trang đang chọn",
    merge: "Ghép PDF…",
    insert: "Chèn trang…",
    extract: "Tách trang đang chọn…",
    convert: "Chuyển đổi",
    encrypt: "Khoá file (đặt mật khẩu)…",
    extractImages: "Xuất ảnh trong PDF…",
    pdfToImages: "Trang PDF → ảnh…",
    imagesToPdf: "Ảnh → PDF…",
    view: "Hiển thị",
    zoomIn: "Phóng to",
    zoomOut: "Thu nhỏ",
    zoomReset: "Cỡ gốc (100%)",
    fullscreen: "Toàn màn hình",
    help: "Trợ giúp",
    settings: "Cài đặt…",
  },
  en: {
    file: "File",
    newWindow: "New Window",
    open: "Open…",
    print: "Print…",
    save: "Save",
    saveAs: "Save As…",
    close: "Close Window",
    quit: "Quit",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    page: "Page",
    rotateL: "Rotate Left 90°",
    rotateR: "Rotate Right 90°",
    deletePage: "Delete Selected Pages",
    merge: "Merge PDF…",
    insert: "Insert Pages…",
    extract: "Extract Selected Pages…",
    convert: "Convert",
    encrypt: "Lock File (set password)…",
    extractImages: "Export Images in PDF…",
    pdfToImages: "PDF Pages → Images…",
    imagesToPdf: "Images → PDF…",
    view: "View",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    zoomReset: "Actual Size (100%)",
    fullscreen: "Toggle Full Screen",
    help: "Help",
    settings: "Settings…",
  },
};

let menuLang = "vi";

function buildMenu(lang) {
  const L = MENU_STR[lang] || MENU_STR.vi;
  const send = (cmd) => () => {
    // Menu commands target the window the user is interacting with.
    const win = primaryWindow();
    if (win) win.webContents.send("menu:cmd", cmd);
  };
  const isDev = !app.isPackaged;
  const template = [
    {
      label: L.file,
      submenu: [
        { label: L.newWindow, accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        { label: L.open, accelerator: "CmdOrCtrl+O", click: send("open") },
        { type: "separator" },
        { label: L.print, accelerator: "CmdOrCtrl+P", registerAccelerator: false, click: send("print") },
        { type: "separator" },
        { label: L.save, accelerator: "CmdOrCtrl+S", click: send("save") },
        { label: L.saveAs, accelerator: "CmdOrCtrl+Shift+S", click: send("saveAs") },
        { type: "separator" },
        { role: "close", label: L.close },
        { role: "quit", label: L.quit },
      ],
    },
    {
      label: L.edit,
      submenu: [
        { label: L.undo, accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: send("undo") },
        { label: L.redo, accelerator: "CmdOrCtrl+Y", registerAccelerator: false, click: send("redo") },
        { type: "separator" },
        { role: "cut", label: L.cut },
        { role: "copy", label: L.copy },
        { role: "paste", label: L.paste },
        { role: "selectAll", label: L.selectAll },
      ],
    },
    {
      label: L.page,
      submenu: [
        { label: L.rotateL, click: send("rotateL") },
        { label: L.rotateR, click: send("rotateR") },
        { label: L.deletePage, accelerator: "Delete", registerAccelerator: false, click: send("delete") },
        { type: "separator" },
        { label: L.merge, click: send("merge") },
        { label: L.insert, click: send("insert") },
        { label: L.extract, click: send("extract") },
      ],
    },
    {
      label: L.convert,
      submenu: [
        { label: L.encrypt, click: send("encrypt") },
        { type: "separator" },
        { label: L.extractImages, click: send("extractImages") },
        { label: L.pdfToImages, click: send("pdfToImages") },
        { label: L.imagesToPdf, click: send("imagesToPdf") },
      ],
    },
    {
      label: L.view,
      submenu: [
        { label: L.zoomIn, accelerator: "CmdOrCtrl+=", registerAccelerator: false, click: send("zoomIn") },
        { label: L.zoomOut, accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: send("zoomOut") },
        { label: L.zoomReset, accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: send("zoomReset") },
        { type: "separator" },
        { role: "togglefullscreen", label: L.fullscreen },
        ...(isDev ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: L.help,
      submenu: [{ label: L.settings, click: send("settings") }],
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

// Single-instance: a second launch is routed into THIS process (see
// second-instance below) rather than spawning another app + sidecar — every
// window shares the one sidecar, so models load once. A second launch opens a
// new window (with the file, if one was passed) instead of a whole new app.
//
// A file passed to a not-yet-ready app (macOS open-file, or a race) is stashed
// here and opened once whenReady resolves.
let pendingOpenPath = null;

// macOS: "Open with" / drag-onto-dock delivers files via this event, which can
// fire before whenReady. Windows uses argv instead (handled below).
app.on("open-file", (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) {
    createWindow(filePath);
  } else {
    pendingOpenPath = filePath;
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (e.g. double-clicking another PDF, or "Open with") is
  // funnelled here instead of starting a new process. Open the file in a NEW
  // window if one was passed; otherwise just surface an existing window.
  app.on("second-instance", (_e, argv) => {
    const filePath = pdfPathFromArgv(argv);
    if (filePath) {
      createWindow(filePath);
      return;
    }
    const win = primaryWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
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

    buildMenu(menuLang);
    // Open a file passed on the command line (Windows "Open with") or stashed by
    // a pre-ready macOS open-file event; otherwise an empty window.
    const launchFile = pendingOpenPath || pdfPathFromArgv(process.argv);
    pendingOpenPath = null;
    createWindow(launchFile || undefined);
    bootSidecar();
    initAutoUpdate(primaryWindow);
    initLicense();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---- IPC: UI language (rebuild native menu to match the in-app toggle) ----

ipcMain.handle("menu:set-lang", (_e, lang) => {
  const next = lang === "en" ? "en" : "vi";
  if (next === menuLang) return next;
  menuLang = next;
  buildMenu(menuLang);
  return menuLang;
});

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

ipcMain.handle("dialog:open-pdf", async (e, { multi = false } = {}) => {
  const props = ["openFile"];
  if (multi) props.push("multiSelections");
  const res = await dialog.showOpenDialog(senderWindow(e), {
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
ipcMain.handle("dialog:open-files", async (e, { multi = true, filters } = {}) => {
  const props = ["openFile"];
  if (multi) props.push("multiSelections");
  const res = await dialog.showOpenDialog(senderWindow(e), {
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

ipcMain.handle("dialog:save-pdf", async (e, { data, defaultName }) => {
  const res = await dialog.showSaveDialog(senderWindow(e), {
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
ipcMain.handle("dialog:save-file", async (e, { data, defaultName, filters }) => {
  const res = await dialog.showSaveDialog(senderWindow(e), {
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

// ---- IPC: print ----------------------------------------------------------
//
// The renderer rasterises the PDF pages into <img>s inside #print-root (see
// printDoc() in renderer/app.js) and shows a Print Options dialog. We then print
// the SENDING window's own webContents — its @media print CSS hides everything but
// #print-root, so the printed content is those real DOM images. This is safe
// (unlike the old approach of printing a hidden window that showed the PDF via
// Chromium's PDFium plugin frame, which the host print path couldn't capture →
// blank sheets). Because we print real DOM, we can pass pageSize/duplex/copies.

ipcMain.handle("print:printers", async (e) => {
  try {
    const win = senderWindow(e);
    if (!win || win.isDestroyed()) return [];
    return await win.webContents.getPrintersAsync();
  } catch (_) {
    return [];
  }
});

ipcMain.handle("print:page", (e, opts = {}) => {
  return new Promise((resolve) => {
    const win = senderWindow(e);
    if (!win || win.isDestroyed()) {
      resolve({ ok: false, reason: "no-window" });
      return;
    }
    const printOpts = {
      silent: !opts.systemDialog, // our modal already collected the options
      printBackground: true,
      copies: Math.max(1, Math.min(999, parseInt(opts.copies, 10) || 1)),
      landscape: !!opts.landscape,
      margins: { marginType: "none" },
    };
    if (opts.deviceName) printOpts.deviceName = opts.deviceName;
    if (opts.pageSize) printOpts.pageSize = opts.pageSize; // 'A4' | 'A5' | 'A3' | 'Letter' | 'Legal'
    if (opts.duplexMode) printOpts.duplexMode = opts.duplexMode; // 'simplex' | 'shortEdge' | 'longEdge'
    try {
      win.webContents.print(printOpts, (success, reason) => {
        resolve({ ok: success, reason });
      });
    } catch (err) {
      resolve({ ok: false, reason: String((err && err.message) || err) });
    }
  });
});

// ---- IPC: clipboard image (copy an image/region out of a page) -----------
//
// The renderer rasterises the chosen image object or marquee region to PNG bytes
// (client-side, via pdf.js) and hands them here. We only ever WRITE an image to
// the OS clipboard — no reading, no arbitrary data — so a compromised renderer
// can't exfiltrate clipboard contents through this channel.
ipcMain.handle("clipboard:write-image", (_e, bytes) => {
  try {
    if (!bytes) return { ok: false, reason: "no-data" };
    const buf = Buffer.from(bytes);
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return { ok: false, reason: "decode-failed" };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

// New empty document window (renderer "Cửa sổ mới" button / Ctrl+N routed here).
ipcMain.handle("window:new", () => {
  createWindow();
  return true;
});

// ---- shutdown ------------------------------------------------------------

app.on("window-all-closed", () => {
  stopSidecar(sidecar);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopSidecar(sidecar));
