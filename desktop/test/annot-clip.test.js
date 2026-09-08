"use strict";

/**
 * Guard for the CROSS-TAB object clipboard (copy an annotation in one document,
 * paste it into another — v0.2.67).
 *
 * Three failure modes, all silent, none visible to any other test:
 *
 *  1. BI-77 — the paste path must stay SYNCHRONOUS. editor.js decides whether it
 *     owns Ctrl+V by calling preventDefault() during the `paste` event, off the
 *     module-level `clip`. The moment somebody "tidies" that into
 *     `await window.desktop.readAnnotClip()`, the decision arrives after the event
 *     has already bubbled to capture.js's image-paste listener: Ctrl+V then either
 *     pastes twice or not at all, depending on timing. Nothing throws. §3 of the
 *     structural group below is the only thing standing in front of that edit.
 *
 *  2. `page: -1` on an adopted clip. pasteClip nudges a paste by PASTE_STEP when it
 *     lands on the SOURCE page, so a copy is not hidden under its original. A clip
 *     from another DOCUMENT has no original here, so page 0 of document B must not
 *     be mistaken for page 0 of document A — keeping srcPage would shift every
 *     cross-document paste 12pt off the spot it was copied from. Off-by-12pt in a
 *     saved file is exactly the class of bug REGRESSION-GUARD §1 warns about.
 *
 *  3. The share filter. Images are held back on purpose (a re-opened photo is a
 *     multi-megabyte base64 string). Widen it by accident and every Ctrl+C pushes
 *     megabytes through IPC; narrow it and cross-tab paste quietly stops working
 *     for kinds that used to cross.
 *
 * Runs the SHIPPING source, not a copy: functions and consts are cut out of
 * renderer/editor.js at run time (the `test:defaults` / `test:geom` pattern), so
 * renaming one of them fails this test loudly rather than testing nothing.
 *
 *   node test/annot-clip.test.js      (npm run test:clip)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, "renderer", "editor.js"), "utf8");
const CODEC_SRC = fs.readFileSync(path.join(ROOT, "renderer", "managed-codec.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");

let pass = 0;
let fail = 0;

function group(name) {
  console.log("\n— " + name);
}
function check(what, ok, extra) {
  if (ok) {
    pass++;
    console.log("  ok   " + what);
  } else {
    fail++;
    console.log("  FAIL " + what + (extra === undefined ? "" : "  → " + extra));
  }
}

// ---- source extraction (same helpers as test:defaults) ---------------------

function cutFunction(src, name, where) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`function ${name}() not found in ${where} — renamed?`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces while cutting ${name}()`);
}

function cutConst(src, name, where) {
  const re = new RegExp("^\\s*const " + name + " = ", "m");
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found in ${where} — renamed?`);
  const start = m.index + m[0].length;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i);
  }
  throw new Error(`no terminating ; for const ${name}`);
}

function evalExpr(src) {
  // eslint-disable-next-line no-eval
  return eval("(" + src + ")");
}

// ---- 1. the share filter ---------------------------------------------------

group("1. share filter — what may cross a tab boundary");

// isShareableKind closes over MANAGED_KINDS (via isManagedKind, from managed-codec.js)
// and SHARE_EXCLUDED. Both are injected from their SHIPPING sources so this test moves
// automatically when either set is edited — which is the point: a new managed kind
// should have to be considered here, not silently inherited.
const MANAGED_KINDS = evalExpr(cutConst(CODEC_SRC, "MANAGED_KINDS", "managed-codec.js"));
const SHARE_EXCLUDED = evalExpr(cutConst(EDITOR_SRC, "SHARE_EXCLUDED", "editor.js"));
const SHARE_EXTRA = evalExpr(cutConst(EDITOR_SRC, "SHARE_EXTRA", "editor.js"));
const isShareableKind = evalExpr(
  "(function(){ const MANAGED_KINDS = arguments[0], SHARE_EXCLUDED = arguments[1], SHARE_EXTRA = arguments[2];" +
    " const isManagedKind = (k) => MANAGED_KINDS.has(k);" +
    " return " +
    cutConst(EDITOR_SRC, "isShareableKind", "editor.js") +
    "; })"
)(MANAGED_KINDS, SHARE_EXCLUDED, SHARE_EXTRA);

for (const k of ["text", "note", "arrow", "box", "ellipse", "cloud", "cloudpen", "draw"]) {
  check(`${k} crosses tabs`, isShareableKind(k) === true);
}
// The one deliberate exclusion. If this flips, every Ctrl+C on a photo starts
// pushing megabytes of base64 through IPC.
check("image is held back (payload size)", isShareableKind("image") === false);
check("SHARE_EXCLUDED is exactly {image}", SHARE_EXCLUDED.size === 1 && SHARE_EXCLUDED.has("image"), [
  ...SHARE_EXCLUDED,
].join(","));

// ✓ and ✗ cross from v0.2.69 (asked for by name: "copy dấu tích V hoặc x … file
// này sang file khác"). They are NOT managed, and that is the point of the test:
// "may this cross a tab boundary" and "does this survive a save" are two different
// questions, and the ✓ is the kind where the answers differ. A pasted ✓ is exactly
// the annotation the ✓ tool would have produced in the destination — nothing about
// the bake changes, so BI-42 is untouched.
for (const k of ["check", "cross"]) {
  check(`${k} crosses tabs (v0.2.69)`, isShareableKind(k) === true);
  check(`${k} is still NOT a managed kind (bake is unchanged)`, MANAGED_KINDS.has(k) === false);
}
check("SHARE_EXTRA is exactly {check, cross}", SHARE_EXTRA.size === 2 && SHARE_EXTRA.has("check") && SHARE_EXTRA.has("cross"), [
  ...SHARE_EXTRA,
].join(","));

// The rest of the flatten-on-bake family did NOT get an opt-in. Highlight/underline/
// strike are anchored to text runs the destination document does not have, and a
// redaction is a promise about THIS file's content — none of them mean anything
// pasted into another document, so a blanket "everything crosses" would be wrong.
for (const k of ["highlight", "under", "strike", "dim", "redact"]) {
  check(`${k} does not cross`, isShareableKind(k) === false);
}

// ---- 2. adopting a clip from another tab -----------------------------------

group("2. adoptSharedClip — page:-1 is load-bearing");

// Every name adoptSharedClip reads is injected, so the body under test is the
// byte-for-byte shipping one (see test:defaults for why this shape).
function makeAdopter() {
  return evalExpr(
    "(function(){" +
      " let clip = null; const ed = { tool: 'select' }; let syncCalls = 0;" +
      " function syncCtlVisibility(){ syncCalls++; }" +
      cutFunction(EDITOR_SRC, "adoptSharedClip", "editor.js") +
      " return { adopt: adoptSharedClip, clip: () => clip, syncCalls: () => syncCalls };" +
      "})"
  )();
}

let A = makeAdopter();
A.adopt({ items: [{ kind: "text", x: 10, y: 20 }], srcPage: 0 });
check("adopts a non-empty payload", A.clip() !== null);
check(
  "adopted clip carries page -1, NOT srcPage",
  A.clip().page === -1,
  "got " + (A.clip() && A.clip().page)
);
check("adopted clip starts with an empty cascade counter", A.clip() && !Object.keys(A.clip().dropped).length);
check("adopting repaints the palette so Dán lights up", A.syncCalls() === 1);

// The whole reason -1 was chosen: pasteClip's "don't hide under the original" branch
// is `i === clip.page`, and that must be dead for a clip that came from ANOTHER
// document — otherwise page 0 of doc B is treated as the source page of doc A.
const PAGE_RULE = "i === clip.page";
check(
  "pasteClip still keys the cascade off `" + PAGE_RULE + "`",
  EDITOR_SRC.includes(PAGE_RULE),
  "expression renamed — re-check the -1 reasoning"
);
let sameAsSource = false;
for (let i = 0; i < 5000; i++) if (i === A.clip().page) sameAsSource = true;
check("no valid page index equals -1 (cross-doc paste keeps its coordinates)", sameAsSource === false);

A = makeAdopter();
A.adopt({ items: [{ kind: "text" }], srcPage: 3 });
A.adopt(null);
check("a null broadcast clears the clip", A.clip() === null);
A.adopt({ items: [], srcPage: 0 });
check("an empty item list clears the clip (image-only copy)", A.clip() === null);

// ---- 3. BI-77 — the paste decision must stay synchronous -------------------

group("3. BI-77 structural guard — no await on the paste decision");

// The `paste` listener, located by regex so the match survives CRLF/LF and
// reformatting. An empty body here would make every check below pass VACUOUSLY,
// so the locator is asserted first and the body length is asserted with it.
const pasteRe = /document\.addEventListener\(\s*(?:async\s+)?"paste"/;
const pasteM = pasteRe.exec(EDITOR_SRC);
check("the `paste` listener is still where this test expects it", !!pasteM);
const pasteBody = pasteM ? EDITOR_SRC.slice(pasteM.index, pasteM.index + 1600) : "";
check("the located paste body is non-empty (guards against vacuous passes below)", pasteBody.length > 200);

check(
  "the paste listener is NOT async",
  !!pasteM && !/"paste",\s*async/.test(pasteBody),
  "an async listener cannot preventDefault() in time"
);
const beforePrevent = pasteBody.slice(0, pasteBody.indexOf("e.preventDefault()"));
check("nothing is awaited before preventDefault()", !/\bawait\b/.test(beforePrevent));
check(
  "the paste decision reads the local `clip`, not IPC",
  /if\s*\(!clip\)\s*return;/.test(pasteBody) && !/readAnnotClip/.test(beforePrevent)
);

// readAnnotClip is a startup-only pull. It must never appear inside pasteClip or
// requestPaste — that would reintroduce the await this whole design avoids.
for (const fn of ["pasteClip", "requestPaste"]) {
  const body = cutFunction(EDITOR_SRC, fn, "editor.js");
  check(`${fn}() never calls readAnnotClip`, !body.includes("readAnnotClip"));
}
// requestPaste is the ONE place allowed to await, and only for the WORK (entering
// Chỉnh sửa), never for the decision.
const reqBody = cutFunction(EDITOR_SRC, "requestPaste", "editor.js");
check("requestPaste re-checks ed.active after awaiting enter()", /await enter\(\)/.test(reqBody) && reqBody.lastIndexOf("!ed.active") > reqBody.indexOf("await enter()"));

// shareClip must not be awaited by its caller for the same reason (copySelected
// calls preventDefault() synchronously in the `copy` listener).
const copyBody = cutFunction(EDITOR_SRC, "copySelected", "editor.js");
check("copySelected does not await the mirror", copyBody.includes("shareClip(") && !/await\s+shareClip/.test(copyBody));

// ---- 4. the main-process mirror -------------------------------------------

group("4. main.js mirror + preload bridge");

check("main registers annots:clip-write", MAIN_SRC.includes('ipcMain.handle("annots:clip-write"'));
check("main registers annots:clip-read", MAIN_SRC.includes('ipcMain.handle("annots:clip-read"'));
check(
  "the broadcast skips the sender (it already set its clip synchronously)",
  /if \(wc === e\.sender\) continue;/.test(MAIN_SRC)
);
check(
  "an empty item list CLEARS objClip rather than leaving a stale one",
  /items && items\.length \? \{ items, srcPage: payload\.srcPage \| 0 \} : null/.test(MAIN_SRC)
);
for (const api of ["writeAnnotClip", "readAnnotClip", "onAnnotClipChanged"]) {
  check(`preload exposes ${api}`, PRELOAD_SRC.includes(api + ":"));
}
check(
  "onAnnotClipChanged returns an unsubscribe (removeListener), like the other on* bridges",
  /onAnnotClipChanged:[\s\S]{0,320}removeListener\("annots:clip-changed"/.test(PRELOAD_SRC)
);

// ---- 5. the main-process handler, actually RUN ----------------------------

group("5. annots:clip-write executed against stubs (not just grepped)");

// Cut the handler callback out of main.js and run it. The checks above only prove
// the source LOOKS right; these prove it behaves right, which is what a reader of
// §4 would otherwise have to take on trust.
function cutHandler(src, channel) {
  const at = src.indexOf(`ipcMain.handle("${channel}"`);
  if (at < 0) throw new Error(`ipcMain.handle("${channel}") not found in main.js`);
  const open = src.indexOf("(", at + `ipcMain.handle`.length - 1);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error("unbalanced parens in ipcMain.handle(" + channel + ")");
  const args = src.slice(open + 1, close);
  const comma = args.indexOf(",", args.indexOf('"', args.indexOf('"') + 1));
  return args.slice(comma + 1).trim(); // the callback expression
}

function makeMain() {
  return evalExpr(
    "(function(){" +
      " let objClip = null; const wcs = []; const sent = [];" +
      " const Tabs = { allDocContents: () => wcs };" +
      " const mkWc = (name) => { const wc = { name, send: (ch, p) => sent.push({ to: name, ch, p }) }; wcs.push(wc); return wc; };" +
      " const handler = " +
      cutHandler(MAIN_SRC, "annots:clip-write") +
      ";" +
      " return { handler, mkWc, sent, clip: () => objClip };" +
      "})"
  )();
}

let M = makeMain();
const wcA = M.mkWc("A");
M.mkWc("B");
M.mkWc("C");
let res = M.handler({ sender: wcA }, { items: [{ kind: "text", x: 5 }], srcPage: 2 });
check("write returns ok", res && res.ok === true, JSON.stringify(res));
check("objClip holds the items", !!M.clip() && M.clip().items.length === 1);
check("objClip records srcPage", M.clip() && M.clip().srcPage === 2);
check("broadcast reached exactly the two NON-sender tabs", M.sent.length === 2, JSON.stringify(M.sent.map((s) => s.to)));
check("the sender was skipped", !M.sent.some((s) => s.to === "A"));
check("broadcast channel is annots:clip-changed", M.sent.every((s) => s.ch === "annots:clip-changed"));

// An image-only copy arrives as an empty list and must CLEAR, not be ignored.
M.sent.length = 0;
res = M.handler({ sender: wcA }, { items: [], srcPage: 0 });
check("an empty list clears objClip", M.clip() === null);
check("the clear is broadcast as null so other tabs grey out Dán", M.sent.length === 2 && M.sent.every((s) => s.p === null));

// A malformed payload must not throw across the IPC boundary.
M = makeMain();
M.mkWc("A");
for (const bad of [null, undefined, {}, { items: "nope" }, { items: null }]) {
  let threw = false;
  try {
    M.handler({ sender: {} }, bad);
  } catch (_) {
    threw = true;
  }
  check("malformed payload " + JSON.stringify(bad) + " does not throw", !threw);
}
check("objClip stays null after malformed payloads", M.clip() === null);

// ---- summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
