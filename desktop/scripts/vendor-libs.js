"use strict";

/**
 * Copy the browser builds of pdf-lib and pdfjs-dist from node_modules into
 * renderer/vendor/ so the renderer can load them as local files — no CDN, no
 * bundler step. Runs on `postinstall` and via `pnpm run vendor`.
 *
 * Local-first (DESIGN D2): everything the renderer needs ships inside the app.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const nm = path.join(root, "node_modules");
const outDir = path.join(root, "renderer", "vendor");

function firstExisting(candidates) {
  for (const rel of candidates) {
    const p = path.join(nm, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function copy(src, destName) {
  if (!src) return false;
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(src, path.join(outDir, destName));
  console.log(`[vendor] ${path.relative(nm, src)} -> renderer/vendor/${destName}`);
  return true;
}

// pdf-lib: single-file UMD bundle, exposes global `PDFLib`.
const pdfLib = firstExisting([
  "pdf-lib/dist/pdf-lib.min.js",
  "pdf-lib/dist/pdf-lib.js",
]);

// pdf.js v4 ships ESM (.mjs); v3 shipped UMD (.js). Prefer the modern .mjs.
const pdfjsMain = firstExisting([
  "pdfjs-dist/build/pdf.min.mjs",
  "pdfjs-dist/build/pdf.mjs",
  "pdfjs-dist/legacy/build/pdf.min.mjs",
  "pdfjs-dist/build/pdf.min.js",
]);
const pdfjsWorker = firstExisting([
  "pdfjs-dist/build/pdf.worker.min.mjs",
  "pdfjs-dist/build/pdf.worker.mjs",
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  "pdfjs-dist/build/pdf.worker.min.js",
]);

const isMjs = pdfjsMain && pdfjsMain.endsWith(".mjs");
const ok =
  copy(pdfLib, "pdf-lib.min.js") &&
  copy(pdfjsMain, isMjs ? "pdf.min.mjs" : "pdf.min.js") &&
  copy(pdfjsWorker, isMjs ? "pdf.worker.min.mjs" : "pdf.worker.min.js");

if (!ok) {
  console.warn(
    "[vendor] Some libs were not found in node_modules. Run `pnpm install` first."
  );
  // Don't fail install if deps aren't there yet (e.g. first lifecycle ordering).
  process.exit(0);
}
