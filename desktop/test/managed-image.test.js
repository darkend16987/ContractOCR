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
// `rgb` is at module scope for the LIFTED hexRgb, which returns pdf-lib colour objects.
const { PDFDocument, rgb, PDFName, PDFHexString, PDFRawStream, PDFDict } = PDFLib;
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
  normAngle, apRotatable, apMatrixFor, apRectFor, shapeAppearance, isVectorKind,
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
// The shape branch of addManagedAnnot converts its colours with this; the note branch
// does too. Lifted rather than re-implemented so a change to the hex parser is felt here.
const hexRgb = lift("hexRgb");
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

  // ---- 3. a rotated page ROUND-TRIPS too (BI-59) ------------------------
  // Until BI-59 these kinds answered `false` on any /Rotate page and were flattened
  // into pixels instead — and flattening is irreversible, so a text box on a rotated
  // page (every CAD drawing; every page our own "Xoay trang" touched) was permanently
  // un-editable. The GEOMETRIC half of the fix — "does it land where the flattened
  // path put it?" — is measured in test:rotate against the shipped flatten path.
  // What this grid owns is the OBJECT half: /Matrix, /Rect, and the read-back.
  for (const rot of [90, 180, 270]) {
    const rd = await PDFDocument.create();
    const rp = rd.addPage([A4.width, A4.height]);
    rp.setRotation(PDFLib.degrees(rot));
    check(`/Rotate ${rot}: the image goes in as a real annotation`,
      await addManagedAnnot(rd, rp, imgAnnot(), map, new Map()), true);
    const rBack = await PDFDocument.load(await rd.save());
    const rGot = readManaged(rBack);
    check(`/Rotate ${rot}: it reads back as ONE editable image`,
      [rGot.length, rGot[0] && rGot[0].annot && rGot[0].annot.kind], [1, "image"]);
    check(`/Rotate ${rot}: overlay geometry survives untouched by the rotation`,
      [rGot[0].annot.x, rGot[0].annot.y, rGot[0].annot.w, rGot[0].annot.h], [40, 60, 120, 90]);
    const apRef = rBack.context.lookup(rGot[0].dict.get(PDFName.of("AP"))).get(PDFName.of("N"));
    const form = rBack.context.lookup(apRef);
    const fd = form.dict || form;
    const mtx = fd.get(PDFName.of("Matrix"));
    check(`/Rotate ${rot}: the appearance carries /Matrix = R(${rot})`,
      mtx ? mtx.asArray().map((n) => n.asNumber()) : null, apMatrixFor(rot));
    // /Rect must be exactly the bbox of Matrix × BBox. If it isn't, §12.5.5 makes the
    // viewer SCALE the appearance to fit — the stamp comes out stretched, and no test
    // that only looks at /Matrix would notice.
    const bbox = fd.get(PDFName.of("BBox")).asArray().map((n) => n.asNumber());
    const rect = rGot[0].dict.get(PDFName.of("Rect")).asArray().map((n) => n.asNumber());
    check(`/Rotate ${rot}: /BBox stays the UNrotated w×h`, [bbox[2], bbox[3]], [120, 90]);
    check(`/Rotate ${rot}: /Rect carries the rotated aspect (so the /AP map is 1:1)`,
      [+(rect[2] - rect[0]).toFixed(4), +(rect[3] - rect[1]).toFixed(4)],
      rot === 180 ? [120, 90] : [90, 120]);
    // Without this, a re-bake on a rotated page would leave two stamps.
    check(`/Rotate ${rot}: a re-bake strips the previous copy`, stripManagedAnnots(rBack), 1);
  }
  // The one case that MUST still flatten: not a quarter turn, so there is no matrix
  // that would place it right. Out of spec, but real files carry it.
  {
    const odd = await PDFDocument.create();
    const oddPage = odd.addPage([A4.width, A4.height]);
    oddPage.node.set(PDFName.of("Rotate"), PDFLib.PDFNumber.of(45));
    check("/Rotate 45 (out of spec) still falls back to flatten",
      await addManagedAnnot(odd, oddPage, imgAnnot(), map, new Map()), false);
    check("apRotatable agrees, and normalises negative angles",
      [apRotatable(0), apRotatable(-90), apRotatable(360), apRotatable(45), apRotatable(91)],
      [true, true, true, false, false]);
    check("apMatrixFor(-90) is R(270), not R(-90)", apMatrixFor(-90), apMatrixFor(270));
  }
  // 0° must be untouched by all of the above — no /Matrix key at all, so an unrotated
  // document saves the same bytes it did before BI-59 existed.
  {
    const flat0 = await PDFDocument.create();
    const p0 = flat0.addPage([A4.width, A4.height]);
    await addManagedAnnot(flat0, p0, imgAnnot(), map, new Map());
    const b0 = await PDFDocument.load(await flat0.save());
    const g0 = readManaged(b0);
    const f0 = b0.context.lookup(b0.context.lookup(g0[0].dict.get(PDFName.of("AP"))).get(PDFName.of("N")));
    check("an UNROTATED page writes NO /Matrix (bytes unchanged from before BI-59)",
      !!(f0.dict || f0).get(PDFName.of("Matrix")), false);
    check("… and apRectFor(0) is literally the old inline Rect",
      apRectFor(0, 120, 90, 40, 60), [40, 60, 160, 150]);
  }

  // ---- 3b. deleting every round-trip annot must actually REMOVE it (BI-60) ----
  // The bug a user hit at v0.2.58: make a text box → Lưu → Chú thích → Delete → the box
  // came straight back. The mechanism below was never broken; two GATES made it
  // unreachable, both asking "is there anything to ADD?" when the question had to be
  // "is there anything to CHANGE?". So this pins the mechanism by measurement, and 3c
  // pins the gates on source (exit()/bakePending() need the DOM).
  {
    const one = await PDFDocument.create();
    const op = one.addPage([A4.width, A4.height]);
    await addManagedAnnot(one, op, imgAnnot(), map, new Map());
    const withAnnot = await one.save();
    check("fixture: one managed annot is in the file", readManaged(await PDFDocument.load(withAnnot)).length, 1);
    // Exactly what bakeInPlace does when ed.annots is empty: strip, add nothing, save.
    const emptied = await PDFDocument.load(withAnnot);
    check("strip reports the one it removed", stripManagedAnnots(emptied), 1);
    const after = await emptied.save();
    const back = await PDFDocument.load(after);
    check("the annot is really gone from the saved file", readManaged(back).length, 0);
    const arr = back.getPages()[0].node.Annots();
    check("no leftover /Annots entry for a viewer to draw", arr ? arr.size() : 0, 0);
    check("and the file shrank instead of keeping the orphaned appearance",
      after.length < withAnnot.length, true);
  }

  // ---- 3c. the two gates that made 3b unreachable (BI-60) --------------------
  {
    check("exit() bakes when round-trip annots were imported, even with nothing pending",
      /if \(ed\._dirty && \(hasAny\(\) \|\| ed\._importedManaged\)\) await bakePending\(\);/.test(SRC), true);
    check("bakePending() no longer returns early on !hasAny() alone",
      /if \(!hasAny\(\) && !ed\._importedManaged\) return false;/.test(SRC), true);
    check("the close guard counts \"I deleted them all\" as an unsaved edit",
      /hasUnsaved: \(\) => ed\._dirty && \(hasAny\(\) \|\| ed\._importedManaged > 0\)/.test(SRC), true);
    check("the imported count is set at BOTH importManaged call sites",
      (SRC.match(/ed\._importedManaged = (?:n|await importManaged\(\))/g) || []).length, 2);
    check("… and cleared by reset()", /ed\._importedManaged = 0;/.test(SRC), true);
    // Emptying an existing text box must DELETE it, not be discarded as "no change".
    check("clearing an existing text box removes it",
      /if \(!text\) \{[\s\S]{0,500}?filter\(\(x\) => x\.id !== existing\.id\)/.test(SRC), true);
    check("the old silent-no-op guard is gone", /if \(text && text !== existing\.text\)/.test(SRC), false);
  }

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

  // ---- 6. box / ellipse round-trip as VECTOR appearances (v0.2.61) ----------
  //
  // The other half of the managed family. A rectangle and an oval go in as /Stamp
  // annots like text/arrow/image, but their /AP is a PATH, not a PNG — shapeAppearance()
  // in managed-codec builds it from pdf-lib's own drawRectangle / drawEllipse operator
  // generators, the same ones drawOneAnnot's flatten branch goes through.
  //
  // WHERE the ink lands is measured in test:rotate, at four rotations, against the
  // shipped flatten path. What THIS section owns is everything else:
  //   · /NabuData alone is enough to rebuild the overlay object (there is no /NabuSrc);
  //   · a stroke-only shape writes NO /Resources — the common case stays minimal;
  //   · a filled one carries its alpha in a DIRECT ExtGState, so no fourth object exists
  //     for collectManagedChain to forget about (that is BI-38's whole failure mode);
  //   · a re-bake replaces rather than duplicates, and the file does not grow.
  {
    const boxAnnot = (over) =>
      Object.assign({ id: 7, kind: "box", x: 40, y: 60, w: 120, h: 90,
                      color: "#d32f2f", width: 3 }, over);
    const ovalAnnot = (over) =>
      Object.assign({ id: 8, kind: "ellipse", x: 40, y: 60, w: 120, h: 90,
                      color: "#1565c0", width: 2 }, over);
    const apForm = (d, dict) =>
      d.context.lookup(d.context.lookup(dict.get(PDFName.of("AP"))).get(PDFName.of("N")));

    // -- the payload -------------------------------------------------------
    check("serializeManaged(box) carries geometry + style, and NO fill key when there is none",
      Object.keys(serializeManaged(boxAnnot())).sort(),
      ["color", "h", "k", "w", "width", "x", "y"]);
    check("serializeManaged(box+fill) adds exactly fill + fillOpacity",
      Object.keys(serializeManaged(boxAnnot({ fill: "#ffeb3b", fillOpacity: 0.4 }))).sort(),
      ["color", "fill", "fillOpacity", "h", "k", "w", "width", "x", "y"]);
    // `fill: "none"` is what the edit bar's "không tô" writes. It must serialise the same
    // as no fill at all, or a re-opened file would come back with a black fill.
    check("fill:\"none\" serialises as NO fill (not as the string \"none\")",
      "fill" in serializeManaged(boxAnnot({ fill: "none" })), false);

    // -- write → save → read back -----------------------------------------
    for (const [label, mk] of [["box", boxAnnot], ["ellipse", ovalAnnot]]) {
      const d = await PDFDocument.create();
      const pg = d.addPage([A4.width, A4.height]);
      check(`${label}: goes in as a real annotation`,
        await addManagedAnnot(d, pg, mk(), map, new Map()), true);
      const b = await PDFDocument.load(await d.save());
      const g = readManaged(b);
      check(`${label}: reads back as exactly one editable object of the right kind`,
        [g.length, g[0] && g[0].annot && g[0].annot.kind], [1, label]);
      check(`${label}: geometry + style survive the round-trip`,
        [g[0].annot.x, g[0].annot.y, g[0].annot.w, g[0].annot.h,
         g[0].annot.color, g[0].annot.width],
        [40, 60, 120, 90, mk().color, mk().width]);
      check(`${label}: a stroke-only shape comes back with NO fill property`,
        ["fill" in g[0].annot, "fillOpacity" in g[0].annot], [false, false]);
      check(`${label}: it is a /Stamp with an appearance (any viewer shows it)`,
        [String(g[0].dict.get(PDFName.of("Subtype"))), !!g[0].dict.get(PDFName.of("AP"))],
        ["/Stamp", true]);
      check(`${label}: it owns NO /NabuSrc (nothing rasterised, nothing to vet)`,
        !!g[0].dict.get(NABU_SRC), false);
      // The BBox must be the box GROWN by one stroke width each side. If it were the
      // bare w×h the form would CLIP the border — half a stroke always sits outside the
      // path, and a mitred corner reaches further still.
      const fd0 = apForm(b, g[0].dict);
      const bb = (fd0.dict || fd0).get(PDFName.of("BBox")).asArray().map((n) => n.asNumber());
      check(`${label}: /BBox is padded by the stroke width on every side`,
        [bb[0], bb[1], bb[2], bb[3]],
        [0, 0, 120 + 2 * mk().width, 90 + 2 * mk().width]);
      check(`${label}: a stroke-only appearance carries NO /Resources at all`,
        !!(fd0.dict || fd0).get(PDFName.of("Resources")), false);
      // At 0° the /Rect is the padded box mapped to lower-left origin, and apRectFor(0)
      // is the identity — so this is the absolute answer, not just an internally
      // consistent one. map() here is the "image" mode y-flip: y_pdf = H - y_overlay.
      const pad = mk().width;
      check(`${label}: /Rect is the padded box at the mapped anchor`,
        g[0].dict.get(PDFName.of("Rect")).asArray().map((n) => +n.asNumber().toFixed(4)),
        apRectFor(0, 120 + 2 * pad, 90 + 2 * pad, 40 - pad, A4.height - 150 - pad));
    }

    // -- a filled shape: alpha rides in a DIRECT ExtGState (BI-38) ----------
    {
      const d = await PDFDocument.create();
      const pg = d.addPage([A4.width, A4.height]);
      await addManagedAnnot(d, pg, boxAnnot({ fill: "#ffeb3b", fillOpacity: 0.4 }), map, new Map());
      const b = await PDFDocument.load(await d.save());
      const g = readManaged(b);
      check("box+fill: fill and its opacity survive the round-trip",
        [g[0].annot.fill, g[0].annot.fillOpacity], ["#ffeb3b", 0.4]);
      const fd = apForm(b, g[0].dict);
      const res = b.context.lookup((fd.dict || fd).get(PDFName.of("Resources")));
      const gsHolder = res && res.get(PDFName.of("ExtGState"));
      check("box+fill: the appearance declares an /ExtGState resource", !!gsHolder, true);
      // THE POINT OF THIS CASE. An INDIRECT ExtGState would be a registered object that
      // collectManagedChain does not walk — leaked on every single re-bake. A direct
      // dict is owned by the form and dies with it.
      check("box+fill: /ExtGState is a DIRECT dict, never an indirect ref (nothing to leak)",
        gsHolder instanceof PDFDict, true);
      const gs = b.context.lookup(gsHolder.get(PDFName.of("NabuGS")));
      check("box+fill: /NabuGS sets fill alpha (ca) and leaves stroke alpha alone",
        [gs.get(PDFName.of("ca")).asNumber(), !!gs.get(PDFName.of("CA"))], [0.4, false]);
      // A fully opaque fill needs no graphics state at all — do not pay for one.
      const d2 = await PDFDocument.create();
      const pg2 = d2.addPage([A4.width, A4.height]);
      await addManagedAnnot(d2, pg2, boxAnnot({ fill: "#ffeb3b", fillOpacity: 1 }), map, new Map());
      const b2 = await PDFDocument.load(await d2.save());
      const fd2 = apForm(b2, readManaged(b2)[0].dict);
      check("box+fill at opacity 1: no /ExtGState is written (nothing to set)",
        !!(fd2.dict || fd2).get(PDFName.of("Resources")), false);
    }

    // -- re-bake replaces, and does not grow the file (BI-38) --------------
    {
      const d = await PDFDocument.create();
      const pg = d.addPage([A4.width, A4.height]);
      await addManagedAnnot(d, pg, boxAnnot(), map, new Map());
      await addManagedAnnot(d, pg, ovalAnnot({ x: 200, y: 200 }), map, new Map());
      const once = await d.save();
      const re = await PDFDocument.load(once);
      check("two shapes on one page strip together", stripManagedAnnots(re), 2);
      check("… and nothing managed is left behind", readManaged(re).length, 0);
      const rePg = re.getPages()[0];
      await addManagedAnnot(re, rePg, boxAnnot(), map, new Map());
      await addManagedAnnot(re, rePg, ovalAnnot({ x: 200, y: 200 }), map, new Map());
      const twice = await re.save();
      check("a strip-and-rewrite does not grow the file (old appearances were freed)",
        twice.length <= once.length + 64, true);
      check("… and it still holds exactly two shapes",
        readManaged(await PDFDocument.load(twice)).length, 2);
    }

    // -- rotated pages take the same /Matrix path as every other kind (BI-59) --
    for (const rot of [90, 180, 270]) {
      const d = await PDFDocument.create();
      const pg = d.addPage([A4.width, A4.height]);
      pg.setRotation(PDFLib.degrees(rot));
      check(`box /Rotate ${rot}: still written as a real annotation`,
        await addManagedAnnot(d, pg, boxAnnot(), map, new Map()), true);
      const b = await PDFDocument.load(await d.save());
      const g = readManaged(b);
      check(`box /Rotate ${rot}: overlay geometry survives untouched by the rotation`,
        [g[0].annot.x, g[0].annot.y, g[0].annot.w, g[0].annot.h], [40, 60, 120, 90]);
      const fd = apForm(b, g[0].dict);
      const mtx = (fd.dict || fd).get(PDFName.of("Matrix"));
      check(`box /Rotate ${rot}: the appearance carries /Matrix = R(${rot})`,
        mtx ? mtx.asArray().map((n) => n.asNumber()) : null, apMatrixFor(rot));
      const rect = g[0].dict.get(PDFName.of("Rect")).asArray().map((n) => n.asNumber());
      // Padded dims: 126 × 96 at width 3. Swapped at the quarter turns, or §12.5.5 would
      // make the viewer stretch the appearance to fit.
      check(`box /Rotate ${rot}: /Rect carries the rotated aspect (so the /AP map is 1:1)`,
        [+(rect[2] - rect[0]).toFixed(4), +(rect[3] - rect[1]).toFixed(4)],
        rot === 180 ? [126, 96] : [96, 126]);
      check(`box /Rotate ${rot}: a re-bake strips the previous copy`, stripManagedAnnots(b), 1);
    }
    {
      const d = await PDFDocument.create();
      const pg = d.addPage([A4.width, A4.height]);
      pg.node.set(PDFName.of("Rotate"), PDFLib.PDFNumber.of(45));
      check("box on an out-of-spec /Rotate 45 falls back to flatten, like every other kind",
        await addManagedAnnot(d, pg, boxAnnot(), map, new Map()), false);
    }

    // -- shapeAppearance itself, as a pure function --------------------------
    // GUARD: the padding is what keeps the border out of the clip. A grid that only
    // checked "BBox exists" would stay green through a one-character regression to
    // `pad = 0`, and the symptom — a hairline shaved off all four sides — is precisely
    // the kind of thing nobody reports as a bug.
    {
      const sa = shapeAppearance({ kind: "box", w: 100, h: 50, width: 4 }, hexRgb("#000000"), null, 1);
      check("shapeAppearance pads by a full stroke width (mitred corners reach √2 halves)",
        [sa.pad, sa.wPt, sa.hPt], [4, 108, 58]);
      check("… and draws the path INSIDE that padding, not at the origin",
        sa.ops.includes("1 0 0 1 4 4 cm"), true);
      check("stroke-only emits `S` (stroke) and never `B` (fill+stroke)",
        [/\bS\b/.test(sa.ops), /\bB\b/.test(sa.ops)], [true, false]);
      const sf = shapeAppearance({ kind: "box", w: 100, h: 50, width: 4 }, hexRgb("#000000"), hexRgb("#ff0000"), 1);
      check("a filled shape emits `B`, so the fill is actually painted",
        /\bB\b/.test(sf.ops), true);
      const se = shapeAppearance({ kind: "ellipse", w: 100, h: 50, width: 2 }, hexRgb("#000000"), null, 1);
      check("the ellipse branch emits Béziers, not a rectangle path",
        [/\bc\b/.test(se.ops), /\bre\b/.test(se.ops)], [true, false]);
      // A degenerate drag (click without moving) must not produce NaN in the content
      // stream — a single NaN makes the whole page unparseable in some readers.
      const sz = shapeAppearance({ kind: "ellipse", w: 0, h: 0, width: 2 }, hexRgb("#000000"), null, 1);
      check("a zero-size shape still emits finite numbers", /NaN|Infinity/.test(sz.ops), false);
    }
  }

    // -- revision clouds: the same vector /AP, with annot-geom's own path ------
    //
    // A cloud differs from a box in exactly two ways that this grid has to pin, and both
    // are places an off-by-one-pad hides: its path is produced by annot-geom (shifted by a
    // whole scallop `bump`, not by the stroke), and a freehand one is stored as VERTICES
    // rather than a rect — so `/NabuData` must carry the polygon, and a polygon too small
    // to scallop must be refused rather than imported as an invisible ghost.
    {
      const AG = require("../renderer/annot-geom.js");
      const cloudAnnot = (over) =>
        Object.assign({ id: 9, kind: "cloud", x: 60, y: 90, w: 140, h: 80,
                        color: "#d32f2f", width: 2, bump: 12 }, over);
      const penAnnot = (over) =>
        Object.assign({ id: 10, kind: "cloudpen", color: "#d32f2f", width: 2, bump: 10,
                        closed: true,
                        pts: [{ x: 50, y: 50 }, { x: 160, y: 70 }, { x: 140, y: 170 }, { x: 45, y: 140 }] }, over);
      const apForm2 = (d, dict) =>
        d.context.lookup(d.context.lookup(dict.get(PDFName.of("AP"))).get(PDFName.of("N")));

      check("serializeManaged(cloud) carries the box + the scallop size",
        Object.keys(serializeManaged(cloudAnnot())).sort(),
        ["bump", "color", "h", "k", "w", "width", "x", "y"]);
      check("serializeManaged(cloudpen) carries the VERTICES, not a box",
        Object.keys(serializeManaged(penAnnot())).sort(),
        ["bump", "color", "pts", "width", "k"].sort());
      // A cloud drawn before the size control existed has no `bump` field at all. The
      // payload must still pin the size it was DRAWN at, or it changes shape on reopen
      // the day the default moves.
      check("a bump-less cloud serialises the resolved default, not undefined",
        serializeManaged(cloudAnnot({ bump: undefined })).bump, AG.CLOUD_BUMP);

      for (const [label, mk] of [["cloud", cloudAnnot], ["cloudpen", penAnnot]]) {
        const d = await PDFDocument.create();
        const pg = d.addPage([A4.width, A4.height]);
        check(`${label}: goes in as a real annotation`,
          await addManagedAnnot(d, pg, mk(), map, new Map()), true);
        const b = await PDFDocument.load(await d.save());
        const g = readManaged(b);
        check(`${label}: reads back as exactly one editable object of the right kind`,
          [g.length, g[0] && g[0].annot && g[0].annot.kind], [1, label]);
        check(`${label}: the scallop size survives`, g[0].annot.bump, mk().bump);
        check(`${label}: it owns NO /NabuSrc`, !!g[0].dict.get(NABU_SRC), false);
        // BBox must be annot-geom's own padded W×H grown by the STROKE. Two paddings
        // stack here and mixing them up is the whole trap: `bump` keeps the bulges
        // inside the path box, `width` keeps the border inside the /BBox.
        const geo = label === "cloud"
          ? AG.cloudPath(mk().w, mk().h, mk().bump)
          : AG.cloudPathPoly(mk().pts, mk().bump);
        const fd = apForm2(b, g[0].dict);
        const bb = (fd.dict || fd).get(PDFName.of("BBox")).asArray().map((n) => +n.asNumber().toFixed(4));
        check(`${label}: /BBox is annot-geom's padded box PLUS the stroke width`,
          bb, [0, 0, +(geo.W + 2 * mk().width).toFixed(4), +(geo.H + 2 * mk().width).toFixed(4)]);
      }

      // Geometry survives bit-for-bit — the vertices ARE the shape for a cloudpen.
      {
        const d = await PDFDocument.create();
        const pg = d.addPage([A4.width, A4.height]);
        await addManagedAnnot(d, pg, cloudAnnot(), map, new Map());
        await addManagedAnnot(d, pg, penAnnot(), map, new Map());
        const b = await PDFDocument.load(await d.save());
        const g = readManaged(b);
        const cl = g.find((x) => x.annot.kind === "cloud").annot;
        const pn = g.find((x) => x.annot.kind === "cloudpen").annot;
        check("cloud: the box survives the round-trip",
          [cl.x, cl.y, cl.w, cl.h], [60, 90, 140, 80]);
        check("cloudpen: every vertex comes back exactly", cl && pn.pts, penAnnot().pts);
        check("cloudpen: it comes back CLOSED (the only kind a file can hold)", pn.closed, true);
        check("two clouds on one page strip together", stripManagedAnnots(b), 2);
      }

      // A polygon too small to scallop. cloudPathPoly answers null, and BOTH writers have
      // to agree about that: the annot writer declines (so drawOneAnnot flattens, which
      // also draws nothing), and the reader refuses the import rather than parking an
      // invisible, unselectable object in ed.annots that the next bake would drop.
      {
        const d = await PDFDocument.create();
        const pg = d.addPage([A4.width, A4.height]);
        check("a 2-point cloudpen is declined by the annot writer (falls back to flatten)",
          await addManagedAnnot(d, pg, penAnnot({ pts: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }), map, new Map()),
          false);
        check("… and nothing was written to the page", !!pg.node.Annots(), false);
        check("deserializeManaged refuses a 2-point payload rather than making a ghost",
          deserializeManaged({ k: "cloudpen", color: "#000", width: 2, pts: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }, null),
          null);
        check("… and refuses NaN vertices too (they poison cloudPathPoly's perimeter)",
          deserializeManaged({ k: "cloudpen", color: "#000", width: 2,
                               pts: [{ x: 1, y: 1 }, { x: NaN, y: 2 }, { x: 3, y: 3 }] }, null),
          null);
      }

      // A payload with no `bump` must leave the key OFF, so bumpOf() falls back to the
      // historical default — setting it to 0 or NaN would silently make every old cloud
      // a different shape.
      check("a bump-less payload leaves `bump` unset (bumpOf falls back)",
        "bump" in deserializeManaged({ k: "cloud", x: 1, y: 2, w: 3, h: 4, color: "#000", width: 2 }, null),
        false);
    }

    // -- freehand strokes (v0.2.63): the same vector /AP, an OPEN path ----------
    //
    // What is new here and nowhere else in the family: a `draw` is the only kind whose
    // stored points are NOT what the user's object holds. Every other kind writes its
    // geometry verbatim; a stroke gains a sample per mousemove, so serializeManaged
    // thins it. That makes three things worth pinning that no earlier kind needed —
    // the path must stay OPEN (a `Z` would close a signature into a blob), the thinning
    // must be idempotent (or save→reopen→save erodes the curve a little each round),
    // and the shape must still be the one that was drawn afterwards.
    {
      const AG = require("../renderer/annot-geom.js");
      // A quarter-circle sampled the way a real drag samples it: many points, almost
      // all of them redundant.
      const arc = [];
      for (let i = 0; i <= 120; i++) {
        const t = (i / 120) * (Math.PI / 2);
        arc.push({ x: 100 + Math.cos(t) * 80, y: 300 - Math.sin(t) * 80 });
      }
      const drawAnnot = (over) =>
        Object.assign({ id: 11, kind: "draw", color: "#d32f2f", width: 3, pts: arc }, over);
      const apForm3 = (d, dict) =>
        d.context.lookup(d.context.lookup(dict.get(PDFName.of("AP"))).get(PDFName.of("N")));

      check("serializeManaged(draw) carries points and no box",
        Object.keys(serializeManaged(drawAnnot())).sort(),
        ["color", "k", "pts", "width"]);
      const ser = serializeManaged(drawAnnot());
      check("… and the points are THINNED, not the raw mousemove samples",
        [ser.pts.length < arc.length / 2, ser.pts.length >= 2], [true, true]);
      // The endpoints are the two RDP always keeps; losing either would shorten the
      // stroke, which is the failure a length-only assertion would miss.
      check("… but the first and last point are untouched",
        [ser.pts[0].x, ser.pts[0].y, ser.pts[ser.pts.length - 1].x, ser.pts[ser.pts.length - 1].y],
        [+arc[0].x.toFixed(2), +arc[0].y.toFixed(2),
         +arc[arc.length - 1].x.toFixed(2), +arc[arc.length - 1].y.toFixed(2)]);
      check("thinning is idempotent — re-saving a reopened stroke does not erode it",
        JSON.stringify(serializeManaged(drawAnnot({ pts: ser.pts })).pts), JSON.stringify(ser.pts));

      const sd = shapeAppearance(drawAnnot(), hexRgb("#d32f2f"), null, 1);
      check("the stroke /AP is an OPEN path: `S`, no fill, and no `Z`",
        [/\bS\b/.test(sd.ops), /\bB\b/.test(sd.ops), /\bh\b/.test(sd.ops)], [true, false, false]);
      // Round cap AND round join, because the flattened writer draws the same stroke as
      // independent round-capped segments. Either one missing and the two disagree.
      check("… with round caps (1 J) and round joins (1 j)",
        [/^1 J$/m.test(sd.ops), /^1 j$/m.test(sd.ops)], [true, true]);
      check("… and `1 j` is INSIDE the form's q/Q, not leaking before it",
        sd.ops.indexOf("\nq\n") < sd.ops.indexOf("\n1 j\n") || sd.ops.startsWith("q\n1 j"), true);
      check("a 1-point stroke has no path — shapeAppearance says flatten",
        shapeAppearance(drawAnnot({ pts: [{ x: 5, y: 5 }] }), hexRgb("#000000"), null, 1), null);

      {
        const d = await PDFDocument.create();
        const pg = d.addPage([A4.width, A4.height]);
        check("draw: goes in as a real annotation",
          await addManagedAnnot(d, pg, drawAnnot(), map, new Map()), true);
        const b = await PDFDocument.load(await d.save());
        const g = readManaged(b);
        check("draw: reads back as one editable stroke",
          [g.length, g[0] && g[0].annot.kind, g[0] && g[0].annot.width], [1, "draw", 3]);
        check("draw: it owns NO /NabuSrc and is never marked closed",
          [!!g[0].dict.get(NABU_SRC), !!g[0].annot.closed], [false, false]);
        // The reopened stroke must still BE the arc: its bounding box is the shape's
        // own, so a thinning bug that clipped an end would move it.
        const back = AG.strokePath(g[0].annot.pts);
        const orig = AG.strokePath(arc);
        check("draw: the reopened stroke covers the same box (within the 0.3pt tolerance)",
          [Math.abs(back.minX - orig.minX) < 0.5, Math.abs(back.minY - orig.minY) < 0.5,
           Math.abs(back.W - orig.W) < 0.5, Math.abs(back.H - orig.H) < 0.5],
          [true, true, true, true]);
        const fd = apForm3(b, g[0].dict);
        const bb = (fd.dict || fd).get(PDFName.of("BBox")).asArray().map((n) => +n.asNumber().toFixed(2));
        check("draw: /BBox is the stroke's own box grown by one full pen width each side",
          bb, [0, 0, +(back.W + 2 * 3).toFixed(2), +(back.H + 2 * 3).toFixed(2)]);
        check("draw strips like every other managed annot", stripManagedAnnots(b), 1);
      }

      // Both writers must agree that a degenerate stroke is nothing at all: the annot
      // writer declines (drawOneAnnot's `for (k = 1; ...)` then draws no segments), and
      // the reader refuses rather than parking an unselectable ghost in ed.annots.
      {
        const d = await PDFDocument.create();
        const pg = d.addPage([A4.width, A4.height]);
        check("a 1-point stroke is declined by the annot writer",
          await addManagedAnnot(d, pg, drawAnnot({ pts: [{ x: 5, y: 5 }] }), map, new Map()), false);
        check("… and nothing was written to the page", !!pg.node.Annots(), false);
        check("deserializeManaged refuses a 1-point stroke",
          deserializeManaged({ k: "draw", color: "#000", width: 2, pts: [{ x: 1, y: 1 }] }, null), null);
        check("… but ACCEPTS a 2-point one (an open line is a legitimate stroke)",
          (deserializeManaged({ k: "draw", color: "#000", width: 2,
                                pts: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }, null) || {}).kind, "draw");
        check("… and drops NaN points before the count is judged",
          deserializeManaged({ k: "draw", color: "#000", width: 2,
                               pts: [{ x: 1, y: 1 }, { x: NaN, y: 2 }] }, null), null);
      }
    }

  // ---- the module surface (BI-14: a rename here breaks editor.js silently) ----
  // editor.js calls all of these by BARE NAME out of the shared classic-script scope,
  // so a rename produces a runtime ReferenceError with no build-time warning. Pinning
  // the surface makes that a failed grid instead.
  check("managed-codec exports exactly what editor.js calls by bare name",
    Object.keys(MC).sort(),
    // NB: .sort() is by UTF-16 code unit, so "strToBytes" (capital T, 0x54) comes
    // BEFORE "stripManagedAnnots" (lowercase i, 0x69). Not a typo.
    ["MANAGED_KINDS", "NABU_DATA", "NABU_IMG", "NABU_KIND", "NABU_SRC", "P_ANNOTS",
     "VECTOR_KINDS", "apMatrixFor", "apRectFor", "apRotatable",
     "collectManagedChain", "freeManagedTrash", "isManagedKind", "isVectorKind", "makeMap",
     "managedSrcBytes", "managedSrcDataUrl", "normAngle", "pageRotate", "pushPageAnnot",
     "serializeManaged", "shapeAppearance", "sniffImage", "strToBytes",
     "stripManagedAnnots", "stripManagedFromPage"]);
  check("the /Nabu* keys are PDFName objects, not strings",
    [NABU_KIND, NABU_DATA, NABU_SRC, NABU_IMG, P_ANNOTS].map((k) => String(k)),
    ["/NabuKind", "/NabuData", "/NabuSrc", "/NabuImg", "/Annots"]);
  check("MANAGED_KINDS is the set that round-trips, and isManagedKind reads it",
    [[...MC.MANAGED_KINDS].sort(), MC.isManagedKind("image"), MC.isManagedKind("box"),
     MC.isManagedKind("ellipse"), MC.isManagedKind("cloud"), MC.isManagedKind("highlight")],
    [["arrow", "box", "cloud", "cloudpen", "draw", "ellipse", "image", "note", "text"],
     true, true, true, true, false]);
  // VECTOR_KINDS is the SUBSET whose /AP is a path instead of a PNG. It must stay a
  // strict subset: a kind outside MANAGED_KINDS would never reach shapeAppearance at all.
  check("VECTOR_KINDS is the vector subset of MANAGED_KINDS, and isVectorKind reads it",
    [[...MC.VECTOR_KINDS].sort(),
     [...MC.VECTOR_KINDS].every((k) => MC.MANAGED_KINDS.has(k)),
     MC.isVectorKind("cloudpen"), MC.isVectorKind("text"), MC.isVectorKind("image")],
    [["box", "cloud", "cloudpen", "draw", "ellipse"], true, true, false, false]);
  // Guard: the module resolves pdf-lib and wire.js/annot-text.js itself (window.PDFLib +
  // bare names in the browser, require() here). If either shim regressed, these two would
  // throw rather than return — and managedSrcDataUrl is the image round-trip's only
  // byte→base64 path (BI-24).
  check("the pushB64Chunks shim resolves under node",
    managedSrcDataUrl(PNG_2x2).startsWith("data:image/png;base64,"), true);
  check("the normTextStyle shim resolves under node (serializeManaged's text branch)",
    serializeManaged({ kind: "text", x: 1, y: 2, w: 3, h: 4, text: "a" }).lineHeight,
    normTextStyle({}).lineHeight);

  // ---- a turned text box survives the file (v0.2.63) -------------------------
  //
  // The raster half of text rotation cannot run here (renderTextPng needs a canvas —
  // see the lift() note at the top), so what this pins is the half that a canvas
  // would not catch anyway: the angle has to be IN the payload and come back off it.
  // Without that a user turns a label, saves, reopens, and the box is upright again
  // with no error anywhere — the quietest possible failure.
  {
    const txt = (over) => Object.assign(
      { kind: "text", x: 40, y: 60, w: 120, h: 20, text: "Nghiệm thu", fontSize: 14,
        color: "#d32f2f", font: "sans" }, over);
    check("serializeManaged(text) carries the angle",
      serializeManaged(txt({ rot: 45 })).rot, 45);
    check("… normalised, so a hand-edited 450 cannot reach the rasteriser",
      serializeManaged(txt({ rot: 450 })).rot, 90);
    // An upright box must serialise rot: 0 rather than omitting the key — the whole
    // payload is compared field by field on the way back in, and "absent" and "0"
    // reading differently is how a round-trip starts to drift.
    check("… and an upright box says so explicitly", serializeManaged(txt()).rot, 0);
    const back = deserializeManaged(serializeManaged(txt({ rot: -30 })), null);
    check("deserializeManaged brings the angle back on the live object", back.rot, -30);
    check("… and a payload written BEFORE rotation existed reads as upright",
      deserializeManaged({ k: "text", x: 1, y: 2, w: 3, h: 4, text: "a" }, null).rot, 0);
    // Rotation must not touch the stored box. `w`/`h` stay the UPRIGHT size; the turn
    // is applied on top by the overlay transform and by the raster. If the box were
    // re-measured to the turned bounds, every further rotation would compound and the
    // annotation would grow without limit.
    check("the stored box is the upright one, whatever the angle",
      [serializeManaged(txt({ rot: 90 })).w, serializeManaged(txt({ rot: 90 })).h], [120, 20]);

    // ---- the RASTER half, on a stub canvas -----------------------------------
    //
    // renderTextPng needs a canvas, which is why the rest of the text path is not
    // exercised in node. But the two numbers that decide WHERE a turned box lands are
    // arithmetic, not pixels, and getting either wrong slides the words off the spot
    // the user put them — silently, because the PNG still looks correct on its own.
    // So the function is lifted with a recording stub in place of the canvas and the
    // arithmetic is checked directly.
    //
    // THE INVARIANT, and it is the whole design: rotation must not move the raster's
    // CENTRE. The canvas grows to hold the turned glyphs and `ox`/`oy` give back
    // exactly half that growth, so the centre lands where the upright box's centre
    // was. Break the halving and the text drifts by a fraction of its own size — the
    // kind of error that looks like a font metric problem for an afternoon.
    {
      const A = require("../renderer/annot-text.js");
      // Bare names renderTextPng's body resolves. In the browser they come from
      // annot-text.js sharing the classic-script scope; here they have to be in scope
      // at the eval, which is why this one is not the module-level lift() — that evals
      // at module scope, where these do not exist. (`normTextStyle` and
      // `dataUrlToBytes` already do, so they are not re-bound.)
      // eslint-disable-next-line no-unused-vars
      const { textFont, layoutTextBox, rotatedBox } = A;
      // A fixed-advance stub: every glyph is 0.6em wide. Makes the expected sizes
      // arithmetic instead of font-dependent, so this grid cannot drift with Windows.
      const stubCtx = {
        font: "", _calls: [],
        measureText: (str) => ({ width: str.length * 0.6 * (parseFloat(stubCtx.font) || 1) }),
        save() {}, restore() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, scale() {},
        translate(x, y) { this._calls.push(["translate", +x.toFixed(4), +y.toFixed(4)]); },
        rotate(r) { this._calls.push(["rotate", +r.toFixed(6)]); },
      };
      const measureCtx = () => stubCtx;
      const PNG_URL = "data:image/png;base64," + PNG_2x2.toString("base64");
      let lastCanvas = null;
      global.document = {
        createElement: () => {
          lastCanvas = { width: 0, height: 0, getContext: () => stubCtx, toDataURL: () => PNG_URL };
          return lastCanvas;
        },
      };
      // eslint-disable-next-line no-eval
      const renderTextPng = eval("(" + fnSource("renderTextPng") + ")");
      try {
        const RS = 3;
        const FS = 16;
        const style = { font: "sans", fontSize: FS };
        const up = renderTextPng("Nghiem thu", FS, "#000000", style);
        check("upright: ox/oy are exactly 0, so every old call site is unchanged",
          [up.ox, up.oy], [0, 0]);
        // The canvas is the padded layout box and nothing turns it. (`_calls` also
        // holds one translate per GLYPH — the layout loop's own — so the question is
        // whether a `rotate` was issued at all, not whether the log is empty.)
        check("upright: the context is never rotated",
          stubCtx._calls.some((c) => c[0] === "rotate"), false);

        for (const deg of [90, -90, 45, 30, 180]) {
          stubCtx._calls.length = 0;
          const r = renderTextPng("Nghiem thu", FS, "#000000", Object.assign({ rot: deg }, style));
          const want = rotatedBox(up.wPt, up.hPt, deg);
          // Ceil at RS units, so the canvas can be up to 1/RS pt bigger per side.
          check(`rot ${deg}: the raster is the turned box (within the ceil)`,
            [r.wPt >= want.w - 1e-9, r.wPt < want.w + 1 / RS + 1e-9,
             r.hPt >= want.h - 1e-9, r.hPt < want.h + 1 / RS + 1e-9],
            [true, true, true, true]);
          // THE INVARIANT. Both writers place the PNG at (anchor + ox, anchor + oy)
          // with the same `anchor`, so equal centres here means equal centres on the
          // page — for the flattened path and the /AP alike.
          check(`rot ${deg}: the raster centre does not move`,
            [+(r.ox + r.wPt / 2).toFixed(6), +(r.oy + r.hPt / 2).toFixed(6)],
            [+(up.wPt / 2).toFixed(6), +(up.hPt / 2).toFixed(6)]);
          // The box grows on one axis and shrinks on the other (a quarter turn swaps
          // them), so the sign of ox/oy is not fixed. What IS fixed is that whatever
          // the change, it is split EVENLY between the two sides — all of it on one
          // side would still keep the raster the right size and still put the words in
          // the wrong place.
          check(`rot ${deg}: the size change is split evenly between both sides`,
            [+(r.ox * 2 + r.wPt).toFixed(6), +(r.oy * 2 + r.hPt).toFixed(6)],
            [+up.wPt.toFixed(6), +up.hPt.toFixed(6)]);
          // Anti-clockwise on screen = a NEGATIVE canvas rotation, the same sign the
          // watermark rasteriser uses. A flipped sign mirrors every angle and is
          // invisible at 180.
          const rot = stubCtx._calls.find((c) => c[0] === "rotate");
          check(`rot ${deg}: the canvas turns anti-clockwise`,
            rot && Math.abs(rot[1] - (-deg * Math.PI) / 180) < 1e-6, true);
          // translate → rotate → translate: to the turned canvas's centre, turn, then
          // back by HALF THE UPRIGHT BOX so the layout still draws from (0,0).
          check(`rot ${deg}: it pivots on the centre, not the corner`,
            [stubCtx._calls[0][0], stubCtx._calls[1][0], stubCtx._calls[2][0],
             +(stubCtx._calls[0][1] + stubCtx._calls[2][1]).toFixed(4),
             +(stubCtx._calls[0][2] + stubCtx._calls[2][2]).toFixed(4)],
            ["translate", "rotate", "translate",
             +((r.wPt - up.wPt) * RS / 2).toFixed(4), +((r.hPt - up.hPt) * RS / 2).toFixed(4)]);
        }
        // 360 is 0 after normRot, so it must take the untransformed path exactly.
        stubCtx._calls.length = 0;
        const full = renderTextPng("Nghiem thu", FS, "#000000", Object.assign({ rot: 360 }, style));
        check("rot 360 is upright: same raster, no rotation",
          [full.wPt, full.hPt, full.ox, full.oy, stubCtx._calls.some((c) => c[0] === "rotate")],
          [up.wPt, up.hPt, 0, 0, false]);
      } finally {
        delete global.document;
      }
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
