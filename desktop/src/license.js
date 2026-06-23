"use strict";

/**
 * Offline license verification (Ed25519).
 *
 * A license key is `NABU1.<payload_b64url>.<signature_b64url>`, signed by the
 * private key the vendor keeps (scripts/license-sign.js). The app ships only the
 * matching PUBLIC key and verifies fully offline — no server, no MAC/IP binding.
 * Keys are portable by design; stopping key-sharing would need online activation,
 * which we deliberately don't do here (local-first product).
 *
 * The activated key lives at <userData>/license.json. The app stays fully usable
 * without a license: ENFORCE is off by default so current behaviour is unchanged.
 * Flip ENFORCE (and gate pro features in the renderer via license.get().enforce)
 * when you actually want to lock features behind a key.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { app, ipcMain } = require("electron");
const { createHash, createPublicKey, verify } = require("crypto");

// Policy switch. Mechanism is always live; this only changes whether the
// renderer should gate features. On = pro features locked behind a valid key.
const ENFORCE = true;

let publicKey = null;
function getPublicKey() {
  if (publicKey) return publicKey;
  const pem = fs.readFileSync(path.join(__dirname, "license-public-key.pem"), "utf8");
  publicKey = createPublicKey(pem);
  return publicKey;
}

function storePath() {
  return path.join(app.getPath("userData"), "license.json");
}

// Stable per-machine id used for HWID-bound keys. Windows: MachineGuid (survives
// reboots; changes only on OS reinstall). Other OS / lookup failure: hash of
// hostname+platform+arch. Always hashed + truncated so the raw GUID is never
// exposed. A key whose payload carries a matching `hwid` runs only on this
// machine; an empty/absent `hwid` claim is a floating key (any machine).
let cachedHwid = null;
function machineHwid() {
  if (cachedHwid) return cachedHwid;
  let raw = "";
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) raw = m[1].trim();
    }
  } catch {
    raw = "";
  }
  if (!raw) raw = `${os.hostname()}|${process.platform}|${process.arch}`;
  cachedHwid = createHash("sha256").update("nabu-hwid:" + raw).digest("hex").slice(0, 16);
  return cachedHwid;
}

// Parse + cryptographically verify a key string. Pure (no disk I/O).
function verifyKey(key) {
  if (typeof key !== "string") return { valid: false, reason: "format" };
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "NABU1") return { valid: false, reason: "format" };
  const [, body, sig] = parts;

  let ok = false;
  try {
    ok = verify(null, Buffer.from(body), getPublicKey(), Buffer.from(sig, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: "signature" };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp > 0 && now > payload.exp) {
    return { valid: false, reason: "expired", payload };
  }
  // HWID binding: if the key is bound to a machine, it only validates there.
  // Empty/absent `hwid` = floating key, valid on any machine.
  if (payload.hwid && payload.hwid !== machineHwid()) {
    return { valid: false, reason: "hwid", payload };
  }
  return { valid: true, payload };
}

function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return typeof raw.key === "string" ? raw.key : null;
  } catch {
    return null;
  }
}

// Renderer-facing status. Never returns the raw key.
function publicStatus() {
  const key = readStored();
  if (!key) return { state: "unlicensed", enforce: ENFORCE };
  const res = verifyKey(key);
  if (!res.valid) {
    return {
      state: res.reason === "expired" ? "expired" : res.reason === "hwid" ? "machine" : "invalid",
      reason: res.reason,
      enforce: ENFORCE,
      payload: res.payload || null,
    };
  }
  const p = res.payload;
  return {
    state: "licensed",
    enforce: ENFORCE,
    name: p.name || "",
    email: p.email || "",
    plan: p.plan || "",
    exp: p.exp || 0,
  };
}

function activate(key) {
  const res = verifyKey(key);
  if (!res.valid) return { ok: false, reason: res.reason, ...publicStatus() };
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify({ key: key.trim() }, null, 2));
  } catch (e) {
    return { ok: false, reason: "store", error: e.message };
  }
  return { ok: true, ...publicStatus() };
}

function deactivate() {
  try {
    fs.unlinkSync(storePath());
  } catch {
    /* already gone */
  }
  return publicStatus();
}

function initLicense() {
  ipcMain.handle("license:get", () => publicStatus());
  ipcMain.handle("license:activate", (_e, key) => activate(key));
  ipcMain.handle("license:deactivate", () => deactivate());
  ipcMain.handle("license:hwid", () => machineHwid());
}

module.exports = { initLicense, verifyKey, publicStatus, machineHwid };
