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

// ---- 4a. the FILL slots (v0.2.64) -----------------------------------------
//
// Exactly the same failure as a typo'd colour slot, one step quieter: a missing fill slot
// reads `undefined`, `ed[slot.on]` is falsy, and the background silently never appears —
// the control moves, nothing happens, and no other test notices. The text box keeps its
// OWN slot so that switching between Hộp văn bản and Khung chữ nhật does not carry a
// white wash across; collapsing the two back into one is a canh-gác failure here.

group("the fill slots exist and the text box keeps its own");
for (const s of ["fillColor", "fillOn", "fillOpacity",
                 "textFillColor", "textFillOn", "textFillOpacity"]) {
  check(`ed.${s} is declared`, new RegExp("^\\s*" + s + ":", "m").test(edBlock));
}
check(
  "a NEW text box has no background — an old document must not repaint itself",
  /^\s*textFillOn: false,/m.test(edBlock),
  "textFillOn must default to false"
);
check(
  "shapes still default to a transparent interior",
  /^\s*fillOn: false,/m.test(edBlock)
);
check(
  "FILL_SLOTS gives `text` its own slot (not the shared one)",
  /FILL_SLOTS = new Map\(\[\s*\n\s*\["text",\s*\{ color: "textFillColor", on: "textFillOn", opacity: "textFillOpacity" \}\],/.test(
    EDITOR_SRC
  ),
  "the text row of FILL_SLOTS was renamed or removed"
);
check(
  "FILLABLE_KINDS includes text (or the Nền controls never show for a text box)",
  /const FILLABLE_KINDS = new Set\(\[[^\]]*"text"[^\]]*\]\)/.test(EDITOR_SRC)
);
// The vector /AP path must NOT grow a text arm: isVectorKind routes to shapeAppearance,
// and a text box's wash is painted into its raster PNG instead.
check(
  "FILLABLE_KINDS is NOT wired into isVectorKind",
  !/VECTOR_KINDS[^\n]*"text"/.test(
    require("fs").readFileSync(require("path").join(ROOT, "renderer", "managed-codec.js"), "utf8")
  )
);
{
  // The three #ed-fill* handlers must resolve their slot through fillSlotFor, or the
  // text box writes the rectangle's memory again and the split is undone.
  const uses = (EDITOR_SRC.match(/fillSlotFor\(fillCtlKind\(\)\)/g) || []).length;
  check(
    "all three fill handlers resolve through fillSlotFor(fillCtlKind())",
    uses >= 3,
    `${uses} use(s)`
  );
}

// ---- 4a-bis. the fill controls must stay USABLE mid-typing (v0.2.65) -------
//
// v0.2.64 shipped the background correct and unverifiable. Everything below is a
// canh-gác case for the four reasons it felt broken on the FIRST run — each one silent,
// each one invisible to every other test in the repo:
//
//  F1 the three Nền controls are ordinary <input>s, so mousedown on them blurred the
//     inline textarea, `commit()` ran, and the box was created with the background from
//     BEFORE the change. The value only reached the NEXT box.
//  F2 nothing painted the wash on the textarea, and app.css gives it a near-opaque white
//     — so "trong suốt" and "trắng 30%" both looked like solid white while typing.
//  F3 syncControls only pushed a colour into #ed-fill when the annot HAD one, so
//     unticking the tick handed back the slot colour, not the one on display.
//  F4 no composite preview: <input type=color> shows the hue with no alpha.
//
// The mousedown-preventDefault trick the B/I/U buttons use is NOT the fix and must not be
// "restored" here: on a range input it kills the drag, on a colour input it can stop the
// picker opening. The blur handler is where this belongs.

