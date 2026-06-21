"use strict";

/**
 * Auto-update over GitHub Releases (electron-updater).
 *
 * Only the INSTALLED (NSIS) build on Windows can actually self-update. It is
 * intentionally a no-op when:
 *   - running unpacked in dev (no app-update.yml),
 *   - running the portable .exe (electron-updater can't replace a single-file
 *     portable — electron-builder sets PORTABLE_EXECUTABLE_DIR for that build).
 *
 * Auto flow: check on startup → download in background → when ready, ask the user
 * to restart now or later.
 *
 * Manual flow: the "Kiểm tra cập nhật" button in Settings calls update:check.
 * That works on every build — on builds that can't self-update it reports *why*
 * (dev / portable / unsupported) so the button never silently does nothing.
 *
 * Unsigned builds still update; Windows may show a SmartScreen prompt for the
 * downloaded installer until a cert is wired up (see SIGNING.md).
 */

const { app, dialog, ipcMain } = require("electron");

// Set once initAutoUpdate runs; null on builds that can't self-update.
let autoUpdaterRef = null;
let winRef = null;

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

// Reason this build can't auto-update, or null if it can.
function updateBlocker() {
  if (!app.isPackaged) return "dev";
  if (process.platform !== "win32") return "unsupported";
  if (isPortable()) return "portable";
  return null;
}

function notify(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("update:status", payload);
}

function initAutoUpdate(mainWindow) {
  winRef = mainWindow;

  // Always register the manual-check handler, even on builds that can't update,
  // so the Settings button gives feedback instead of doing nothing.
  ipcMain.handle("update:check", () => checkManually());

  if (updateBlocker()) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    // Dependency missing (e.g. not installed yet) — fail quiet, don't crash.
    console.warn("[updater] electron-updater not available:", err.message);
    return;
  }
  autoUpdaterRef = autoUpdater;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => notify(winRef, { state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    notify(winRef, { state: "available", version: info && info.version })
  );
  autoUpdater.on("update-not-available", () =>
    notify(winRef, { state: "current", version: app.getVersion() })
  );
  autoUpdater.on("download-progress", (p) =>
    notify(winRef, { state: "downloading", percent: Math.round(p.percent) })
  );
  autoUpdater.on("error", (err) =>
    notify(winRef, { state: "error", error: (err && err.message) || String(err) })
  );

  autoUpdater.on("update-downloaded", async (info) => {
    notify(winRef, { state: "downloaded", version: info && info.version });
    const { response } = await dialog.showMessageBox(winRef, {
      type: "info",
      buttons: ["Khởi động lại & cập nhật", "Để sau"],
      defaultId: 0,
      cancelId: 1,
      title: "Có bản cập nhật",
      message: `Nabu PDF ${info && info.version} đã tải xong.`,
      detail: "Khởi động lại để cài bản mới. Bạn cũng có thể tiếp tục dùng và bản mới sẽ tự cài khi thoát app.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Don't block startup; let the window + sidecar settle first.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) =>
      console.warn("[updater] check failed:", err && err.message)
    );
  }, 4000);

  return autoUpdater;
}

// Triggered by the Settings "Kiểm tra cập nhật" button. Returns an immediate
// state synchronously; for a real check the async result arrives via the
// "update:status" events wired above.
function checkManually() {
  const blocker = updateBlocker();
  if (blocker) return { state: blocker, version: app.getVersion() };
  if (!autoUpdaterRef) return { state: "unsupported", version: app.getVersion() };
  notify(winRef, { state: "checking" });
  autoUpdaterRef.checkForUpdates().catch((err) =>
    notify(winRef, { state: "error", error: (err && err.message) || String(err) })
  );
  return { state: "checking", version: app.getVersion() };
}

module.exports = { initAutoUpdate };
