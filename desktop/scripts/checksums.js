"use strict";

/**
 * Write SHA-256 checksums for the built installers into dist-app/SHA256SUMS.txt.
 * Until the app is code-signed, publishing these lets users verify the .exe they
 * downloaded matches what we built. Run after `pnpm run build`:
 *
 *   node scripts/checksums.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const distDir = path.join(__dirname, "..", "dist-app");

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

if (!fs.existsSync(distDir)) {
  console.error("[checksums] dist-app not found — run `pnpm run build` first.");
  process.exit(1);
}

const targets = fs
  .readdirSync(distDir)
  .filter((f) => f.toLowerCase().endsWith(".exe"))
  .sort();

if (targets.length === 0) {
  console.error("[checksums] no .exe artifacts in dist-app.");
  process.exit(1);
}

const lines = targets.map((f) => `${sha256(path.join(distDir, f))}  ${f}`);
const out = path.join(distDir, "SHA256SUMS.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");

console.log(lines.join("\n"));
console.log(`\n[checksums] wrote ${path.relative(process.cwd(), out)}`);
