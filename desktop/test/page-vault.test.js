"use strict";

/*
 * Grid for renderer/page-vault.js — "ẩn trang có khoá".
 *
 * WHY THIS GRID EXISTS, and why it was written BEFORE the UI. Every failure mode of this
 * feature is the same failure mode: a page of the user's contract is gone and nothing
 * said so. There is no crash, no toast, no red text — the placeholder is simply there
 * forever. docs/REGRESSION-GUARD.md §1 calls that the criterion for splitting a file out
 * so it can be tested; here it was also the criterion for not writing a line of UI until
 * these cases were green.
 *
 * WHAT IS ACTUALLY EXERCISED. The real pdf-lib from node_modules (byte-identical to
 * renderer/vendor/pdf-lib.min.js — `npm run vendor` copies it verbatim) and the real
 * WebCrypto, so the encryption in this grid is the encryption that ships. Nothing is
 * stubbed except the placeholder's label PNG, which needs a canvas.
 *
 * THE FOUR SURVIVAL CASES (V4–V7) are the point of the whole design. Each replays an
 * operation the app ALREADY performs on state.bytes and asks whether the hidden page is
 * still recoverable afterwards. V4 in particular (`create()` + `copyPages`, which is what
 * reorderPages does) is the case that ruled out storing the blob on the catalog: measured
 * on pdf-lib 1.17.1, a catalog key does not survive it.
 *
 * Run: node desktop/test/page-vault.test.js      (npm run test:vault)
 */

const path = require("path");
const zlib = require("zlib");
const { PDFDocument, PDFName, PDFRawStream, rgb } = require("pdf-lib");
const V = require(path.join(__dirname, "..", "renderer", "page-vault.js"));
const MC = require(path.join(__dirname, "..", "renderer", "managed-codec.js"));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}
function group(name) {
  console.log("\n— " + name);
}
// Every case that must NOT change the document asserts through this: an operation that
// throws is only safe if it also left the page count and the vault list alone.
async function throwsWith(fn) {
  try {
    await fn();
    return "no throw";
  } catch (e) {
    return e && e.code ? e.code : "unknown:" + (e && e.message);
  }
}

const PW = "mật khẩu 123";
// Deliberately tiny: PBKDF2 at the shipping 310 000 rounds would make this grid take
// minutes. The ITERATION COUNT itself is asserted separately (it travels in the payload,
// which is the property that matters); what these cases test is the surrounding logic.
const FAST = { iter: 1000 };

// A document whose pages are individually identifiable, so "the right page came back"
// is a measurement rather than a vibe: page k gets a rectangle k+1 units wide.
async function makeDoc(n) {
  const doc = await PDFDocument.create();
  for (let k = 0; k < n; k++) {
    const p = doc.addPage([300, 400]);
    p.drawRectangle({ x: 10, y: 10, width: k + 1, height: 20, color: rgb(0, 0, 0) });
    p.setFontSize(12);
  }
  return doc;
}
// The width of that rectangle, read back out of the page's content stream. This is the
// fingerprint the restore cases compare — it survives save/load and copyPages, which is
// exactly the journey under test.
function pageMark(doc, i) {
  const page = doc.getPage(i);
  const refs = page.node.Contents();
  const streams = refs && refs.asArray ? refs.asArray() : [refs];
  let text = "";
  for (const r of streams) {
    if (!r) continue;
    const st = doc.context.lookup(r);
    if (!st || !st.getContents) continue;
    let bytes = st.getContents();
    const filt = (st.dict || st).get(PDFName.of("Filter"));
    if (filt && String(filt) === "/FlateDecode") {
      try { bytes = zlib.inflateSync(Buffer.from(bytes)); } catch (_) { /* leave raw */ }
    }
    text += Buffer.from(bytes).toString("latin1");
  }
  // pdf-lib emits a rectangle as an explicit path (`0 0 m / 0 20 l / W 20 l / W 0 l / h`),
  // never as `re`, so the fingerprint is read off the corner that carries the width. Two
  // corners sit at y=20 — one at x=0 and one at x=W — hence the max rather than the first
  // match. Getting this wrong reads every page as `null`, which would make the restore
  // cases pass each other by agreeing on nothing.
  const widths = [...text.matchAll(/([\d.]+) 20 l/g)].map((m) => parseFloat(m[1]));
  return widths.length ? Math.round(Math.max(...widths)) : null;
}
const marks = (doc) => doc.getPages().map((_, i) => pageMark(doc, i));
// save → load, the round trip every one of these cases has to survive at least once.
const reload = async (doc) => PDFDocument.load(await doc.save());

