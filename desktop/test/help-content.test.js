"use strict";

/*
 * Grid for renderer/help.js — the Hướng dẫn sử dụng content table.
 *
 * WHY THIS EXISTS. The guide replaced the instruction hints that used to sit in the
 * annotate / text-edit bars, and it is the only place several gestures are documented at
 * all. Its failure mode is not a crash: it is a missing English string that silently
 * falls back to Vietnamese, an unclosed `**bold**`, or a shortcut row that lost its
 * meaning — none of which any other test would notice. So this asserts the SHAPE of the
 * data, which is exactly the part a human editing prose gets wrong.
 *
 * Run: npm run test:help
 */

const path = require("path");
const help = require(path.join(__dirname, "..", "renderer", "help.js"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
}
function group(name) {
  console.log(name);
}

const { SECTIONS, UI, fold, fmt } = help;

// ---- 1. module surface ------------------------------------------------------

group("module surface");
check("SECTIONS is a non-empty array", Array.isArray(SECTIONS) && SECTIONS.length > 0);
check("UI strings present", !!(UI && UI.title && UI.search && UI.close && UI.empty));

// ---- 2. every { vi, en } pair is complete -----------------------------------
//
// A pair is any object with a `vi` key. Walking the whole tree rather than listing the
// block kinds means a NEW block kind added later is covered without touching this test.

group("VI/EN parity");

const seen = [];
function walk(node, trail) {
  if (node == null) return;
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    node.forEach((x, i) => walk(x, `${trail}[${i}]`));
    return;
  }
  if (typeof node !== "object") return;
  if (Object.prototype.hasOwnProperty.call(node, "vi")) {
    seen.push({ trail, pair: node });
    return; // a leaf pair — do not descend into its strings
  }
  for (const k of Object.keys(node)) walk(node[k], `${trail}.${k}`);
}
walk(SECTIONS, "SECTIONS");
walk(UI, "UI");

check("found a meaningful number of strings", seen.length > 100, `only ${seen.length}`);
for (const { trail, pair } of seen) {
  check(`${trail} has vi`, typeof pair.vi === "string" && pair.vi.trim().length > 0);
  check(
    `${trail} has en`,
    typeof pair.en === "string" && pair.en.trim().length > 0,
    "English missing → renders Vietnamese in English mode"
  );
  // A pair whose two sides are identical is almost always a forgotten translation. Bare
  // key names ("F1", "Ctrl+O") are legitimately identical, so allow short ASCII-only ones.
  const identical = pair.vi === pair.en;
  const looksLikeKeyName = pair.vi.length <= 24 && !/[^\x20-\x7e]/.test(pair.vi);
  check(`${trail} vi !== en`, !identical || looksLikeKeyName, `both sides are "${pair.vi}"`);
}

// ---- 3. section shape -------------------------------------------------------

group("section shape");
const ids = new Set();
const KNOWN_BLOCKS = new Set(["h", "p", "ul", "note", "keys", "table"]);
for (const sec of SECTIONS) {
  check(`section id "${sec.id}" is a slug`, /^[a-z][a-z0-9-]*$/.test(sec.id || ""));
  check(`section id "${sec.id}" is unique`, !ids.has(sec.id));
  ids.add(sec.id);
  check(`section "${sec.id}" has a title pair`, !!(sec.title && sec.title.vi && sec.title.en));
  check(`section "${sec.id}" has blocks`, Array.isArray(sec.blocks) && sec.blocks.length > 0);
  for (const [i, b] of (sec.blocks || []).entries()) {
    const kinds = Object.keys(b);
    check(`${sec.id}.blocks[${i}] has exactly one kind`, kinds.length === 1, kinds.join("+"));
    check(`${sec.id}.blocks[${i}] kind "${kinds[0]}" is known`, KNOWN_BLOCKS.has(kinds[0]));
    if (b.keys) {
      for (const [j, row] of b.keys.entries()) {
        check(`${sec.id}.blocks[${i}].keys[${j}] is [key, meaning]`, Array.isArray(row) && row.length === 2);
        const [k, meaning] = row;
        check(`${sec.id}.keys[${j}] key is a string or pair`, typeof k === "string" || (k && k.vi));
        check(`${sec.id}.keys[${j}] has a meaning`, !!(meaning && meaning.vi));
      }
    }
    if (b.table) {
      const t = b.table;
      check(`${sec.id}.blocks[${i}].table has a head`, Array.isArray(t.head) && t.head.length > 0);
      for (const [j, row] of (t.rows || []).entries()) {
        check(
          `${sec.id}.table.rows[${j}] width matches the head (${t.head.length})`,
          Array.isArray(row) && row.length === t.head.length,
          `got ${row && row.length}`
        );
      }
    }
  }
}

