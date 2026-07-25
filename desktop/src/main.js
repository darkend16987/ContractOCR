"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, clipboard, nativeImage } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");
const { initAutoUpdate } = require("./updater");
const { initLicense } = require("./license");
const { initSigning } = require("./signing");
const Tabs = require("./tabs");

// Each document opens as a TAB inside a TabbedWindow (BaseWindow + one
// WebContentsView per doc — see src/tabs.js). Every tab is a full, independent
// renderer with its own single-doc state, but all tabs across all windows share
// the ONE Python sidecar (same port + token) so OCR models load once.
let sidecar = null;
// Set once an app-wide quit is under way, so the per-tab unsaved-changes guard
// stands down (see TabbedWindow._onClose).
let appQuitting = false;

// A BaseWindow to parent app-level dialogs (updater / message boxes) on: the
// focused TabbedWindow, else any. May be null before the first window exists.
function primaryWindow() {
  const tw = Tabs.focusedTabbedWindow();
  return tw ? tw.base : null;
}

// The BaseWindow that owns the webContents that sent an IPC message — the
// correct parent for its native dialogs. Resolves both document views and the
// tab strip; falls back to the primary window.
function senderWindow(e) {
  const wc = e && e.sender;
  if (wc) {
    const found = Tabs.findDoc(wc);
    if (found && !found.tw.base.isDestroyed()) return found.tw.base;
    const tw = Tabs.findByStrip(wc);
    if (tw && !tw.base.isDestroyed()) return tw.base;
  }
  return primaryWindow();
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
  for (const wc of Tabs.allDocContents()) {
    wc.send("sidecar:status", sidecarState);
  }
}

// Defence-in-depth navigation lock for a document view: it only ever shows the
// one local page. Block any attempt to navigate away or open new windows (in
// case the renderer is ever compromised, e.g. via a crafted PDF). External
// http(s) links go through the explicit shell:open-external IPC instead.
function hardenNav(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (e, url) => {
    if (url !== webContents.getURL()) e.preventDefault();
  });
}

// Open a PDF path in the app: as a new TAB in the focused window if one exists,
// otherwise in a fresh window. Used by "Open with" / drag-onto-icon and the
// second-instance handler (double-clicking more PDFs → more tabs).
function openPathInApp(filePath) {
  const tw = Tabs.focusedTabbedWindow();
  if (tw) {
    tw.createTab({ openPath: filePath });
    tw.focus();
  } else {
    Tabs.createTabbedWindow(filePath);
  }
}

