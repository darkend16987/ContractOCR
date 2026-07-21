#!/usr/bin/env node
// Build the Windows signing helper (desktop/signing-helper → desktop/dist-helper).
//
// Publishes a self-contained, single-file win-x64 exe so the END USER needs no
// .NET runtime. Only THIS (build) machine needs the .NET 8 SDK:
//     https://dotnet.microsoft.com/download/dotnet/8.0
//
// dist-helper/ is bundled into the app by electron-builder (see electron-builder.yml
// extraResources) and spawned at runtime by src/signing.js.

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");           // desktop/
const repoRoot = path.resolve(root, "..");            // repo root (for git commit)
const proj = path.join(root, "signing-helper", "NabuSign.csproj");
const outDir = path.join(root, "dist-helper");
const exePath = path.join(outDir, "nabu-sign.exe");

// Fail early with a clear message if the SDK is missing.
try {
  execFileSync("dotnet", ["--version"], { stdio: "ignore" });
} catch {
  console.error("\n[build-helper] .NET SDK not found on PATH.");
  console.error("  Install the .NET 8 SDK, then re-run:  npm run build:helper");
  console.error("  https://dotnet.microsoft.com/download/dotnet/8.0\n");
  process.exit(1);
}

console.log("[build-helper] dotnet publish (self-contained, single-file, win-x64)…");
execFileSync(
  "dotnet",
  [
    "publish", proj,
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:EnableCompressionInSingleFile=true",
    "-o", outDir,
  ],
  { stdio: "inherit" }
);

if (!fs.existsSync(exePath)) {
  console.error("[build-helper] FAILED — nabu-sign.exe was not produced in " + outDir);
  process.exit(1);
}

// Commit marker (mirrors write-sidecar-marker.js) so check-sidecar-fresh.js can
// refuse to package a helper that predates its C# source.
let commit = "unknown";
try { commit = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(); } catch {}
fs.writeFileSync(
  path.join(outDir, "HELPER_BUILD.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)
);

const kb = Math.round(fs.statSync(exePath).size / 1024);
console.log(`[build-helper] OK — ${exePath} (${kb} KB), commit ${commit.slice(0, 8)}`);
