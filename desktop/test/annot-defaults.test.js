"use strict";

/**
 * Guard for the annotation DEFAULT COLOUR (Cài đặt → Màu chú thích mặc định).
 *
 * Two failure modes, both silent, both cheap to catch here:
 *
 *  1. THREE literals have to agree — DEFAULT_ANNOT_COLOR in editor.js, the `value=` of
 *     `#ed-color` and the `value=` of `#set-annot-color` in index.html. The first is the
 *     colour the app actually draws with; the other two are what the user sees for the
 *     split second before JS writes them. Drift shows up as an edit bar that flashes the
 *     old colour, or a Settings swatch that lies about the current default — neither
 *     throws, neither shows in any other test.
 *
 *  2. colorSlotFor() decides which kinds keep their OWN colour. ✓ = đúng (green),
 *     ✗ = sai (red), tô sáng = highlighter yellow, che thông tin = black. "Simplify" it
 *     into one shared colour and a tick turns red — i.e. it starts meaning "sai" — while
 *     redaction boxes stop being black. The cases below are canh-gác cases: they are
 *     meant to FAIL if someone collapses the map.
 *
 * Runs the SHIPPING source, not a copy: the functions are cut out of renderer/editor.js
 * at run time (the `test:geom` / `test:managed` pattern), so there is no second copy to
 * drift and renaming one of them makes this test fail loudly — which is the intent.
 *
 *   node test/annot-defaults.test.js      (npm run test:defaults)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, "renderer", "editor.js"), "utf8");
const INDEX_SRC = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");

let pass = 0;
let fail = 0;
let groupName = "";

function group(name) {
  groupName = name;
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

// ---- source extraction -----------------------------------------------------

// Cut `function <name>(...) { ... }` out of a source string by bracket matching.
// Same helper shape as test/viewer-geom.test.js: it must fail loudly if the function is
// renamed rather than silently testing nothing.
function cutFunction(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`function ${name}() not found in editor.js — renamed?`);
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

// Cut a top-level `const <name> = ...;` / `const <name> = new Map([...]);` declaration.
function cutConst(src, name) {
  const re = new RegExp("^\\s*const " + name + " = ", "m");
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found in editor.js — renamed?`);
  const start = m.index + m[0].length;
  // Walk to the semicolon that closes the initialiser, tracking bracket depth so the
  // `[...]` of a Map literal doesn't end it early.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i);
  }
  throw new Error(`no terminating ; for const ${name}`);
}

// This file is strict mode, so a direct eval() of a function DECLARATION would keep the
// binding inside eval's own scope and never reach us. Wrap it in parens and eval it as an
// EXPRESSION instead, which hands the function back as a value.
function evalExpr(src) {
  // eslint-disable-next-line no-eval
  return eval("(" + src + ")");
}

const DEFAULT_ANNOT_COLOR = evalExpr(cutConst(EDITOR_SRC, "DEFAULT_ANNOT_COLOR"));
const ANNOT_COLOR_KEY = evalExpr(cutConst(EDITOR_SRC, "ANNOT_COLOR_KEY"));
const HEX6 = evalExpr(cutConst(EDITOR_SRC, "HEX6"));
const COLOR_SLOTS = evalExpr(cutConst(EDITOR_SRC, "COLOR_SLOTS"));
const colorSlotFor = evalExpr(cutFunction(EDITOR_SRC, "colorSlotFor"));

// savedAnnotColor() closes over localStorage + the two constants; inject all of them so
// the body under test is byte-for-byte the shipping one.
//
// Every name the function reads MUST be passed here. Miss one and it throws a
// ReferenceError *inside* the function's own try/catch, which returns the default — so
// the test would show "junk rejected" everywhere and look like it passed the interesting
// cases. That is why the fake store asserts the key it is handed (below).
const savedAnnotColorSrc = cutFunction(EDITOR_SRC, "savedAnnotColor");
function savedAnnotColorWith(storage) {
  // eslint-disable-next-line no-new-func
  const make = new Function(
    "localStorage",
    "HEX6",
    "DEFAULT_ANNOT_COLOR",
    "ANNOT_COLOR_KEY",
    savedAnnotColorSrc + "; return savedAnnotColor;"
  );
  return make(storage, HEX6, DEFAULT_ANNOT_COLOR, ANNOT_COLOR_KEY)();
}
// Reading any key other than ANNOT_COLOR_KEY is a bug worth failing on, not worth
// silently tolerating: it would mean the getter and the setter disagree about where the
// preference lives, so the colour would never survive a restart.
const storeWith = (v) => ({
  getItem(k) {
    if (k !== ANNOT_COLOR_KEY) throw new Error(`read the wrong key: ${k}`);
    return v;
  },
});
const throwingStore = {
  getItem() {
    throw new Error("storage disabled"); // mirrors a locked-down / quota-exceeded profile
  },
};

// Read a `value="..."` off an <input id="..."> in index.html.
function inputValue(id) {
  const re = new RegExp('<input[^>]*id="' + id + '"[^>]*>', "i");
  const tag = re.exec(INDEX_SRC);
  if (!tag) throw new Error(`<input id="${id}"> not found in index.html`);
  const v = /value="([^"]*)"/i.exec(tag[0]);
  if (!v) throw new Error(`<input id="${id}"> has no value= attribute`);
  return v[1];
}

// ---- 1. the three literals agree ------------------------------------------

group("default colour literals agree");
check(
  "DEFAULT_ANNOT_COLOR is a 6-digit lowercase hex",
  /^#[0-9a-f]{6}$/.test(DEFAULT_ANNOT_COLOR),
  DEFAULT_ANNOT_COLOR
);
check(
  "DEFAULT_ANNOT_COLOR is RED, not the old yellow #ffd54a",
  DEFAULT_ANNOT_COLOR === "#d32f2f",
  DEFAULT_ANNOT_COLOR
);
check(
  '#ed-color value= matches DEFAULT_ANNOT_COLOR',
  inputValue("ed-color").toLowerCase() === DEFAULT_ANNOT_COLOR,
  `markup ${inputValue("ed-color")} vs code ${DEFAULT_ANNOT_COLOR}`
);
check(
  '#set-annot-color value= matches DEFAULT_ANNOT_COLOR',
  inputValue("set-annot-color").toLowerCase() === DEFAULT_ANNOT_COLOR,
  `markup ${inputValue("set-annot-color")} vs code ${DEFAULT_ANNOT_COLOR}`
);
check("storage key is namespaced like the other prefs", ANNOT_COLOR_KEY === "nabu-annot-color", ANNOT_COLOR_KEY);

// ---- 2. savedAnnotColor() never returns junk ------------------------------

group("savedAnnotColor() validates on the way out of storage");
check("a stored valid hex is returned", savedAnnotColorWith(storeWith("#123abc")) === "#123abc");
check("uppercase is normalised to lowercase", savedAnnotColorWith(storeWith("#AABBCC")) === "#aabbcc");
check("absent key → default", savedAnnotColorWith(storeWith(null)) === DEFAULT_ANNOT_COLOR);
check("empty string → default", savedAnnotColorWith(storeWith("")) === DEFAULT_ANNOT_COLOR);
check('a colour NAME → default (an <input type=color> would show #000000)', savedAnnotColorWith(storeWith("red")) === DEFAULT_ANNOT_COLOR);
check("3-digit hex → default", savedAnnotColorWith(storeWith("#fff")) === DEFAULT_ANNOT_COLOR);
check("8-digit hex → default", savedAnnotColorWith(storeWith("#ffddaa80")) === DEFAULT_ANNOT_COLOR);
check("non-hex digit → default", savedAnnotColorWith(storeWith("#12345g")) === DEFAULT_ANNOT_COLOR);
check("missing # → default", savedAnnotColorWith(storeWith("d32f2f")) === DEFAULT_ANNOT_COLOR);
check("whitespace padding → default", savedAnnotColorWith(storeWith(" #d32f2f ")) === DEFAULT_ANNOT_COLOR);
check("CSS injection attempt → default", savedAnnotColorWith(storeWith("#fff;} body{display:none")) === DEFAULT_ANNOT_COLOR);
check(
  "storage that THROWS → default, not an exception (locked-down profile)",
  savedAnnotColorWith(throwingStore) === DEFAULT_ANNOT_COLOR
);

// ---- 3. colorSlotFor(): the four kinds that keep their own colour ---------
//
// CANH GÁC. These four exist because their colour is meaning, not taste. If a future
// change collapses COLOR_SLOTS into one shared colour "for simplicity", every case in
// this group fails — that is the point of writing them down.

group("colorSlotFor() keeps the four meaningful colours separate");
check('check ("đúng") has its own slot', colorSlotFor("check") === "checkColor");
check('cross ("sai") has its own slot', colorSlotFor("cross") === "crossColor");
check("highlight keeps highlighter yellow, not the shared red", colorSlotFor("highlight") === "highlightColor");
check("redact keeps its own black", colorSlotFor("redact") === "redactColor");

group("colorSlotFor() sends everything else to the shared slot");
for (const k of ["text", "arrow", "cloud", "cloudpen", "box", "ellipse", "draw", "note", "dim", "image"]) {
  check(`${k} → color`, colorSlotFor(k) === "color");
}
check("an unknown kind falls through to color", colorSlotFor("no-such-kind") === "color");
check("undefined falls through to color", colorSlotFor(undefined) === "color");
// A plain object literal would resolve "constructor"/"__proto__" through the prototype
// chain and hand back a truthy non-slot; a Map cannot. Asserted so the Map is not
// "simplified" back into an object literal.
check('"constructor" cannot leak a prototype member', colorSlotFor("constructor") === "color");
check('"__proto__" cannot leak a prototype member', colorSlotFor("__proto__") === "color");
check("COLOR_SLOTS is a Map, not an object literal", COLOR_SLOTS instanceof Map);

// ---- 4. the slots colorSlotFor names really exist on `ed` -----------------
//
// A typo'd slot name reads back `undefined` and every new object of that kind gets
// colour `undefined` — which renders as black and bakes as black. Nothing throws.

group("every slot name exists in the ed literal");
const edBlock = EDITOR_SRC.slice(EDITOR_SRC.indexOf("const ed = {"), EDITOR_SRC.indexOf("// ---- model helpers"));
const slotNames = ["color", ...COLOR_SLOTS.values()];
for (const s of slotNames) {
  check(`ed.${s} is declared`, new RegExp("^\\s*" + s + ":", "m").test(edBlock));
}
check(
  "ed.color is seeded from the stored preference, not a hard-coded literal",
  /^\s*color: savedAnnotColor\(\),/m.test(edBlock),
  "ed.color must call savedAnnotColor() or the Settings row does nothing on restart"
);
check(
  "ed.highlightColor is still the highlighter yellow",
  /^\s*highlightColor: "#ffd54a"/m.test(edBlock)
);

// ---- 4b. multi-kind creation paths go through colorSlotFor ----------------
//
// The branches that serve SEVERAL kinds must resolve the colour through the map, or a
// kind with its own slot gets the shared one. This is not hypothetical: the shape branch
// used to read `ed.tool === "redact" ? ed.redactColor : ed.color`, which would now hand
// tô sáng the shared red.
//
// Single-kind branches (arrow, dim, draw, cloudpen, text, note) legitimately read
// ed.color directly — see BI-61.

group("multi-kind creation paths resolve through colorSlotFor");
{
  const uses = (EDITOR_SRC.match(/ed\[colorSlotFor\(ed\.tool\)\]/g) || []).length;
  check(
    "both the shape branch and the symbol branch use ed[colorSlotFor(ed.tool)]",
    uses >= 2,
    `${uses} use(s)`
  );
}
{
  // The exact regression this replaced: a per-site ternary that re-spells one of the
  // four special kinds instead of asking the map.
  const offenders = EDITOR_SRC.split("\n").filter(
    (l, i) =>
      !l.trim().startsWith("//") &&
      /ed\.color/.test(l) &&
      /ed\.tool ===/.test(l) &&
      i > -1
  );
  check(
    "no creation line re-spells a special kind alongside ed.color",
    offenders.length === 0,
    offenders.join(" | ")
  );
}
{
  // Every kind that HAS its own slot must be reachable only through the map. The four
  // are created via `kind: ed.tool` in the two multi-kind branches, so what has to hold
  // is that neither branch reads the shared slot directly.
  const shapeBranch = EDITOR_SRC.slice(
    EDITOR_SRC.indexOf('if (ed.tool === "highlight"'),
    EDITOR_SRC.indexOf("if (SYMBOL_KINDS.has(ed.tool))")
  );
  check("the shape branch exists (renamed?)", shapeBranch.length > 0);
  check(
    "the shape branch never reads ed.color directly",
    !/\bed\.color\b/.test(shapeBranch.replace(/\/\/.*$/gm, "")),
    "highlight and redact would lose their own colours"
  );
}

// ---- 5. the round-trip import fallbacks were NOT retargeted --------------
//
// deserializeManaged() falls back to "#ffd54a" for an arrow/note whose /NabuData carries
// no colour. That is a property of the FILE FORMAT as shipped, not a user preference:
// point it at the new default and every such annotation in an already-saved file changes
// colour when reopened. Asserted so a later "tidy up the yellow" sweep cannot do it.

group("legacy import fallbacks stay yellow");
const deserialize = cutFunction(EDITOR_SRC, "deserializeManaged");
const fallbacks = (deserialize.match(/data\.color \|\| "#ffd54a"/g) || []).length;
check(
  "deserializeManaged still falls back to #ffd54a in 2 places (arrow + note)",
  fallbacks === 2,
  `found ${fallbacks}`
);
check(
  "deserializeManaged does NOT fall back to the new default",
  !deserialize.includes("DEFAULT_ANNOT_COLOR"),
  "an already-saved file must reopen with the colours it was saved with"
);

// ---- summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
