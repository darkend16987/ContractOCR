#!/usr/bin/env node
// Refuse to package an installer whose bundled sidecar predates the current
// Python source. Runs as the first step of `npm run build`.
//
// Cross-machine safety: the check is *commit-based*, not mtime-based. It compares
// the git commit recorded in dist/sidecar/SIDECAR_BUILD.json (written by
// write-sidecar-marker.js) against HEAD, and also flags uncommitted edits to any
// *.py / sidecar.spec. So pulling a teammate's api.py change and forgetting to
// rebuild the sidecar is caught here instead of silently shipping a stale binary.
//
// Override (e.g. an intentional renderer-only rebuild): SKIP_SIDECAR_CHECK=1.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.env.SKIP_SIDECAR_CHECK === "1") {
  console.log("[sidecar-check] skipped (SKIP_SIDECAR_CHECK=1)");
  process.exit(0);
}

const root = path.resolve(__dirname, "..", "..");
const markerPath = path.join(root, "dist", "sidecar", "SIDECAR_BUILD.json");

function fail(msg) {
  console.error("\n[sidecar-check] " + msg);
  console.error("  Fix: cd desktop && npm run build:sidecar   (rebuilds + re-stamps the marker)");
  console.error("  Or, if you are SURE the Python source is unchanged: SKIP_SIDECAR_CHECK=1 npm run build\n");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "dist", "sidecar", "sidecar.exe"))) {
  fail("No sidecar binary in dist/sidecar — build it before packaging.");
}
if (!fs.existsSync(markerPath)) {
  fail("dist/sidecar has no SIDECAR_BUILD.json marker — built by an old/unknown process. Rebuild to be safe.");
}

const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
const builtCommit = marker.commit;

let head, changed, dirty;
try {
  head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  changed = execSync(`git diff --name-only ${builtCommit} HEAD -- "*.py" sidecar.spec`, { cwd: root })
    .toString()
    .trim();
  dirty = execSync('git status --porcelain -- "*.py" sidecar.spec', { cwd: root }).toString().trim();
} catch (e) {
  fail("git check failed (" + e.message + "). Cannot verify sidecar freshness.");
}

if (changed) {
  fail(
    `Python source changed since the sidecar was built (${builtCommit.slice(0, 8)} → ${head.slice(0, 8)}):\n` +
      changed.split("\n").map((f) => "    " + f).join("\n")
  );
}
if (dirty) {
  fail("Uncommitted changes to *.py / sidecar.spec — the built sidecar does not include them:\n" + dirty);
}

console.log(`[sidecar-check] OK — sidecar built from ${builtCommit.slice(0, 8)} matches current source.`);