// ---- 4. inline markup is balanced ------------------------------------------
//
// fmt() turns **x** into <b>x</b> and `x` into <code>x</code> with a non-greedy match, so
// an ODD number of either marker means one of them renders as a literal asterisk /
// backtick in the shipped guide. Cheap to assert, invisible to spot by eye.

group("inline markup");
for (const { trail, pair } of seen) {
  for (const l of ["vi", "en"]) {
    const s = pair[l];
    const stars = (s.match(/\*\*/g) || []).length;
    check(`${trail}.${l} has balanced **bold**`, stars % 2 === 0, `${stars} markers`);
    const ticks = (s.match(/`/g) || []).length;
    check(`${trail}.${l} has balanced \`code\``, ticks % 2 === 0, `${ticks} backticks`);
    check(`${trail}.${l} has no stray single *`, !/(^|[^*])\*([^*]|$)/.test(s));
  }
}

// ---- 5. fmt() escapes before it formats ------------------------------------

group("fmt() escaping");
check(
  "raw < is escaped",
  fmt({ vi: "a < b", en: "a < b" }) === "a &lt; b",
  fmt({ vi: "a < b", en: "a < b" })
);
check(
  "& is escaped and not double-escaped",
  fmt({ vi: "A & B", en: "A & B" }) === "A &amp; B",
  fmt({ vi: "A & B", en: "A & B" })
);
check("**bold** becomes <b>", fmt({ vi: "x **y** z", en: "" }) === "x <b>y</b> z");
check("`code` becomes <code>", fmt({ vi: "press `Esc`", en: "" }) === "press <code>Esc</code>");
// An injected tag must arrive as text, never as markup — the guide is our own copy today,
// but this is the property that keeps it safe when someone pastes an example into it.
check(
  "an HTML tag in content stays inert",
  fmt({ vi: "<b>no</b>", en: "" }) === "&lt;b&gt;no&lt;/b&gt;",
  fmt({ vi: "<b>no</b>", en: "" })
);

// ---- 6. diacritic folding (the search box) ---------------------------------

group("search folding");
check("mũi tên folds to mui ten", fold("Mũi tên") === "mui ten", fold("Mũi tên"));
check("đ folds to d", fold("Đảo chiều") === "dao chieu", fold("Đảo chiều"));
check("ASCII is untouched apart from case", fold("Ctrl+C") === "ctrl+c");
check("a folded query matches folded content", fold("khoanh mây").includes("khoanh may"));

// ---- 7. the content the removed hints used to carry ------------------------
//
// These are the gestures that ONLY lived in #ed-hint / #te-hint before v0.2.53. If a
// future edit drops one, the app documents it nowhere at all — so pin them here rather
// than trusting that nobody trims the annotate section.

group("removed-hint coverage");
const annotate = SECTIONS.find((s) => s.id === "annotate");
check("annotate section exists", !!annotate);
const viText = JSON.stringify(SECTIONS.map((s) => s.blocks)); // vi + en, all sections
const MUST_MENTION = [
  ["resize by the corners", "4 góc"],
  ["Shift keeps the aspect ratio", "đúng tỷ lệ"],
  ["Ctrl+click multi-select", "thêm / bớt mục vào vùng chọn"],
  ["copy/paste across pages", "Ctrl+V"],
  ["right-click menu", "bấm chuột phải"],
  ["Delete removes the object", "Delete` xoá mục"],
  ["double-click to edit", "Bấm đúp"],
  ["arrow end grips", "2 nút tròn"],
  ["arrow 15° lock", "15°"],
  ["arrow reverse", "Đảo chiều"],
  ["freehand straight segment", "duỗi **thẳng**"],
  ["cloud polygon closing", "bấm từng điểm"],
  ["measure calibration", "hiệu chuẩn"],
  ["what stays editable", "dán chết"],
  ["text box Ctrl+Enter", "Ctrl+Enter"],
];
for (const [label, needle] of MUST_MENTION) {
  check(`annotate guide covers: ${label}`, viText.includes(needle), `missing "${needle}"`);
}

// ---- 8. every tool shortcut is listed --------------------------------------
//
// Mirrors TOOL_KEYS in editor.js. A tool added there with no row here means a key nobody
// can discover, which is the exact gap this whole change was meant to close.

group("tool shortcut table");
const TOOL_KEYS = ["V", "T", "H", "D", "R", "O", "C", "F", "A", "K", "J", "N", "I", "X", "M"];
const keyBlock = (annotate.blocks || []).find((b) => b.keys);
check("annotate has a shortcut table", !!keyBlock);
const listed = new Set((keyBlock ? keyBlock.keys : []).map(([k]) => (typeof k === "string" ? k : k.vi)));
for (const k of TOOL_KEYS) check(`tool key ${k} is documented`, listed.has(k));
check("no extra tool keys listed", listed.size === TOOL_KEYS.length, `${listed.size} rows`);

// ---- result ----------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll help-content checks passed (${seen.length} strings, ${SECTIONS.length} sections).`);
