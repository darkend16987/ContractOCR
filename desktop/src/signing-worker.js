"use strict";

/**
 * Signing worker — runs in an Electron utilityProcess (a dedicated Node process),
 * NOT on the main process.
 *
 * Why: pdf-lib load/save and @signpdf's whole-file hashing are synchronous CPU
 * work, and the temp-file I/O was synchronous fs. Running them on the main
 * process froze the whole app ("Not Responding") for the entire sign+save — the
 * bigger the PDF, the longer. Moving the identical logic here keeps the main
 * process (and the window) responsive; only the actual CMS still needs the token.
 *
 * The logic below is moved VERBATIM from signing.js (applySignature + helpers) so
 * the produced signature is byte-for-byte the same — nothing about how the PDF is
 * signed changed, only WHICH process runs it.
 *
 * Protocol: parent posts { payload, helperExe }; we post back the same result
 * applySignature always returned: { ok:true, bytes } | { ok:false, reason, error }.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } = require("pdf-lib");
const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
const signpdf = require("@signpdf/signpdf").default;
const { Signer, SUBFILTER_ADOBE_PKCS7_DETACHED } = require("@signpdf/utils");

// Reserve room for the CMS: leaf + full chain + an RFC3161 timestamp token fits
// comfortably in ~16 KB; 32 KB leaves generous headroom for long VN CA chains.
const SIGNATURE_LENGTH = 32000;

// The main process resolves the bundled helper path (it has `app`) and hands it
// to us in the message — a utilityProcess has no `app`/resourcesPath of its own.
let HELPER_EXE = null;

// Spawn the helper, collect stdout/stderr, resolve { code, stdout, stderr }.
function runHelper(args) {
  return new Promise((resolve, reject) => {
    const exe = HELPER_EXE;
    if (!exe || !fs.existsSync(exe)) {
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
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nabu-sign-"));
    const inPath = path.join(dir, "tbs.bin");
    const outPath = path.join(dir, "sig.der");
    try {
      await fs.promises.writeFile(inPath, pdfBuffer);
      const args = ["sign", "--in", inPath, "--out", outPath, "--thumbprint", this.thumbprint];
      if (this.tsaUrl) args.push("--tsa", this.tsaUrl);
      const { code, stderr } = await runHelper(args);
      if (code !== 0) {
        const e = new Error(stderr || `sign exit ${code}`);
        e.reason = reasonForCode(code);
        throw e;
      }
      return await fs.promises.readFile(outPath); // DER PKCS#7 (Buffer)
    } finally {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

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

// --- utilityProcess message loop ---------------------------------------------

process.parentPort.on("message", async (e) => {
  const msg = (e && e.data) || {};
  HELPER_EXE = msg.helperExe || null;
  let result;
  try {
    result = await applySignature(msg.payload || {});
  } catch (err) {
    result = { ok: false, reason: "other", error: (err && err.message) || String(err) };
  }
  try {
    process.parentPort.postMessage(result);
  } catch (_) {
    // Parent gone — nothing to do; the process will be killed.
  }
});
