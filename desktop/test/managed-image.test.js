"use strict";

// Regression net for the image round-trip in renderer/editor.js — "chèn ảnh" that
// stays a real, movable object after Lưu (v0.2.48).
//
// It drives the SHIPPED functions, not copies of them: like viewer-geom.test.js this
// lifts each one out of editor.js at run time and gives it the handful of names it
// closes over (pdf-lib classes, the /Nabu* keys, wire.js's chunked base64 encoder).
// So the writer, the reader, the /Filter guard and the strip-and-free path under test
// are literally the code that runs in the app. The only thing faked is `ed`, and the
// only hand-written value is the `f` number formatter (ambiguous to lift; a 2-decimal
// formatter is not what this grid is about).
//
// pdf-lib comes from node_modules, which `npm run vendor` copies verbatim into
// renderer/vendor/pdf-lib.min.js — byte-identical, so the answers apply to the build.
//
// What it is really pinning down, all of it measured rather than assumed:
//   · the original image bytes survive save → load byte-for-byte;
//   · a re-bake does NOT grow the file (the old appearance is freed, not orphaned);
//   · one image applied to N pages is embedded ONCE;
//   · a foreign tool re-compressing our private stream makes the annot READ-ONLY
//     rather than deleting the user's image on the next bake.
//
// Run:  node desktop/test/managed-image.test.js     (or: npm run test:managed)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PDFLib = require("pdf-lib");
const { PDFDocument, PDFName, PDFHexString, PDFRawStream, PDFDict } = PDFLib;
// `b64ToU8` is here for the LIFTED `dataUrlToBytes`, which delegates to it (v0.2.48
// folded two hand-rolled copies of that loop into wire.js's one). Not used directly
// by this grid — it has to exist at MODULE scope or the lifted function can't see it.
const { pushB64Chunks, b64ToU8 } = require("../renderer/wire.js");

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

// ---- lift the real implementation out of editor.js -----------------------

const SRC = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");

