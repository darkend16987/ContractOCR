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
const path = require("path");
const { app, ipcMain } = require("electron");
const { createPublicKey, verify } = require("crypto");

// Policy switch. Mechanism is always live; this only changes whether the
// renderer should gate features. Left false so nothing breaks for free users.
const ENFORCE = false;

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
      state: res.reason === "expired" ? "expired" : "invalid",
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
}

module.exports = { initLicense, verifyKey, publicStatus };
