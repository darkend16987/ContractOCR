"use strict";

/**
 * PDF digital signing (PKI) — like Foxit/Acrobat, for Vietnamese USB tokens.
 *
 * The private key never leaves the token. Flow:
 *   1. Ask the bundled Windows helper (nabu-sign.exe) to enumerate signing
 *      certificates from the Windows Certificate Store — where VNPT-CA /
 *      Viettel-CA / FPT-CA / BKAV… tokens register.
 *   2. Insert a signature placeholder (+ optional visible appearance) into the
 *      PDF via pdf-lib + @signpdf, compute the /ByteRange, hand the to-be-signed
 *      bytes to the helper (which triggers the token's own PIN dialog and returns
 *      a detached PKCS#7/CMS, optionally RFC3161-timestamped), then splice the
 *      signature into /Contents.
 *
 * Signing is a TERMINAL step: the result is saved to a NEW file. Re-editing and
 * re-saving through pdf-lib would rewrite the whole file and invalidate the
 * signature — same as every PDF tool. The renderer warns about this.
 *
 * IMPORTANT (perf): step 2 — pdf-lib load/save, @signpdf's whole-file hashing,
 * and the temp-file I/O — is synchronous CPU + fs work. Running it on the main
 * process froze the entire window ("Not Responding") for the whole sign+save,
 * scaling with file size. It now runs in a utilityProcess (signing-worker.js),
 * so the main process and the window stay responsive; the token PIN dialog is a
 * native Windows dialog and shows regardless of which process spawned the helper.
 * This module (main process) only enumerates certs (fast) and relays IPC.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, ipcMain, utilityProcess } = require("electron");

// --- helper process ----------------------------------------------------------

function helperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "signing-helper", "nabu-sign.exe");
  }
  return path.join(__dirname, "..", "dist-helper", "nabu-sign.exe");
}

// Spawn the helper, collect stdout/stderr, resolve { code, stdout, stderr }.
// Only used here for the (fast) cert enumeration; the sign path runs in the worker.
function runHelper(args) {
  return new Promise((resolve, reject) => {
    const exe = helperPath();
    if (!fs.existsSync(exe)) {
      reject(
        new Error(
          "Chưa có bộ ký số (nabu-sign.exe). Máy build cần chạy: npm run build:helper"
        )
      );
      return;
    }
    const child = spawn(exe, args, { windowsHide: true });
    let out = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out.toString("utf8"), stderr: err.trim() }));
  });
}

// Map a helper exit code to a stable reason the renderer can localise.
function reasonForCode(code) {
  if (code === 2) return "cancelled"; // PIN cancelled / key access denied
  if (code === 3) return "no_cert";
  if (code === 4) return "tsa";
  return "other";
}

// --- certificate list --------------------------------------------------------

async function listCerts() {
  const { code, stdout, stderr } = await runHelper(["list-certs"]);
  if (code !== 0) {
    return { ok: false, reason: reasonForCode(code), error: stderr || `exit ${code}` };
  }
  let certs;
  try {
    certs = JSON.parse(stdout || "[]");
  } catch (e) {
    return { ok: false, reason: "other", error: "Không đọc được danh sách chứng thư." };
  }
  return { ok: true, certs: Array.isArray(certs) ? certs : [] };
}

// --- signing (offloaded to a utilityProcess) ---------------------------------

// Fork signing-worker.js, hand it the payload + the resolved helper path (the
// worker has no `app`/resourcesPath), and resolve with the worker's result —
// the same shape applySignature always returned: { ok:true, bytes } |
// { ok:false, reason, error }. The heavy work never touches the main thread.
function signInWorker(payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = utilityProcess.fork(path.join(__dirname, "signing-worker.js"));
    } catch (e) {
      resolve({ ok: false, reason: "other", error: "Không khởi động được tiến trình ký: " + ((e && e.message) || e) });
      return;
    }
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve(res);
    };
    child.on("message", (res) => finish(res));
    child.on("exit", (code) => finish({
      ok: false,
      reason: "other",
      error: "Tiến trình ký kết thúc bất thường (mã " + code + ").",
    }));
    // Post once the child is up, so its message listener is registered.
    child.once("spawn", () => {
      try {
        child.postMessage({ payload, helperExe: helperPath() });
      } catch (e) {
        finish({ ok: false, reason: "other", error: "Không gửi được dữ liệu ký: " + ((e && e.message) || e) });
      }
    });
  });
}

// --- IPC ---------------------------------------------------------------------

function initSigning() {
  ipcMain.handle("sign:list-certs", async () => {
    try {
      return await listCerts();
    } catch (e) {
      return { ok: false, reason: "other", error: e.message || String(e) };
    }
  });
  ipcMain.handle("sign:apply", async (_e, payload) => {
    try {
      return await signInWorker(payload || {});
    } catch (e) {
      return { ok: false, reason: "other", error: e.message || String(e) };
    }
  });
}

module.exports = { initSigning };
