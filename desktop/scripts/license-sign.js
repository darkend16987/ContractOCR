"use strict";

/**
 * Mint a signed license key.
 *
 *   node scripts/license-sign.js --name "Nguyen Van A" --email a@x.com --plan pro --days 365
 *
 * --days 0 (or omitted) → perpetual (no expiry). Prints the key to stdout:
 *   NABU1.<payload_b64url>.<signature_b64url>
 */

const { createPrivateKey, sign } = require("crypto");
const fs = require("fs");
const path = require("path");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PRIV = path.join(__dirname, ".keys", "license-private-key.pem");
if (!fs.existsSync(PRIV)) {
  console.error("No private key. Run: node scripts/license-keygen.js");
  process.exit(1);
}
const privateKey = createPrivateKey(fs.readFileSync(PRIV));

const days = parseInt(arg("days", "0"), 10) || 0;
const now = Math.floor(Date.now() / 1000);
const payload = {
  v: 1,
  name: arg("name", "Unnamed"),
  email: arg("email", ""),
  plan: arg("plan", "pro"),
  iat: now,
  exp: days > 0 ? now + days * 86400 : 0,
};

const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signature = sign(null, Buffer.from(body), privateKey).toString("base64url");
console.log(`NABU1.${body}.${signature}`);