// Right-click context menu. Rebuilt on every click from the hit-test params so it
// only offers what applies where the user clicked: the full edit set inside a text
// field, copy/select for a plain text selection, and copy/open for a link. Uses
// native roles (they act on this window's webContents) so it needs no renderer
// code and works under the sandbox. Labels follow the in-app language (menuLang);
// undo/redo appear only inside editable fields, so the native roles here never
// clash with the renderer's own PDF undo stack.
function attachContextMenu(webContents) {
  webContents.on("context-menu", (_e, params) => {
    const L = MENU_STR[menuLang] || MENU_STR.vi;
    const f = params.editFlags || {};
    const hasSelection = !!(params.selectionText && params.selectionText.trim());
    const items = [];

    if (params.isEditable) {
      items.push(
        { role: "undo", label: L.undo, enabled: !!f.canUndo },
        { role: "redo", label: L.redo, enabled: !!f.canRedo },
        { type: "separator" },
        { role: "cut", label: L.cut, enabled: !!f.canCut },
        { role: "copy", label: L.copy, enabled: !!f.canCopy },
        { role: "paste", label: L.paste, enabled: !!f.canPaste },
        { type: "separator" },
        { role: "selectAll", label: L.selectAll, enabled: f.canSelectAll !== false }
      );
    } else if (hasSelection) {
      // Plain text selection (e.g. in a dialog): copy it / select all. When there
      // is NO selection and no editable target — e.g. a right-click on a PDF page
      // canvas — we intentionally pop nothing here so the renderer's own page menu
      // ("Sao chép ảnh" / "Sao chép vùng") owns that gesture (see capture.js).
      items.push(
        { role: "copy", label: L.copy, enabled: !!f.canCopy },
        { role: "selectAll", label: L.selectAll, enabled: f.canSelectAll !== false }
      );
    }

    // Link under the cursor → copy its URL / open it in the default browser.
    if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
      const url = params.linkURL;
      items.push(
        { type: "separator" },
        { label: L.copyLink, click: () => clipboard.writeText(url) },
        { label: L.openLink, click: () => shell.openExternal(url) }
      );
    }

    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}

// Read a PDF off disk and push it to a window's renderer to open. Guards the
// path so only real .pdf files are read (defence against a bogus argv entry).
function sendFileToView(webContents, filePath) {
  try {
    if (!webContents || webContents.isDestroyed()) return;
    if (!filePath || !/\.pdf$/i.test(filePath)) return;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
    const data = fs.readFileSync(filePath);
    webContents.send("file:open", {
      path: filePath,
      name: path.basename(filePath),
      data,
    });
  } catch (_) {
    /* ignore unreadable file — the empty tab is still usable */
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
    copyLink: "Sao chép liên kết",
    openLink: "Mở liên kết trong trình duyệt",
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
    copyLink: "Copy Link",
    openLink: "Open Link in Browser",
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
    // Menu commands target the active tab of the window the user is using.
    const wc = Tabs.activeContents();
    if (wc) wc.send("menu:cmd", cmd);
  };
  const isDev = !app.isPackaged;
  const template = [
    {
      label: L.file,
      submenu: [
        { label: L.newWindow, accelerator: "CmdOrCtrl+N", click: () => Tabs.createTabbedWindow() },
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
    openPathInApp(filePath);
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
      openPathInApp(filePath);
      return;
    }
    const tw = Tabs.focusedTabbedWindow();
    if (tw) {
      if (tw.base.isMinimized()) tw.base.restore();
      tw.focus();
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

    // Wire the tab layer with the process-level helpers it needs (keeps tabs.js
    // free of app wiring / circular requires).
    Tabs.configure({
      RENDERER,
      docPreload: path.join(__dirname, "preload.js"),
      shellPreload: path.join(__dirname, "shell-preload.js"),
      iconPath: path.join(__dirname, "..", "build", "icon.png"),
      hardenNav,
      attachContextMenu,
      sendFileToView,
      isQuitting: () => appQuitting,
      onAllClosed: () => {
        if (process.platform !== "darwin") app.quit();
      },
    });

    buildMenu(menuLang);
    // Open a file passed on the command line (Windows "Open with") or stashed by
    // a pre-ready macOS open-file event; otherwise an empty tab.
    const launchFile = pendingOpenPath || pdfPathFromArgv(process.argv);
    pendingOpenPath = null;
    Tabs.createTabbedWindow(launchFile || undefined);
    bootSidecar();
    // Updater needs both a BaseWindow (to parent its dialogs) and a webContents
    // (to push status events) — the focused window's base + its active tab.
    initAutoUpdate(() => {
      const tw = Tabs.focusedTabbedWindow();
      if (!tw) return null;
      return { base: tw.base, contents: Tabs.activeContents() };
    });
    initLicense();
    initSigning();

    app.on("activate", () => {
      if (Tabs.count() === 0) Tabs.createTabbedWindow();
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
  await fs.promises.writeFile(res.filePath, Buffer.from(data)); // async: never block main
  return { saved: true, path: res.filePath };
});

// Silent save (no dialog) to a path the document already has — backs "Lưu"
// (Ctrl+S) once the file has a known location. Falls back to {saved:false} on
// any write error so the renderer can surface it / prompt Save As instead.
ipcMain.handle("file:write-pdf", async (_e, { path: fp, data }) => {
  try {
    if (!fp) return { saved: false };
    await fs.promises.writeFile(fp, Buffer.from(data)); // async: never block main
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
  await fs.promises.writeFile(res.filePath, Buffer.from(data)); // async: never block main
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
    // e.sender is the requesting document view's webContents (its #print-root
    // holds the rasterised pages we print).
    if (!e.sender || e.sender.isDestroyed()) return [];
    return await e.sender.getPrintersAsync();
  } catch (_) {
    return [];
  }
});

// Paper sizes valid for webContents.print() in Electron 33 (WebContentsPrintOptions).
const PRINT_PAGE_SIZES = new Set([
  "A0", "A1", "A2", "A3", "A4", "A5", "A6", "Legal", "Letter", "Tabloid",
]);

ipcMain.handle("print:page", (e, opts = {}) => {
  return new Promise((resolve) => {
    const wc = e.sender; // the requesting document view's webContents
    if (!wc || wc.isDestroyed()) {
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
    // Named sizes Electron's webContents.print() accepts (WebContentsPrintOptions).
    // A0/A1/A2 are supported natively — large-format printing (drawings/posters).
    // Only forward a known-good value; an unrecognised string makes print() throw.
    if (opts.pageSize && PRINT_PAGE_SIZES.has(opts.pageSize)) printOpts.pageSize = opts.pageSize;
    if (opts.duplexMode) printOpts.duplexMode = opts.duplexMode; // 'simplex' | 'shortEdge' | 'longEdge'
    try {
      wc.print(printOpts, (success, reason) => {
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

// Read an image OFF the OS clipboard as a PNG data URL (for "Dán ảnh vào trang"
// in the page context menu). Returns null when the clipboard holds no image. We
// only ever read image data here — never text — so this can't leak clipboard text.
ipcMain.handle("clipboard:read-image", () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    return img.toDataURL(); // "data:image/png;base64,…"
  } catch (_) {
    return null;
  }
});

// New empty document WINDOW (renderer "Cửa sổ mới" button / Ctrl+N). Each window
// carries its own tabs.
ipcMain.handle("window:new", () => {
  Tabs.createTabbedWindow();
  return true;
});

// ---- IPC: tab strip (shell.html) -----------------------------------------

// The ＋ button — open a new empty tab in the window that owns this strip.
ipcMain.on("tabs:new-tab", (e) => {
  const tw = Tabs.findByStrip(e.sender);
  if (tw) tw.createTab();
});

ipcMain.on("tabs:activate", (e, id) => {
  const tw = Tabs.findByStrip(e.sender);
  if (tw) tw.activateTab(id);
});

// ✕ on a tab (or middle-click) — runs the same unsaved-changes guard as a window
// close, but only tears down that one tab (closing the window if it was last).
ipcMain.on("tabs:close", (e, id) => {
  const tw = Tabs.findByStrip(e.sender);
  if (tw) tw.closeTab(id);
});

// A document renderer reporting its tab title / dirty state (see setTabMeta in
// preload.js). e.sender is that tab's view webContents.
ipcMain.on("tab:meta", (e, meta) => {
  const found = Tabs.findDoc(e.sender);
  if (found) found.tw.setMeta(e.sender, meta);
});

// ---- IPC: unsaved-changes close guard ------------------------------------

// Native Save / Don't save / Cancel dialog for a window closing with unsaved
// changes. Labels follow the in-app language. Returns 0=save, 1=don't save,
// 2=cancel (also the value on any failure, so an error never force-closes).
ipcMain.handle("window:confirm-close", async (e) => {
  const win = senderWindow(e);
  const dl =
    menuLang === "en"
      ? { buttons: ["Save", "Don't Save", "Cancel"], message: "You have unsaved changes.", detail: "Do you want to save them before closing?" }
      : { buttons: ["Lưu", "Không lưu", "Huỷ"], message: "Tài liệu có thay đổi chưa lưu.", detail: "Bạn có muốn lưu trước khi đóng không?" };
  try {
    const res = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: dl.buttons,
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: "Nabu PDF",
      message: dl.message,
      detail: dl.detail,
    });
    return res.response;
  } catch (_) {
    return 2; // treat any failure as Cancel — never lose data by force-closing
  }
});

// The document renderer has decided its tab may close — resolve the pending
// close request (see TabbedWindow._requestClose), which tears that tab down
// (and closes the window if it was the last tab).
ipcMain.handle("window:force-close", (e) => {
  const found = Tabs.findDoc(e.sender);
  if (found) found.tw._resolveClose(found.tab.id, true);
  return true;
});

// The document renderer cancelled its close (user chose "Huỷ", or aborted a Save
// As) — resolve the pending close as "cancel" so a whole-window close aborts
// cleanly instead of hanging waiting for a decision.
ipcMain.handle("window:close-cancelled", (e) => {
  const found = Tabs.findDoc(e.sender);
  if (found) found.tw._resolveClose(found.tab.id, false);
  return true;
});

// ---- IPC: crash recovery (AutoRecover-style snapshots) -------------------
//
// Snapshots live under userData/recovery/<docId>/{autosave.pdf, manifest.json}.
// A clean session (save or confirmed close) clears its slot, so whatever survives
// to the next launch is a crash/power-loss remnant that recovery:scan surfaces.

const recoveryDir = () => path.join(app.getPath("userData"), "recovery");
// docId is a renderer-generated UUID; hard-sanitise anyway so it can only ever
// name a direct child of the recovery folder (no traversal).
const sanitizeId = (id) => String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
const RECOVERY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // prune snapshots older than 2 weeks
let recoveryScanDone = false; // only the first window per launch consumes orphans

ipcMain.handle("recovery:save", async (_e, { docId, bytes, name, srcPath } = {}) => {
  try {
    const id = sanitizeId(docId);
    if (!id || !bytes) return { saved: false };
    const dir = path.join(recoveryDir(), id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "autosave.pdf"), Buffer.from(bytes));
    const manifest = { docId: id, name: name || "document.pdf", srcPath: srcPath || null, savedAt: Date.now(), version: app.getVersion() };
    await fs.promises.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    return { saved: true };
  } catch (err) {
    return { saved: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("recovery:clear", async (_e, docId) => {
  try {
    const id = sanitizeId(docId);
    if (!id) return false;
    await fs.promises.rm(path.join(recoveryDir(), id), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle("recovery:scan", async () => {
  try {
    if (recoveryScanDone) return []; // one prompt per launch, from the first asker
    recoveryScanDone = true;
    const base = recoveryDir();
    if (!fs.existsSync(base)) return [];
    const out = [];
    for (const id of await fs.promises.readdir(base)) {
      const dir = path.join(base, id);
      try {
        if (!fs.existsSync(path.join(dir, "autosave.pdf"))) continue;
        const mf = JSON.parse(await fs.promises.readFile(path.join(dir, "manifest.json"), "utf8"));
        // Prune stale remnants so the folder can't grow without bound.
        if (mf.savedAt && Date.now() - mf.savedAt > RECOVERY_MAX_AGE_MS) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          continue;
        }
        out.push({ docId: id, name: mf.name || "document.pdf", srcPath: mf.srcPath || null, savedAt: mf.savedAt || 0 });
      } catch (_) {
        /* skip a broken/half-written entry */
      }
    }
    out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return out;
  } catch (_) {
    return [];
  }
});

ipcMain.handle("recovery:read", async (_e, docId) => {
  try {
    const id = sanitizeId(docId);
    const dir = path.join(recoveryDir(), id);
    const bytes = await fs.promises.readFile(path.join(dir, "autosave.pdf"));
    const mf = JSON.parse(await fs.promises.readFile(path.join(dir, "manifest.json"), "utf8"));
    return { ok: true, bytes, name: mf.name || "document.pdf", srcPath: mf.srcPath || null };
  } catch (_) {
    return { ok: false };
  }
});

// ---- shutdown ------------------------------------------------------------

app.on("window-all-closed", () => {
  stopSidecar(sidecar);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  appQuitting = true; // let windows close without the per-window guard blocking quit
  stopSidecar(sidecar);
});
