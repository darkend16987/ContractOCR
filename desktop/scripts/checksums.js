"use strict";

/**
 * Write SHA-256 checksums for THIS release's installers into dist-app/SHA256SUMS.txt.
 * Until the app is code-signed, publishing these lets users verify the .exe they
 * downloaded matches what we built. Run after `npm run build`:
 *
 *   node scripts/checksums.js
 *
 * Scoped to the version in package.json ON PURPOSE. `dist-app/` is not cleaned
 * between builds, so it accumulates every .exe ever produced on this machine —
 * hashing all of them shipped a 55-line SHA256SUMS.txt covering builds that were
 * never published (and, worse, versions that were later deleted from Releases).
 * A checksums file must describe exactly the assets attached next to it.
 *
 * Hashing streams rather than readFileSync: the installer is ~455 MB and the old
 * whole-file read pulled every historical build through memory (~10 GB per run,
 * minutes of wall clock).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const distDir = path.join(__dirname, "..", "dist-app");
const { version } = require("../package.json");

function sha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", rej)
      .on("end", () => res(h.digest("hex")));
  });
}

if (!fs.existsSync(distDir)) {
  console.error("[checksums] dist-app not found — run `npm run build` first.");
  process.exit(1);
}

const targets = fs
  .readdirSync(distDir)
  .filter((f) => f.toLowerCase().endsWith(".exe") && f.includes(`-${version}-`))
  .sort();

if (targets.length === 0) {
  console.error(`[checksums] no .exe for v${version} in dist-app — did the build run?`);
  console.error("[checksums] present: " + fs.readdirSync(distDir).filter((f) => f.endsWith(".exe")).join(", "));
  process.exit(1);
}

(async () => {
  const lines = [];
  for (const f of targets) lines.push(`${await sha256(path.join(distDir, f))}  ${f}`);
  const out = path.join(distDir, "SHA256SUMS.txt");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\n[checksums] wrote ${path.relative(process.cwd(), out)} — v${version}, ${lines.length} file(s)`);
})();
