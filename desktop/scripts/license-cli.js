"use strict";

/**
 * Nabu PDF license admin — generate keys, issue licenses, and keep a ledger so
 * you never copy/paste keys into a doc by hand.
 *
 *   node scripts/license-cli.js keygen [--force]
 *   node scripts/license-cli.js issue --name "Nguyen Van A" --email a@x.com --plan pro --days 365 [--note "..."]
 *   node scripts/license-cli.js list [--all]            # active only by default
 *   node scripts/license-cli.js show <email-or-name>    # substring match
 *   node scripts/license-cli.js revoke <id>             # ledger flag only (see note)
 *   node scripts/license-cli.js reissue <id>            # re-print an existing key
 *   node scripts/license-cli.js export <file.csv>
 *
 * The private key AND the ledger live in scripts/.keys/ (git-ignored). The ledger
 * (licenses.json) records who got which key, when, and the expiry. Keys are
 * offline Ed25519 — `revoke` only marks the ledger; it cannot kill an already
 * issued key on a customer's machine without online activation (intentionally
 * out of scope for the local-first model).
 */

const { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } = require("crypto");
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "src", "license-public-key.pem");
const KEYDIR = path.join(__dirname, ".keys");
const PRIV = path.join(KEYDIR, "license-private-key.pem");
const LEDGER = path.join(KEYDIR, "licenses.json");

// --- tiny arg parser -------------------------------------------------------
function flag(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return { issued: [] };
  }
}
function saveLedger(db) {
  fs.mkdirSync(KEYDIR, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(db, null, 2));
}

function fmtDate(epoch) {
  return epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : "perpetual";
}

// --- commands --------------------------------------------------------------

function keygen() {
  if (fs.existsSync(PRIV) && !process.argv.includes("--force")) {
    console.error("Private key already exists:", PRIV);
    console.error("Pass --force to ROTATE (invalidates every issued license).");
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.mkdirSync(KEYDIR, { recursive: true });
  fs.writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));
  console.log("Public key  ->", PUB, "(commit this)");
  console.log("Private key ->", PRIV, "(secret; never commit)");
}

function requirePriv() {
  if (!fs.existsSync(PRIV)) {
    console.error("No private key. Run: node scripts/license-cli.js keygen");
    process.exit(1);
  }
  return createPrivateKey(fs.readFileSync(PRIV));
}

function issue() {
  const privateKey = requirePriv();
  const db = loadLedger();
  const seq = db.issued.length + 1;
  const id = "NB-" + String(seq).padStart(4, "0");

  const days = parseInt(flag("days", "0"), 10) || 0;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    id,
    name: flag("name", "Unnamed"),
    email: flag("email", ""),
    plan: flag("plan", "pro"),
    iat: now,
    exp: days > 0 ? now + days * 86400 : 0,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(body), privateKey).toString("base64url");
  const key = `NABU1.${body}.${signature}`;

  // Self-check the freshly minted key against the public key before recording.
  const pub = createPublicKey(fs.readFileSync(PUB, "utf8"));
  if (!verify(null, Buffer.from(body), pub, Buffer.from(signature, "base64url"))) {
    console.error("Sanity check failed — key did not verify. Aborting.");
    process.exit(1);
  }

  db.issued.push({
    ...payload,
    days,
    note: flag("note", ""),
    key,
    issuedAt: new Date(now * 1000).toISOString(),
    revoked: false,
    revokedAt: null,
  });
  saveLedger(db);

  console.log(`Issued ${id} -> ${payload.name} <${payload.email}> · ${payload.plan} · ${fmtDate(payload.exp)}`);
  console.log("Recorded in", LEDGER);
  console.log("\n" + key + "\n");
}

function rows(all) {
  const db = loadLedger();
  return db.issued.filter((r) => all || !r.revoked);
}

function list() {
  const all = process.argv.includes("--all");
  const rs = rows(all);
  if (!rs.length) {
    console.log("No licenses issued yet.");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  console.log(["ID", "NAME", "EMAIL", "PLAN", "EXPIRY", "STATUS"].join("\t"));
  for (const r of rs) {
    const status = r.revoked ? "revoked" : r.exp && r.exp < now ? "expired" : "active";
    console.log([r.id, r.name, r.email, r.plan, fmtDate(r.exp), status].join("\t"));
  }
  console.log(`\n${rs.length} license(s)${all ? "" : " (active; use --all to include revoked)"}.`);
}

function show() {
  const q = (process.argv[3] || "").toLowerCase();
  if (!q) {
    console.error("Usage: license-cli.js show <email-or-name>");
    process.exit(1);
  }
  const hits = loadLedger().issued.filter(
    (r) => (r.email || "").toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q)
  );
  if (!hits.length) {
    console.log("No match for:", q);
    return;
  }
  for (const r of hits) {
    console.log(`\n${r.id} · ${r.name} <${r.email}> · ${r.plan} · ${fmtDate(r.exp)}${r.revoked ? " · REVOKED" : ""}`);
    if (r.note) console.log("  note:", r.note);
    console.log("  " + r.key);
  }
}

function reissue() {
  const id = process.argv[3];
  const r = loadLedger().issued.find((x) => x.id === id);
  if (!r) {
    console.error("No license with id:", id);
    process.exit(1);
  }
  console.log(r.key);
}

function revoke() {
  const id = process.argv[3];
  const db = loadLedger();
  const r = db.issued.find((x) => x.id === id);
  if (!r) {
    console.error("No license with id:", id);
    process.exit(1);
  }
  r.revoked = true;
  r.revokedAt = new Date().toISOString();
  saveLedger(db);
  console.log(`Marked ${id} revoked in the ledger.`);
  console.log("NOTE: offline keys can't be killed on a customer's machine — this");
  console.log("is bookkeeping only. Granular revocation needs online activation.");
}

function exportCsv() {
  const out = process.argv[3];
  if (!out) {
    console.error("Usage: license-cli.js export <file.csv>");
    process.exit(1);
  }
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["id", "name", "email", "plan", "issuedAt", "expiry", "revoked", "note", "key"];
  const lines = [head.join(",")];
  for (const r of loadLedger().issued) {
    lines.push(
      [r.id, r.name, r.email, r.plan, r.issuedAt, fmtDate(r.exp), r.revoked, r.note, r.key].map(esc).join(",")
    );
  }
  fs.writeFileSync(out, lines.join("\n"));
  console.log("Wrote", out);
}

// --- dispatch --------------------------------------------------------------
const cmd = process.argv[2];
const table = { keygen, issue, list, show, reissue, revoke, export: exportCsv };
if (table[cmd]) {
  table[cmd]();
} else {
  console.log("Commands: keygen | issue | list | show | reissue | revoke | export");
  console.log("Run a command with no args to see its usage, or read scripts/license-cli.js.");
  if (cmd) process.exit(1);
}