group("the Nền controls survive an open text editor (v0.2.65)");
check(
  "F1 · the textarea's blur does NOT commit when focus moves into the palette",
  /ta\.addEventListener\("blur",\s*\(e\)\s*=>\s*\{\s*\n\s*if \(inPalette\(e\.relatedTarget\)\) return;/.test(EDITOR_SRC),
  "a bare `blur -> commit` is back: picking a background commits the box with the OLD one"
);
check(
  "F1 · the palette selector spares #ed-tools / Copy / Dán / Áp dụng",
  /PALETTE_KEEP_SEL = "#edit-bar \[data-ctl\], #fmt-panel"/.test(EDITOR_SRC),
  'widening this to "#edit-bar" loses the typing on every tool change (#ed-tools is INSIDE #edit-bar)'
);
check(
  "F1 · renderLayer carries an open inline editor across the innerHTML wipe (BI-75)",
  /const keep = layer\.querySelector\("\.annot-text-edit, \.annot-note-panel"\);[\s\S]{0,400}?layer\.innerHTML = "";[\s\S]{0,400}?layer\.appendChild\(keep\)/.test(
    EDITOR_SRC
  ),
  "without this, any syncOverlays() from a palette control deletes the words being typed — no blur, no undo, no error"
);
check(
  "F1 · … and restores the caret, not just the focus",
  /setSelectionRange\(caret\[0\], caret\[1\]\)/.test(EDITOR_SRC),
  "focus() alone drops the caret to the end of the text"
);
check(
  "F1 · the Nền controls target the box being retyped, not a stale selection",
  /function fillTargetAnnot\(\)[\s\S]{0,600}?if \(ed\._taCommit\) return ed\._taAnnot \|\| null;/.test(EDITOR_SRC),
  "openTextEditor does not select the box it opens, so ed.sel is either null or a DIFFERENT object"
);
check(
  "F1 · applyFillToSel refuses a target whose kind is not the one on display",
  /if \(a\.kind !== kind\) return;/.test(EDITOR_SRC),
  "a rectangle left selected under the Hộp văn bản tool used to eat an undo step per slider move"
);
check(
  "F2 · the inline textarea previews the background",
  /function taFillPreview\(/.test(EDITOR_SRC) && /taFillPreview\(ta, existing\)/.test(EDITOR_SRC),
  "colour + opacity go back to being unverifiable until the box is committed"
);
check(
  "F2 · the repaint RE-READS its source (a snapshot taken at open would freeze)",
  /const paint = \(\) => \{[\s\S]{0,500}?taFillPreview\(ta, existing\);\s*\n\s*\};/.test(EDITOR_SRC) &&
    /ed\._taPreview = paint;/.test(EDITOR_SRC),
  "hoisting fs/st out of paint() puts the open-time values back and the preview stops tracking the palette"
);
check(
  "F2 · no fill ⇒ the inline background is CLEARED, not painted transparent",
  /ta\.style\.background = on \? hexToRgba\([\s\S]{0,80}?\) : "";/.test(EDITOR_SRC),
  'a truly see-through field over dark artwork is a box you cannot read your own typing in — app.css\'s white has to stand'
);
check(
  "F2 · the preview is NOT pre-multiplied by the text opacity",
  !/taFillPreview[\s\S]{0,700}?\*\s*(s\.opacity|st\.opacity|ed\.textOpacity)/.test(EDITOR_SRC),
  "the element already carries opacity (applyTextCss); multiplying again makes the preview darker than the result"
);
check(
  "F3 · syncControls falls back to the slot colour when the annot has no fill",
  /\$\("ed-fill"\)\.value = none \? ed\[fillSlotFor\(a\.kind\)\.color\] : a\.fill;/.test(EDITOR_SRC),
  "`if (!none)` is back: the swatch shows one colour and effFill hands back another"
);
check(
  "F4 · the composite preview chip exists in the markup, inside the fill row",
  /data-ctl="fill"[^\n]*id="ed-fill-swatch"[^\n]*>\s*<i><\/i>/.test(INDEX_SRC),
  "the chip must live in a data-ctl=fill label or it stays visible for kinds with no fill"
);
check(
  "F4 · the chip reads the CONTROLS, not ed.* — one source of truth",
  /function refreshFillSwatch\(\)[\s\S]{0,600}?\$\("ed-fill-none"\)\.checked[\s\S]{0,300}?\$\("ed-fill"\)\.value/.test(
    EDITOR_SRC
  ),
  "reading ed.* lets the chip disagree with the numbers printed beside it"
);
{
  // Three repaint sites: the tool change, the selection change, and any palette move.
  // Miss one and the chip goes stale exactly when it matters.
  const uses = (EDITOR_SRC.match(/refreshFillSwatch\(\);/g) || []).length;
  check("F4 · refreshFillSwatch is called from every place the controls change", uses >= 4, `${uses} call(s)`);
}
check(
  "the palette repaint is ONE delegated listener, not a call per handler",
  /document\.querySelectorAll\("#edit-bar, #fmt-panel"\)\.forEach/.test(EDITOR_SRC),
  "twenty handlers each remembering to repaint is the drift FILLABLE_KINDS exists to prevent"
);
check(
  "the caret is handed back on `change`, never on `input`",
  /if \(evt === "change" && ed\._taFocus\) ed\._taFocus\(\);/.test(EDITOR_SRC),
  "refocusing on `input` fights a slider drag for the mouse"
);
check(
  "all four inline-editor hooks are cleared together",
  /function clearTaHooks\(\)[\s\S]{0,300}?_taCommit = null;[\s\S]{0,200}?_taAnnot = null;[\s\S]{0,200}?_taPreview = null;[\s\S]{0,200}?_taFocus = null;/.test(
    EDITOR_SRC
  ),
  "a stale _taAnnot silently redirects the Nền controls at a box nobody is editing"
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

// ---- 4c. the three background handlers, driven for real (BI-76) ------------
//
// WHY THIS EXISTS. Through v0.2.65 the three #ed-fill* controls were inline arrow bodies
// nobody could call from a test, and they carried two silent bugs no other grid could
// see — both of them "the toolbar shows one thing, the object gets another":
//
//   A. applyFillToSel() rebuilt the fill from `ed[slot]` via effFill() (the defaults for
//      the NEXT object) instead of from the controls (the object's own background).
//      syncControls() only ever writes the DOM, so ticking and un-ticking the tick on a
//      yellow-40% rectangle brought it back WHITE-100% while both controls still showed
//      yellow 40%. Silent data loss.
//   B. dragging Mờ nền to 0% left the tick CLEAR, so the object carried an invisible wash
//      while the control read "has a background" — which is why the tick looked like a
//      duplicate of the slider and did nothing anybody could name.
//
// So the handlers are named functions now, and this section RUNS them against a fake DOM
// and a fake target. Every case below is a state the user can reach by hand.

group("the three background handlers (BI-76)");
{
  const FILL_SLOTS_DECL = "const FILL_SLOTS = " + cutConst(EDITOR_SRC, "FILL_SLOTS") + ";\n";
  const SHAPE_FILL_SLOT = evalExpr(cutConst(EDITOR_SRC, "SHAPE_FILL_SLOT"));
  const FILLABLE_KINDS = evalExpr(cutConst(EDITOR_SRC, "FILLABLE_KINDS"));
  const FILL_ON_FROM_ZERO_PCT = evalExpr(cutConst(EDITOR_SRC, "FILL_ON_FROM_ZERO_PCT"));
  check(
    "FILL_ON_FROM_ZERO_PCT is a VISIBLE percentage — raising to 0 would fix nothing",
    FILL_ON_FROM_ZERO_PCT > 0 && FILL_ON_FROM_ZERO_PCT <= 100,
    String(FILL_ON_FROM_ZERO_PCT)
  );

  // Every function the handlers reach, cut from the SHIPPING source. Renaming any one of
  // them fails loudly here rather than quietly testing nothing.
  const BODY = [
    "clampFillPct", "setFillPctCtl", "setFillOn", "fillFromCtls",
    "fillTargetAnnot", "applyFillToSel",
    "onFillColorInput", "onFillNoneToggle", "onFillOpacityInput",
    "fillCtlKind", "fillSlotFor",
  ].map((n) => cutFunction(EDITOR_SRC, n)).join("\n");

  // One rig per case: a fake DOM for the three controls plus the readout, a fake target,
  // and the `ed` fields the handlers touch. `$` THROWS on an unexpected id, so a handler
  // that starts reaching for some other control fails here instead of passing quietly.
  // Note the chip (#ed-fill-swatch) is deliberately absent: repainting it is the delegated
  // #edit-bar listener's job, and a handler that took it over would trip this.
  function rig(opts) {
    const o = opts || {};
    const dom = {
      "ed-fill": { value: o.ctlColor || "#ffffff" },
      "ed-fill-none": { checked: o.ctlNone !== undefined ? o.ctlNone : true },
      "ed-fill-opacity": { value: String(o.ctlPct !== undefined ? o.ctlPct : 100) },
      "ed-fill-opacity-val": { textContent: "" },
    };
    const $ = (id) => {
      if (!dom[id]) throw new Error("the handlers touched an unexpected control: #" + id);
      return dom[id];
    };
    const target = o.target || null;
    const ed = Object.assign({
      tool: o.tool || "select",
      sel: target ? target.id : null,
      _taCommit: null,
      _taAnnot: null,
      fillColor: "#ffffff", fillOn: false, fillOpacity: 1,
      textFillColor: "#ffffff", textFillOn: false, textFillOpacity: 0.8,
    }, o.ed || {});
    const undos = [];
    const findAnnot = (id) => (target && target.id === id ? { page: 0, a: target } : null);
    const make = new Function(
      "$", "ed", "findAnnot", "pushEdUndo", "syncOverlays",
      "FILLABLE_KINDS", "SHAPE_FILL_SLOT", "FILL_ON_FROM_ZERO_PCT",
      FILL_SLOTS_DECL + BODY +
      "; return { onFillColorInput, onFillNoneToggle, onFillOpacityInput };"
    );
    const api = make(
      $, ed, findAnnot, (t) => undos.push(t), () => {},
      FILLABLE_KINDS, SHAPE_FILL_SLOT, FILL_ON_FROM_ZERO_PCT
    );
    return Object.assign(
      { dom, ed, a: target, undos, pct: () => +dom["ed-fill-opacity"].value },
      api
    );
  }
  const rect = (over) =>
    Object.assign({ id: 1, kind: "box", fill: "#ffeb3b", fillOpacity: 0.4 }, over);

  // ---- A. the tick is a MUTE button: off and back on loses nothing ----------
  {
    // The state syncControls() leaves behind after clicking that rectangle: the controls
    // show the OBJECT's yellow 40%, while ed.fill* still hold the white-100% defaults.
    const r = rig({ target: rect(), ctlColor: "#ffeb3b", ctlNone: false, ctlPct: 40 });
    r.onFillNoneToggle(true);
    check('tick ⇒ the object goes to fill:"none"', r.a.fill === "none", r.a.fill);
    check("tick ⇒ the opacity it had is KEPT (there is nothing else to restore from)",
      r.a.fillOpacity === 0.4, String(r.a.fillOpacity));
    r.onFillNoneToggle(false);
    check("untick ⇒ the object's OWN colour comes back, not the remembered white",
      r.a.fill === "#ffeb3b", r.a.fill);
    check("untick ⇒ the object's OWN opacity comes back, not the remembered 100%",
      r.a.fillOpacity === 0.4, String(r.a.fillOpacity));
    check("… and the controls still agree with what the object has (no lying toolbar)",
      r.dom["ed-fill"].value === "#ffeb3b" && r.pct() === 40 &&
      r.dom["ed-fill-none"].checked === false);
    check("a tick and an untick are two undo steps, not zero", r.undos.length === 2,
      String(r.undos.length));
  }
  // CANH GÁC for bug A: the values written to the target must come from the CONTROLS.
  // Point applyFillToSel back at effFill()/ed[slot] and this fails. Comments stripped
  // first — the block deliberately NAMES effFill to say where it does still belong.
  {
    const applyCode = cutFunction(EDITOR_SRC, "applyFillToSel").replace(/\/\/.*$/gm, "");
    check("applyFillToSel() reads the controls (fillFromCtls), not the remembered slot",
      /fillFromCtls\(\)/.test(applyCode) && !/effFill/.test(applyCode),
      "reading ed[slot] here IS bug A");
    // effFill/effFillOpacity must SURVIVE, on the create paths: `ed[slot]` really is the
    // answer for an object that does not exist yet. Deleting them "because the handlers
    // stopped using them" would leave every new shape with no background at all.
    const creates = (EDITOR_SRC.match(/effFill\(/g) || []).length;
    check("effFill() is still wired into the create paths", creates >= 3, `${creates} use(s)`);
  }
  // The OTHER direction — target → controls. syncControls reads ~30 controls, so a full
  // rig costs more than it proves; what matters is pinned on the source, the pattern
  // find-replace.js and page-move.js use for their DOM halves.
  {
    const at = cutFunction(EDITOR_SRC, "syncControls").indexOf("FILLABLE_KINDS.has(a.kind)");
    check("syncControls() still has a FILLABLE_KINDS branch (renamed?)", at > 0);
    const branch = cutFunction(EDITOR_SRC, "syncControls").slice(at);
    check("syncControls ticks for a 0% wash too, so the two controls agree on sight",
      /clampFillPct\([\s\S]*?\) === 0/.test(branch),
      "otherwise selecting a 0% object shows the tick clear next to a 0% slider");
    check("syncControls pushes the percentage through setFillPctCtl (one writer only)",
      /setFillPctCtl\(/.test(branch));
  }

  // ---- B. 0% and the tick are ONE state, never two -------------------------
  {
    const r = rig({ tool: "box", target: rect(), ctlColor: "#ffeb3b", ctlNone: false, ctlPct: 40 });
    r.onFillOpacityInput(0);
    check("slider → 0% ticks the box (0% IS no background)",
      r.dom["ed-fill-none"].checked === true);
    check("slider → 0% turns the remembered slot off too", r.ed.fillOn === false);
    check('slider → 0% ⇒ the object gets fill:"none", not an invisible wash',
      r.a.fill === "none", r.a.fill);
    check("the readout follows the slider",
      r.dom["ed-fill-opacity-val"].textContent === "0%",
      r.dom["ed-fill-opacity-val"].textContent);
    r.onFillOpacityInput(40);
    check("slider back above 0 clears the tick", r.dom["ed-fill-none"].checked === false);
    check("… and is NOT bumped to 100 by the from-zero rule", r.pct() === 40, String(r.pct()));
    check("… and the object is filled again at exactly that value",
      r.a.fill === "#ffeb3b" && r.a.fillOpacity === 0.4);
  }
  {
    // Untick with the slider sitting at 0 — reachable by dragging to 0 and changing your
    // mind, and from a file a build saved with a fill colour and fillOpacity 0.
    const r = rig({ tool: "box", target: rect({ fill: "none", fillOpacity: 0 }),
                    ctlColor: "#00c853", ctlNone: true, ctlPct: 0 });
    r.onFillNoneToggle(false);
    check("untick at 0% raises the slider so the background is VISIBLE",
      r.pct() === FILL_ON_FROM_ZERO_PCT, String(r.pct()));
    check("… and the object really gets that opacity",
      r.a.fillOpacity === FILL_ON_FROM_ZERO_PCT / 100, String(r.a.fillOpacity));
    check("… with the colour the swatch was showing", r.a.fill === "#00c853", r.a.fill);
  }
  {
    // The same rule through the colour swatch: picking a colour at 0% must not paint nothing.
    const r = rig({ tool: "box", target: rect({ fill: "none", fillOpacity: 0 }),
                    ctlNone: true, ctlPct: 0 });
    r.onFillColorInput("#2962ff");
    check("picking a colour at 0% raises the slider as well", r.pct() === FILL_ON_FROM_ZERO_PCT);
    check("picking a colour clears the tick", r.dom["ed-fill-none"].checked === false);
    check("… and the object shows it", r.a.fill === "#2962ff" &&
      r.a.fillOpacity === FILL_ON_FROM_ZERO_PCT / 100);
  }
  {
    // THE SIDE DOOR. Remember 0% (so ed.fillOpacity is 0), then work on another object
    // that sits at 70%: the slider is no longer at zero, so the DOM raise must not fire —
    // but the REMEMBERED zero is still there, and the next new rectangle would come out
    // invisible with the tick clear. Each zero has to be cleared on its own.
    const r = rig({ tool: "box", target: rect({ fillOpacity: 0.7 }),
                    ctlColor: "#ffeb3b", ctlNone: false, ctlPct: 70, ed: { fillOpacity: 0 } });
    r.onFillNoneToggle(true);
    r.onFillNoneToggle(false);
    check("un-ticking clears the REMEMBERED zero, so the NEXT object is visible",
      r.ed.fillOn === true && r.ed.fillOpacity > 0,
      "on=" + r.ed.fillOn + " op=" + r.ed.fillOpacity);
    check("… without repainting the object on screen away from its own 70%",
      r.a.fillOpacity === 0.7 && r.pct() === 70, String(r.a.fillOpacity));
  }
  // CANH GÁC: no handler may leave "background on" together with "opacity 0" — that pair
  // IS the invisible-but-ticked lie, whichever door it arrives through.
  {
    const bad = [];
    for (const startPct of [0, 40, 100]) {
      for (const startOn of [false, true]) {
        for (const act of ["none-off", "none-on", "colour", "op0", "op1", "op100"]) {
          const r = rig({ tool: "box", ctlNone: !startOn, ctlPct: startPct,
                          ed: { fillOn: startOn, fillOpacity: startPct / 100 } });
          if (act === "none-off") r.onFillNoneToggle(true);
          else if (act === "none-on") r.onFillNoneToggle(false);
          else if (act === "colour") r.onFillColorInput("#123456");
          else if (act === "op0") r.onFillOpacityInput(0);
          else if (act === "op1") r.onFillOpacityInput(1);
          else r.onFillOpacityInput(100);
          const domLies = r.dom["ed-fill-none"].checked === false && r.pct() === 0;
          const edLies = r.ed.fillOn === true && !r.ed.fillOpacity;
          if (domLies || edLies) bad.push(startPct + "%/on=" + startOn + "/" + act);
        }
      }
    }
    check('no reachable action leaves "has a background" sitting at 0% opacity',
      bad.length === 0, bad.join(" | "));
  }

  // ---- C. the target, and the guards v0.2.65 put around it ----------------
  {
    // A rectangle left selected under the Hộp văn bản tool: the controls show the TEXT
    // slot, so it is NOT a target. Writing to it would be an undo step and a dirty
    // session for a change the user cannot see (v0.2.65's `a.kind !== kind` guard).
    const r = rig({ tool: "text", target: rect(), ctlColor: "#ffeb3b", ctlNone: false, ctlPct: 40 });
    r.onFillOpacityInput(55);
    check("a target whose kind is not the one on display is left alone",
      r.a.fill === "#ffeb3b" && r.a.fillOpacity === 0.4);
    check("… and costs no undo step", r.undos.length === 0, String(r.undos.length));
    check("… while the TEXT slot still moves, ready for the next box", r.ed.textFillOpacity === 0.55);
  }
  {
    // The inline editor OWNS the controls: openTextEditor does not select the box it
    // opens, so `ed.sel` stays null and only `_taAnnot` names the target.
    const box = { id: 9, kind: "text", fill: "none", fillOpacity: 1 };
    const r = rig({ tool: "text", ctlColor: "#fff59d", ctlNone: true, ctlPct: 60,
                    ed: { _taCommit: () => {}, _taAnnot: box } });
    r.onFillNoneToggle(false);
    check("the box being retyped is the target even with nothing selected",
      box.fill === "#fff59d" && box.fillOpacity === 0.6);
    check("… and the undo step is keyed on THAT box's id", r.undos[0] === "fill:9", r.undos[0]);
  }
  {
    // A brand-new box does not exist yet: nothing to write to, and nothing may throw.
    const r = rig({ tool: "text", ctlNone: true, ctlPct: 80, ed: { _taCommit: () => {} } });
    r.onFillColorInput("#e0f7fa");
    check("a box that does not exist yet only moves the default, no undo step",
      r.ed.textFillColor === "#e0f7fa" && r.ed.textFillOn === true && r.undos.length === 0);
  }

  // ---- D. the two remembered slots stay separate through the handlers ------
  {
    const r = rig({ tool: "text", ctlPct: 80 });
    r.onFillColorInput("#e0f7fa");
    check("under the text tool the colour lands in textFillColor",
      r.ed.textFillColor === "#e0f7fa" && r.ed.fillColor === "#ffffff");
    check("… and so does the ON flag", r.ed.textFillOn === true && r.ed.fillOn === false);
    const r2 = rig({ tool: "box", ctlPct: 100 });
    r2.onFillOpacityInput(35);
    check("under the rectangle tool the opacity lands in fillOpacity",
      r2.ed.fillOpacity === 0.35 && r2.ed.textFillOpacity === 0.8);
  }
  {
    // Under Select the slot follows the SELECTED object's kind, not `ed.tool`.
    const r = rig({ tool: "select",
                    target: { id: 7, kind: "text", fill: "none", fillOpacity: 1 }, ctlPct: 80 });
    r.onFillColorInput("#fff59d");
    check("Select + a text box ⇒ the TEXT slot is the one written",
      r.ed.textFillColor === "#fff59d" && r.ed.fillColor === "#ffffff");
  }

  // ---- E. the percentage clamp --------------------------------------------
  {
    const r = rig({ tool: "box", ctlPct: 50 });
    const at = (v) => { r.onFillOpacityInput(v); return r.pct(); };
    check("above 100 clamps to 100", at(140) === 100);
    check("below 0 clamps to 0", at(-5) === 0);
    check("a fractional value rounds, it does not floor away to 0", at(0.6) === 1);
    check("junk reads as 0, not NaN%", at("abc") === 0);
  }
}

// ---- 4d. the tick's markup and the i18n dictionary agree ------------------
//
// i18n.js registers a text node or a title ONLY on an exact dictionary match (see
// buildRegistry), so a one-character drift between index.html and the VI key is not an
// error — it is an English-mode UI that silently keeps showing Vietnamese. Nothing else
// in the repo notices. Same reason section 1 pins the three colour literals.

group("the background controls' labels are translatable");
{
  const I18N_SRC = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
  const hasViKey = (s) => I18N_SRC.includes('"' + s + '":');

  // The tick's own <label>: its text node is what i18n swaps, so it has to match a key
  // byte for byte, trimmed.
  const tick = /<label[^>]*>\s*<input type="checkbox" id="ed-fill-none"[^>]*\/>\s*([^<]*)<\/label>/
    .exec(INDEX_SRC);
  check("the #ed-fill-none label is still shaped <input …/> text</label>", !!tick);
  if (tick) {
    const label = tick[1].trim();
    check('the tick reads "Không nền", not the old "Trong suốt"', label === "Không nền", label);
    check("… and that exact string is in the i18n dictionary", hasViKey(label), label);
  }
  for (const id of ["ed-fill", "ed-fill-none", "ed-fill-opacity"]) {
    const tag = new RegExp('<label[^>]*title="([^"]*)"[^>]*>(?:[^<]*)<input[^>]*id="' + id + '"', "i")
      .exec(INDEX_SRC);
    check(`#${id} still sits in a titled <label>`, !!tag, id);
    if (tag) check("… and its tooltip is translatable", hasViKey(tag[1]), tag[1]);
  }
  // The word the rename was about: "Trong suốt" read as a LEVEL of Mờ nền, which is why
  // the tick looked like a duplicate of the slider. It must not creep back into the bar.
  const from = INDEX_SRC.indexOf('id="edit-bar"');
  const to = INDEX_SRC.indexOf('id="wm-modal"');
  check("the edit bar could be located in index.html", from > 0 && to > from);
  check('no control in the edit bar is labelled "Trong suốt" any more',
    !/Trong suốt/.test(INDEX_SRC.slice(from, to)));
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
