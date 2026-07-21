"use strict";

/**
 * PDF digital signing (PKI) — like Foxit/Acrobat, for Vietnamese USB tokens.
 *
 * The private key never leaves the token. This module:
 *   1. Asks the bundled Windows helper (src → signing-helper, spawned like the
 *      sidecar) to enumerate signing certificates from the Windows Certificate
 *      Store — where VNPT-CA / Viettel-CA / FPT-CA / BKAV… tokens register.
 *   2. Inserts a signature placeholder (+ optional visible appearance) into the
 *      PDF via pdf-lib + @signpdf, computes the /ByteRange, hands the to-be-signed
 *      bytes to the helper (which triggers the token's own PIN dialog and returns
 *      a detached PKCS#7/CMS, optionally RFC3161-timestamped), then splices the
 *      signature into /Contents.
 *
 * Signing is a TERMINAL step: the result is saved to a NEW file. Re-editing and
 * re-saving through pdf-lib would rewrite the whole file and invalidate the
 * signature — same as every PDF tool. The renderer warns about this.
 *
 * All heavy lifting runs in the main process (fs / child_process / network for
 * the TSA). The renderer only drives the UI and ships the final bytes + options.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { app, ipcMain } = require("electron");

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } = require("pdf-lib");
const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
const signpdf = require("@signpdf/signpdf").default;
const { Signer, SUBFILTER_ADOBE_PKCS7_DETACHED } = require("@signpdf/utils");

// Reserve room for the CMS: leaf + full chain + an RFC3161 timestamp token fits
// comfortably in ~16 KB; 32 KB leaves generous headroom for long VN CA chains.
const SIGNATURE_LENGTH = 32000;

// --- helper process ----------------------------------------------------------

function helperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "signing-helper", "nabu-sign.exe");
  }
  return path.join(__dirname, "..", "dist-helper", "nabu-sign.exe");
}

// Spawn the helper, collect stdout/stderr, resolve { code, stdout, stderr }.
function runHelper(args) {
  return new Promise((resolve, reject) => {
    const exe = helperPath();
    if (!fs.existsSync(exe)) {
      reject(
        new Error(
          "Chưa có bộ ký số (nabu-sign.exe). Máy build cần chạy: npm run build:helper"
        )
      );
      return;
    }
    const child = spawn(exe, args, { windowsHide: true });
    let out = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out.toString("utf8"), stderr: err.trim() }));
  });
}

// Map a helper exit code to a stable reason the renderer can localise.
function reasonForCode(code) {
  if (code === 2) return "cancelled"; // PIN cancelled / key access denied
  if (code === 3) return "no_cert";
  if (code === 4) return "tsa";
  return "other";
}

// --- certificate list --------------------------------------------------------

async function listCerts() {
  const { code, stdout, stderr } = await runHelper(["list-certs"]);
  if (code !== 0) {
    return { ok: false, reason: reasonForCode(code), error: stderr || `exit ${code}` };
  }
  let certs;
  try {
    certs = JSON.parse(stdout || "[]");
  } catch (e) {
    return { ok: false, reason: "other", error: "Không đọc được danh sách chứng thư." };
  }
  return { ok: true, certs: Array.isArray(certs) ? certs : [] };
}

// --- signing -----------------------------------------------------------------

function strToBytes(s) {
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xff;
  return o;
}
const f = (n) => (+n).toFixed(2);

// Build a Form XObject that paints the appearance PNG into a w×h box (points),
// returning its registered reference. Mirrors editor.js addManagedAnnot.
function buildImageAP(pdfDoc, imgRef, w, h) {
  const ctx = pdfDoc.context;
  const apDict = ctx.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: [0, 0, w, h],
    Resources: { XObject: { NabuSig: imgRef } },
  });
  const apStream = PDFRawStream.of(apDict, strToBytes(`q ${f(w)} 0 0 ${f(h)} 0 0 cm /NabuSig Do Q`));
  return ctx.register(apStream);
}

// The widget @signpdf just created is the last field in the AcroForm.
function lastSigWidget(pdfDoc) {
  const acro = pdfDoc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!acro) return null;
  const fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields || fields.size() === 0) return null;
  const dict = pdfDoc.context.lookup(fields.get(fields.size() - 1));
  return dict instanceof PDFDict ? dict : null;
}

// The helper-backed Signer @signpdf calls with the to-be-signed bytes.
class HelperSigner extends Signer {
  constructor(thumbprint, tsaUrl) {
    super();
    this.thumbprint = thumbprint;
    this.tsaUrl = tsaUrl;
  }
  async sign(pdfBuffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-sign-"));
    const inPath = path.join(dir, "tbs.bin");
    const outPath = path.join(dir, "sig.der");
    try {
      fs.writeFileSync(inPath, pdfBuffer);
      const args = ["sign", "--in", inPath, "--out", outPath, "--thumbprint", this.thumbprint];
      if (this.tsaUrl) args.push("--tsa", this.tsaUrl);
      const { code, stderr } = await runHelper(args);
      if (code !== 0) {
        const e = new Error(stderr || `sign exit ${code}`);
        e.reason = reasonForCode(code);
        throw e;
      }
      return fs.readFileSync(outPath); // DER PKCS#7 (Buffer)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Sign `bytes` and return the signed PDF bytes.
 * payload = {
 *   bytes: Uint8Array,               // the final (already-baked) PDF
 *   thumbprint: string,              // chosen certificate
 *   tsaUrl?: string,                 // RFC3161 timestamp authority (optional)
 *   meta: { name, reason, location, contactInfo },
 *   appearance?: {                   // omit / null → invisible signature
 *     pageIndex: number,
 *     rect: [x1, y1, x2, y2],        // PDF points, lower-left origin
 *     imagePng: Uint8Array,          // rendered appearance (matches rect aspect)
 *   },
 * }
 */
