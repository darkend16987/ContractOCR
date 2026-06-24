"use strict";

/**
 * License verification — offline-first with optional online activation (hybrid).
 *
 * Two credential shapes live in <userData>/license.json:
 *   { key }          — legacy/offline: a portable NABU1 key verified locally.
 *   { key, token }   — hybrid: an Ed25519 activation token (NABT1) minted by the
 *                      license server, bound to this machine (hwid) with a short
 *                      expiry. Verified fully OFFLINE with the bundled public key;
 *                      silently refreshed online before it lapses.
 *
 * The server (Supabase Edge Functions, see /supabase) enforces what local crypto
 * cannot: per-key seat caps, remote revoke/deactivate, and central expiry. Those
 * take effect at the next refresh, so the lag is at most the token TTL (7 days).
 *
 * If no server is configured (SERVER.anon empty) the app runs in pure-offline
 * mode: activation just verifies + stores the NABU1 key. ENFORCE gates whether
 * the renderer locks pro features.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { app, ipcMain } = require("electron");
const { createHash, createPublicKey, verify } = require("crypto");

// On = renderer locks pro features behind a valid license.
const ENFORCE = true;

// License server (Supabase). The anon key is public by design (safe to ship). An
// empty anon key disables all server calls → pure-offline mode. Override via env
// for testing. Fill SUPABASE_ANON_KEY once the project keys are known.
const SERVER = {
  url: process.env.NABU_LICENSE_URL || "https://gaqwijsudxpfydruozmd.supabase.co",
  anon:
    process.env.NABU_LICENSE_ANON ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcXdpanN1ZHhwZnlkcnVvem1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNTgzOTUsImV4cCI6MjA5NzgzNDM5NX0.l7nna-AwNWq23Ak1VqqwbaBDI08msaFsePsyeacU6C0",
};

const TTL_REFRESH_WINDOW = 2 * 86400; // refresh when < 2 days of token life left
const OFFLINE_GRACE = 14 * 86400; // allow this long past token exp while offline

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

// Stable per-machine id. Windows: MachineGuid (survives reboots; changes on OS
// reinstall). Else: hash of hostname+platform+arch. Hashed + truncated so the
// raw GUID never leaves the device. Binds activation tokens to one machine.
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

// --- crypto: NABU1 license keys + NABT1 activation tokens (same Ed25519 key) --

function verifyDotted(prefix, str) {
  if (typeof str !== "string") return null;
  const parts = str.trim().split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, body, sig] = parts;
  try {
    if (!verify(null, Buffer.from(body), getPublicKey(), Buffer.from(sig, "base64url"))) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Verify a portable license key (offline path). Pure.
function verifyKey(key) {
  if (typeof key !== "string") return { valid: false, reason: "format" };
  if (key.trim().split(".")[0] !== "NABU1") return { valid: false, reason: "format" };
  const payload = verifyDotted("NABU1", key);
  if (!payload) return { valid: false, reason: "signature" };
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp > 0 && now > payload.exp) {
    return { valid: false, reason: "expired", payload };
  }
  if (payload.hwid && payload.hwid !== machineHwid()) {
    return { valid: false, reason: "hwid", payload };
  }
  return { valid: true, payload };
}

// Verify an activation token's signature; returns payload (caller checks exp/hwid).
const parseToken = (token) => verifyDotted("NABT1", token);

// --- store --------------------------------------------------------------------

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    if (raw && typeof raw.key === "string") return raw;
    return null;
  } catch {
    return null;
  }
}

function writeStore(obj) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(obj, null, 2));
}

// --- server -------------------------------------------------------------------

async function serverCall(fnName, body) {
  if (!SERVER.anon) return { ok: false, reason: "not_configured", offline: true };
  try {
    const r = await fetch(`${SERVER.url}/functions/v1/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVER.anon,
        Authorization: `Bearer ${SERVER.anon}`,
      },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: "network", offline: true, error: String((e && e.message) || e) };
  }
}

let refreshing = false;
async function backgroundRefresh(store) {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await serverCall("refresh", { token: store.token });
    if (r.ok && r.token) writeStore({ key: store.key, token: r.token });
  } finally {
    refreshing = false;
  }
}

// --- status -------------------------------------------------------------------

function base(state, reason, extra) {
  return { state, enforce: ENFORCE, ...(reason ? { reason } : {}), ...(extra || {}) };
}
function licensed(p, grace) {
  return {
    state: "licensed",
    enforce: ENFORCE,
    name: p.name || "",
    email: p.email || "",
    plan: p.plan || "",
    exp: p.lic_exp || p.exp || 0,
    ...(grace ? { grace: true } : {}),
  };
}

// Map a server rejection reason to a renderer state.
function stateForReason(reason) {
  if (reason === "expired") return "expired";
  if (reason === "deactivated" || reason === "no_activation") return "deactivated";
  if (reason === "revoked") return "revoked";
  if (reason === "suspended") return "suspended";
  if (reason === "seat_limit") return "seat";
  return "invalid";
}

// Renderer-facing status. Async: may refresh the token online. Never returns the raw key.
async function getStatus() {
  const store = readStore();
  if (!store) return base("unlicensed");

  // Hybrid path: activation token present.
  if (store.token) {
    const p = parseToken(store.token);
    if (!p) return base("invalid", "signature");
    if (p.hwid && p.hwid !== machineHwid()) return base("machine", "hwid");

    const now = Math.floor(Date.now() / 1000);
    if (p.lic_exp && p.lic_exp > 0 && now > p.lic_exp) return base("expired", "expired");

    const tokenExpired = p.exp && now > p.exp;
    if (!tokenExpired) {
      if (p.exp - now < TTL_REFRESH_WINDOW) backgroundRefresh(store); // fire-and-forget
      return licensed(p);
    }

    // Token lapsed → re-validate with the server (this is where revoke bites).
    const r = await serverCall("refresh", { token: store.token });
    if (r.ok && r.token) {
      writeStore({ key: store.key, token: r.token });
      return licensed(parseToken(r.token));
    }
    if (r.offline) {
      // Can't reach the server: keep working through the offline grace window.
      if (now < (p.exp || 0) + OFFLINE_GRACE) return licensed(p, true);
      return base("expired", "grace_over");
    }
    return base(stateForReason(r.reason), r.reason); // server said no
  }

  // Legacy/offline path: portable key, verified locally.
  const res = verifyKey(store.key);
  if (!res.valid) {
    const state = res.reason === "expired" ? "expired" : res.reason === "hwid" ? "machine" : "invalid";
    return base(state, res.reason, { payload: res.payload || null });
  }
  return licensed(res.payload);
}

// --- actions ------------------------------------------------------------------

async function activate(key) {
  key = (key || "").trim();

  // Pure-offline mode (no server configured): verify + store the NABU1 key.
  if (!SERVER.anon) {
    const v = verifyKey(key);
    if (!v.valid) return { ok: false, reason: v.reason, ...(await getStatus()) };
    writeStore({ key });
    return { ok: true, ...(await getStatus()) };
  }

  // Hybrid: first activation MUST go through the server so the seat cap is real.
  const res = await serverCall("activate", {
    key,
    hwid: machineHwid(),
    machine_name: os.hostname(),
    app_version: app.getVersion(),
  });
  if (res.ok && res.token) {
    writeStore({ key, token: res.token });
    return { ok: true, ...(await getStatus()) };
  }
  if (res.offline) {
    // Need internet for the first activation; don't silently fall back (would
    // bypass the seat cap). Tell the user to retry online.
    return { ok: false, reason: "network", ...(await getStatus()) };
  }
  return { ok: false, reason: res.reason, max_seats: res.max_seats, ...(await getStatus()) };
}

function deactivate() {
  // Local removal. NOTE: the server seat stays counted until an admin deactivates
  // that machine (re-activating on the SAME machine reuses its slot, so this only
  // matters when moving to a new machine while at the cap).
  try {
    fs.unlinkSync(storePath());
  } catch {
    /* already gone */
  }
  return getStatus();
}

function initLicense() {
  ipcMain.handle("license:get", () => getStatus());
  ipcMain.handle("license:activate", (_e, key) => activate(key));
  ipcMain.handle("license:deactivate", () => deactivate());
  ipcMain.handle("license:hwid", () => machineHwid());
}

module.exports = { initLicense, verifyKey, getStatus, machineHwid };