function fnSource(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in editor.js — renamed or removed?`);
  if (SRC.slice(at - 6, at) === "async ") at -= 6; // keep the keyword, or `await` won't parse
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}
function constSource(name) {
  const hits = SRC.match(new RegExp("^\\s*const " + name + "\\s*=\\s*[^;]+;", "gm")) || [];
  if (hits.length !== 1) throw new Error(`const ${name}: ${hits.length} declarations in editor.js`);
  return /=\s*([^;]+);/.exec(hits[0])[1];
}

// Fakes / locals the lifted code closes over.
const ed = { seq: 1, annots: {}, _managedPages: new Set() };
const f = (n) => (+n).toFixed(2); // mirrors editor.js's number formatter for the AP matrix

// Most of the codec moved to renderer/managed-codec.js at v0.2.49, so these are now a
// PLAIN require — no eval, no brace-matching, and a rename is a load-time TypeError.
// Destructured at MODULE scope on purpose: the four functions still lifted below close
// over this file's top level, so that is where the names they call must live.
const MC = require("../renderer/managed-codec.js");
const {
  NABU_KIND, NABU_DATA, NABU_SRC, NABU_IMG, P_ANNOTS,
  sniffImage, strToBytes, pushPageAnnot, makeMap, serializeManaged,
  managedSrcBytes, managedSrcDataUrl, collectManagedChain, freeManagedTrash,
  stripManagedFromPage, stripManagedAnnots,
} = MC;
// `normTextStyle` is what serializeManaged's text branch normalises through; required
// here too so the LIFTED addManagedAnnot resolves it the same way the browser does.
const { normTextStyle } = require("../renderer/annot-text.js");

// eslint-disable-next-line no-eval
const lift = (name) => eval("(" + fnSource(name) + ")");
// Still lifted, and each for a stated reason — these genuinely cannot leave editor.js:
//   deserializeManaged  mints ids from `ed.seq`
//   addManagedAnnot     calls the canvas rasterisers renderTextPng / renderArrowPng
//   edSnapshot          is the undo pool, and closes over URL_TOKEN below
//   dataUrlToBytes      a 3-line adapter over wire.js's b64ToU8, private to editor.js
const dataUrlToBytes = lift("dataUrlToBytes");
const deserializeManaged = lift("deserializeManaged");
const addManagedAnnot = lift("addManagedAnnot");
const edSnapshot = lift("edSnapshot");
// URL_TOKEN stayed with edSnapshot (it is the undo pool's sentinel, not codec state).
const URL_TOKEN = eval(constSource("URL_TOKEN"));

// ---- fixtures ------------------------------------------------------------

// A real 2×2 RGBA PNG with a transparent pixel, so pdf-lib produces an /SMask (the
// transparent-signature case, and the extra object collectManagedChain must free).
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxIAE0DkAAKUcA/wgQ8p3AAAAAElFTkSuQmCC",
  "base64"
);
const pngUrl = "data:image/png;base64," + PNG_2x2.toString("base64");
// A bigger, incompressible payload so "did the file grow?" is measurable at all.
const BIG = Buffer.concat([PNG_2x2, crypto.randomBytes(120 * 1024)]);
const bigUrl = "data:image/png;base64," + BIG.toString("base64");

const A4 = { width: 595, height: 842 };
const map = makeMap(A4, "image"); // (x,y) → [x, height-y]; no fake viewport needed
const imgAnnot = (over) =>
  Object.assign({ id: 1, kind: "image", x: 40, y: 60, w: 120, h: 90, dataUrl: pngUrl, fmt: "png" }, over);

async function newDoc() {
  const doc = await PDFDocument.create();
  return { doc, page: doc.addPage([A4.width, A4.height]) };
}
// Read every managed annot back the way importManaged does.
function readManaged(doc) {
  const out = [];
  doc.getPages().forEach((pg, i) => {
    const arr = pg.node.Annots();
    if (!arr) return;
    for (let j = 0; j < arr.size(); j++) {
      const dict = doc.context.lookup(arr.get(j));
      if (!(dict instanceof PDFDict) || !dict.get(NABU_KIND)) continue;
      const parsed = JSON.parse(dict.get(NABU_DATA).decodeText());
      const raw = parsed.k === "image" ? managedSrcBytes(doc, dict) : null;
      out.push({ page: i, dict, parsed, annot: deserializeManaged(parsed, raw ? managedSrcDataUrl(raw) : null) });
    }
  });
  return out;
}

(async () => {
  // ---- 1. the fixtures themselves ---------------------------------------
  check("sniffImage recognises the PNG fixture", sniffImage(PNG_2x2), "png");
  // Guard cases for the v0.2.48 fold of `dataUrlToBytes` onto wire.js's `b64ToU8`.
  // The delegate tolerates a missing payload (test:wire pins "null → 0 bytes"), and
  // 0 bytes here means silently embedding an EMPTY image. So the adapter MUST throw.
  check("dataUrlToBytes decodes a data: URL to the exact bytes",
    [...dataUrlToBytes(pngUrl)], [...PNG_2x2]);
  check("a string with no comma throws instead of yielding 0 bytes",
    (() => { try { dataUrlToBytes("not-a-data-url"); return "no throw"; } catch (e) { return "threw"; } })(), "threw");
  check("null/undefined throw too (b64ToU8 alone would return 0 bytes)",
    [null, undefined].map((v) => { try { dataUrlToBytes(v); return "no throw"; } catch (e) { return "threw"; } }),
    ["threw", "threw"]);
  check("serializeManaged carries geometry only (no pixels)",
    Object.keys(serializeManaged(imgAnnot())).sort(), ["fmt", "h", "k", "w", "x", "y"]);

  // ---- 2. write → save → read back --------------------------------------
  let { doc, page } = await newDoc();
  check("addManagedAnnot writes an image as a real annotation",
    await addManagedAnnot(doc, page, imgAnnot(), map, new Map()), true);
  let bytes = await doc.save();

  let back = await PDFDocument.load(bytes);
  let got = readManaged(back);
  check("exactly one managed annot came back", got.length, 1);
  check("it is an editable image object", got[0].annot && got[0].annot.kind, "image");
  check("geometry survives the round-trip",
    [got[0].annot.x, got[0].annot.y, got[0].annot.w, got[0].annot.h], [40, 60, 120, 90]);
  check("the image bytes come back byte-identical",
    Buffer.compare(Buffer.from(managedSrcBytes(back, got[0].dict)), PNG_2x2), 0);
  check("the rebuilt data URL is exactly what was inserted", got[0].annot.dataUrl, pngUrl);
  check("the annot is a /Stamp with an appearance (so any viewer shows it)",
    [String(got[0].dict.get(PDFName.of("Subtype"))), !!got[0].dict.get(PDFName.of("AP"))],
    ["/Stamp", true]);
  check("Rect matches the mapped box (lower-left origin)",
    got[0].dict.get(PDFName.of("Rect")).asArray().map((n) => Math.round(n.asNumber())),
    [40, A4.height - 150, 160, A4.height - 60]);

  // ---- 3. a rotated page still flattens (unchanged behaviour) -----------
  const rot = await PDFDocument.create();
  const rotPage = rot.addPage([A4.width, A4.height]);
  rotPage.setRotation(PDFLib.degrees(90));
  check("rotated page refuses the round-trip and falls back to flatten",
    await addManagedAnnot(rot, rotPage, imgAnnot(), map, new Map()), false);

  // ---- 4. re-bake must not grow the file --------------------------------
  ({ doc, page } = await newDoc());
  await addManagedAnnot(doc, page, imgAnnot({ dataUrl: bigUrl }), map, new Map());
  const gen1 = await doc.save();
  let prev = gen1;
  for (let round = 0; round < 3; round++) {
    const d = await PDFDocument.load(prev);
    const stripped = stripManagedAnnots(d);
    check(`round ${round + 1}: the previous copy is stripped`, stripped, 1);
    // moved a bit, exactly like a user dragging it between saves
    await addManagedAnnot(d, d.getPages()[0], imgAnnot({ x: 50 + round, dataUrl: bigUrl }), map, new Map());
    prev = await d.save();
  }
  check("three re-bakes stay within 5% of the first save (no orphaned copies)",
    prev.length < gen1.length * 1.05, true);
  const finalBuf = Buffer.from(prev);
  check("only ONE copy of the image bytes is left in the file",
    finalBuf.indexOf(BIG.subarray(200, 264)) === finalBuf.lastIndexOf(BIG.subarray(200, 264)), true);
  const reread = readManaged(await PDFDocument.load(prev));
  check("and it is still editable after all that", reread.length === 1 && reread[0].annot.kind === "image", true);
  check("with the geometry from the LAST bake", reread[0].annot.x, 52);

  // ---- 5. one image on many pages is embedded once ----------------------
  const multi = await PDFDocument.create();
  const share = new Map();
  for (let i = 0; i < 5; i++) {
    const pg = multi.addPage([A4.width, A4.height]);
    await addManagedAnnot(multi, pg, imgAnnot({ id: 10 + i, dataUrl: bigUrl }), map, share);
  }
  const multiBytes = await multi.save();
  const mBack = await PDFDocument.load(multiBytes);
  const srcRefs = mBack.getPages().map((pg) => String(mBack.context.lookup(pg.node.Annots().get(0)).get(NABU_SRC)));
  check("all 5 pages point at the SAME /NabuSrc", new Set(srcRefs).size, 1);
  check("5 pages cost barely more than 1 copy of the image",
    multiBytes.length < BIG.length * 1.4, true);
  check("every page still reads back as an editable image",
    readManaged(mBack).filter((g) => g.annot && g.annot.kind === "image").length, 5);
  // The ordering trap: stripping page 1 must not free a source pages 2-5 still need.
  const stripDoc = await PDFDocument.load(multiBytes);
  check("stripping all 5 pages removes all 5", stripManagedAnnots(stripDoc), 5);
  const emptied = await stripDoc.save();
  check("and frees the shared source exactly once", emptied.length < BIG.length * 0.2, true);
  check("the emptied document still loads", (await PDFDocument.load(emptied)).getPageCount(), 5);

  // ---- 6. a foreign tool re-compressed our stream → read-only, never lost
  const tampered = await PDFDocument.load(multiBytes);
  const tamperedDict = tampered.context.lookup(tampered.getPages()[0].node.Annots().get(0));
  const srcStream = tampered.context.lookup(tamperedDict.get(NABU_SRC));
  (srcStream.dict || srcStream).set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  check("a filtered source is refused (contents are no longer the image file)",
    managedSrcBytes(tampered, tamperedDict), null);
  check("so it is NOT imported as an editable object",
    deserializeManaged({ k: "image", x: 1, y: 2, w: 3, h: 4, fmt: "png" }, null), null);
  const keptTrash = [];
  const removedOnPage1 = stripManagedFromPage(tampered, tampered.getPages()[0], keptTrash);
  freeManagedTrash(tampered, keptTrash);
  check("and stripping REFUSES to delete it (the user's image survives)", removedOnPage1, 0);
  const afterTamper = await tampered.save();
  check("the annot is still on the page after a bake",
    (await PDFDocument.load(afterTamper)).getPages()[0].node.Annots().size(), 1);

  // ---- 7. the /SMask of a transparent PNG is freed too -----------------
  const alpha = await PDFDocument.create();
  const alphaPage = alpha.addPage([A4.width, A4.height]);
  await addManagedAnnot(alpha, alphaPage, imgAnnot(), map, new Map());
  const alphaBytes = await alpha.save();
  const aDoc = await PDFDocument.load(alphaBytes);
  const aDict = aDoc.context.lookup(aDoc.getPages()[0].node.Annots().get(0));
  const chain = [];
  collectManagedChain(aDoc, aDict, aDoc.getPages()[0].node.Annots().get(0), chain);
  // src + AP form + image + annot = 4; the fixture's alpha channel adds an /SMask.
  check("the collected chain covers src, appearance, image, SMask and the annot",
    chain.length >= 4 && chain.length <= 5, true);
  const objsBefore = aDoc.context.enumerateIndirectObjects().length;
  freeManagedTrash(aDoc, chain);
  check("freeing the chain removes every object it listed",
    aDoc.context.enumerateIndirectObjects().length, objsBefore - chain.length);
  check("the document still loads with nothing dangling",
    (await PDFDocument.load(await aDoc.save())).getPageCount(), 1);

  // ---- 8. non-image managed kinds are untouched by all of this ----------
  check("a note has no /NabuSrc to look up", managedSrcBytes(aDoc, PDFDict.withContext(aDoc.context)), null);
  check("deserialize still refuses a payload with no kind", deserializeManaged({}, null), null);
  check("deserialize still refuses an image with no source", deserializeManaged({ k: "image" }, null), null);

  // ---- 9. the undo snapshot: still a deep copy, minus the base64 ----------
  // Because images round-trip, an image annot now lives in ed.annots for the whole
  // session — so every undo step used to clone its multi-MB base64. edSnapshot swaps
  // the dataUrl for a token and restores it by reference. This is the half that fails
  // SILENTLY if the reviver is wrong: images would simply vanish on Ctrl+Z.
  ed.annots = {
    0: [
      imgAnnot({ id: 1, dataUrl: bigUrl }),
      { id: 2, kind: "draw", pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#000", width: 2 },
      { id: 3, kind: "note", x: 5, y: 6, w: 18, h: 18, text: "gốc", replies: [{ text: "trả lời", ts: 1 }] },
    ],
  };
  ed.watermark = null;
  const snap = edSnapshot();
  check("the image dataUrl comes through the snapshot intact", snap.annots[0][0].dataUrl, bigUrl);
  check("the token never leaks into the restored object",
    String(snap.annots[0][0].dataUrl).startsWith(URL_TOKEN), false);
  // Mutation isolation — these three are all mutated in place by the live editor
  // (drag, freehand stroke, note reply), so sharing them would corrupt history.
  ed.annots[0][0].x = 999;
  ed.annots[0][1].pts.push({ x: 9, y: 9 });
  ed.annots[0][2].replies.push({ text: "sau", ts: 2 });
  check("geometry is a real copy", snap.annots[0][0].x, 40);
  check("freehand points are a real copy", snap.annots[0][1].pts.length, 2);
  check("note replies are a real copy", snap.annots[0][2].replies.length, 1);
  check("… and the reply objects themselves are copies", snap.annots[0][2].replies[0].text, "trả lời");
  // The point of the exercise: 60 history slots must not cost 60 copies of the photo.
  // The bound is deliberately loose (cloning would cost ~60 × 5 MB ≈ 300 MB).
  const hugeUrl = "data:image/png;base64," + crypto.randomBytes(5 * 1024 * 1024).toString("base64");
  ed.annots = { 0: [imgAnnot({ dataUrl: hugeUrl })] };
  const heap0 = process.memoryUsage().heapUsed;
  const slots = [];
  for (let i = 0; i < 60; i++) slots.push(edSnapshot());
  const grewMb = (process.memoryUsage().heapUsed - heap0) / (1024 * 1024);
  check(`60 snapshots of a 5 MB image stay far below 60 copies (grew ${grewMb.toFixed(1)} MB)`,
    grewMb < 80, true);
  check("… and every slot still holds the image", slots.every((s) => s.annots[0][0].dataUrl === hugeUrl), true);

  // ---- the module surface (BI-14: a rename here breaks editor.js silently) ----
  // editor.js calls all of these by BARE NAME out of the shared classic-script scope,
  // so a rename produces a runtime ReferenceError with no build-time warning. Pinning
  // the surface makes that a failed grid instead.
  check("managed-codec exports exactly what editor.js calls by bare name",
    Object.keys(MC).sort(),
    // NB: .sort() is by UTF-16 code unit, so "strToBytes" (capital T, 0x54) comes
    // BEFORE "stripManagedAnnots" (lowercase i, 0x69). Not a typo.
    ["MANAGED_KINDS", "NABU_DATA", "NABU_IMG", "NABU_KIND", "NABU_SRC", "P_ANNOTS",
     "collectManagedChain", "freeManagedTrash", "isManagedKind", "makeMap",
     "managedSrcBytes", "managedSrcDataUrl", "pageRotate", "pushPageAnnot",
     "serializeManaged", "sniffImage", "strToBytes", "stripManagedAnnots",
     "stripManagedFromPage"]);
  check("the /Nabu* keys are PDFName objects, not strings",
    [NABU_KIND, NABU_DATA, NABU_SRC, NABU_IMG, P_ANNOTS].map((k) => String(k)),
    ["/NabuKind", "/NabuData", "/NabuSrc", "/NabuImg", "/Annots"]);
  check("MANAGED_KINDS is the set that round-trips, and isManagedKind reads it",
    [[...MC.MANAGED_KINDS].sort(), MC.isManagedKind("image"), MC.isManagedKind("highlight")],
    [["arrow", "image", "note", "text"], true, false]);
  // Guard: the module resolves pdf-lib and wire.js/annot-text.js itself (window.PDFLib +
  // bare names in the browser, require() here). If either shim regressed, these two would
  // throw rather than return — and managedSrcDataUrl is the image round-trip's only
  // byte→base64 path (BI-24).
  check("the pushB64Chunks shim resolves under node",
    managedSrcDataUrl(PNG_2x2).startsWith("data:image/png;base64,"), true);
  check("the normTextStyle shim resolves under node (serializeManaged's text branch)",
    serializeManaged({ kind: "text", x: 1, y: 2, w: 3, h: 4, text: "a" }).lineHeight,
    normTextStyle({}).lineHeight);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
