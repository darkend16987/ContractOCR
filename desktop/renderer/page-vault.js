"use strict";

/*
 * Page vault — "ẩn trang có khoá" (hidden pages, v0.2.64).
 *
 * WHAT IT DOES. Hiding page i takes the page OUT of the document, encrypts it with a
 * password, and puts a **placeholder page** in its place carrying the ciphertext. Any
 * viewer opens the file and sees a sheet saying the page is hidden; only Nabu, with the
 * password, can put the original back. The page count never changes — for a contract,
 * "trang 7/12" staying 7/12 is the point.
 *
 * WHY IT IS A SEPARATE FILE AND WHY IT LOOKS LIKE managed-codec.js. Same reasoning as
 * docs/REGRESSION-GUARD.md §1: a mistake here does not throw, it loses a page of the
 * user's contract permanently. So the whole thing is written DOM-free and pdf-lib-only,
 * which makes it require()-able and gives it a grid (`npm run test:vault`) from its very
 * first commit — including the four survival cases that motivated the design.
 *
 * ── THE FOUR TRAPS, ALL MEASURED, ALL LOAD-BEARING ────────────────────────────────
 *
 * 1. THE BLOB LIVES ON THE PAGE DICT, NEVER ON THE CATALOG.
 *    `reorderPages()` (app.js) rebuilds the document with `PDFDocument.create()` +
 *    `copyPages()`. Measured on pdf-lib 1.17.1: a custom key on the CATALOG is gone
 *    afterwards; the same key on a PAGE DICT survives that, plus removePage of another
 *    page, merge/insert, split/extract, and a PyMuPDF round-trip. Dragging one thumbnail
 *    would otherwise wipe every hidden page in the file, with no error anywhere.
 *
 * 2. THE KEY IS `/NabuVault`, NEVER `/NabuKind`.
 *    `stripManagedFromPage` (managed-codec.js) deletes EVERY annotation carrying
 *    `/NabuKind`. Annotate the placeholder page, press Áp dụng, and a vault tagged that
 *    way would be collected with the rest. A different namespace on a different object
 *    (the page dict, not an annot) means the managed-annot machinery never sees it.
 *
 * 3. `/Filter /FlateDecode` MUST BE READ, NOT REFUSED.
 *    BI-37's rule for image round-trips is "a filter means another tool re-compressed
 *    this, so don't trust it" — safe there, because the worst case is a read-only image.
 *    Here the worst case is an unrecoverable page. And the "other tool" is OUR OWN
 *    sidecar: PyMuPDF's `doc.tobytes(deflate=True)` re-compresses the stream on every
 *    /add-page-numbers, /edit-text, /compress and Tìm & Thay thế. Measured: a stream
 *    written with no filter comes back `<< /NabuFmt /blob /Length 17 /Filter
 *    /FlateDecode >>`. So `readVaultBytes` inflates instead of giving up.
 *
 * 4. NOTHING IS DELETED ON A FAILED READ.
 *    Wrong password, unknown filter, malformed payload — every one of them throws and
 *    leaves the document untouched. A vault we cannot open is still a vault; the one
 *    outcome that must never happen is "couldn't read it, so removed it".
 *
 * ── CRYPTO ────────────────────────────────────────────────────────────────────────
 * AES-256-GCM with a PBKDF2-SHA256 key, random salt and IV per page. Measured available
 * in a `file://` Electron renderer under `sandbox: true` (it is a secure context) and in
 * node, so the same code runs in the app and in the grid. A wrong password fails the GCM
 * tag, which is why no password hash is stored anywhere.
 *
 * HONEST LIMITS, repeated in the user guide: lose the password and the page is gone;
 * only Nabu can restore it; the file does not get smaller.
 *
 * EXPOSURE — the `page-range.js` tier of §2 (the cleanest one, for NEW code): nothing is
 * published as a bare name, only `window.PageVault`. The IIFE is mandatory anyway,
 * because this file destructures pdf-lib and a top-level `const` of those names would
 * collide with app.js — that is BI-14, and it once turned the whole app white.
 */

