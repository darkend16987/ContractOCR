"use strict";

/*
 * Text layout engine for the overlay editor — lifted out of editor.js at v0.2.48.
 *
 * WHY THIS FILE EXISTS (docs/REGRESSION-GUARD.md §1): this is the one part of
 * editor.js that is both genuinely pure and genuinely dangerous. `layoutTextBox`
 * positions EVERY glyph and is the single shared source of truth for two paths that
 * must agree pixel-for-pixel:
 *   · `measureText`   → the on-screen box the user drags and types into;
 *   · `renderTextPng` → the PNG that actually gets baked into the PDF.
 * When they disagree the failure is SILENT — the box looks right on screen and the
 * saved PDF has text overflowing, re-wrapped, or on the wrong number of lines. That
 * is the §1 criterion for splitting a file ("does a mistake here stay quiet?"), not
 * the line count. Now it is require()-able from node → `npm run test:text`.
 *
 * EXPOSURE — deliberately the `wire.js` tier of §2, NOT the `page-range.js` tier:
 * these names had ~25 call sites in editor.js before the split. Declared at the top
 * level of a classic script they stay in exactly the same shared scope as before, so
 * NOT ONE call site had to change and the editor.js side of this commit is a pure
 * deletion. Switching to `AnnotText.*` would mean 25 hand-edits in the
 * highest-diff file in the repo to buy nothing — that is BI-14 courted for style.
 * `module.exports` is for node; `window.AnnotText` is the same set under a name a
 * probe or test can assert on.
 *
 * TRADE-OFF (same as wire.js): this file MUST be loaded BEFORE editor.js in
 * index.html. Renaming anything here without renaming the call site is a runtime
 * ReferenceError with no build-time warning — BI-14. The test grid is the net:
 * it looks each name up by hand, so a rename fails the grid loudly.
 *
 * Everything here is pure except `measureCtx`, which needs a throwaway canvas to
 * measure glyphs. It is behind a `typeof document` gate (the `pan.js` half-and-half
 * pattern) so node can load this file, and `measureText` takes an optional ctx so
 * the grid can drive it with a stub.
 */

// Built-in font-family keys → a CSS font-family stack. Any other value is taken
// as a literal system family name (from the /fonts picker) and quoted as-is.
const FONT_STACKS = {
  sans: 'system-ui, "Segoe UI", Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
function fontFamily(key) {
  return FONT_STACKS[key] || `"${(key || "sans").replace(/"/g, "")}", sans-serif`;
}
// CSS `font` shorthand from a size (px) and an optional style object
// ({ font, bold, italic }). Defaults match a plain sans-serif text box.
function textFont(fontSizePx, opts) {
  const o = opts || {};
  const style = o.italic ? "italic " : "";
  const weight = o.bold ? "700 " : "";
  return `${style}${weight}${fontSizePx}px ${fontFamily(o.font)}`;
}
// Normalise a text annotation (or a partial style object) into the full set of
// style fields the layout engine understands, filling in safe defaults. Old
// files / older annots that lack the new fields keep their original look.
function normTextStyle(a) {
  a = a || {};
  const num = (v, d) => (v == null || isNaN(+v) ? d : +v);
  const al = a.align;
  return {
    font: a.font || "sans",
    bold: !!a.bold,
    italic: !!a.italic,
    underline: !!a.underline,
    strike: !!a.strike,
    align: al === "center" || al === "right" || al === "justify" ? al : "left",
    lineHeight: Math.max(0.5, num(a.lineHeight, 1.3)), // multiplier of font size
    paraSpacing: Math.max(0, num(a.paraSpacing, 0)), // extra pt at blank-line breaks
    letterSpacing: num(a.letterSpacing, 0), // pt between characters
    wordSpacing: num(a.wordSpacing, 0), // pt added on spaces
    charScale: Math.max(0.2, num(a.charScale, 1)), // horizontal glyph scale (1 = 100%)
    indent: Math.max(0, num(a.indent, 0)), // left indent in pt
    listType: a.listType === "bullet" || a.listType === "number" ? a.listType : "none",
    opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),
  };
}
// Back-compat alias: the style bundle read off a text annotation is now the full
// normalised set (superset of the old {font,bold,italic}).
function textStyle(a) {
  return normTextStyle(a);
}