async function applySignature(payload) {
  const { bytes, thumbprint, tsaUrl, meta = {}, appearance } = payload;
  if (!bytes || !thumbprint) return { ok: false, reason: "other", error: "Thiếu dữ liệu ký." };

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(bytes);
  } catch (e) {
    // Encrypted PDFs can't be signed cleanly here — ask the user to remove the
    // password first (Tools → Khoá file).
    return { ok: false, reason: "load", error: "Không mở được PDF để ký (file có mật khẩu?)." };
  }

  const pages = pdfDoc.getPages();
  let widgetRect = [0, 0, 0, 0];
  let apRef = null;

  if (appearance && appearance.imagePng) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, appearance.pageIndex | 0));
    const page = pages[pageIndex];
    if (page.getRotation().angle % 360 !== 0) {
      return { ok: false, reason: "rotated", error: "Trang xoay chưa hỗ trợ chữ ký nhìn thấy. Dùng chữ ký vô hình." };
    }
    const r = appearance.rect;
    widgetRect = [r[0], r[1], r[2], r[3]];
    const w = Math.abs(r[2] - r[0]);
    const h = Math.abs(r[3] - r[1]);
    const img = await pdfDoc.embedPng(appearance.imagePng);
    apRef = buildImageAP(pdfDoc, img.ref, w, h);
  }

  const targetPage = appearance && appearance.imagePng
    ? pages[Math.max(0, Math.min(pages.length - 1, appearance.pageIndex | 0))]
    : pages[0];

  pdflibAddPlaceholder({
    pdfDoc,
    pdfPage: targetPage,
    reason: meta.reason || "",
    contactInfo: meta.contactInfo || "",
    name: meta.name || "",
    location: meta.location || "",
    signatureLength: SIGNATURE_LENGTH,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
    widgetRect,
    appName: "Nabu PDF",
  });

  // Swap @signpdf's empty appearance for our rendered one.
  if (apRef) {
    const widget = lastSigWidget(pdfDoc);
    if (widget) widget.set(PDFName.of("AP"), pdfDoc.context.obj({ N: apRef }));
  }

  // Signatures require a classic xref (no object streams) so the ByteRange is valid.
  const withPlaceholder = await pdfDoc.save({ useObjectStreams: false });

  try {
    const signer = new HelperSigner(thumbprint, tsaUrl);
    const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer);
    return { ok: true, bytes: signed };
  } catch (e) {
    return { ok: false, reason: e.reason || "other", error: e.message || String(e) };
  }
}

// --- IPC ---------------------------------------------------------------------

function initSigning() {
  ipcMain.handle("sign:list-certs", async () => {
    try {
      return await listCerts();
    } catch (e) {
      return { ok: false, reason: "other", error: e.message || String(e) };
    }
  });
  ipcMain.handle("sign:apply", async (_e, payload) => {
    try {
      return await applySignature(payload || {});
    } catch (e) {
      return { ok: false, reason: "other", error: e.message || String(e) };
    }
  });
}

module.exports = { initSigning };
