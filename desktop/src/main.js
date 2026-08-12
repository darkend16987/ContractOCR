"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, clipboard, nativeImage, screen } = require("electron");
const { startSidecar, stopSidecar } = require("./sidecar");
const Session = require("./session");
const Prefs = require("./prefs");
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

// Open a PDF path in the app: as a new TAB in the focused window, or in a fresh
// window — whichever the "Mở file mới trong" setting says (default: tab, the
// behaviour that predates the setting). Used by "Open with" / drag-onto-icon and
// the second-instance handler (double-clicking more PDFs).
//
// This route is exactly why that preference has to live in main (src/prefs.js):
// a file arriving from Explorer may find no window open at all, so there is no
// renderer to ask.
function openPathInApp(filePath) {
  const tw = Tabs.focusedTabbedWindow();
  if (tw && Prefs.getOpenIn() === "tab") {
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
    newTab: "Tab mới",
    newWindow: "Cửa sổ mới",
    closeTab: "Đóng tab",
    tearOut: "Tách ra cửa sổ riêng",
    moveToWindow: "Chuyển tới cửa sổ",
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
    fullscreen: "Toàn màn hình (trọn trang)",
    help: "Trợ giúp",
    guide: "Hướng dẫn sử dụng",
    settings: "Cài đặt…",
  },
  en: {
    file: "File",
    newTab: "New Tab",
    newWindow: "New Window",
    closeTab: "Close Tab",
    tearOut: "Move Tab to New Window",
    moveToWindow: "Move Tab to Window",
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
    fullscreen: "Full Screen (fit page)",
    help: "Help",
    guide: "User Guide",
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
        {
          label: L.newTab,
          accelerator: "CmdOrCtrl+T",
          click: () => {
            const tw = Tabs.focusedTabbedWindow();
            if (tw) tw.createTab();
            else Tabs.createTabbedWindow();
          },
        },
        { label: L.newWindow, accelerator: "CmdOrCtrl+N", click: () => Tabs.createTabbedWindow() },
        { label: L.open, accelerator: "CmdOrCtrl+O", click: send("open") },
        { type: "separator" },
        { label: L.print, accelerator: "CmdOrCtrl+P", registerAccelerator: false, click: send("print") },
        { type: "separator" },
        { label: L.save, accelerator: "CmdOrCtrl+S", click: send("save") },
        { label: L.saveAs, accelerator: "CmdOrCtrl+Shift+S", click: send("saveAs") },
        { type: "separator" },
        // Ctrl+W must close the TAB, not the window — that is what every tabbed app
        // does, and role:"close" would silently bind Ctrl+W to the whole window
        // (taking every other tab down with it). Window close moves to Ctrl+Shift+W.
        {
          label: L.closeTab,
          accelerator: "CmdOrCtrl+W",
          click: () => {
            const tw = Tabs.focusedTabbedWindow();
            if (tw && tw.activeId != null) tw.closeTab(tw.activeId);
          },
        },
        {
          label: L.close,
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => {
            const tw = Tabs.focusedTabbedWindow();
            if (tw && !tw.base.isDestroyed()) tw.base.close();
          },
        },
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
        // Not role:"togglefullscreen": that only stretches the window — the
        // toolbars, the sidebar and the tab strip stay, and the page keeps its
        // zoom, so the document does NOT end up whole on screen. Our own mode
        // does all four. registerAccelerator:false leaves F11 to the renderer's
        // key handler (same pattern as Ctrl+P) so it can't fire twice.
        { label: L.fullscreen, accelerator: "F11", registerAccelerator: false, click: send("presentation") },
        ...(isDev ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: L.help,
      submenu: [
        // F1 keeps `registerAccelerator` at its default (true), unlike Ctrl+P / Ctrl+Z /
        // Delete / F11 above. Those are handed to the renderer because it has to check
        // what is focused first (a Delete while typing must not delete pages). Nothing
        // in the app types F1, so letting Electron own it is both correct and one less
        // key path in the renderer's keydown ladder.
        { label: L.guide, accelerator: "F1", click: send("guide") },
        { type: "separator" },
        { label: L.settings, click: send("settings") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Spawn the Python sidecar in the background. OCR-dependent UI stays disabled
// until this resolves; the rest of the app works without it.
function bootSidecar() {
  setSidecarState({ state: "starting", port: null, error: null });
  // A sidecar that dies by itself has to say so. The renderer already handles
  // state:"error" everywhere (red badge with this message as its tooltip, and
  // updateToolbar dimming every engine-backed button) — it was simply never told.
  const onExit = (code, handle) => {
    // Only the sidecar we are actually using may report its own death. An older one
    // exiting late (after a restart) must not overwrite the new one's "ready".
    if (sidecar !== handle) return;
    sidecar = null;
    setSidecarState({
      state: "error",
      port: null,
      error: `Engine đã dừng đột ngột (mã ${code}). Khởi động lại app để dùng tiếp.`,
    });
  };
  startSidecar(SIDECAR_TOKEN, onExit)
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

    Session.configure({
      file: path.join(app.getPath("userData"), "session.json"),
      snapshot: Tabs.snapshotSession,
      anyClosing: Tabs.anyClosing,
    });

    // Must come before the first window is created below: the launch path can
    // already be routing a file handed over by Explorer.
    Prefs.configure({ file: path.join(app.getPath("userData"), "prefs.json") });

    buildMenu(menuLang);
    // Open a file passed on the command line (Windows "Open with") or stashed by
    // a pre-ready macOS open-file event; otherwise reopen the previous session.
    const launchFile = pendingOpenPath || pdfPathFromArgv(process.argv);
    pendingOpenPath = null;
    if (launchFile) {
      // Launched by double-clicking a PDF: open just that file. Dragging the
      // whole previous session along would be a surprise, not a service.
      Tabs.createTabbedWindow(launchFile);
    } else {
      const restored = Session.isEnabled() ? Tabs.restoreSession(Session.previousWindows()) : 0;
      if (!restored) {
        Tabs.createTabbedWindow();
      } else if (hasRecoveryOrphans()) {
        // A previous run crashed with unsaved work. Every restored tab is
        // earmarked for a document and declines the recovery prompt, so give
        // that prompt an empty tab of its own to appear in.
        const tw = Tabs.focusedTabbedWindow();
        if (tw) tw.createTab();
      }
    }
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

// Pick PDF paths WITHOUT reading them: the tab layer opens each by path, so main
// reads the bytes straight into the target renderer (no wasteful double read /
// IPC of a large file just to grab its path). Returns absolute paths, [] if
// cancelled.
ipcMain.handle("dialog:pick-pdfs", async (e) => {
  const res = await dialog.showOpenDialog(senderWindow(e), {
    title: "Mở PDF",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return res.canceled ? [] : res.filePaths;
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

// Full-screen reading mode for the window that owns the calling tab. Routed
// through main because the window and the tab strip are main's to change; the
// renderer only hides its own chrome, and only once main confirms.
ipcMain.handle("window:set-presentation", (e, on) => {
  const d = Tabs.findDoc(e.sender);
  if (!d) return false;
  return d.tw.setPresentation(!!on);
});

// ---- IPC: moving pages between documents ----------------------------------
//
// docs/SPEC-page-drag.md. Main is a ROUTER here and nothing else: it never parses
// a PDF, and it never lets one renderer name another. Every transfer runs
// source → main → target → main → source, so a renderer can only ever act on the
// document it already owns (BI-55) — the webContents of the destination never
// leaves this file.
//
// The transfer is deliberately COPY at this layer: main hands the target a set of
// pages, and only the SOURCE may delete anything, only after the target has
// confirmed the insert really happened (BI-56). A failure anywhere therefore
// costs a duplicated page — visible, and one Ctrl+Z away — never a lost one.

// One page-drag at a time: there is one cursor.
let pageDrag = null; // { wc, timer, watchdog, hoveredWc }
const PAGE_HOVER_MS = 80; // cue refresh — smooth enough to follow a hand
const PAGE_DRAG_MAX_MS = 30000; // watchdog: a lost dragend must not leave a timer running (BI-58)
const PAGE_ASK_MS = 800; // building the menu: a tab too busy to answer is greyed out
const PAGE_DROP_ASK_MS = 3000; // an actual drop deserves patience — a mid-render tab is not a refusal
const PAGE_EXPORT_MS = 60000; // pdf-lib load + copyPages + save on the source
const PAGE_INSERT_MS = 180000; // same again on the target, plus a full re-render

// main → renderer request/response. ipcMain cannot invoke INTO a renderer, so the
// reply comes back on one shared channel carrying the same reqId. Resolves to null
// on timeout or a dead renderer, and every caller treats null as "it did not
// happen" rather than guessing.
const pageReqs = new Map(); // reqId -> { wc, resolve, timer }
let _pageReqSeq = 0;
function askRenderer(wc, channel, payload, timeoutMs) {
  return new Promise((resolve) => {
    if (!wc || wc.isDestroyed()) return resolve(null);
    const reqId = ++_pageReqSeq;
    const timer = setTimeout(() => {
      pageReqs.delete(reqId);
      resolve(null);
    }, timeoutMs);
    pageReqs.set(reqId, { wc, resolve, timer });
    try {
      wc.send(channel, { ...(payload || {}), reqId });
    } catch (_) {
      clearTimeout(timer);
      pageReqs.delete(reqId);
      resolve(null);
    }
  });
}
// A reply counts only from the renderer the request was actually sent to.
ipcMain.on("pages:reply", (e, msg) => {
  const reqId = msg && msg.reqId;
  const p = reqId ? pageReqs.get(reqId) : null;
  if (!p || p.wc !== e.sender) return;
  clearTimeout(p.timer);
  pageReqs.delete(reqId);
  p.resolve(msg);
});

function pageSend(wc, channel, payload) {
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch (_) {
    /* renderer gone */
  }
}

// Tell whichever renderer was showing a drop cue to stop. Called on every change
// of hovered window and once more when the drag ends, so a cue can never outlive
// the drag that drew it (P4).
function endPageHover() {
  if (pageDrag && pageDrag.hoveredWc) {
    pageSend(pageDrag.hoveredWc, "pages:hover-end", {});
    pageDrag.hoveredWc = null;
  }
}

function stopPageDrag() {
  if (!pageDrag) return;
  endPageHover();
  clearInterval(pageDrag.timer);
  clearTimeout(pageDrag.watchdog);
  pageDrag = null;
}

// While a page drag is in flight, push the cursor to the window under it so that
// window can draw the insert cue. The cursor is read HERE for the same reason the
// tab layer reads it here: renderer screen coordinates inside a WebContentsView
// are offset by the window frame (docs/TABS-2B-DESIGN.md §2.3).
function pageDragTick() {
  if (!pageDrag) return;
  if (pageDrag.wc.isDestroyed()) return stopPageDrag();
  const src = Tabs.findDoc(pageDrag.wc);
  let point = null;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    /* no cursor info → classifyPageDrop returns "none" and we just clear the cue */
  }
  const d = Tabs.classifyPageDrop(point, src ? src.tw : null, Tabs.pageDropTargets());
  // "self" is the shipped in-column reorder: not one byte of IPC, not one cue.
  if (d.action !== "send") return endPageHover();
  const wc = d.key.activeDocContents();
  if (!wc) return endPageHover();
  if (pageDrag.hoveredWc && pageDrag.hoveredWc !== wc) endPageHover();
  pageDrag.hoveredWc = wc;
  const at = Tabs.docViewLocalPoint(d.key.docViewScreenRect(), point);
  if (at) pageSend(wc, "pages:hover", at);
}

// The one path pages ever travel. `at` is a point in the target view's client
// coordinates (hand-thrown pages) or null (menu — append at the end, the same
// predictable v1 choice the tab layer made for a tab dropped into another window,
// docs/TABS-2B-DESIGN.md T8).
//
// Focus is deliberately NOT stolen: with COPY as the default the source document
// is still the one being worked on, and for a destination that is an inactive TAB
// switching to it would yank the user off the document they are reading. Both ends
// toast instead, so whichever window is being looked at reports what happened.
async function routePages(sourceWc, targetWc, { at, label } = {}) {
  if (!targetWc || targetWc.isDestroyed()) return { ok: false, reason: "no-target" };
  if (targetWc === sourceWc) return { ok: false, reason: "same-doc" };
  // Ask the destination FIRST. It is the only side that can say whether that point
  // is a real insert position, and asking costs milliseconds where exporting costs
  // seconds on a large document — so a drop landed in the wrong place must not make
  // the source grind through pdf-lib for nothing.
  const can = await askRenderer(targetWc, "pages:can-accept", { at: at || null }, PAGE_DROP_ASK_MS);
  if (!can || !can.ok) return { ok: false, reason: (can && can.block) || "busy" };
  const ex = await askRenderer(sourceWc, "pages:export", {}, PAGE_EXPORT_MS);
  if (!ex || !ex.ok || !ex.bytes) return { ok: false, reason: (ex && ex.reason) || "export-failed" };
  const got = await askRenderer(
    targetWc,
    "pages:receive",
    { bytes: ex.bytes, count: ex.count, from: ex.name || null, gap: can.gap },
    PAGE_INSERT_MS
  );
  if (!got || !got.ok) return { ok: false, reason: (got && got.reason) || "insert-failed" };
  return { ok: true, inserted: got.inserted || ex.count, target: label || null };
}

// A page drag started. Cheap on purpose: this fires for EVERY thumbnail drag,
// including the plain same-document reorder, so it may not do real work.
ipcMain.on("pages:drag-start", (e) => {
  stopPageDrag(); // a previous drag that never reported its end
  if (!Tabs.findDoc(e.sender)) return;
  pageDrag = { wc: e.sender, timer: null, watchdog: null, hoveredWc: null };
  pageDrag.timer = setInterval(pageDragTick, PAGE_HOVER_MS);
  pageDrag.watchdog = setTimeout(stopPageDrag, PAGE_DRAG_MAX_MS);
});

// A page drag finished. Returns what the drop meant so the SOURCE can report it
// and, for a Shift-move, delete its originals — only ever after ok:true.
ipcMain.handle("pages:drag-end", async (e) => {
  const mine = !!(pageDrag && pageDrag.wc === e.sender);
  // Stop chasing the cursor, but LEAVE THE CUE UP. It is pointing at exactly where
  // the pages are about to land, and taking it down before the insert finishes makes
  // the destination flicker — and, when its page column was spring-loaded open, snap
  // shut and re-open (P12). One hover-end goes out in the `finally` below instead.
  if (mine) {
    clearInterval(pageDrag.timer);
    clearTimeout(pageDrag.watchdog);
    pageDrag.timer = null;
    pageDrag.watchdog = null;
  }
  try {
    const src = Tabs.findDoc(e.sender);
    if (!mine || !src) return { ok: false, action: "none" };
    let point = null;
    try {
      point = screen.getCursorScreenPoint();
    } catch (_) {
      /* → "none": a drop we cannot place is a drop that does nothing */
    }
    const d = Tabs.classifyPageDrop(point, src.tw, Tabs.pageDropTargets());
    if (d.action !== "send") return { ok: false, action: d.action };
    const targetWc = d.key.activeDocContents();
    const at = Tabs.docViewLocalPoint(d.key.docViewScreenRect(), point);
    const res = await routePages(e.sender, targetWc, { at, label: Tabs.windowLabel(d.key) });
    return { action: "send", ...res };
  } finally {
    // Only ever tear down OUR drag: another window's drag may be in flight.
    if (mine) stopPageDrag();
  }
});

// Destinations for "Chuyển trang tới…". Eligibility is ASKED at menu-open time
// rather than remembered: whether a tab can take pages changes with every document
// opened and every annotation session started, and a stale "yes" here would offer
// a destination that then refuses (P13).
ipcMain.handle("pages:targets", async (e) => {
  if (!Tabs.findDoc(e.sender)) return [];
  const cands = Tabs.pageTargetTabs(e.sender);
  const replies = await Promise.all(
    cands.map((c) => askRenderer(c.wc, "pages:can-accept", { at: null }, PAGE_ASK_MS))
  );
  return cands.map((c, i) => {
    const r = replies[i];
    return {
      id: c.id,
      title: c.title,
      window: c.window,
      sameWindow: c.sameWindow,
      accepts: !!(r && r.ok),
      // No answer at all ⇒ that renderer is wedged or still loading. Say so rather
      // than inventing a reason the tab never gave.
      block: r ? r.block || null : "busy",
    };
  });
});

// "Chuyển trang tới <tab>" was picked. Unlike a dropped page this can address an
// INACTIVE tab, which is the whole point: two tabs in one window can never be
// drag targets for each other (SPEC-page-drag.md §4).
ipcMain.handle("pages:send-to", async (e, { tabId } = {}) => {
  if (!Tabs.findDoc(e.sender)) return { ok: false, reason: "no-source" };
  const found = Tabs.findTabById(tabId);
  if (!found || !found.tab.view) return { ok: false, reason: "no-target" };
  return routePages(e.sender, found.tab.view.webContents, { at: null, label: found.tab.title });
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

// A tab drag finished. The cursor position is read HERE, not in the strip: the
// screen coordinates a WebContentsView reports are offset by the window frame
// (measured; see docs/TABS-2B-DESIGN.md §2.3). Main then decides whether that
// drop was a reorder, a move into another window, or a tear-out.
ipcMain.on("tabs:drag-end", (e, { id, order } = {}) => {
  const tw = Tabs.findByStrip(e.sender);
  if (!tw) return;
  let point = null;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    /* no cursor info → classifyDrop falls back to a plain reorder */
  }
  Tabs.handleDragEnd(tw, { id, order, point });
});

// Right-click on a tab. Built here rather than in the strip's HTML so it is a
// native menu, follows the app language, and can reach the other windows.
ipcMain.on("tabs:context-menu", (e, id) => {
  const tw = Tabs.findByStrip(e.sender);
  if (!tw || !tw.tabs.some((t) => t.id === id)) return;
  const L = MENU_STR[menuLang] || MENU_STR.vi;
  const others = Tabs.allWindows().filter((w) => w !== tw);

  const items = [
    { label: L.newTab, click: () => tw.createTab() },
    { type: "separator" },
    // Tearing out the only tab would just rebuild the window it came from.
    { label: L.tearOut, enabled: tw.tabs.length > 1, click: () => tw.tearOutTab(id, null) },
  ];
  if (others.length) {
    items.push({
      label: L.moveToWindow,
      submenu: others.map((w) => ({ label: Tabs.windowLabel(w), click: () => tw.moveTabTo(id, w) })),
    });
  }
  items.push({ type: "separator" }, { label: L.closeTab, click: () => tw.closeTab(id) });
  Menu.buildFromTemplate(items).popup();
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

// Open PDF paths as new tabs in the window that asked (menu/toolbar Open, or a
// drop onto a tab that already holds a document). fillCurrent loads the first
// path into the asking tab when it's still empty, instead of leaving it blank.
ipcMain.handle("tabs:open-paths", (e, { paths, fillCurrent } = {}) => {
  const found = Tabs.findDoc(e.sender);
  const tw = found ? found.tw : Tabs.focusedTabbedWindow();
  if (!tw || !Array.isArray(paths) || !paths.length) return false;
  // The placement decision is pure and tested (Tabs.planOpen, BI-8 + BI-35);
  // this handler only carries it out.
  const plan = Tabs.planOpen(paths, { fillCurrent, openIn: Prefs.getOpenIn() });
  if (plan.fill) sendFileToView(e.sender, plan.fill);
  for (const p of plan.sameWindow) tw.createTab({ openPath: p });
  if (plan.newWindow.length) {
    // One new window for the whole batch — the rest ride along as its tabs.
    const nw = Tabs.createTabbedWindow(plan.newWindow[0]);
    for (let i = 1; i < plan.newWindow.length; i++) nw.createTab({ openPath: plan.newWindow[i] });
  }
  return true;
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

// Is there anything for the recovery prompt to offer? Asked at launch, before any
// renderer exists, to decide whether a restored session needs an empty tab for
// that prompt to live in. Deliberately cheap and non-destructive: it does not
// prune, parse or consume anything — recovery:scan still owns all of that.
function hasRecoveryOrphans() {
  try {
    const base = recoveryDir();
    if (!fs.existsSync(base)) return false;
    return fs.readdirSync(base).some((id) => fs.existsSync(path.join(base, id, "autosave.pdf")));
  } catch (_) {
    return false;
  }
}

// ---- IPC: session restore setting ----------------------------------------

ipcMain.handle("session:get-restore", () => Session.isEnabled());
ipcMain.handle("session:set-restore", (_e, on) => Session.setEnabled(on));

// ---- IPC: main-side preferences ------------------------------------------

// "Mở file mới trong: Tab mới / Cửa sổ mới". Both handlers return the value
// actually stored, so the Settings dialog shows what main will really do rather
// than what the renderer asked for (setOpenIn rejects anything off the list —
// this crosses a process boundary, so the value is untrusted input).
ipcMain.handle("prefs:get-open-in", () => Prefs.getOpenIn());
ipcMain.handle("prefs:set-open-in", (_e, v) => Prefs.setOpenIn(v));

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
  // Quit from the menu / Ctrl+Q: the windows are all still standing, so this is
  // the last honest look at what was open. (When the quit comes from closing the
  // final window instead, there is nothing left to snapshot and TabbedWindow has
  // already frozen the file — hence the guard.)
  if (Tabs.count()) Session.saveNow();
  Session.cancel();
  appQuitting = true; // let windows close without the per-window guard blocking quit
  stopSidecar(sidecar);
});
