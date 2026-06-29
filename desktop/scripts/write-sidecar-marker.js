#!/usr/bin/env node
// Stamp the freshly-built sidecar with the git commit it was built from.
//
// The PyInstaller output (../dist/sidecar) is NOT in git — every dev machine has
// its own copy. Releases used to silently reuse a stale binary built before later
// api.py fixes (the text-edit font fix shipped broken for several versions because
// of exactly this). The marker lets check-sidecar-fresh.js refuse to package a
// sidecar that predates the current Python source. Run automatically by the
// `build:sidecar` npm script after PyInstaller succeeds.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const outDir = path.join(root, "dist", "sidecar");

if (!fs.existsSync(outDir)) {
  console.error(`[sidecar-marker] ${outDir} missing — did PyInstaller run?`);
  process.exit(1);
}

let commit = "unknown";
let dirty = false;
try {
  commit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  // Uncommitted Python/spec changes mean the binary reflects work not yet pushed;
  // record that so the freshness check can still flag a later mismatch.
  const status = execSync('git status --porcelain -- "*.py" sidecar.spec', { cwd: root })
    .toString()
    .trim();
  dirty = status.length > 0;
} catch (e) {
  console.warn("[sidecar-marker] git unavailable:", e.message);
}

const marker = { commit, dirty, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, "SIDECAR_BUILD.json"), JSON.stringify(marker, null, 2));
console.log(`[sidecar-marker] stamped ${commit.slice(0, 8)}${dirty ? " (dirty)" : ""}`);