// Core text layout, shared by measureText (box sizing) and renderTextPng (baked
// PNG) so the on-screen box and the printed result always agree. Positions EVERY
// glyph so we can honour alignment, justify, letter/word spacing, horizontal
// char scale, indent and bullet/number lists — none of which plain fillText(str)
// can do. Works in an abstract unit: `fpx` is the font size in that unit and
// `upp` is units-per-point (so pt-based spacings scale correctly): raster passes
// fpx=sizePt*RS, upp=RS; measuring passes fpx=sizePt, upp=1.
//   ctx: a canvas-2d-like object (needs .font + measureText(str).width).
// Returns { width, height, ops:[{ch,x,y}], decos:[{x0,x1,y,kind}], style }.
function layoutTextBox(text, style, ctx, fpx, upp) {
  const s = normTextStyle(style);
  ctx.font = textFont(fpx, s);
  const meas = (str) => ctx.measureText(str).width;
  const sx = s.charScale;
  const ls = s.letterSpacing * upp;
  const ws = s.wordSpacing * upp;
  const indent = s.indent * upp;
  const para = s.paraSpacing * upp;
  const lh = fpx * s.lineHeight;
  const markerGap = fpx * 0.4;
  const isList = s.listType === "bullet" || s.listType === "number";

  const rawLines = String(text == null ? "" : text).split("\n");
  // Width of a line's text run, including char scale + letter/word spacing but
  // NOT the trailing letter-space (spacing sits *between* glyphs).
  const lineTextWidth = (str) => {
    let w = 0;
    for (const ch of str) {
      w += meas(ch) * sx + ls;
      if (ch === " ") w += ws;
    }
    if (str.length) w -= ls;
    return Math.max(0, w);
  };

  let num = 0;
  const items = rawLines.map((str) => {
    const blank = str.trim() === "";
    let marker = "";
    if (isList && !blank) {
      num++;
      marker = s.listType === "bullet" ? "•" : num + ".";
    }
    return { str, blank, marker };
  });
  const markerW = (m) => (m ? meas(m) * sx : 0);
  const maxMarkerW = items.reduce((mx, it) => Math.max(mx, markerW(it.marker)), 0);
  const textLeft = indent + (isList ? maxMarkerW + markerGap : 0);
  const blockW = items.reduce((mx, it) => Math.max(mx, lineTextWidth(it.str)), 1);

  const ops = [];
  const decos = [];
  let y = 0;
  items.forEach((it, idx) => {
    if (!it.blank) {
      const lw = lineTextWidth(it.str);
      const lastOfPara = idx === items.length - 1 || items[idx + 1].blank;
      let offset = 0;
      let justifyExtra = 0;
      if (s.align === "center") offset = (blockW - lw) / 2;
      else if (s.align === "right") offset = blockW - lw;
      else if (s.align === "justify" && !lastOfPara) {
        const spaces = (it.str.match(/ /g) || []).length;
        if (spaces > 0) justifyExtra = (blockW - lw) / spaces;
      }
      // Marker (bullet / number) sits at the indent; text follows it.
      if (it.marker) {
        let mx = indent;
        for (const ch of it.marker) {
          ops.push({ ch, x: mx, y });
          mx += meas(ch) * sx;
        }
      }
      let cx = textLeft + offset;
      const lineStartX = cx;
      for (const ch of it.str) {
        ops.push({ ch, x: cx, y });
        cx += meas(ch) * sx + ls;
        if (ch === " ") cx += ws + justifyExtra;
      }
      const lineEndX = it.str.length ? cx - ls : lineStartX;
      if (s.underline) decos.push({ x0: lineStartX, x1: lineEndX, y: y + fpx * 1.02, kind: "under" });
      if (s.strike) decos.push({ x0: lineStartX, x1: lineEndX, y: y + fpx * 0.62, kind: "strike" });
    }
    y += lh;
    if (it.blank) y += para;
  });

  return { width: Math.max(1, textLeft + blockW), height: Math.max(lh, y), ops, decos, style: s };
}

// One throwaway 2d context, reused for every measurement (creating a canvas per
// keystroke was measurable). node has no `document`: rather than crash somewhere
// deep in layout, say so — callers there are expected to pass their own ctx.
let _measureCtx;
function measureCtx() {
  if (!_measureCtx) {
    if (typeof document === "undefined") {
      throw new Error("measureCtx: no DOM in this environment — pass a ctx explicitly");
    }
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  return _measureCtx;
}

// `ctx` is an optional override (the test grid passes a stub); the browser leaves it
// out and gets the shared measuring canvas. Callers in editor.js pass 3 args, as before.
function measureText(text, fontSizePt, opts, ctx) {
  const lay = layoutTextBox(text, opts, ctx || measureCtx(), fontSizePt, 1);
  const pad = fontSizePt * 0.15;
  return { w: Math.ceil(lay.width + pad * 2), h: Math.ceil(lay.height + pad * 2) };
}

// Text with bullet/number markers prefixed per non-empty line — DISPLAY ONLY
// (the stored `text` stays clean so editing never touches the markers).
function listDisplayText(text, style) {
  const s = normTextStyle(style);
  const str = text == null ? "" : String(text);
  if (s.listType === "none") return str;
  let n = 0;
  return str
    .split("\n")
    .map((ln) => {
      if (ln.trim() === "") return ln;
      n++;
      return (s.listType === "bullet" ? "• " : n + ". ") + ln;
    })
    .join("\n");
}

// node (tests) takes the module export; the browser already has the bare names
// above in the shared script scope. window.AnnotText is the same set under a name a
// probe can assert on. Mirrors the tail of wire.js exactly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FONT_STACKS, fontFamily, textFont, normTextStyle, textStyle,
    layoutTextBox, measureCtx, measureText, listDisplayText,
  };
}
if (typeof window !== "undefined") {
  window.AnnotText = {
    FONT_STACKS, fontFamily, textFont, normTextStyle, textStyle,
    layoutTextBox, measureCtx, measureText, listDisplayText,
  };
}
