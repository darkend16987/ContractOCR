"use strict";

/**
 * One-time: generate the Ed25519 keypair that signs Nabu PDF licenses.
 *
 *   node scripts/license-keygen.js
 *
 * Writes:
 *   src/license-public-key.pem            → COMMIT this. Bundled in the app; used
 *                                            only to verify keys (safe to ship).
 *   scripts/.keys/license-private-key.pem → GITIGNORED. Keep secret & backed up.
 *                                            Anyone holding it can mint licenses.
 *
 * Re-running refuses to clobber an existing private key. Pass --force to ROTATE,
 * which invalidates every license issued with the old key.
 */

const { generateKeyPairSync } = require("crypto");
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "src", "license-public-key.pem");
const KEYDIR = path.join(__dirname, ".keys");
const PRIV = path.join(KEYDIR, "license-private-key.pem");

if (fs.existsSync(PRIV) && !process.argv.includes("--force")) {
  console.error("Private key already exists:", PRIV);
  console.error("Re-run with --force to ROTATE (invalidates all existing licenses).");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
fs.mkdirSync(KEYDIR, { recursive: true });
fs.writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }));
fs.writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));

console.log("Public key  ->", PUB, "(commit this)");
console.log("Private key ->", PRIV, "(keep secret; never commit)");