(function () {
  const _PDFLib =
    (typeof window !== "undefined" && window.PDFLib) ||
    (typeof require === "function" ? require("pdf-lib") : null);
  if (!_PDFLib) throw new Error("page-vault: pdf-lib unavailable (load vendor/pdf-lib.min.js first)");
  const { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFRawStream, PDFDict } = _PDFLib;

  // The one key this whole feature hangs on. Deliberately NOT in the /Nabu*Kind family —
  // see trap 2 in the header.
  const VAULT_KEY = PDFName.of("NabuVault");
  const K_V = PDFName.of("V");
  const K_ITER = PDFName.of("Iter");
  const K_SALT = PDFName.of("Salt");
  const K_IV = PDFName.of("IV");
  const K_HINT = PDFName.of("Hint");
  const K_BLOB = PDFName.of("Blob");
  const K_FILTER = PDFName.of("Filter");
  const P_ROTATE = PDFName.of("Rotate");

  const VAULT_VERSION = 1;
  // OWASP's 2023 floor for PBKDF2-SHA256. Stored in the payload rather than assumed, so
  // raising it later still opens every file written today.
  const DEFAULT_ITER = 310000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12; // the size AES-GCM is specified for; anything else weakens it

  // Errors carry a CODE, because the UI has to say different things for "sai mật khẩu"
  // (try again) and "file này đã bị công cụ khác nén lại" (nothing you can type helps).
  class VaultError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "VaultError";
      this.code = code;
    }
  }

  function subtle() {
    const c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (!c || !c.subtle) {
      throw new VaultError("NO_CRYPTO", "Trình duyệt không có WebCrypto — không mã hoá được.");
    }
    return c;
  }

  const bytesToHex = (u8) =>
    Array.prototype.map.call(u8, (b) => b.toString(16).padStart(2, "0")).join("");

  // ---- crypto --------------------------------------------------------------

  async function deriveKey(password, salt, iter) {
    const c = subtle();
    const base = await c.subtle.importKey(
      "raw", new TextEncoder().encode(String(password == null ? "" : password)),
      "PBKDF2", false, ["deriveKey"]
    );
    return c.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  // Encrypt `bytes` under `password`. Returns everything the reader needs EXCEPT the
  // password: salt and IV are public by design, and both are fresh per call so hiding
  // two pages under one password never reuses a keystream.
  async function sealBytes(bytes, password, opts) {
    const o = opts || {};
    const c = subtle();
    const iter = Math.max(1, Math.floor(o.iter || DEFAULT_ITER));
    const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(password, salt, iter);
    const ct = await c.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { salt, iv, iter, cipher: new Uint8Array(ct) };
  }

  // The inverse. A wrong password fails GCM's authentication tag and lands here as
  // BAD_PASSWORD — which is also why nothing resembling a password hash is ever written
  // to the file: the tag already answers the question.
  async function openSealed(sealed, password) {
    const c = subtle();
    const key = await deriveKey(password, sealed.salt, sealed.iter);
    try {
      const pt = await c.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.cipher);
      return new Uint8Array(pt);
    } catch (_) {
      throw new VaultError("BAD_PASSWORD", "Sai mật khẩu.");
    }
  }

  // ---- reading the blob back (trap 3) --------------------------------------

  // Bytes of the vault stream `ref`, inflating when something has re-compressed it.
  //
  // We write the stream with NO filter. PyMuPDF adds /FlateDecode on any sidecar
  // round-trip, so "no filter" is the shape of a FRESH file, not an invariant — treating
  // a filter as tampering the way BI-37 does would make the page unrecoverable after the
  // user numbered their pages. Anything OTHER than FlateDecode is refused loudly and
  // changes nothing: better an error the user can read than a page silently binned.
  async function readVaultBytes(doc, ref) {
    const st = doc.context.lookup(ref);
    if (!(st instanceof PDFRawStream) || !st.contents) {
      throw new VaultError("CORRUPT", "Kho trang ẩn hỏng — không đọc được dữ liệu.");
    }
    const raw = st.contents;
    const dict = st.dict || st;
    const filter = dict.get && dict.get(K_FILTER);
    if (!filter) return raw;
    const name = String(filter);
    if (name !== "/FlateDecode") {
      throw new VaultError(
        "FILTER",
        "Trang ẩn đã bị một công cụ khác mã hoá lại (" + name + ") — Nabu không mở lại được."
      );
    }
    if (typeof DecompressionStream === "undefined") {
      throw new VaultError("FILTER", "Môi trường không giải nén được luồng /FlateDecode.");
    }
    // "deflate" is the zlib-wrapped flavour, which is what /FlateDecode means.
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- the payload on a page dict ------------------------------------------

  // The vault carried by `page`, or null. Never throws: it is called while painting
  // thumbnails, and a malformed dict must degrade to "this is an ordinary page", not
  // take the sidebar down with it.
  function vaultInfo(doc, page) {
    try {
      const node = page.node || page;
      const raw = node.get(VAULT_KEY);
      if (!raw) return null;
      const d = doc.context.lookup(raw);
      if (!(d instanceof PDFDict)) return null;
      const salt = d.get(K_SALT);
      const iv = d.get(K_IV);
      const blob = d.get(K_BLOB);
      if (!salt || !iv || !blob) return null;
      const hint = d.get(K_HINT);
      const iter = doc.context.lookup(d.get(K_ITER));
      return {
        v: Number(doc.context.lookup(d.get(K_V)) && doc.context.lookup(d.get(K_V)).asNumber
          ? doc.context.lookup(d.get(K_V)).asNumber() : VAULT_VERSION),
        iter: iter && iter.asNumber ? iter.asNumber() : DEFAULT_ITER,
        salt: new Uint8Array(doc.context.lookup(salt).asBytes()),
        iv: new Uint8Array(doc.context.lookup(iv).asBytes()),
        hint: hint ? String(doc.context.lookup(hint).decodeText()) : "",
        blobRef: blob,
      };
    } catch (_) {
      return null;
    }
  }

  // Cheap "is it worth parsing this document?" test, run on the raw bytes.
  //
  // The badge and the status line need to know whether a document has hidden pages, and
  // they need to know it on every render. `PDFDocument.load` costs ~53 ms on a 200-page
  // file (measured) — too much to spend on every render of every document, when almost
  // no document has a hidden page. This scans for the marker on the vault stream's
  // DICTIONARY, which pdf-lib leaves in the clear (see the note where it is written).
  //
  // Deliberately one-sided. A false POSITIVE costs one parse that finds nothing. A false
  // negative would only mean no badge — never a lost page, because unhide reads the page
  // dict directly and never consults this.
  const MARKER = "/NabuVaultBlob";
  function looksLikeVaultFile(bytes) {
    if (!bytes || !bytes.length) return false;
    const first = MARKER.charCodeAt(0);
    for (let i = 0; i + MARKER.length <= bytes.length; i++) {
      if (bytes[i] !== first) continue;
      let k = 1;
      while (k < MARKER.length && bytes[i + k] === MARKER.charCodeAt(k)) k++;
      if (k === MARKER.length) return true;
    }
    return false;
  }

  // 0-based indices of every placeholder page in `doc`. This is what the sidebar badge
  // and the status line count, and what "Bỏ ẩn" offers.
  function vaultPageIndices(doc) {
    const out = [];
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) if (vaultInfo(doc, pages[i])) out.push(i);
    return out;
  }

  // ---- hide ----------------------------------------------------------------

  // Extract page `i` as a standalone one-page PDF. `copyPages` brings the page's own
  // resources, annotations and /Rotate with it, which is what makes the restore lossless.
  async function extractPage(doc, i) {
    const sub = await PDFDocument.create();
    const [copied] = await sub.copyPages(doc, [i]);
    sub.addPage(copied);
    return sub.save();
  }

  // Replace page `i` with a blank page of the SAME size and rotation. Written as
  // insertPage-then-removePage (the idiom app.js already uses for page surgery) so the
  // page tree is only ever touched through pdf-lib's own bookkeeping.
  function swapInPlaceholder(doc, i) {
    const orig = doc.getPage(i);
    const size = orig.getSize();
    const rot = orig.node.get(P_ROTATE);
    const ph = doc.insertPage(i, [size.width, size.height]);
    // Carry /Rotate across, or hiding a page on a landscape drawing sheet would leave a
    // portrait placeholder in a run of landscape pages.
    if (rot) ph.node.set(P_ROTATE, rot);
    doc.removePage(i + 1); // the original, now one further down
    return ph;
  }

  // Paint the "this page is hidden" sheet. `labelPng` is supplied by the caller because
  // the label is Vietnamese and rendering Vietnamese means either embedding a font or
  // rasterising with a canvas — and a canvas would cost this file its node grid. No
  // label is a legitimate (if plain) result, which is exactly what the grid runs with.
  async function paintPlaceholder(doc, page, opts) {
    const o = opts || {};
    const { width, height } = page.getSize();
    const rgb = _PDFLib.rgb;
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.965, 0.965, 0.965) });
    const m = Math.min(width, height) * 0.08;
    page.drawRectangle({
      x: m, y: m, width: width - 2 * m, height: height - 2 * m,
      borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1,
    });
    if (o.labelPng && o.labelPng.length) {
      const img = await doc.embedPng(o.labelPng);
      const maxW = (width - 2 * m) * 0.8;
      const scale = Math.min(1, maxW / img.width);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    }
  }

  // Hide `indices` (0-based) under one password. Returns the number of pages hidden.
  //
  // Order matters twice over. Pages are processed HIGH → LOW so an earlier swap cannot
  // shift an index still to be processed — and because each page is REPLACED rather than
  // removed, the document keeps its length throughout, which is what lets the caller's
  // page numbers stay valid. Already-hidden pages are skipped rather than double-sealed:
  // sealing a placeholder would bury the first password under a second one.
  async function hidePages(doc, indices, password, opts) {
    const o = opts || {};
    if (!password) throw new VaultError("NO_PASSWORD", "Cần mật khẩu để ẩn trang.");
    const n = doc.getPageCount();
    const uniq = [...new Set(indices)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
      .filter((i) => !vaultInfo(doc, doc.getPage(i)))
      .sort((a, b) => b - a);
    if (!uniq.length) return 0;
    if (uniq.length >= n) throw new VaultError("ALL_PAGES", "Không thể ẩn toàn bộ trang.");

    for (const i of uniq) {
      const plain = await extractPage(doc, i);
      const sealed = await sealBytes(plain, password, o);
      const ph = swapInPlaceholder(doc, i);
      await paintPlaceholder(doc, ph, o);
      const ctx = doc.context;
      // A raw stream, not a hex string: /NabuData-style hex costs ~1.46x and pdf-lib's
      // string decoders throw RangeError past ~150 KB (BI-37) — a scanned page is far
      // past that. Written with no /Filter; see trap 3 for what happens next.
      const blobRef = ctx.register(PDFRawStream.of(
        // `/NabuVaultBlob` is the FILE-LEVEL MARKER, and it is on the stream dict for a
        // measured reason: pdf-lib's save() packs ordinary objects into object streams by
        // default, so `/NabuVault` on the page dict is NOT visible in the raw bytes —
        // measured, `Buffer.includes("/NabuVault")` is false on our own output. Stream
        // objects are never packed, so their dictionary IS in the clear. That is what
        // lets looksLikeVaultFile() answer "does this document have hidden pages?" with a
        // memcmp instead of a full parse on every render. It also survives the sidecar:
        // PyMuPDF keeps the key (and adds /Filter — trap 3).
        ctx.obj({ NabuFmt: PDFName.of("vault"), NabuVaultBlob: true }),
        sealed.cipher
      ));
      const dict = ctx.obj({});
      dict.set(K_V, PDFNumber.of(VAULT_VERSION));
      dict.set(PDFName.of("Alg"), PDFName.of("AESGCM256"));
      dict.set(PDFName.of("KDF"), PDFName.of("PBKDF2SHA256"));
      dict.set(K_ITER, PDFNumber.of(sealed.iter));
      dict.set(K_SALT, PDFHexString.of(bytesToHex(sealed.salt)));
      dict.set(K_IV, PDFHexString.of(bytesToHex(sealed.iv)));
      dict.set(K_HINT, PDFHexString.fromText(String(o.hint || "")));
      dict.set(K_BLOB, blobRef);
      ph.node.set(VAULT_KEY, dict);
    }
    return uniq.length;
  }

  // ---- unhide --------------------------------------------------------------

  // Restore `indices` with one password. Returns the number restored.
  //
  // NOTHING IS MUTATED UNTIL EVERY PAGE HAS DECRYPTED (trap 4). Decrypt-and-restore in
  // one pass would leave the document half-restored when the third of five pages turns
  // out to use a different password — and the user would be looking at a mixture with no
  // way to tell which is which. So: read everything, then write everything.
  async function unhidePages(doc, indices, password) {
    const n = doc.getPageCount();
    const uniq = [...new Set(indices)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
      .sort((a, b) => b - a);
    const restore = [];
    for (const i of uniq) {
      const info = vaultInfo(doc, doc.getPage(i));
      if (!info) throw new VaultError("NO_VAULT", "Trang " + (i + 1) + " không phải trang đã ẩn.");
      const cipher = await readVaultBytes(doc, info.blobRef);
      const plain = await openSealed({ salt: info.salt, iv: info.iv, iter: info.iter, cipher }, password);
      let src;
      try {
        src = await PDFDocument.load(plain);
      } catch (e) {
        // Decryption succeeded (the tag matched) but the payload is not a PDF. That can
        // only be a corrupted blob, never a wrong password.
        throw new VaultError("CORRUPT", "Trang ẩn giải mã được nhưng nội dung hỏng.");
      }
      restore.push({ i, src, blobRef: info.blobRef });
    }
    if (!restore.length) return 0;

    for (const r of restore) {
      const [page] = await doc.copyPages(r.src, [0]);
      doc.insertPage(r.i, page);
      doc.removePage(r.i + 1); // the placeholder, now one further down
      // Free the ciphertext. pdf-lib keeps every object it has parsed and writes them all
      // back, so unlinking the page alone would leave the encrypted copy in the file
      // forever — the same growth BI-38 is about, at page scale.
      try { doc.context.delete(r.blobRef); } catch (_) { /* not an indirect ref */ }
    }
    return restore.length;
  }

  // ---- export --------------------------------------------------------------

  // A copy of `doc` with every hidden page dropped entirely — the safe thing to send
  // someone when you do not want the ciphertext travelling with the file at all.
  async function exportWithoutVaults(doc) {
    const keep = [];
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) if (!vaultInfo(doc, pages[i])) keep.push(i);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, keep);
    copied.forEach((p) => out.addPage(p));
    return { bytes: await out.save(), dropped: pages.length - keep.length };
  }

  const _SURFACE = {
    VAULT_KEY, VAULT_VERSION, DEFAULT_ITER, VaultError, MARKER,
    bytesToHex, deriveKey, sealBytes, openSealed, readVaultBytes, looksLikeVaultFile,
    vaultInfo, vaultPageIndices, extractPage, swapInPlaceholder, paintPlaceholder,
    hidePages, unhidePages, exportWithoutVaults,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = _SURFACE;
  // The `page-range.js` tier: ONE global, no bare names leaked into the shared
  // classic-script scope. New code, no existing call sites — so there is nothing to buy
  // by courting BI-14.
  if (typeof window !== "undefined") window.PageVault = _SURFACE;
})();
