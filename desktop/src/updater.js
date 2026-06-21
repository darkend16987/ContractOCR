"use strict";

/**
 * Auto-update over GitHub Releases (electron-updater).
 *
 * Only runs for the INSTALLED (NSIS) build on Windows. It is intentionally a
 * no-op when:
 *   - running unpacked in dev (no app-update.yml),
 *   - running the portable .exe (electron-updater can't replace a single-file
 *     portable — electron-builder sets PORTABLE_EXECUTABLE_DIR for that build).
 *
 * Flow: check on startup → download in background → when ready, ask the user to
 * restart now or later. Unsigned builds still update; Windows may show a
 * SmartScreen prompt for the downloaded installer until a cert is wired up
 * (see SIGNING.md).
 */

const { app, dialog } = require("electron");

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function notify(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("update:status", payload);
}

function initAutoUpdate(mainWindow) {
  // Skip in dev and for the portable target — there's nothing to update.
  if (!app.isPackaged || isPortable() || process.platform !== "win32") {
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    // Dependency missing (e.g. not installed yet) — fail quiet, don't crash.
    console.warn("[updater] electron-updater not available:", err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => notify(mainWindow, { state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    notify(mainWindow, { state: "available", version: info && info.version })
  );
  autoUpdater.on("update-not-available", () => notify(mainWindow, { state: "current" }));
  autoUpdater.on("download-progress", (p) =>
    notify(mainWindow, { state: "downloading", percent: Math.round(p.percent) })
  );
  autoUpdater.on("error", (err) =>
    notify(mainWindow, { state: "error", error: (err && err.message) || String(err) })
  );

  autoUpdater.on("update-downloaded", async (info) => {
    notify(mainWindow, { state: "downloaded", version: info && info.version });
    const { response } = await dialog.showMessageBox(mainWindow, {
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

module.exports = { initAutoUpdate };
