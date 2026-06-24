"use strict";

/**
 * Generate THIRD-PARTY-LICENSES.txt — the notices that AGPL/Apache/MIT/BSD all
 * require to travel with a redistributed binary.
 *
 * Sources:
 *   - Python deps bundled into sidecar.exe (PyInstaller): read each package's
 *     *.dist-info from the project venv (METADATA license + LICENSE/COPYING text).
 *   - Vendored JS + Electron runtime: a small curated table (texts pulled from
 *     node_modules when present, else a short attribution line).
 *
 * Output: <repo-root>/THIRD-PARTY-LICENSES.txt. Bundled into the app via
 * electron-builder extraResources; surfaced from Settings → Giới thiệu.
 */

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const SITE = path.join(REPO, ".venv", "Lib", "site-packages");
const NODE = path.join(__dirname, "..", "node_modules");
const OUT = path.join(REPO, "THIRD-PARTY-LICENSES.txt");

// Python packages actually shipped inside sidecar.exe (the significant ones).
const PY_PACKAGES = [
  "pymupdf", "PyMuPDF", "paddleocr", "paddlepaddle", "vietocr",
  "torch", "torchvision", "numpy", "pillow", "Pillow", "matplotlib",
  "fastapi", "uvicorn", "starlette", "pydantic", "opencv-python",
  "opencv-contrib-python", "shapely", "scikit-image", "openpyxl",
  "google-genai", "google_genai", "requests", "python-bidi",
];

// Vendored JS / Electron runtime → license + where to find full text.
const JS_COMPONENTS = [
  ["Electron", "MIT", "node_modules/electron/LICENSE"],
  ["electron-updater", "MIT", "node_modules/electron-updater/LICENSE"],
  ["pdf-lib", "MIT", "node_modules/pdf-lib/LICENSE.md"],
  ["pdfjs-dist (pdf.js)", "Apache-2.0", "node_modules/pdfjs-dist/LICENSE"],
];

const LICENSE_FILE_NAMES = [
  "LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE.rst",
  "COPYING", "COPYING.txt", "LICENCE", "license", "license.txt",
];

function readFirst(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, "utf8");
  }
  return null;
}

function distInfoFor(pkg) {
  if (!fs.existsSync(SITE)) return null;
  const want = pkg.toLowerCase().replace(/-/g, "_");
  const hit = fs.readdirSync(SITE).find((d) => {
    if (!d.toLowerCase().endsWith(".dist-info")) return false;
    const base = d.slice(0, -".dist-info".length); // "name-version"
    const name = base.replace(/-\d.*$/, ""); // strip "-<version>"
    return name.toLowerCase().replace(/-/g, "_") === want;
  });
  return hit ? path.join(SITE, hit) : null;
}

function metaField(metaText, field) {
  const m = metaText.match(new RegExp("^" + field + ":\\s*(.+)$", "im"));
  return m ? m[1].trim() : null;
}

const seen = new Set();
const blocks = [];

for (const pkg of PY_PACKAGES) {
  const di = distInfoFor(pkg);
  if (!di) continue;
  const name = path.basename(di).replace(/\.dist-info$/i, "");
  if (seen.has(name.toLowerCase())) continue;
  seen.add(name.toLowerCase());

  let license = "(see text)";
  const metaPath = path.join(di, "METADATA");
  if (fs.existsSync(metaPath)) {
    const meta = fs.readFileSync(metaPath, "utf8");
    license = metaField(meta, "License") ||
      (metaField(meta, "Classifier") || "").replace(/^.*License :: (OSI Approved :: )?/, "") ||
      license;
  }
  // License text: dist-info root, then its licenses/ subdir.
  let text = readFirst(di, LICENSE_FILE_NAMES);
  if (!text && fs.existsSync(path.join(di, "licenses")))
    text = readFirst(path.join(di, "licenses"), LICENSE_FILE_NAMES);

  blocks.push(
    `\n${"=".repeat(78)}\n${name}  —  ${license}\n${"=".repeat(78)}\n` +
      (text ? text.trim() : "(License text not bundled in package metadata; see the project homepage.)") +
      "\n"
  );
}

for (const [name, license, rel] of JS_COMPONENTS) {
  const p = path.join(__dirname, "..", rel);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  blocks.push(
    `\n${"=".repeat(78)}\n${name}  —  ${license}\n${"=".repeat(78)}\n` +
      (text ? text.trim() : `(See ${rel} or the project homepage for the full ${license} text.)`) +
      "\n"
  );
}

const header =
  "NABU PDF — THIRD-PARTY LICENSES\n" +
  "===============================\n\n" +
  "Nabu PDF (GNU AGPL-3.0) bundles the third-party components listed below.\n" +
  "Their licenses require that these notices accompany the distributed binary.\n" +
  "The application itself, including the PyMuPDF dependency, is licensed under\n" +
  "the GNU Affero General Public License v3.0 — see the LICENSE file.\n\n" +
  `Generated: ${new Date().toISOString().slice(0, 10)}\n`;

fs.writeFileSync(OUT, header + blocks.join("\n"), "utf8");
console.log(`[third-party] wrote ${OUT} (${blocks.length} components)`);