(async () => {
  // ========================================================================
  // V1–V3 · hide and unhide
  // ========================================================================
  group("V1–V3 · hide → unhide");
  {
    const doc = await makeDoc(4);
    check("baseline: four identifiable pages", marks(doc), [1, 2, 3, 4]);

    const n = await V.hidePages(doc, [1], PW, FAST);
    check("hidePages reports one page hidden", n, 1);
    check("the page COUNT does not change — a placeholder took its place",
      doc.getPageCount(), 4);
    check("the hidden page's content is gone from the visible document",
      pageMark(doc, 1), null);
    check("its neighbours are untouched",
      [pageMark(doc, 0), pageMark(doc, 2), pageMark(doc, 3)], [1, 3, 4]);
    check("vaultPageIndices finds it", V.vaultPageIndices(doc), [1]);

    // Through the file, because that is the only journey that counts.
    const back = await reload(doc);
    check("after save → load the vault is still there", V.vaultPageIndices(back), [1]);
    check("V1 · unhide restores it", await V.unhidePages(back, [1], PW), 1);
    check("… the ORIGINAL page, in its original position", marks(back), [1, 2, 3, 4]);
    check("… and the document no longer holds a vault", V.vaultPageIndices(back), []);
  }
  {
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const f = await reload(doc);
    const before = f.getPageCount();
    check("V2 · a wrong password is refused", await throwsWith(() => V.unhidePages(f, [1], "sai")),
      "BAD_PASSWORD");
    check("… and changes NOTHING: same page count, vault still present",
      [f.getPageCount(), V.vaultPageIndices(f)], [before, [1]]);
    check("… so the right password still works afterwards",
      await V.unhidePages(f, [1], PW), 1);
    check("… restoring the real page", marks(f), [1, 2, 3]);
  }
  {
    // Three scattered pages, hidden together, then unhidden ONE AT A TIME. Every
    // intermediate state has to be right, not just the final one: this is where an
    // index that shifted under its own feet would show up.
    const doc = await makeDoc(6);
    check("V3 · three scattered pages hide in one call",
      await V.hidePages(doc, [4, 1, 2], PW, FAST), 3);
    check("… and they are the three we asked for", V.vaultPageIndices(doc), [1, 2, 4]);
    check("… with the others untouched",
      [pageMark(doc, 0), pageMark(doc, 3), pageMark(doc, 5)], [1, 4, 6]);
    const f = await reload(doc);
    await V.unhidePages(f, [2], PW);
    check("unhide the middle one: it returns to ITS OWN slot", marks(f), [1, null, 3, 4, null, 6]);
    await V.unhidePages(f, [4], PW);
    check("unhide the next", marks(f), [1, null, 3, 4, 5, 6]);
    await V.unhidePages(f, [1], PW);
    check("unhide the last — the document is whole again", marks(f), [1, 2, 3, 4, 5, 6]);
  }
  {
    const doc = await makeDoc(2);
    check("hiding EVERY page is refused (nothing left to look at)",
      await throwsWith(() => V.hidePages(doc, [0, 1], PW, FAST)), "ALL_PAGES");
    check("… and the document is untouched", [doc.getPageCount(), marks(doc)], [2, [1, 2]]);
    check("hiding with no password is refused",
      await throwsWith(() => V.hidePages(doc, [0], "", FAST)), "NO_PASSWORD");
    check("hiding an already-hidden page is a no-op, not a second seal",
      await (async () => {
        await V.hidePages(doc, [0], PW, FAST);
        return V.hidePages(doc, [0], "mật khẩu khác", FAST);
      })(), 0);
    check("… so the FIRST password still opens it",
      await V.unhidePages(doc, [0], PW), 1);
  }

  // ========================================================================
  // V4–V7 · the survival cases — the reason for the whole design
  // ========================================================================
  group("V4–V7 · survival through operations the app already performs");
  {
    // V4. reorderPages() (app.js) rebuilds the document with create() + copyPages. A
    // custom key on the CATALOG does not survive this — measured — which is why the
    // vault lives on the page dict. Dragging one thumbnail must not cost a hidden page.
    const doc = await makeDoc(4);
    await V.hidePages(doc, [1], PW, FAST);
    const src = await reload(doc);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, [3, 1, 2, 0]); // the vault page moves to slot 1
    copied.forEach((p) => out.addPage(p));
    const after = await reload(out);
    check("V4 · the vault survives a create()+copyPages rebuild (reorderPages)",
      V.vaultPageIndices(after), [1]);
    check("… and still opens", await V.unhidePages(after, [1], PW), 1);
    check("… giving back the right page, in its new position", marks(after), [4, 2, 3, 1]);
  }
  {
    // V5. Deleting some OTHER page must not disturb the vault.
    const doc = await makeDoc(4);
    await V.hidePages(doc, [2], PW, FAST);
    const f = await reload(doc);
    f.removePage(0);
    const after = await reload(f);
    check("V5 · the vault survives removePage of another page",
      V.vaultPageIndices(after), [1]);
    check("… and opens", await V.unhidePages(after, [1], PW), 1);
    check("… correctly", marks(after), [2, 3, 4]);
  }
  {
    // V6. Merging another file in (mergeFiles / insertFile in app.js).
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const f = await reload(doc);
    const other = await makeDoc(2);
    const cp = await f.copyPages(other, [0, 1]);
    cp.forEach((p, k) => f.insertPage(k, p)); // pushed in at the FRONT, so the index moves
    const after = await reload(f);
    check("V6 · the vault survives a merge and moves with its page",
      V.vaultPageIndices(after), [3]);
    check("… and opens", await V.unhidePages(after, [3], PW), 1);
    check("… correctly", marks(after), [1, 2, 1, 2, 3]);
  }
  {
    // V7. THE ONE THAT NAMED THE KEY. stripManagedAnnots removes every annotation
    // carrying /NabuKind — it runs on every "Áp dụng" in the annotate overlay. If the
    // vault had been tagged that way, annotating the placeholder page would collect it.
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const f = await reload(doc);
    const removed = MC.stripManagedAnnots(f);
    const after = await reload(f);
    check("V7 · stripManagedAnnots does not see the vault as one of its own",
      [removed, V.vaultPageIndices(after)], [0, [1]]);
    check("… and it still opens after a bake pass", await V.unhidePages(after, [1], PW), 1);
    check("… correctly", marks(after), [1, 2, 3]);
  }
  {
    // V12. A page with real annotations and a /Rotate must come back with both. This is
    // the landscape-drawing-sheet case: a portrait placeholder in a run of landscape
    // pages is a visible defect, and losing the annots is a silent one.
    const doc = await makeDoc(3);
    const p = doc.getPage(1);
    p.node.set(PDFName.of("Rotate"), doc.context.obj(90));
    const ctx = doc.context;
    const annot = ctx.obj({ Type: "Annot", Subtype: "Square", F: 4, Rect: [10, 10, 60, 60] });
    p.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(annot)]));
    await V.hidePages(doc, [1], PW, FAST);
    const held = await reload(doc);
    check("V12 · the placeholder inherits the original's /Rotate",
      String(held.getPage(1).node.get(PDFName.of("Rotate"))), "90");
    await V.unhidePages(held, [1], PW);
    check("… and the restored page brings back /Rotate and its annotation",
      [String(held.getPage(1).node.get(PDFName.of("Rotate"))),
       held.getPage(1).node.Annots() ? held.getPage(1).node.Annots().size() : 0,
       pageMark(held, 1)],
      ["90", 1, 2]);
  }

  // ========================================================================
  // V8–V11 · reading the blob back
  // ========================================================================
  group("V8–V11 · the blob is read, not refused");
  {
    // V8. THE TRAP BI-37'S RULE WOULD HAVE WALKED INTO. Our own sidecar re-compresses
    // this stream on every PyMuPDF round-trip (/add-page-numbers, /edit-text, /compress,
    // Tìm & Thay thế). Measured: a stream written with no filter comes back
    // `<< /NabuFmt /vault /Length n /Filter /FlateDecode >>`. Treating that as tampering
    // — which is the right answer for an image — would make the page unrecoverable.
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const f = await reload(doc);
    const info = V.vaultInfo(f, f.getPage(1));
    const st = f.context.lookup(info.blobRef);
    const deflated = new Uint8Array(zlib.deflateSync(Buffer.from(st.contents)));
    // Rewrite the stream exactly as PyMuPDF hands it back.
    f.context.assign(info.blobRef, PDFRawStream.of(
      f.context.obj({ NabuFmt: PDFName.of("vault"), Filter: PDFName.of("FlateDecode") }),
      deflated
    ));
    const after = await reload(f);
    check("V8 · a /FlateDecode'd blob is inflated and opens normally",
      await V.unhidePages(after, [1], PW), 1);
    check("… giving back the right page", marks(after), [1, 2, 3]);
  }
  {
    // V9. An unknown filter means a tool we do not model has rewritten the stream. The
    // only safe answer is to say so and touch nothing — never to remove the placeholder.
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const f = await reload(doc);
    const info = V.vaultInfo(f, f.getPage(1));
    f.context.assign(info.blobRef, PDFRawStream.of(
      f.context.obj({ NabuFmt: PDFName.of("vault"), Filter: PDFName.of("LZWDecode") }),
      st0(f, info)
    ));
    check("V9 · an unknown filter is refused with a distinct code",
      await throwsWith(() => V.unhidePages(f, [1], PW)), "FILTER");
    check("… and the placeholder is STILL THERE (never removed on a failed read)",
      [f.getPageCount(), V.vaultPageIndices(f)], [3, [1]]);
  }
  {
    // V10. Junk in the dict must degrade to "this is an ordinary page", not crash the
    // sidebar — vaultInfo runs while thumbnails paint.
    const doc = await makeDoc(2);
    const bad = doc.context.obj({});
    bad.set(PDFName.of("V"), doc.context.obj(1)); // no Salt / IV / Blob at all
    doc.getPage(0).node.set(V.VAULT_KEY, bad);
    check("V10 · a malformed vault dict reads as 'not a vault', with no throw",
      [V.vaultInfo(doc, doc.getPage(0)), V.vaultPageIndices(doc)], [null, []]);
    doc.getPage(1).node.set(V.VAULT_KEY, doc.context.obj(42)); // not even a dict
    check("… and so does a vault key that is not a dictionary",
      V.vaultPageIndices(doc), []);
    check("unhiding a page that has no vault is refused by code, not by exception type",
      await throwsWith(() => V.unhidePages(doc, [0], PW)), "NO_VAULT");
  }
  {
    // V11. Two pages, two different passwords. Each must open only with its own — the
    // per-page salt is what makes that true, and it is also what stops two pages sealed
    // with ONE password from sharing a key stream.
    const doc = await makeDoc(4);
    await V.hidePages(doc, [1], "mật khẩu A", FAST);
    await V.hidePages(doc, [2], "mật khẩu B", FAST);
    const f = await reload(doc);
    check("V11 · two vaults, two passwords", V.vaultPageIndices(f), [1, 2]);
    check("… page 2 refuses page 3's password",
      await throwsWith(() => V.unhidePages(f, [1], "mật khẩu B")), "BAD_PASSWORD");
    check("… each opens with its own",
      [await V.unhidePages(f, [1], "mật khẩu A"), await V.unhidePages(f, [2], "mật khẩu B")],
      [1, 1]);
    check("… and the document is whole", marks(f), [1, 2, 3, 4]);
    // Two pages sealed under ONE password must still get different salt AND different IV.
    const d2 = await makeDoc(3);
    await V.hidePages(d2, [0, 1], PW, FAST);
    const i0 = V.vaultInfo(d2, d2.getPage(0));
    const i1 = V.vaultInfo(d2, d2.getPage(1));
    check("one password, two pages ⇒ still a fresh salt and IV each",
      [V.bytesToHex(i0.salt) === V.bytesToHex(i1.salt),
       V.bytesToHex(i0.iv) === V.bytesToHex(i1.iv)], [false, false]);
  }

  // ========================================================================
  // the payload itself
  // ========================================================================
  group("the payload");
  {
    const doc = await makeDoc(2);
    await V.hidePages(doc, [0], PW, { hint: "gợi ý: tên dự án", iter: 4321 });
    const f = await reload(doc);
    const info = V.vaultInfo(f, f.getPage(0));
    check("the iteration count TRAVELS with the file, so raising the default later still opens old files",
      info.iter, 4321);
    check("the hint round-trips with its diacritics", info.hint, "gợi ý: tên dự án");
    check("salt and IV are the specified sizes", [info.salt.length, info.iv.length], [16, 12]);
    check("the shipping default is OWASP's PBKDF2-SHA256 floor", V.DEFAULT_ITER, 310000);
    // The stream is written with NO filter — that is what makes "has a filter" mean
    // "something else re-encoded this", which V8/V9 then act on.
    const st = f.context.lookup(info.blobRef);
    check("the blob goes in as an unfiltered raw stream",
      [st instanceof PDFRawStream, !!(st.dict || st).get(PDFName.of("Filter"))], [true, false]);
    // Guard: the ciphertext must not be recognisable as a PDF. If this ever reads %PDF,
    // a page is sitting in the file in the clear.
    check("the blob is ciphertext, not a PDF in disguise",
      Buffer.from(st.contents.slice(0, 4)).toString("latin1") === "%PDF", false);
  }
  {
    // looksLikeVaultFile is what saves a full parse on every render, so the property that
    // matters is that it is TRUE on our own saved bytes. That is not obvious: pdf-lib
    // packs ordinary objects into object streams, so `/NabuVault` on the page dict is
    // NOT in the clear — measured — and the marker had to move onto the blob's stream
    // dictionary, which pdf-lib never packs. If this case ever fails, the badge silently
    // stops appearing for every file that has one.
    const plain = await makeDoc(2);
    check("looksLikeVaultFile: false for an ordinary document",
      V.looksLikeVaultFile(await plain.save()), false);
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const sealed = await doc.save();
    check("looksLikeVaultFile: TRUE on our own pdf-lib output (object streams and all)",
      V.looksLikeVaultFile(sealed), true);
    check("guard — /NabuVault on the page dict really is NOT scannable, which is WHY the marker sits on the stream",
      Buffer.from(sealed).includes("/NabuVault "), false);
    const f = await reload(doc);
    await V.unhidePages(f, [1], PW);
    check("… and false again once the last vault is opened",
      V.looksLikeVaultFile(await f.save()), false);
    check("it tolerates empty / missing input instead of throwing",
      [V.looksLikeVaultFile(null), V.looksLikeVaultFile(new Uint8Array(0))], [false, false]);
  }
  {
    // Freeing the ciphertext on unhide. pdf-lib writes back every object it parsed, so
    // an unlinked-but-undeleted blob would ride along forever — BI-38 at page scale.
    const doc = await makeDoc(3);
    await V.hidePages(doc, [1], PW, FAST);
    const sealedSize = (await doc.save()).length;
    const f = await reload(doc);
    await V.unhidePages(f, [1], PW);
    const openedSize = (await f.save()).length;
    check("unhide FREES the ciphertext — the file shrinks back",
      openedSize < sealedSize, true);
  }
  {
    // "Xuất bản sao không kèm trang ẩn" — the safe copy to send outside.
    const doc = await makeDoc(4);
    await V.hidePages(doc, [1, 2], PW, FAST);
    const { bytes, dropped } = await V.exportWithoutVaults(doc);
    const out = await PDFDocument.load(bytes);
    check("exportWithoutVaults drops the hidden pages entirely",
      [dropped, out.getPageCount(), V.vaultPageIndices(out)], [2, 2, []]);
    check("… keeping the visible ones in order", marks(out), [1, 4]);
    check("… and the original is untouched",
      [doc.getPageCount(), V.vaultPageIndices(doc)], [4, [1, 2]]);
  }

  console.log(`\npage-vault: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});

// Raw bytes currently in the vault stream — used by V9 to rewrite it with a bogus filter
// while keeping the payload, so the case tests the FILTER branch and nothing else.
function st0(doc, info) {
  const st = doc.context.lookup(info.blobRef);
  return st.contents;
}
