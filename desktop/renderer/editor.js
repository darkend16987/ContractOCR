"use strict";

/**
 * Nabu PDF — renderer (Phase 4: overlay editor).
 *
 * Adds annotation / watermark / redaction / form-fill on top of the P1 viewer.
 * Design notes:
 *  - Annotations live in `ed.annots[pageIndex]` as plain objects whose coords are
 *    in *scale-1 PDF-point space, top-left origin* (the pdf.js viewport at scale 1).
 *    The overlay renders them at `state.scale`; baking maps them to pdf-lib's
 *    bottom-left user space via the page viewport's `convertToPdfPoint`.
 *  - Vietnamese text is rendered to a PNG via the system font and embedded as an
 *    image — pdf-lib's standard fonts can't encode Vietnamese diacritics and we
 *    deliberately avoid vendoring a Unicode font (offline / zero new deps).
 *  - Redaction is *secure*: any page with a redaction box is rasterised with the
 *    box burned in and the page content is replaced by that image, so the original
 *    text is physically gone (not merely covered). Other pages stay vector.
 *
 * Shares app.js globals (same classic-script scope): state, $, toast,
 * showOverlay/hideOverlay, renderAll, renderViewer, updateToolbar.
 */

(function () {
  const PDFLib = window.PDFLib;
  const { PDFDocument, rgb, PDFName, PDFHexString, PDFRawStream, PDFDict, degrees } = PDFLib;

  // ---- managed annotations (Option B round-trip) ---------------------------
  //
  // Text boxes and comment notes are written to the PDF as REAL annotations
  // (visible in Foxit/Acrobat) that also carry a private `/NabuData` payload, so
  // re-opening the file lets us reconstruct the editable overlay object and the
  // user can move / retype / keep commenting. Everything else still flattens.
  //
  //  - text  → /Stamp annot whose appearance (/AP /N) is the same PNG we already
  //            render for the flattened path (Vietnamese-safe, no font embedding).
  //  - note  → /Text annot carrying the thread in /Contents (as before) plus the
  //            structured thread in /NabuData; its coloured marker is drawn by the
  //            viewer's note layer, not baked into page content, so it's removable.
  //
  // Rotated pages: a text/arrow Stamp appearance would need a matrix; that's
  // deferred, so text/arrow on a rotated page still flatten (today's behaviour).
  // Notes are points and round-trip on any rotation.
  //  - arrow → /Stamp whose /AP is a PNG of the whole arrow (line + head + label),
  //            rendered the same Vietnamese-safe way as text; geometry + label in
  //            /NabuData so a re-opened file is fully re-editable (move / re-angle /
  //            retype the head-or-tail label).
  //  - box / ellipse / cloud / cloudpen (v0.2.61) → /Stamp whose /AP is a VECTOR form,
  //            appearance is built by managed-codec's shapeAppearance() from pdf-lib's
  //            own drawRectangle / drawEllipse operator generators — the same ones
  //            drawOneAnnot's flatten branch goes through — so the re-editable copy and
  //            the flattened copy cannot draw different geometry. Stays sharp at any
  //            zoom and in print, and owns no image (so no /NabuSrc, and nothing for
  //            managedSrcBytes to vet). Everything the shape needs is in /NabuData.
  // Still flattened, deliberately: draw (vẽ tay), highlight, redact, measure, ✓/✗. Not an
  // oversight — each would need its own appearance branch, and shipping them one class at
  // a time is what keeps test:rotate's guard cases meaningful.
  // Kinds drawn as a plain x/y/w/h box — the ones that get resize grips. Named
  // because it used to be an inline `||` chain inside renderAnnot, which is the kind
  // of thing that quietly drifts out of step with the .handle rules in app.css.
  const RESIZABLE_KINDS = new Set(["highlight", "redact", "image", "box", "ellipse", "check", "cross"]);
  const HANDLE_DIRS = ["nw", "ne", "sw", "se"];
  // Single-key tool shortcuts (edit mode only). Letters mirror the tool tooltips.
  // `x` was already redact, so the ✗ symbol takes `j` — j/k are neighbours on the
  // keyboard and the pair is learned as one, which beats a second lone mnemonic.
  const TOOL_KEYS = {
    v: "select", t: "text", h: "highlight", d: "draw", r: "box", o: "ellipse",
    c: "cloud", f: "cloudpen", a: "arrow", n: "note", i: "image", x: "redact", m: "measure",
    k: "check", j: "cross",
  };
  // The ✓ / ✗ stamps. Grouped because six places have to treat them alike, and an
  // inline `||` chain in each is how those places drift apart (see RESIZABLE_KINDS).
  const SYMBOL_KINDS = new Set(["check", "cross"]);
  // Which remembered default colour a tool/kind draws with. Four kinds keep their OWN
  // slot because their colour carries meaning rather than preference: ✓ = đúng (green),
  // ✗ = sai (red), tô sáng = highlighter yellow, che thông tin = black. Every other kind
  // shares `ed.color` — the slot Cài đặt → Màu chú thích mặc định writes.
  //
  // A Map, not the ternary chain this used to be: four exceptions threaded through a
  // chain, read from four call sites (the shape + symbol create paths, setTool, and the
  // #ed-color handler), is exactly how those call sites drift apart. A Map also has no
  // prototype keys, so an unexpected `k` can only ever fall through to "color".
  //
  // Declared UP HERE with the other kind classifiers, not next to colorSlotFor down in
  // the palette section: `colorSlotFor` is a hoisted function declaration but this Map
  // is a `const`, so a call from anything that runs at IIFE-init time would hit its TDZ
  // and blank the app. Nothing calls it at init today — this keeps it that way.
  const COLOR_SLOTS = new Map([
    ["check", "checkColor"],
    ["cross", "crossColor"],
    ["highlight", "highlightColor"],
    ["redact", "redactColor"],
  ]);
  function colorSlotFor(k) {
    return COLOR_SLOTS.get(k) || "color";
  }
  // MANAGED_KINDS / isManagedKind / the /Nabu* keys / sniffImage / strToBytes /
  // makeMap / pageRotate / serializeManaged / pushPageAnnot / managedSrcBytes /
  // managedSrcDataUrl / collectManagedChain / freeManagedTrash /
  // stripManagedFromPage / stripManagedAnnots moved to renderer/managed-codec.js
  // at v0.2.49 (pure → now require()-able by `npm run test:managed`). Still reachable
  // by BARE NAME from here: managed-codec.js is a classic script loaded BEFORE this
  // one, so it declares them in the same shared scope. `deserializeManaged` (needs
  // ed.seq) and `addManagedAnnot` (+ its `f`; calls the canvas rasterisers) stayed.
  // See BI-14 + BI-37/38 + §2.

  // ---- default annotation colour (Cài đặt → Màu chú thích mặc định) --------
  //
  // RED, not the yellow this used to be: the shared slot below is what a text box, an
  // arrow, a cloud and a rectangle all draw with, and yellow on white paper is very
  // nearly invisible — a review mark nobody can see is worse than no mark. Tô sáng and
  // ✓/✗ keep their own slots (see `ed` and colorSlotFor), so this change does not turn
  // the highlighter pink or make a tick mean "sai".
  //
  // Stored renderer-side (localStorage) like the theme and the path bar, NOT in main's
  // prefs.json: prefs.js exists for decisions main has to make with no window open
  // (BI-35). Only a renderer with the overlay open ever reads this one.
  //
  // THREE literals have to agree: this constant, `#ed-color`'s markup value and
  // `#set-annot-color`'s — the first is the running default, the other two are what the
  // user sees for the split second before JS writes them. `npm run test:defaults` fails
  // if they drift.
  const DEFAULT_ANNOT_COLOR = "#d32f2f";
  const ANNOT_COLOR_KEY = "nabu-annot-color";
  const HEX6 = /^#[0-9a-fA-F]{6}$/;

  // Validated on the way OUT of storage, which a human may have edited and which an
  // older/newer build may have written: junk falls back to the default rather than
  // reaching an `<input type="color">` (which would silently show #000000 instead).
  function savedAnnotColor() {
    try {
      const v = localStorage.getItem(ANNOT_COLOR_KEY);
      return HEX6.test(v || "") ? v.toLowerCase() : DEFAULT_ANNOT_COLOR;
    } catch (_) {
      return DEFAULT_ANNOT_COLOR; // unreadable storage must not cost the drawing tools
    }
  }

  const ed = {
    active: false,
    tool: "select",
    // The shared default for every kind that draws with the one "Màu" control:
    // text, arrow, cloud, cloudpen, box, ellipse, draw, note, dim.
    color: savedAnnotColor(),
    redactColor: "#000000", // redaction fill colour (separate from `color`)
    // Tô sáng keeps the highlighter yellow even though the shared default above is now
    // red: `.an-highlight` is `mix-blend-mode: multiply` at 0.4 (app.css), so red comes
    // out as a pink wash over the words — which reads as "something is wrong with this
    // line" rather than "look here". Own slot, same "Màu" control (colorSlotFor).
    highlightColor: "#ffd54a", // tô sáng — highlighter yellow
    // The ✓ / ✗ stamps remember their own colour, like redactColor does: they mean
    // "đúng" and "sai", so inheriting the shared default would make every new
    // tick meaningless until the user recoloured it by hand. Same "Màu" control —
    // it just shows whichever default belongs to the current tool (colorSlotFor).
    checkColor: "#2e7d32", // ✓ — green
    crossColor: "#d32f2f", // ✗ — red
    fontSize: 16, // points
    font: "sans", // text-box font family key (see FONT_STACKS)
    bold: false,
    italic: false,
    underline: false,
    // --- text-box paragraph / advanced formatting (defaults for NEW boxes) ---
    strike: false, // strikethrough
    align: "left", // left | center | right | justify
    lineHeight: 1.3, // line-spacing multiplier
    paraSpacing: 0, // extra pt at blank-line paragraph breaks
    letterSpacing: 0, // pt between characters
    wordSpacing: 0, // pt added on spaces
    charScale: 1, // horizontal glyph scale (1 = 100%)
    indent: 0, // left indent in pt
    listType: "none", // none | bullet | number
    textOpacity: 1, // 0..1 text opacity
    penWidth: 2,
    arrowLabelEnd: "head", // where a new arrow's label sits: "head" (tip) or "tail" (base)
    fillColor: "#ffffff", // interior fill for box / ellipse / cloud / cloudpen
    fillOn: false, // false → transparent interior (the default for revision clouds)
    fillOpacity: 1, // 0..1 interior-fill opacity (0 = fully transparent, 1 = solid)
    cloudBump: 12, // scallop size for new revision clouds (denser than the old fixed 16)
    annots: {}, // pageIndex -> [annot]
    watermark: null, // { text, size, angle, opacity, color }
    seq: 1,
    sel: null, // PRIMARY selected annot id (numbers are unique across pages)
    // Additional ids in a Ctrl+click multi-selection, NOT including `ed.sel`.
    //
    // Deliberately a side-set instead of turning `ed.sel` into a Set: `ed.sel` is read
    // in ~30 places (style controls, the format panel, syncCtlVisibility, the fmt
    // panel's arrange…) and every one of them wants exactly ONE object. Making it a
    // collection would mean rewriting all of them in the file the guard doc calls the
    // highest-diff in the repo. This way the primary keeps its old meaning and old
    // behaviour, and only the operations that genuinely act on a group — select
    // outline, move, copy, delete, colour, stroke width — consult selIds().
    //
    // A multi-selection is ALWAYS within one page (see toggleSelect). That is not a
    // limitation to route around later: it is what keeps a group drag to a single
    // renderLayer() per mousemove, and what lets copy/delete assume one page.
    selMore: new Set(),
    pendingImage: null, // { dataUrl, mime } awaiting a placement click
    _poly: null, // freehand-cloud polygon in progress: { page, id, layer, cx, cy }
    _form: null,
    _formDoc: null,
    // Measure/dimension tool: calibration from one known length + last-used unit.
    // unitsPerPoint = real-world units per PDF point; reset per edit session (a
    // different drawing has a different scale). See the "measure" tool branches.
    measureCal: null, // { unitsPerPoint } or null (not yet calibrated)
    measureUnit: "m", // unit label appended to auto dim text
    measureDecimals: 2, // decimal places for the measured value
    _dimPending: null, // drag awaiting the calibration modal: { id, page, layer, pdfDist }
    _dirty: false, // true once the user actually changed something this session
    _taCommit: null, // commit/close fn of the open inline editor (text/note/label), or null
    _exiting: false, // guards bakePending's re-import while we're leaving edit mode
    _managedPages: new Set(), // pages that hold (or held) round-trip text/notes → always repaint on bake
    // How many round-trip annots importManaged() took OWNERSHIP of from the file this
    // session. Not a statistic: it is the only way to know a bake still has work when
    // `hasAny()` is false. Deleting the last text box empties ed.annots, and the bake
    // that must REMOVE it from the PDF was gated on there being something to ADD — so
    // the box silently came back on repaint. See BI-60.
    _importedManaged: 0,
  };

  // ---- model helpers -------------------------------------------------------

  function annotsFor(i) {
    return ed.annots[i] || (ed.annots[i] = []);
  }
  function findAnnot(id) {
    for (const i of Object.keys(ed.annots)) {
      const a = ed.annots[i].find((x) => x.id === id);
      if (a) return { a, page: +i };
    }
    return null;
  }
  function hasAny() {
    return Object.values(ed.annots).some((a) => a.length) || !!ed.watermark;
  }
  function countAnnots() {
    return Object.values(ed.annots).reduce((s, a) => s + a.length, 0) + (ed.watermark ? 1 : 0);
  }

  // `arrowLabelPos` moved to renderer/annot-geom.js at v0.2.48 — see the note at the
  // cloud-path site below for why the call sites here did not change.

  // ---- annotation-level undo/redo (Ctrl+Z/Y while the editor is open) ------
  // Snapshots of the *pending* annotations, separate from app.js's document
  // history: nothing here touches state.bytes until bake.

  const edHist = { past: [], future: [], lastKey: null, lastT: 0 };

  // A JSON round-trip is still the deep copy (it is proven, and annots are plain
  // data), but image `dataUrl`s are swapped for a token on the way out and restored
  // BY REFERENCE on the way in. They are immutable — an edit replaces the string,
  // never mutates it — and since images round-trip they now live in ed.annots for a
  // whole session: a re-opened photo is a multi-megabyte base64 string and a plain
  // JSON.parse(JSON.stringify(...)) cloned it into every one of the 50 history slots.
  // Same lesson as BI-24, on the heap instead of the wire. Everything else is still
  // genuinely copied, including the nested pts/replies arrays that ARE mutated
  // in place (draw strokes, note threads).
  // Collision-proof by construction: a real dataUrl always begins "data:".
  const URL_TOKEN = "nabu-src-ref:";
  function edSnapshot() {
    const pool = [];
    const json = JSON.stringify(ed.annots, (k, v) => {
      if (k === "dataUrl" && typeof v === "string") {
        pool.push(v);
        return URL_TOKEN + (pool.length - 1);
      }
      return v;
    });
    return {
      annots: JSON.parse(json, (k, v) =>
        k === "dataUrl" && typeof v === "string" && v.startsWith(URL_TOKEN)
          ? pool[+v.slice(URL_TOKEN.length)]
          : v
      ),
      watermark: ed.watermark ? { ...ed.watermark } : null,
    };
  }
  // Record an undo step *before* a mutation. `coalesceKey` merges rapid repeats
  // (a colour-picker drag / font-size spinner fires per tick) into one step.
  function pushEdUndo(coalesceKey) {
    ed._dirty = true; // any mutation routes through here → session has unsaved edits
    const now = Date.now();
    if (coalesceKey && edHist.lastKey === coalesceKey && now - edHist.lastT < 800) {
      edHist.lastT = now;
      return;
    }
    edHist.lastKey = coalesceKey || null;
    edHist.lastT = now;
    edHist.past.push(edSnapshot());
    if (edHist.past.length > 50) edHist.past.shift();
    edHist.future.length = 0;
    syncUndoBtns();
  }
  // Drop the last snapshot (a cancelled drag returned us to exactly that state).
  function dropLastEdUndo() {
    edHist.past.pop();
    edHist.lastKey = null;
    syncUndoBtns();
  }
  function edRestore(s) {
    ed.annots = s.annots;
    ed.watermark = s.watermark;
    ed.sel = null;
    ed.selMore.clear(); // ids from before the undo may not exist any more
    syncOverlays();
    syncUndoBtns();
  }
  function edUndo() {
    if (drag) return; // never mutate the model mid-drag
    if (!edHist.past.length) {
      toast("Không còn thao tác để hoàn tác.", "");
      return;
    }
    edHist.future.push(edSnapshot());
    edHist.lastKey = null;
    edRestore(edHist.past.pop());
  }
  function edRedo() {
    if (drag || !edHist.future.length) return;
    edHist.past.push(edSnapshot());
    edHist.lastKey = null;
    edRestore(edHist.future.pop());
  }
  function clearEdHistory() {
    edHist.past.length = 0;
    edHist.future.length = 0;
    edHist.lastKey = null;
    syncUndoBtns();
  }
  // While the editor owns Ctrl+Z/Y, the toolbar buttons should reflect *its*
  // stacks; app.js's updateUndoRedo() takes back over on exit.
  function syncUndoBtns() {
    if (!ed.active) return;
    const u = $("btn-undo");
    const r = $("btn-redo");
    if (u) u.disabled = !edHist.past.length;
    if (r) r.disabled = !edHist.future.length;
  }

  // ---- geometry helpers ----------------------------------------------------

  function layerFor(i) {
    return document.querySelector(`.annot-layer[data-index="${i}"]`);
  }
  function layerPoint(layer, e) {
    const r = layer.getBoundingClientRect();
    const s = state.scale;
    const w = +layer.dataset.w || r.width / s;
    const h = +layer.dataset.h || r.height / s;
    const x = Math.max(0, Math.min(w, (e.clientX - r.left) / s));
    const y = Math.max(0, Math.min(h, (e.clientY - r.top) / s));
    return { x, y };
  }

  // `measureCtx` / `FONT_STACKS` / `fontFamily` / `textFont` / `normTextStyle` /
  // `textStyle` / `layoutTextBox` / `measureText` / `listDisplayText` moved to
  // renderer/annot-text.js at v0.2.48 (pure → now under `npm run test:text`). They
  // are still reachable by BARE NAME from here: annot-text.js is a classic script
  // loaded BEFORE this one, so it declares them in the same shared scope they used
  // to live in — that is why no call site in this file changed. See BI-14 + §2.

  // The formatting bundle a NEW text box inherits from the current palette state.
  // (ed.textOpacity → the annot's `opacity`, kept distinct from fill opacity.)
  function edTextStyle() {
    return {
      font: ed.font, bold: ed.bold, italic: ed.italic, underline: ed.underline,
      strike: ed.strike, align: ed.align, lineHeight: ed.lineHeight,
      paraSpacing: ed.paraSpacing, letterSpacing: ed.letterSpacing,
      wordSpacing: ed.wordSpacing, charScale: ed.charScale, indent: ed.indent,
      listType: ed.listType, opacity: ed.textOpacity,
    };
  }

  // Apply a text style to a DOM element (on-screen box or the inline <textarea>)
  // as a live preview. `scalePx` = px per PDF point (state.scale). Char-scale and
  // list markers are handled by the caller (they need DOM structure changes); the
  // baked PNG via renderTextPng is always the exact source of truth.
  function applyTextCss(el, style, scalePx) {
    const s = normTextStyle(style);
    el.style.textAlign = s.align;
    el.style.lineHeight = String(s.lineHeight);
    el.style.letterSpacing = s.letterSpacing * scalePx + "px";
    el.style.wordSpacing = s.wordSpacing * scalePx + "px";
    el.style.paddingLeft = s.indent * scalePx + "px";
    el.style.opacity = String(s.opacity);
    el.style.fontWeight = s.bold ? "700" : "400";
    el.style.fontStyle = s.italic ? "italic" : "normal";
    el.style.fontFamily = fontFamily(s.font);
    el.style.textDecoration =
      [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none";
  }

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return rgb(0, 0, 0);
    const n = parseInt(m[1], 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  // Strip the `data:…;base64,` prefix and hand the payload to wire.js's `b64ToU8`
  // — the ONE base64 decoder in the renderer (BI-24's rule, decode side). This used
  // to be a hand-rolled copy of that loop, and `sign.js` had a third copy; the
  // pattern that produced BI-27 (a private `parsePageRanges` in this file) all over
  // again. Keep it a one-line adapter: the loop lives in wire.js, under test:wire.
  function dataUrlToBytes(dataUrl) {
    const b64 = String(dataUrl).split(",")[1];
    // `b64ToU8` tolerates a missing payload (returns 0 bytes). Here that would mean
    // silently embedding an EMPTY image, so keep the old behaviour: fail loudly.
    if (b64 == null) throw new Error("dataUrlToBytes: not a data: URL");
    return b64ToU8(b64);
  }

  // Identify an image by its magic bytes — pdf-lib can only embed PNG or JPEG, and
  // the file's reported MIME is unreliable (empty for some files, wrong for others).
  // Returns "png", "jpg", or null (unsupported: webp/gif/bmp/svg/…).
  // Coerce any browser-decodable image data URL into one pdf-lib can embed.
  // PNG/JPEG pass through unchanged; anything else the browser can decode (BMP,
  // GIF, WebP…) is re-encoded to PNG via a canvas so it can still be placed.
  // Resolves { dataUrl, fmt } or null (undecodable). Async: image decode + draw.
  function toEmbeddable(dataUrl) {
    return new Promise((resolve) => {
      let bytes;
      try {
        bytes = dataUrlToBytes(dataUrl);
      } catch (_) {
        resolve(null);
        return;
      }
      const fmt = sniffImage(bytes);
      if (fmt) {
        resolve({ dataUrl, fmt });
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || 1;
          c.height = img.naturalHeight || 1;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve({ dataUrl: c.toDataURL("image/png"), fmt: "png" });
        } catch (_) {
          resolve(null); // e.g. a tainted canvas — shouldn't happen for local files
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // Effective interior fill for a newly created box/ellipse/cloud: a hex colour
  // when the fill toggle is on, otherwise "none" (transparent — the usual choice
  // for a revision cloud so the marked-up content stays visible).
  function effFill() {
    return ed.fillOn ? ed.fillColor : "none";
  }

  // "#rgb" / "#rrggbb" + alpha (0..1) → CSS rgba() for the overlay fill preview.
  function hexToRgba(hex, alpha) {
    let h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    const a = alpha != null ? alpha : 1;
    return `rgba(${r},${g},${b},${a})`;
  }

  // `CLOUD_BUMP` / `CLOUD_BUMP_MIN` / `CLOUD_BUMP_MAX` / `bumpOf` / `cloudPath` /
  // `arcApex` / `cloudPathPoly` / `arrowLabelPos` / `resizeRect` moved to
  // renderer/annot-geom.js at v0.2.48 (pure → now under `npm run test:geom`). They are
  // still reachable by BARE NAME from here: annot-geom.js is a classic script loaded
  // BEFORE this one, so it declares them in the same shared scope they used to live
  // in — that is why no call site in this file changed. See BI-14 + §2.

  // ---- overlay rendering ---------------------------------------------------

  function syncOverlays() {
    document.querySelectorAll("#viewer .page-wrap").forEach((wrap) => {
      const i = +wrap.dataset.index;
      const canvas = wrap.querySelector("canvas");
      if (!canvas) return;
      let layer = wrap.querySelector(".annot-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "annot-layer";
        wrap.appendChild(layer);
      }
      const cw = parseFloat(canvas.style.width) || canvas.width;
      const ch = parseFloat(canvas.style.height) || canvas.height;
      layer.style.width = cw + "px";
      layer.style.height = ch + "px";
      layer.dataset.index = String(i);
      layer.dataset.w = String(cw / state.scale);
      layer.dataset.h = String(ch / state.scale);
      renderLayer(layer, i);
    });
    document.body.classList.toggle("editing", ed.active);
  }

  function renderLayer(layer, i) {
    layer.innerHTML = "";
    const s = state.scale;
    for (const a of annotsFor(i)) layer.appendChild(renderAnnot(a, s));
    if (ed.watermark) layer.appendChild(renderWatermarkEl());
  }

  // Flatten a note + its replies into one text block (tooltip + PDF Contents).
  // Original text stays first; each reply is appended, never overwriting it.
  function noteThreadText(a) {
    let s = a.text || "";
    for (const r of a.replies || []) {
      const ts = r.ts ? new Date(r.ts).toLocaleString() : "";
      s += "\n\n— " + (ts ? "[" + ts + "] " : "") + (r.text || "");
    }
    return s;
  }

  function renderAnnot(a, s) {
    const el = document.createElement("div");
    el.className = "an an-" + a.kind;
    el.dataset.id = String(a.id);
    el.dataset.kind = a.kind;
    if (isSelected(a.id)) el.classList.add("sel");

    if (a.kind === "draw") {
      // SVG sized to the path's bounding box; coords relative to that box.
      const xs = a.pts.map((p) => p.x);
      const ys = a.pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - minX);
      const h = Math.max(1, Math.max(...ys) - minY);
      el.style.left = minX * s + "px";
      el.style.top = minY * s + "px";
      el.style.width = w * s + "px";
      el.style.height = h * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        a.pts.map((p, k) => (k ? "L" : "M") + (p.x - minX) + " " + (p.y - minY)).join(" ")
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", a.color);
      path.setAttribute("stroke-width", String(a.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      el.appendChild(svg);
      return el;
    }

    if (a.kind === "arrow") {
      // SVG over the arrow's bounding box; line + filled arrowhead.
      const minX = Math.min(a.x1, a.x2);
      const minY = Math.min(a.y1, a.y2);
      const w = Math.max(1, Math.abs(a.x2 - a.x1));
      const h = Math.max(1, Math.abs(a.y2 - a.y1));
      const pad = (a.width || 2) * 3 + 6; // room for the head
      el.style.left = (minX - pad) * s + "px";
      el.style.top = (minY - pad) * s + "px";
      el.style.width = (w + 2 * pad) * s + "px";
      el.style.height = (h + 2 * pad) * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w + 2 * pad} ${h + 2 * pad}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const sx = a.x1 - minX + pad;
      const sy = a.y1 - minY + pad;
      const ex = a.x2 - minX + pad;
      const ey = a.y2 - minY + pad;
      const ang = Math.atan2(ey - sy, ex - sx);
      const hl = Math.max(8, (a.width || 2) * 4); // head length
      const ha = Math.PI / 7; // half-angle
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", sx);
      line.setAttribute("y1", sy);
      line.setAttribute("x2", ex);
      line.setAttribute("y2", ey);
      line.setAttribute("stroke", a.color);
      line.setAttribute("stroke-width", String(a.width || 2));
      line.setAttribute("stroke-linecap", "round");
      const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      const p1 = [ex - hl * Math.cos(ang - ha), ey - hl * Math.sin(ang - ha)];
      const p2 = [ex - hl * Math.cos(ang + ha), ey - hl * Math.sin(ang + ha)];
      head.setAttribute("points", `${ex},${ey} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`);
      head.setAttribute("fill", a.color);
      svg.appendChild(line);
      svg.appendChild(head);
      // Optional label: sits just beyond the head (tip) or tail (base) along the
      // arrow direction, per a.labelEnd. SVG overflow is visible (app.css) so it
      // paints outside the padded box.
      if (a.label) {
        const fs = a.labelSize || 14;
        const lp = arrowLabelPos(a, sx, sy, ex, ey, ang, hl, fs);
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", String(lp.x));
        t.setAttribute("y", String(lp.y));
        t.setAttribute("fill", a.color);
        t.setAttribute("font-size", String(fs));
        t.setAttribute("font-family", "system-ui, Arial, sans-serif");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.style.whiteSpace = "pre";
        t.textContent = a.label;
        svg.appendChild(t);
      }
      el.appendChild(svg);
      // Two end grips on a selected arrow: drag either one to re-aim or re-length it
      // (Shift snaps the angle — see snapLineEnd). An arrow is the one kind whose
      // shape is two POINTS rather than a box, so `RESIZABLE_KINDS`' four corner
      // grips would be meaningless for it — dragging a corner of its bounding box
      // says nothing about which end should move. That is why arrows had no grips at
      // all until v0.2.52 and could only be moved wholesale; `data-pt` is read back
      // by onDown exactly as `data-dir` is for boxes.
      if (gripsFor(a.id)) {
        for (const [pt, gx, gy] of [["1", sx, sy], ["2", ex, ey]]) {
          const g = document.createElement("div");
          g.className = "handle h-pt";
          g.dataset.pt = pt;
          // Positioned in the padded box's own coordinates, like the cloud's grip:
          // the svg viewBox is 1 unit per PDF point, so multiplying by `s` lands the
          // grip on the endpoint at any zoom.
          g.style.cssText = `left:${gx * s}px; top:${gy * s}px; right:auto; bottom:auto;`;
          g.title = pt === "1" ? "Kéo để xoay / đổi độ dài (gốc)" : "Kéo để xoay / đổi độ dài (mũi nhọn)";
          el.appendChild(g);
        }
      }
      return el;
    }

    if (a.kind === "dim") {
      // Dimension line: a stroke between the two picked points, a perpendicular
      // tick at each end, and the measured value centred just off the midpoint.
      const minX = Math.min(a.x1, a.x2);
      const minY = Math.min(a.y1, a.y2);
      const w = Math.max(1, Math.abs(a.x2 - a.x1));
      const h = Math.max(1, Math.abs(a.y2 - a.y1));
      const fs = a.labelSize || 14;
      const pad = (a.width || 2) * 3 + fs + 8; // room for ticks + label
      el.style.left = (minX - pad) * s + "px";
      el.style.top = (minY - pad) * s + "px";
      el.style.width = (w + 2 * pad) * s + "px";
      el.style.height = (h + 2 * pad) * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${w + 2 * pad} ${h + 2 * pad}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const sx = a.x1 - minX + pad;
      const sy = a.y1 - minY + pad;
      const ex = a.x2 - minX + pad;
      const ey = a.y2 - minY + pad;
      const ang = Math.atan2(ey - sy, ex - sx);
      const nx = -Math.sin(ang); // unit perpendicular
      const ny = Math.cos(ang);
      const tick = Math.max(5, (a.width || 2) * 3);
      const mkLine = (x1, y1, x2, y2) => {
        const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", x1);
        ln.setAttribute("y1", y1);
        ln.setAttribute("x2", x2);
        ln.setAttribute("y2", y2);
        ln.setAttribute("stroke", a.color);
        ln.setAttribute("stroke-width", String(a.width || 2));
        ln.setAttribute("stroke-linecap", "round");
        svg.appendChild(ln);
      };
      mkLine(sx, sy, ex, ey);
      mkLine(sx - nx * tick, sy - ny * tick, sx + nx * tick, sy + ny * tick);
      mkLine(ex - nx * tick, ey - ny * tick, ex + nx * tick, ey + ny * tick);
      if (a.text) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", String((sx + ex) / 2 + nx * (tick + fs * 0.7)));
        t.setAttribute("y", String((sy + ey) / 2 + ny * (tick + fs * 0.7)));
        t.setAttribute("fill", a.color);
        t.setAttribute("font-size", String(fs));
        t.setAttribute("font-family", "system-ui, Arial, sans-serif");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.style.whiteSpace = "pre";
        t.textContent = a.text;
        svg.appendChild(t);
      }
      el.appendChild(svg);
      return el;
    }

    if (a.kind === "cloud") {
      // The element covers the padded box (scallops included) so it renders and
      // hit-tests over the whole cloud, like the freehand/arrow overlays.
      const { d, pad, W, H } = cloudPath(a.w, a.h, bumpOf(a));
      el.style.left = (a.x - pad) * s + "px";
      el.style.top = (a.y - pad) * s + "px";
      el.style.width = W * s + "px";
      el.style.height = H * s + "px";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      const cloudFilled = a.fill && a.fill !== "none";
      path.setAttribute("fill", cloudFilled ? a.fill : "none");
      if (cloudFilled) path.setAttribute("fill-opacity", String(a.fillOpacity != null ? a.fillOpacity : 1));
      path.setAttribute("stroke", a.color);
      path.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      el.appendChild(svg);
      if (gripsFor(a.id)) {
        const hnd = document.createElement("div");
        hnd.className = "handle";
        // Pin the resize grip to the true box corner, not the padded corner.
        hnd.style.cssText = `left:${(a.w + pad) * s}px; top:${(a.h + pad) * s}px; right:auto; bottom:auto;`;
        el.appendChild(hnd);
      }
      return el;
    }

    if (a.kind === "cloudpen") {
      if (a.closed) {
        const cp = cloudPathPoly(a.pts, bumpOf(a));
        if (!cp) return el; // degenerate — render nothing (kept only until cleaned up)
        el.style.left = (cp.minX - cp.pad) * s + "px";
        el.style.top = (cp.minY - cp.pad) * s + "px";
        el.style.width = cp.W * s + "px";
        el.style.height = cp.H * s + "px";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${cp.W} ${cp.H}`);
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", cp.d);
        const filled = a.fill && a.fill !== "none";
        path.setAttribute("fill", filled ? a.fill : "none");
        if (filled) path.setAttribute("fill-opacity", String(a.fillOpacity != null ? a.fillOpacity : 1));
        path.setAttribute("stroke", a.color);
        path.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        el.appendChild(svg);
      } else {
        // In-progress polygon/freehand: plain guide polyline + vertex dots, plus a
        // rubber-band segment to the cursor while placing polygon vertices.
        const live = ed._poly && ed._poly.id === a.id && ed._poly.cx != null ? { x: ed._poly.cx, y: ed._poly.cy } : null;
        const chain = live ? a.pts.concat([live]) : a.pts.slice();
        const xs = chain.map((p) => p.x), ys = chain.map((p) => p.y);
        const pad = 6;
        const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
        const w = Math.max(1, Math.max(...xs) + pad - minX);
        const h = Math.max(1, Math.max(...ys) + pad - minY);
        el.style.left = minX * s + "px";
        el.style.top = minY * s + "px";
        el.style.width = w * s + "px";
        el.style.height = h * s + "px";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        if (chain.length > 1) {
          const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
          poly.setAttribute("points", chain.map((p) => `${p.x - minX},${p.y - minY}`).join(" "));
          poly.setAttribute("fill", "none");
          poly.setAttribute("stroke", a.color);
          poly.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
          poly.setAttribute("stroke-dasharray", "4 3");
          poly.setAttribute("stroke-linejoin", "round");
          svg.appendChild(poly);
        }
        a.pts.forEach((p, k) => {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          dot.setAttribute("cx", String(p.x - minX));
          dot.setAttribute("cy", String(p.y - minY));
          dot.setAttribute("r", k === 0 ? "5" : "3"); // first vertex = the close target
          dot.setAttribute("fill", k === 0 ? "#fff" : a.color);
          dot.setAttribute("stroke", a.color);
          dot.setAttribute("stroke-width", "1.5");
          svg.appendChild(dot);
        });
        el.appendChild(svg);
      }
      return el;
    }

    el.style.left = a.x * s + "px";
    el.style.top = a.y * s + "px";
    el.style.width = a.w * s + "px";
    el.style.height = a.h * s + "px";

    if (a.kind === "text") {
      const st = normTextStyle(a);
      el.style.fontSize = a.fontSize * s + "px";
      el.style.color = a.color;
      applyTextCss(el, st, s); // font/weight/style/align/spacing/indent/opacity/decoration
      el.textContent = listDisplayText(a.text, st); // markers are display-only
      // Horizontal character scale — approximate preview (baked PNG is exact).
      if (st.charScale !== 1) {
        el.style.width = (a.w * s) / st.charScale + "px";
        el.style.transformOrigin = "left top";
        el.style.transform = `scaleX(${st.charScale})`;
      }
    } else if (a.kind === "redact") {
      el.style.background = a.color || "#000";
    } else if (a.kind === "highlight") {
      el.style.background = a.color;
    } else if (a.kind === "box") {
      el.style.border = Math.max(1, (a.width || 2)) * s + "px solid " + a.color;
      if (a.fill && a.fill !== "none") el.style.background = hexToRgba(a.fill, a.fillOpacity != null ? a.fillOpacity : 1);
    } else if (a.kind === "ellipse") {
      el.style.border = Math.max(1, (a.width || 2)) * s + "px solid " + a.color;
      el.style.borderRadius = "50%";
      if (a.fill && a.fill !== "none") el.style.background = hexToRgba(a.fill, a.fillOpacity != null ? a.fillOpacity : 1);
    } else if (a.kind === "note") {
      el.style.background = a.color;
      el.title = noteThreadText(a) || "(ghi chú trống)";
      el.textContent = "💬";
      // Badge with the reply count so a thread is visible at a glance.
      const n = (a.replies || []).length;
      if (n) {
        const b = document.createElement("span");
        b.className = "note-badge";
        b.textContent = String(n);
        el.appendChild(b);
      }
    } else if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.draggable = false;
      el.appendChild(img);
    } else if (SYMBOL_KINDS.has(a.kind)) {
      // Drawn from symbolStrokes — the SAME function the bake reads, so screen and
      // PDF cannot drift. Local 0-origin viewBox (the element is already positioned
      // at a.x/a.y above), so the strokes are asked for at the origin.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${Math.max(1, a.w)} ${Math.max(1, a.h)}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      for (const line of symbolStrokes(a.kind, 0, 0, a.w, a.h)) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", line.map((q, k) => (k ? "L" : "M") + q.x + " " + q.y).join(" "));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", a.color);
        path.setAttribute("stroke-width", String(Math.max(1, a.width || 2)));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      }
      el.appendChild(svg);
    }
    // redact needs no extra content (solid black via CSS)

    if (gripsFor(a.id) && RESIZABLE_KINDS.has(a.kind)) {
      for (const dir of HANDLE_DIRS) {
        const h = document.createElement("div");
        h.className = "handle h-" + dir;
        h.dataset.dir = dir; // read back by onDown → resizeRect
        el.appendChild(h);
      }
    }
    return el;
  }

  function renderWatermarkEl() {
    const wm = ed.watermark;
    const el = document.createElement("div");
    el.className = "an an-watermark";
    el.textContent = wm.text;
    el.style.color = wm.color;
    el.style.opacity = String(wm.opacity);
    el.style.fontSize = wm.size * state.scale + "px";
    el.style.transform = `translate(-50%,-50%) rotate(${-wm.angle}deg)`;
    return el;
  }

  // ---- selection -----------------------------------------------------------

  // Every selected id, primary first. `[]` when nothing is selected.
  function selIds() {
    if (ed.sel == null) return [];
    return [ed.sel, ...ed.selMore];
  }
  const isSelected = (id) => id === ed.sel || ed.selMore.has(id);
  // Reshape grips (corner, cloud, arrow-end) are drawn only on a LONE selection.
  // `resizeRect` and `snapLineEnd` each reshape exactly one annot, so grips over a
  // group would be lying about what they do — and eight of them on screen at once
  // gives no clue which object they belong to. A multi-selection can still be dragged
  // and recoloured; to resize one member, click it on its own first. Same call as the
  // `.sel` outline so the two can't disagree about what "selected" means.
  const gripsFor = (id) => id === ed.sel && ed.selMore.size === 0;
  // The live annots behind the current selection, in the order they sit on the page
  // (NOT selection order) — so a copied group pastes back in the same z-order it had.
  function selAnnots() {
    const ids = new Set(selIds());
    if (!ids.size) return [];
    const hit = findAnnot(ed.sel);
    if (!hit) return [];
    return annotsFor(hit.page).filter((a) => ids.has(a.id));
  }

  // Ctrl/Cmd+click: add to (or remove from) the selection, the convention everywhere
  // from Explorer to Illustrator. Clicking an object on ANOTHER page starts a fresh
  // selection rather than extending across pages — a cross-page group would have to
  // repaint two layers on every mousemove of a drag, and "copy these, paste on page 7"
  // is the workflow, not "select things on pages 3 and 7 at once".
  function toggleSelect(id) {
    const hit = findAnnot(id);
    if (!hit) return;
    const cur = ed.sel != null ? findAnnot(ed.sel) : null;
    if (!cur || cur.page !== hit.page) {
      select(id);
      return;
    }
    if (id === ed.sel) {
      // Deselecting the primary promotes one of the others, so the palette always has
      // a subject; the last one out clears the selection entirely.
      const next = ed.selMore.values().next();
      if (next.done) {
        deselect();
        return;
      }
      ed.selMore.delete(next.value);
      ed.sel = next.value;
    } else if (ed.selMore.has(id)) {
      ed.selMore.delete(id);
    } else {
      ed.selMore.add(id);
    }
    syncOverlays();
    afterSelectionChange();
  }

  function select(id) {
    ed.sel = id;
    ed.selMore.clear(); // a plain click is always a fresh single selection
    syncOverlays();
    afterSelectionChange();
  }
  // Everything the UI has to re-read once the selection changes, in one place so
  // `select` and `toggleSelect` cannot fall out of step.
  //
  // This used to also write a gesture hint into #ed-hint (a generic one, a separate
  // arrow one, and a group one). All of that moved to Trợ giúp → Hướng dẫn sử dụng
  // (renderer/help.js): a paragraph of instructions parked permanently in the edit bar
  // is what inflated the bar to 381px tall on a narrow window (BI-41), and it was
  // Vietnamese-only in English mode because #ed-hint is in i18n's SKIP_IDS. #ed-hint
  // survives as a TRANSIENT STATUS slot only — see setEdStatus below.
  function afterSelectionChange() {
    syncControls();
    if (ed.tool === "select") syncCtlVisibility("select");
    updateFmtPanel(); // reflect a newly-selected text box (or hide otherwise)
  }
  function deselect() {
    if (ed.sel == null) return;
    ed.sel = null;
    ed.selMore.clear();
    syncOverlays();
    if (ed.tool === "select") syncCtlVisibility("select");
    updateFmtPanel();
  }
  function deleteSelected() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit) return;
    const ids = new Set(selIds());
    const hadNote = selAnnots().some((a) => a.kind === "note");
    pushEdUndo();
    // One undo step for the whole group: the user made one gesture, so Ctrl+Z should
    // undo one thing. Deleting per-id with a push each would need N presses to reverse.
    ed.annots[hit.page] = ed.annots[hit.page].filter((x) => !ids.has(x.id));
    ed.sel = null;
    ed.selMore.clear();
    syncOverlays();
    if (ed.tool === "select") syncCtlVisibility("select");
    if (hadNote && window.updateComments) window.updateComments();
  }

  // True when `el` is somewhere the user is entering text, so a clipboard gesture
  // aimed at it means characters, not objects. Target-based on purpose: the `copy` /
  // `paste` events carry the element the gesture landed on, which is more precise than
  // app.js's activeElement-based `isTyping()` — an inline annotation editor can be open
  // while the click that produced the event was somewhere else entirely.
  function isTypingTarget(el) {
    if (!el || !el.closest) return false;
    if (el.closest(".annot-text-edit, .annot-note-panel, .span-input")) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable;
  }

  // ---- clipboard (copy an object, paste it on another page) ----------------
  //
  // THE CLIPBOARD DELIBERATELY LIVES OUTSIDE `ed`, and that is the whole feature.
  // `reset()` and `bakePending()` both clear `ed.annots` — so a clip stored in `ed`
  // would be wiped by the very act of pressing "Áp dụng", which is exactly the
  // workflow asked for ("copy … và paste ở 1 trang khác, ngay cả khi đã áp dụng
  // xong"). Kept as its own module-level binding, it survives a bake, a discard, and
  // leaving/re-entering Chỉnh sửa, for as long as the renderer lives. It is NOT
  // persisted to disk and NOT shared between tabs — each tab is its own renderer
  // process (§2), so every tab has its own clipboard. That is a limitation, not an
  // oversight: sharing it would mean putting annotation payloads through IPC.
  //
  // WHAT IT CANNOT DO, so nobody goes looking for the bug: only kinds that round-trip
  // (text / note / arrow / image — MANAGED_KINDS) come back as live objects after a
  // save. Clouds, boxes, ellipses, freehand and ✓/✗ are FLATTENED TO PIXELS when baked
  // (BI-42), so once applied there is no object left to select and copy. Copy them
  // BEFORE applying — the clip outlives the bake, which is what makes that sequence
  // work. Making those kinds re-selectable after a save is a different feature with a
  // known price (BI-37/38).
  let clip = null; // { items: [<annot minus id>], page: <source page>, dropped: {page: n} }
  const PASTE_STEP = 12; // pt of cascade per repeat paste, so copies don't hide

  // Deep copy via JSON, which is sound here BECAUSE every field an annotation holds is
  // a JSON primitive: numbers, strings (including an image's `dataUrl`), booleans, and
  // arrays of {x,y} points or {text,ts} replies. No Date, no Map, no undefined-valued
  // key that matters. structuredClone would also work; JSON additionally drops the
  // `undefined` fields the editor uses to mean "absent" (e.g. a cleared arrow label),
  // which is the behaviour we want anyway.
  const cloneAnnot = (a) => JSON.parse(JSON.stringify(a));

  // Put the whole selection on the clipboard — one object or a Ctrl+click group.
  // Idempotent: copying twice is the same as copying once, which is what lets the
  // button, the context menu, the `copy` DOM event and the Ctrl+C fallback all call it
  // without having to coordinate (see the listeners at the bottom of this file).
  function copySelected() {
    const picked = selAnnots();
    if (!picked.length) return false;
    const items = picked.map((src) => {
      const a = cloneAnnot(src);
      delete a.id; // the paste mints a fresh one from ed.seq
      delete a._managed; // "came back from /NabuData" is about the ORIGINAL, not the copy
      return a;
    });
    clip = { items, page: findAnnot(ed.sel).page, dropped: {} };
    toast(
      items.length > 1
        ? `Đã sao chép ${items.length} mục. Sang trang khác rồi Ctrl+V để dán.`
        : `Đã sao chép 1 mục (${items[0].kind}). Sang trang khác rồi Ctrl+V để dán.`,
      ""
    );
    syncCtlVisibility(ed.tool); // lights up "Dán"
    return true;
  }

  // Drop the clipboard onto `pageIndex` (default: the page being read). Returns true if
  // something was pasted.
  function pasteClip(pageIndex) {
    if (!clip || !clip.items.length) return false;
    if (!ed.active || !state.numPages) return false;
    let i = pageIndex;
    if (i == null) i = typeof currentPageIndex === "function" ? currentPageIndex() : clip.page;
    if (!(i >= 0 && i < state.numPages)) i = 0;

    const fresh = clip.items.map((src) => {
      const a = cloneAnnot(src);
      a.id = ed.seq++;
      return a;
    });

    // Cascade repeats so a second paste is visible instead of sitting exactly on the
    // first. Landing on a DIFFERENT page starts at the original coordinates — that is
    // the point of pasting across pages (same stamp, same spot, like "Áp nhiều
    // trang"); landing back on the SOURCE page starts one step off, or the copy would
    // be perfectly hidden under its original.
    clip.dropped[i] = (clip.dropped[i] || 0) + 1;
    const k = clip.dropped[i] - (i === clip.page ? 0 : 1);
    // Both shifts below are applied to EVERY member with the SAME delta, and the clamp
    // is computed from the group's union box — clamping members individually would
    // shear the group apart on a smaller page (see unionBounds).
    const layer = document.querySelector(`#viewer .page-wrap[data-index="${i}"] .annot-layer`);
    const pw = layer ? +layer.dataset.w : 0;
    const ph = layer ? +layer.dataset.h : 0;
    if (k > 0) for (const a of fresh) translateAnnot(a, PASTE_STEP * k, PASTE_STEP * k);
    const s = fitShift(unionBounds(fresh), pw, ph);
    if (s.dx || s.dy) for (const a of fresh) translateAnnot(a, s.dx, s.dy);

    pushEdUndo(); // one step for the whole paste, however many objects it was
    for (const a of fresh) {
      annotsFor(i).push(a);
      // A pasted text/note/arrow/image is a managed annot on a page that may never have
      // held one, so that page has to repaint on the next bake — same bookkeeping the
      // create paths do (see openTextEditor / placeImage).
      if (isManagedKind(a.kind)) ed._managedPages.add(i);
    }
    if (typeof scrollToPage === "function" && i !== currentPageIndex()) scrollToPage(i);
    syncOverlays();
    // Leave the paste selected so it can be dragged into place immediately — and if it
    // was a group, selected AS a group, so one drag moves all of it.
    select(fresh[0].id);
    if (fresh.length > 1) {
      for (const a of fresh.slice(1)) ed.selMore.add(a.id);
      // select() already ran afterSelectionChange() while selMore was still empty, so
      // run it again now the group is complete — otherwise the outline, the palette and
      // the hint would all describe a single object.
      syncOverlays();
      afterSelectionChange();
    }
    if (fresh.some((a) => a.kind === "note") && window.updateComments) window.updateComments();
    toast(
      fresh.length > 1 ? `Đã dán ${fresh.length} mục vào trang ${i + 1}.` : `Đã dán vào trang ${i + 1}.`,
      "good"
    );
    return true;
  }

  // Flip the selected arrow end for end. Swapping the two points is the WHOLE job:
  // the head is drawn at (x2,y2) and arrowLabelPos reads `labelEnd` against the same
  // pair, so the arrowhead AND its label move to the other end together — which is
  // what "đảo chiều" means on a drawing (the label annotates whatever the arrow is
  // pointing at, so it has to travel with the point).
  //
  // Works on an arrow that was already applied because arrows round-trip: they are in
  // MANAGED_KINDS, so re-entering Chỉnh sửa re-imports them from /NabuData as live
  // objects. Nothing here is bake-aware, and that is deliberately not a coincidence —
  // it is why this feature was possible for arrows but not for clouds/boxes, which
  // flatten to pixels (BI-42).
  function reverseSelectedArrow() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit || hit.a.kind !== "arrow") return;
    const a = hit.a;
    pushEdUndo();
    const { x1, y1 } = a;
    a.x1 = a.x2;
    a.y1 = a.y2;
    a.x2 = x1;
    a.y2 = y1;
    syncOverlays();
  }

  // Reflect the selected annotation's style in the palette controls.
  function syncControls() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit) return;
    const a = hit.a;
    if (a.kind === "redact") {
      $("ed-redact-color").value = toHex(a.color || "#000000");
    } else if (a.color) {
      $("ed-color").value = toHex(a.color);
    }
    if (a.kind === "text") {
      $("ed-fontsize").value = String(a.fontSize);
      $("ed-font").value = a.font || "sans";
      setFmtBtn("ed-bold", a.bold);
      setFmtBtn("ed-italic", a.italic);
      setFmtBtn("ed-underline", a.underline);
    }
    if (["draw", "box", "ellipse", "cloud", "cloudpen", "arrow", "check", "cross"].includes(a.kind) && a.width) $("ed-penwidth").value = String(a.width);
    if (a.kind === "arrow") $("ed-arrowlabel").value = a.labelEnd === "tail" ? "tail" : "head";
    if (a.kind === "cloud" || a.kind === "cloudpen") {
      const b = bumpOf(a);
      $("ed-cloudsize").value = String(b);
      $("ed-cloudsize-val").textContent = String(b);
    }
    if (["box", "ellipse", "cloud", "cloudpen"].includes(a.kind)) {
      const none = !a.fill || a.fill === "none";
      $("ed-fill-none").checked = none;
      if (!none) $("ed-fill").value = a.fill;
      const op = a.fillOpacity != null ? a.fillOpacity : 1;
      $("ed-fill-opacity").value = String(Math.round(op * 100));
      $("ed-fill-opacity-val").textContent = Math.round(op * 100) + "%";
    }
  }
  function setFmtBtn(id, on) {
    const b = $(id);
    if (b) b.classList.toggle("active", !!on);
  }
  function toHex(c) {
    return /^#/.test(c) ? c : c;
  }

  // ---- pointer interaction (create / move / resize) ------------------------

  // `resizeRect` moved to renderer/annot-geom.js at v0.2.48 (see the note above).

  let drag = null; // { type, page, id, layer, sx, sy, orig }

  // Pre-drag snapshot of whichever coordinate fields a kind moves by. Named because a
  // group drag needs one of these per member and cancelDrag needs to put them all back
  // — three copies of this ternary is how the three would drift apart.
  function moveOrigOf(a) {
    if (a.kind === "draw" || a.kind === "cloudpen") return { pts: a.pts.map((q) => ({ ...q })) };
    if (a.kind === "arrow" || a.kind === "dim") return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
    return { x: a.x, y: a.y };
  }
  // Put one annot back where `orig` says it was. The inverse of a move, used by
  // cancelDrag (Esc mid-drag) for every member of the group.
  function restoreMoveOrig(a, orig) {
    if (a.kind === "draw" || a.kind === "cloudpen") a.pts = orig.pts;
    else if (a.kind === "arrow" || a.kind === "dim") {
      a.x1 = orig.x1;
      a.y1 = orig.y1;
      a.x2 = orig.x2;
      a.y2 = orig.y2;
    } else {
      a.x = orig.x;
      a.y = orig.y;
    }
  }

  function onDown(e) {
    if (!ed.active || e.button !== 0) return;
    // Clicks inside an open inline editor (textarea / note panel) belong to it:
    // caret placement and text selection must not fall through to the canvas,
    // where deselect()/renderLayer() would destroy the editor mid-edit.
    if (e.target.closest(".annot-text-edit, .annot-note-panel")) return;
    // Clicking anywhere else commits the open editor first — the re-renders
    // below remove it via innerHTML, which fires no blur, so without this the
    // typed text would be silently lost.
    if (ed._taCommit) ed._taCommit();
    const layer = e.target.closest(".annot-layer");
    if (!layer) return;
    const i = +layer.dataset.index;
    const p = layerPoint(layer, e);

    // Arrow end grip — checked BEFORE the box-corner branch below, because both wear
    // the `.handle` class but they carry different data and drive different maths:
    // `data-pt` moves ONE POINT of a two-point annot, `data-dir` reshapes a BOX. An
    // arrow has no x/y/w/h at all, so falling into the box branch would read four
    // undefineds into `orig` and cancelDrag could never put it back.
    if (e.target.classList.contains("handle") && e.target.dataset.pt) {
      const id = +e.target.closest(".an").dataset.id;
      const a = findAnnot(id).a;
      drag = {
        type: "point", page: i, id, layer,
        pt: e.target.dataset.pt === "1" ? 1 : 2,
        sx: p.x, sy: p.y,
        orig: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 },
        pushed: false, // undo pushed lazily on the first real move, like move/resize
      };
      e.preventDefault();
      return;
    }

    if (e.target.classList.contains("handle")) {
      const id = +e.target.closest(".an").dataset.id;
      const a = findAnnot(id).a;
      // x/y are part of `orig` now: dragging the nw/ne/sw grips moves the box's
      // origin as well as its size, and cancelDrag has to be able to put both back.
      // undo pushed lazily on the first real resize move (see onMove); a click
      // that grabs the handle but never drags leaves the session untouched
      drag = {
        type: "resize", page: i, id, layer, sx: p.x, sy: p.y,
        dir: e.target.dataset.dir || "se", // "se" = the single-grip behaviour this replaced
        orig: { x: a.x, y: a.y, w: a.w, h: a.h },
        pushed: false,
      };
      e.preventDefault();
      return;
    }

    const anEl = e.target.closest(".an");

    if (ed.tool === "select") {
      if (anEl && anEl.dataset.kind !== "watermark") {
        const id = +anEl.dataset.id;
        const a = findAnnot(id).a;
        // Double-click → open the matching editor. Handled on the second
        // mousedown, not in a dblclick listener: select() re-renders the layer,
        // which replaces the clicked element mid-gesture, so the browser
        // retargets the real dblclick event at the layer and it never reaches
        // the annot element.
        if (e.detail >= 2 && (a.kind === "text" || a.kind === "note" || a.kind === "arrow")) {
          e.preventDefault();
          select(id);
          if (a.kind === "text") openTextEditor(layer, i, { x: a.x, y: a.y }, a);
          else if (a.kind === "note") openNoteEditor(layer, i, { x: a.x, y: a.y }, a);
          else openArrowLabelEditor(layer, i, a, true);
          return;
        }
        // Ctrl/Cmd+click extends the selection and does NOT start a drag: the modifier
        // means "also this one", and letting the same gesture nudge the group would
        // make building a selection a minefield.
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleSelect(id);
          return;
        }
        // Clicking a member of an existing multi-selection KEEPS it (so a group can be
        // dragged by grabbing any of its objects, the usual convention); clicking
        // anything else selects just that object.
        if (!isSelected(id)) select(id);
        // undo pushed lazily on the first real move (see onMove); a bare select
        // click must not dirty the session or leave a no-op undo step. `group` carries
        // one origin per selected object so a multi-selection drags as a unit.
        drag = {
          type: "move", page: i, id, layer, sx: p.x, sy: p.y,
          orig: moveOrigOf(a),
          group: selAnnots().map((m) => ({ id: m.id, orig: moveOrigOf(m) })),
          pushed: false,
        };
        e.preventDefault();
      } else {
        deselect();
      }
      return;
    }

    if (ed.tool === "text") {
      // Stop the mousedown's default focus shift, otherwise the freshly-focused
      // textarea blurs immediately → commits empty → vanishes before you can type.
      e.preventDefault();
      const txtEl = e.target.closest(".an-text");
      if (txtEl) {
        // Click on an existing text box edits it instead of stacking a new one.
        const a = findAnnot(+txtEl.dataset.id).a;
        openTextEditor(layer, i, { x: a.x, y: a.y }, a);
      } else {
        openTextEditor(layer, i, p, null);
      }
      return;
    }

    if (ed.tool === "image") {
      if (!ed.pendingImage) {
        toast("Bấm lại công cụ Ảnh để chọn tệp ảnh trước.", "bad");
        return;
      }
      placeImage(i, p);
      return;
    }

    if (ed.tool === "highlight" || ed.tool === "redact" || ed.tool === "box" || ed.tool === "ellipse" || ed.tool === "cloud") {
      // One lookup for all five tools in this branch: highlight and redact both keep
      // their own remembered colour now, and spelling either of them out here again is
      // how this line and colorSlotFor would end up disagreeing.
      const col = ed[colorSlotFor(ed.tool)];
      const a = { id: ed.seq++, kind: ed.tool, x: p.x, y: p.y, w: 1, h: 1, color: col, width: ed.penWidth };
      if (ed.tool === "box" || ed.tool === "ellipse" || ed.tool === "cloud") {
        a.fill = effFill();
        a.fillOpacity = ed.fillOpacity;
      }
      if (ed.tool === "cloud") a.bump = ed.cloudBump;
      pushEdUndo(); // dropped again if the shape ends up tiny/cancelled
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "rect", page: i, id: a.id, layer, sx: p.x, sy: p.y };
      e.preventDefault();
      return;
    }

    if (SYMBOL_KINDS.has(ed.tool)) {
      // Starts exactly like a rectangle drag. The difference is at mouse-UP: a
      // drag too small to be a deliberate box becomes a default-size stamp centred
      // on the click instead of being discarded, so ticking a checkbox is one
      // click while a big ✗ across a clause is still a drag. See onUp.
      const a = { id: ed.seq++, kind: ed.tool, x: p.x, y: p.y, w: 1, h: 1,
                  color: ed[colorSlotFor(ed.tool)], width: ed.penWidth };
      pushEdUndo(); // dropped again if the gesture is cancelled (see cancelDrag)
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "symbol", page: i, id: a.id, layer, sx: p.x, sy: p.y };
      e.preventDefault();
      return;
    }

    if (ed.tool === "arrow") {
      const a = { id: ed.seq++, kind: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ed.color, width: ed.penWidth, labelEnd: ed.arrowLabelEnd };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "arrow", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }

    if (ed.tool === "measure") {
      // Drag out the segment (like arrow). Its dim text is filled on mouseup:
      // the first segment calibrates (asks the real length), later ones are auto
      // numbered by the stored ratio. `text` is a live preview during the drag.
      const a = { id: ed.seq++, kind: "dim", x1: p.x, y1: p.y, x2: p.x, y2: p.y,
                  color: ed.color, width: ed.penWidth, text: "", labelSize: 14 };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "measure", page: i, id: a.id, layer };
      e.preventDefault();
      return;
    }

    if (ed.tool === "note") {
      e.preventDefault(); // keep focus on the note textarea (see text tool above)
      const noteEl = e.target.closest(".an-note");
      if (noteEl) {
        // Click on an existing marker opens its thread (add a reply) instead of
        // dropping a brand-new note on top of it.
        const a = findAnnot(+noteEl.dataset.id).a;
        openNoteEditor(layer, i, { x: a.x, y: a.y }, a);
      } else {
        openNoteEditor(layer, i, p, null);
      }
      return;
    }

    if (ed.tool === "draw") {
      const a = { id: ed.seq++, kind: "draw", pts: [p], color: ed.color, width: ed.penWidth };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      // lineFrom: index the Shift-straight segment pivots on; null = freehand.
      drag = { type: "draw", page: i, id: a.id, layer, lineFrom: null };
      e.preventDefault();
      return;
    }

    if (ed.tool === "cloudpen") {
      // A polygon is being clicked out: only its own page is interactive. Add a
      // vertex, or close if the click lands on the first vertex (≥3 points).
      if (ed._poly) {
        e.preventDefault();
        if (ed._poly.layer !== layer) return; // ignore clicks on other pages
        const hit = findAnnot(ed._poly.id);
        if (hit) {
          const first = hit.a.pts[0];
          const near = first && Math.hypot(p.x - first.x, p.y - first.y) * state.scale < 12;
          if (near && hit.a.pts.length >= 3) {
            closePoly();
          } else {
            hit.a.pts.push(p);
            renderLayer(layer, i);
          }
        }
        return;
      }
      // New stroke: a drag turns freehand (closed on mouse-up); a plain click
      // (no drag) starts a click-to-add-vertex polygon.
      const a = {
        id: ed.seq++,
        kind: "cloudpen",
        pts: [p],
        closed: false,
        color: ed.color,
        width: ed.penWidth,
        fill: effFill(),
        fillOpacity: ed.fillOpacity,
        bump: ed.cloudBump,
      };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      drag = { type: "cloudpen", page: i, id: a.id, layer, downX: p.x, downY: p.y, moved: false };
      e.preventDefault();
      return;
    }
  }

  function onMove(e) {
    // Polygon-in-progress rubber band: track the cursor so the open cloud shows a
    // provisional segment to where the next vertex would land. No active drag here.
    if (!drag && ed._poly) {
      const layer = e.target.closest(".annot-layer");
      if (layer && layer === ed._poly.layer) {
        const q = layerPoint(layer, e);
        ed._poly.cx = q.x;
        ed._poly.cy = q.y;
        renderLayer(layer, ed._poly.page);
      }
      return;
    }
    if (!drag) return;
    const p = layerPoint(drag.layer, e);
    const hit = findAnnot(drag.id);
    if (!hit) {
      drag = null;
      return;
    }
    const a = hit.a;

    // Lazy undo/dirty for move, resize & end-grip drags: only the first gesture that
    // genuinely shifts a point records a snapshot. A click that merely selects (or
    // grabs a handle) without dragging leaves the session clean, so exiting won't
    // re-bake.
    if ((drag.type === "move" || drag.type === "resize" || drag.type === "point") && !drag.pushed && (p.x !== drag.sx || p.y !== drag.sy)) {
      drag.pushed = true;
      pushEdUndo();
    }

    if (drag.type === "move") {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      // Always driven from `orig` + the total delta, never by accumulating per-move
      // steps: the same rule the single-object drag already used, and the reason the
      // group cannot drift apart over a long drag. Every member is on `drag.page`
      // (toggleSelect keeps a selection within one page), so one renderLayer below
      // repaints all of them.
      for (const m of drag.group || [{ id: drag.id, orig: drag.orig }]) {
        const mh = findAnnot(m.id);
        if (!mh) continue;
        const t = mh.a;
        if (t.kind === "draw" || t.kind === "cloudpen") {
          t.pts = m.orig.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
        } else if (t.kind === "arrow" || t.kind === "dim") {
          t.x1 = m.orig.x1 + dx;
          t.y1 = m.orig.y1 + dy;
          t.x2 = m.orig.x2 + dx;
          t.y2 = m.orig.y2 + dy;
        } else {
          t.x = m.orig.x + dx;
          t.y = m.orig.y + dy;
        }
      }
    } else if (drag.type === "point") {
      // Swing / re-length one end of an arrow about the other. Shift is read live off
      // the event (same rule as resize and freehand — BI-42) so it can be pressed and
      // released mid-drag; snapLineEnd keeps the length and quantises the angle.
      const fixedX = drag.pt === 1 ? drag.orig.x2 : drag.orig.x1;
      const fixedY = drag.pt === 1 ? drag.orig.y2 : drag.orig.y1;
      const q = snapLineEnd(fixedX, fixedY, p.x, p.y, e.shiftKey);
      a["x" + drag.pt] = q.x;
      a["y" + drag.pt] = q.y;
    } else if (drag.type === "arrow") {
      a.x2 = p.x;
      a.y2 = p.y;
    } else if (drag.type === "measure") {
      a.x2 = p.x;
      a.y2 = p.y;
      // Live preview: show the length while dragging once a scale is known.
      const d = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      a.text = ed.measureCal ? formatDim(d * ed.measureCal.unitsPerPoint) : "";
    } else if (drag.type === "resize") {
      // Shift is read live off the event, so it can be pressed or released
      // mid-drag and the box follows immediately.
      const g = resizeRect(drag.dir, drag.orig, p.x - drag.sx, p.y - drag.sy, e.shiftKey, 4);
      a.x = g.x;
      a.y = g.y;
      a.w = g.w;
      a.h = g.h;
    } else if (drag.type === "rect" || drag.type === "symbol") {
      a.x = Math.min(drag.sx, p.x);
      a.y = Math.min(drag.sy, p.y);
      a.w = Math.abs(p.x - drag.sx);
      a.h = Math.abs(p.y - drag.sy);
    } else if (drag.type === "draw") {
      // Shift is read live off the event (same rule as resize above), so it can be
      // pressed and released mid-stroke: hold → straight segment from the pinned
      // anchor, release → freehand resumes from where that segment ended. One
      // stroke can therefore mix both. `drag.lineFrom` carries the anchor across
      // moves — deriving it fresh each time collapses the line (see strokeExtend).
      const ext = strokeExtend(a.pts, p, e.shiftKey, drag.lineFrom);
      a.pts = ext.pts;
      drag.lineFrom = ext.anchor;
    } else if (drag.type === "cloudpen") {
      // Past the click threshold this stroke is a freehand drag → collect points.
      if (!drag.moved && Math.hypot(p.x - drag.downX, p.y - drag.downY) * state.scale > 5) drag.moved = true;
      if (drag.moved) a.pts.push(p);
    }
    renderLayer(drag.layer, drag.page);
  }

  function onUp() {
    if (!drag) return;
    // A freehand cloud drag ends by closing the loop; a click (no drag) instead
    // arms polygon mode so further clicks add vertices.
    if (drag.type === "cloudpen") {
      const hit = findAnnot(drag.id);
      if (hit) {
        if (drag.moved) {
          if (cloudPathPoly(hit.a.pts, bumpOf(hit.a))) {
            hit.a.closed = true;
          } else {
            ed.annots[drag.page] = ed.annots[drag.page].filter((x) => x.id !== drag.id);
            ed.sel = null;
            dropLastEdUndo();
          }
        } else {
          ed._poly = { page: drag.page, id: drag.id, layer: drag.layer, cx: null, cy: null };
          // Kept when the per-tool instruction hints were removed: this is not advice,
          // it is the ONLY signal that a polygon is currently open and how to close it.
          setEdStatus("Bấm thêm điểm; bấm vào điểm đầu (hoặc nhấn Enter / bấm đúp) để đóng mây. Esc để huỷ.");
        }
      }
      const layer = drag.layer, page = drag.page;
      drag = null;
      renderLayer(layer, page);
      return;
    }
    // A ✓/✗ that was clicked rather than dragged out: give it the default size
    // centred on the click instead of discarding it as a stray rectangle. Clamped
    // to the page so a click near the edge still lands fully on paper — the box is
    // what the four resize grips act on, and one hanging off the sheet can't be
    // grabbed back.
    if (drag.type === "symbol") {
      const h0 = findAnnot(drag.id);
      if (h0 && (h0.a.w < 4 || h0.a.h < 4)) {
        const a0 = h0.a;
        const pw = +drag.layer.dataset.w || 0;
        const ph = +drag.layer.dataset.h || 0;
        a0.w = SYMBOL_SIZE;
        a0.h = SYMBOL_SIZE;
        a0.x = drag.sx - SYMBOL_SIZE / 2;
        a0.y = drag.sy - SYMBOL_SIZE / 2;
        if (pw) a0.x = Math.max(0, Math.min(pw - SYMBOL_SIZE, a0.x));
        if (ph) a0.y = Math.max(0, Math.min(ph - SYMBOL_SIZE, a0.y));
      }
    }
    const hit = findAnnot(drag.id);
    if (hit) {
      const a = hit.a;
      // Discard accidental zero-size rectangles / single-point scribbles.
      const tinyArrow = drag.type === "arrow" && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 6;
      const tinyDim = drag.type === "measure" && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 6;
      if ((drag.type === "rect" && (a.w < 4 || a.h < 4)) || (drag.type === "draw" && a.pts.length < 2) || tinyArrow || tinyDim) {
        ed.annots[drag.page] = ed.annots[drag.page].filter((x) => x.id !== drag.id);
        ed.sel = null;
        dropLastEdUndo(); // the creation was discarded — state is back at that snapshot
      }
    }
    // A freshly drawn arrow immediately offers a head label (blank/Esc = none).
    // The undo snapshot from creation already covers the label, so no extra push.
    if (drag.type === "arrow") {
      const still = findAnnot(drag.id);
      const la = drag.layer, pg = drag.page;
      drag = null;
      renderLayer(la, pg);
      if (still) openArrowLabelEditor(la, pg, still.a, false);
      return;
    }
    if (drag.type === "measure") {
      const still = findAnnot(drag.id);
      const la = drag.layer, pg = drag.page;
      drag = null;
      renderLayer(la, pg);
      if (still) {
        const a = still.a;
        const d = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
        if (!ed.measureCal) {
          // First segment sets the scale: ask its real length, then back-fill text.
          ed._dimPending = { id: a.id, page: pg, layer: la, pdfDist: d };
          openDimModal();
        } else {
          a.text = formatDim(d * ed.measureCal.unitsPerPoint);
          renderLayer(la, pg);
        }
      }
      return;
    }
    const layer = drag.layer;
    const page = drag.page;
    drag = null;
    renderLayer(layer, page);
  }

  // Finish a click-to-add-vertex cloud: needs ≥3 points, else it's discarded.
  function closePoly() {
    if (!ed._poly) return;
    const info = ed._poly;
    ed._poly = null;
    const hit = findAnnot(info.id);
    if (hit) {
      if (hit.a.pts.length >= 3 && cloudPathPoly(hit.a.pts, bumpOf(hit.a))) {
        hit.a.closed = true;
      } else {
        ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
        ed.sel = null;
        dropLastEdUndo();
      }
    }
    setTool("cloudpen"); // clears the "polygon open" status; stays on the tool for the next cloud
    renderLayer(info.layer, info.page);
  }

  // Abandon a click-to-add-vertex cloud without closing it (Esc).
  function cancelPoly() {
    if (!ed._poly) return;
    const info = ed._poly;
    ed._poly = null;
    ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
    ed.sel = null;
    dropLastEdUndo();
    setTool("cloudpen");
    renderLayer(info.layer, info.page);
  }

  // Esc mid-gesture: abort the in-progress create/move/resize and restore the
  // pre-drag state (the matching undo snapshot is dropped — nothing changed).
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const hit = findAnnot(d.id);
    if (hit) {
      const a = hit.a;
      if (d.type === "rect" || d.type === "draw" || d.type === "arrow" || d.type === "cloudpen" || d.type === "symbol") {
        // creation in progress → remove it entirely
        ed.annots[d.page] = ed.annots[d.page].filter((x) => x.id !== d.id);
        ed.sel = null;
      } else if (d.type === "move") {
        // Every member of the group, not just the one grabbed. (This branch also used
        // to miss `dim`, which shares the arrow's x1/y1/x2/y2 shape — Esc mid-drag left
        // a measured segment where the cursor abandoned it. restoreMoveOrig covers it.)
        for (const m of d.group || [{ id: d.id, orig: d.orig }]) {
          const mh = findAnnot(m.id);
          if (mh) restoreMoveOrig(mh.a, m.orig);
        }
      } else if (d.type === "resize") {
        a.x = d.orig.x;
        a.y = d.orig.y;
        a.w = d.orig.w;
        a.h = d.orig.h;
      } else if (d.type === "point") {
        // Both ends restored, not just the dragged one: `orig` holds the whole line
        // and putting back a single point would leave the other wherever a snap had
        // already moved it.
        a.x1 = d.orig.x1;
        a.y1 = d.orig.y1;
        a.x2 = d.orig.x2;
        a.y2 = d.orig.y2;
      }
      // Creation gestures push on mousedown; move/resize/end-grip push lazily. Only
      // drop a snapshot this gesture actually recorded, else we'd pop a prior step.
      if ((d.type !== "move" && d.type !== "resize" && d.type !== "point") || d.pushed) dropLastEdUndo();
    }
    renderLayer(d.layer, d.page);
  }

  function onDblClick(e) {
    if (!ed.active) return;
    const layer = e.target.closest(".annot-layer");
    if (!layer) return;
    const i = +layer.dataset.index;
    // Double-click closes a polygon cloud in progress. The two mousedowns of the
    // dbl-click each pushed a vertex; drop the near-duplicate last one first.
    if (ed._poly) {
      e.preventDefault();
      const hit = findAnnot(ed._poly.id);
      if (hit && hit.a.pts.length > 3) hit.a.pts.pop();
      closePoly();
      return;
    }
    // Text / note / arrow editors open from the second mousedown (see onDown's
    // select branch): by the time the dblclick event fires the clicked element
    // has been re-rendered, so e.target is retargeted at the layer here and
    // can't be matched against annot elements.
  }

  // ---- text editor (inline textarea; Electron has no window.prompt) --------

  // Starting size of every inline text-entry box in the editor (text box, note,
  // arrow label). One pair of numbers rather than three literals, so the three
  // boxes can't drift apart the next time one of them is tuned. `cols` is in
  // characters, so a box scales with the zoom level for free — a px min-width
  // alone would stay small at 300%.
  const TA_ROWS = 3;
  const TA_COLS = 26;

  function openTextEditor(layer, i, p, existing) {
    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit";
    // A textarea with no rows/cols is 2×20 — cramped enough that users reported
    // typing into a slot barely taller than one line. These are the STARTING size
    // only: `resize: both` (app.css) still lets it be dragged, and the size has no
    // effect on the result, because layoutTextBox never re-wraps (it splits on \n
    // and nothing else) and the annot's own w/h come from measureText on commit,
    // not from this element. So this is free to tune — BI-40 is not in play.
    ta.rows = TA_ROWS;
    ta.cols = TA_COLS;
    const fs = existing ? existing.fontSize : ed.fontSize;
    const st = existing ? normTextStyle(existing) : edTextStyle();
    ta.style.left = p.x * state.scale + "px";
    ta.style.top = p.y * state.scale + "px";
    ta.style.fontSize = fs * state.scale + "px";
    ta.style.color = existing ? existing.color : ed.color;
    applyTextCss(ta, st, state.scale); // live-preview the full paragraph style
    ta.value = existing ? existing.text : "";
    layer.appendChild(ta);
    ta.focus();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      ed._taCommit = null;
      const text = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (existing) {
        // Emptying the box means DELETE it, not "no change". The old `text &&` guard
        // made clearing the text a silent no-op — the user wiped the box, clicked away,
        // and the old words came straight back. An empty text box cannot be kept
        // either: deserializeManaged refuses one on import (`if (!data.text)`), so it
        // would vanish on the next open anyway, and renderTextPng would be asked for a
        // zero-size PNG. The note editor's editOrig branch already got this right. BI-60.
        if (!text) {
          pushEdUndo();
          const hit = findAnnot(existing.id);
          if (hit) ed.annots[hit.page] = ed.annots[hit.page].filter((x) => x.id !== existing.id);
          if (ed.sel === existing.id) ed.sel = null;
          ed.selMore.delete(existing.id);
          if (ed.tool === "select") syncCtlVisibility("select");
        } else if (text !== existing.text) {
          pushEdUndo();
          existing.text = text;
          const m = measureText(text, existing.fontSize, textStyle(existing));
          existing.w = m.w;
          existing.h = m.h;
        }
      } else if (text) {
        pushEdUndo();
        const stNew = edTextStyle();
        const m = measureText(text, ed.fontSize, stNew);
        annotsFor(i).push({
          id: ed.seq++,
          kind: "text",
          x: p.x,
          y: p.y,
          w: m.w,
          h: m.h,
          text,
          fontSize: ed.fontSize,
          color: ed.color,
          ...stNew, // font, bold, italic, underline, strike, align, spacing, list, opacity…
        });
        ed._managedPages.add(i);
      }
      renderLayer(layer, i);
    };
    ed._taCommit = commit; // outside clicks route here before any re-render
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        done = true;
        ed._taCommit = null;
        ta.remove();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        commit();
      }
    });
  }

  // ---- note editor (comment anchored to a point) ---------------------------

  // A note is a small comment thread: the original text plus append-only
  // replies. New note → one textarea (create). Existing note → read-only thread
  // on top, a box to add a reply, and a "Sửa gốc" toggle to edit the original.
  function openNoteEditor(layer, i, p, existing) {
    const panel = document.createElement("div");
    panel.className = "annot-note-panel";
    panel.style.left = (p.x + 20) * state.scale + "px";
    panel.style.top = p.y * state.scale + "px";
    // Clicks inside the panel must not start a drag / new note on the layer.
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    if (existing) {
      const thread = document.createElement("div");
      thread.className = "note-thread";
      const orig = document.createElement("div");
      orig.className = "note-orig-line";
      orig.textContent = existing.text || "(ghi chú trống)";
      thread.appendChild(orig);
      for (const r of existing.replies || []) {
        const rd = document.createElement("div");
        rd.className = "note-reply-line";
        rd.textContent = "↳ " + (r.text || "");
        thread.appendChild(rd);
      }
      panel.appendChild(thread);
    }

    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit annot-note-edit";
    ta.rows = TA_ROWS; // see TA_ROWS — cols is overridden by the panel's width:100%
    ta.placeholder = existing ? "Thêm bình luận…" : "Nội dung ghi chú…";
    panel.appendChild(ta);

    const row = document.createElement("div");
    row.className = "note-actions";
    const btnAdd = document.createElement("button");
    btnAdd.textContent = existing ? "Thêm bình luận" : "Lưu";
    row.appendChild(btnAdd);
    if (existing) {
      const btnEdit = document.createElement("button");
      btnEdit.textContent = "Sửa gốc";
      row.appendChild(btnEdit);
      btnEdit.addEventListener("click", () => {
        mode = "editOrig";
        ta.value = existing.text || "";
        ta.placeholder = "Sửa nội dung ghi chú gốc…";
        btnAdd.textContent = "Lưu ghi chú gốc";
        ta.focus();
      });
    }
    const btnClose = document.createElement("button");
    btnClose.textContent = "Đóng";
    row.appendChild(btnClose);
    panel.appendChild(row);

    layer.appendChild(panel);
    ta.focus();

    let mode = existing ? "reply" : "new"; // reply | new | editOrig
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      ed._taCommit = null;
      panel.remove();
      renderLayer(layer, i);
      if (window.updateComments) window.updateComments(); // keep the Comments panel in sync
    };
    const save = () => {
      const text = ta.value.replace(/\s+$/, "");
      if (mode === "new") {
        if (text) {
          pushEdUndo();
          const a = { id: ed.seq++, kind: "note", x: p.x, y: p.y, w: 18, h: 18, text, color: ed.color, replies: [] };
          annotsFor(i).push(a);
          ed._managedPages.add(i);
          ed.sel = a.id;
        }
      } else if (mode === "editOrig") {
        if (text !== (existing.text || "")) {
          pushEdUndo();
          existing.text = text;
        }
      } else {
        // reply: append without touching the original or earlier replies
        if (text) {
          pushEdUndo();
          if (!existing.replies) existing.replies = [];
          existing.replies.push({ text, ts: Date.now() });
        }
      }
      close();
    };
    // Outside click: keep what was typed (save) rather than silently dropping
    // the panel; an empty box just closes.
    ed._taCommit = () => (ta.value.trim() ? save() : close());
    btnAdd.addEventListener("click", save);
    btnClose.addEventListener("click", close);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  }

  // ---- arrow head label (text anchored to the arrow tip) -------------------

  // `fresh=false` (just-drawn arrow): the label rides the creation undo snapshot,
  // so no extra push. `fresh=true` (double-click edit): push before changing.
  function openArrowLabelEditor(layer, i, a, editing) {
    const ta = document.createElement("textarea");
    ta.className = "annot-text-edit annot-note-edit";
    // Two rows, not TA_ROWS: an arrow label is a short phrase and this box floats
    // over the drawing right next to the arrowhead, so extra height covers the very
    // thing the label is pointing at. The width still comes from TA_COLS.
    ta.rows = 2;
    ta.cols = TA_COLS;
    ta.placeholder = "Nhãn mũi tên… (Enter xong, Esc bỏ qua)";
    // Anchor the input at the end the label belongs to (tail = base, else tip).
    const anchorX = a.labelEnd === "tail" ? a.x1 : a.x2;
    const anchorY = a.labelEnd === "tail" ? a.y1 : a.y2;
    ta.style.left = (anchorX + 8) * state.scale + "px";
    ta.style.top = (anchorY - 12) * state.scale + "px";
    ta.style.color = a.color;
    ta.value = a.label || "";
    layer.appendChild(ta);
    ta.focus();
    ta.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      ed._taCommit = null;
      const text = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (text !== (a.label || "")) {
        if (editing) pushEdUndo();
        a.label = text || undefined;
      }
      renderLayer(layer, i);
    };
    ed._taCommit = commit;
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        done = true;
        ed._taCommit = null;
        ta.remove();
        renderLayer(layer, i);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      }
    });
  }

  // ---- image placement -----------------------------------------------------

  function chooseImage() {
    const inp = $("ed-file");
    inp.value = "";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        // Trust the bytes, not the MIME. PNG/JPEG embed directly; BMP/GIF/WebP
        // are re-encoded to PNG so they still work despite pdf-lib's PNG/JPEG-only limit.
        const emb = await toEmbeddable(reader.result);
        if (!emb) {
          toast("Không đọc được ảnh này — thử PNG, JPG hoặc BMP.", "bad");
          return;
        }
        ed.pendingImage = emb;
        if (emb.fmt === "jpg")
          toast("Đã chọn ảnh JPG (nền đặc) — chữ ký nên dùng PNG nền trong. Bấm lên trang để đặt.", "warn");
        else toast("Đã chọn ảnh — bấm lên trang để đặt.", "good");
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function placeImage(i, p) {
    const img = new Image();
    img.onload = () => {
      const maxW = 240; // points
      const ratio = img.naturalHeight / img.naturalWidth || 1;
      const w = Math.min(img.naturalWidth, maxW);
      const a = {
        id: ed.seq++,
        kind: "image",
        x: p.x,
        y: p.y,
        w,
        h: w * ratio,
        dataUrl: ed.pendingImage.dataUrl,
        fmt: ed.pendingImage.fmt,
      };
      pushEdUndo();
      annotsFor(i).push(a);
      ed.sel = a.id;
      setTool("select");
      syncOverlays();
    };
    img.src = ed.pendingImage.dataUrl;
  }

  // Paste an image (from the OS clipboard) onto a page. Enters edit mode if
  // needed, arms the image tool with the pasted bytes, then the next click on a
  // page places it — reusing the exact same path as the "Ảnh" tool. dataUrl must
  // be a PNG or JPEG data URL (pdf-lib can only embed those). Returns false if the
  // image can't be used (no doc open / unsupported format).
  async function beginImagePaste(dataUrl) {
    if (!state.bytes) {
      toast("Mở một PDF trước khi dán ảnh.", "bad");
      return false;
    }
    const emb = await toEmbeddable(dataUrl);
    if (!emb) {
      toast("Ảnh trong clipboard không dán được.", "bad");
      return false;
    }
    if (!ed.active) enter();
    ed.pendingImage = emb;
    setTool("image");
    toast("Bấm lên trang để dán ảnh.", "good");
    return true;
  }

  // What the current "Áp nhiều trang" input resolves to.
  //
  // The arithmetic is deliberately NOT reimplemented here: `window.PageRange.parseSpec`
  // is the app's ONE page-spec parser (BI-27), the same one behind "Xoá nhiều trang
  // theo khoảng" and mirroring the sidecar's `_parse_ranges` — so "1-3, 5" means the
  // same pages everywhere a user can type it.
  //
  // This file used to carry its own copy, written before that rule existed, and it
  // differed in ways that only ever hurt: an en dash ("1–3", what Word and Excel
  // produce) counted as junk, a semicolon was junk, and ONE bad token threw the whole
  // string away. Merging brings two behaviour changes with it — a junk token is now
  // skipped instead of failing the spec, and a number past the last page clamps to it
  // instead of vanishing. Neither is allowed to be a surprise: `syncImgPages` shows the
  // resolved pages BEFORE the user commits, which is also how the delete-range dialog
  // has always worked (app.js `syncDeleteRange`).
  //
  // Returns { count, hit, raw, targets }: `raw` is what the text parsed to, `targets`
  // is that minus the page the image already sits on, sorted.
  function imgPagesSpec() {
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    const count = (state.pdf && state.pdf.numPages) || 0;
    const raw = window.PageRange.parseSpec($("imgpages-input").value, count);
    const targets = new Set(raw);
    if (hit) targets.delete(hit.page); // the source page already carries the image
    return { count, hit, raw, targets: [...targets].sort((a, b) => a - b) };
  }

  // Live preview + OK gate. Three distinct outcomes get three distinct sentences —
  // "you typed nothing we recognise" and "you named only the page it is already on"
  // are different problems and used to share one misleading message.
  // #imgpages-hint is rewritten on every keystroke, so it is in i18n's SKIP_IDS (BI-10).
  function syncImgPages() {
    const hint = $("imgpages-hint");
    const ok = $("imgpages-ok");
    const s = imgPagesSpec();
    if (ok) ok.disabled = !s.targets.length;
    if (!hint) return;
    if (!$("imgpages-input").value.trim()) {
      hint.textContent = `Tài liệu có ${s.count} trang. Ảnh đang ở trang ${s.hit ? s.hit.page + 1 : 1}.`;
    } else if (!s.raw.size) {
      hint.textContent = "Chưa nhận ra trang nào — vd: 1-3, 5, 8-10.";
    } else if (!s.targets.length) {
      hint.textContent = "Chỉ có đúng trang ảnh đang nằm — chọn thêm trang khác.";
    } else {
      hint.textContent = `Sẽ áp sang ${s.targets.length} trang: ${window.PageRange.formatList(s.targets)}.`;
    }
  }

  function openImgPages() {
    if (ed.sel == null) {
      toast("Chọn ảnh / chữ ký cần áp trước.", "bad");
      return;
    }
    const hit = findAnnot(ed.sel);
    if (!hit || hit.a.kind !== "image") {
      toast("Chỉ áp được cho ảnh / chữ ký đang chọn.", "bad");
      return;
    }
    $("imgpages-input").value = "";
    syncImgPages(); // fills the hint and starts with OK disabled (nothing typed yet)
    $("imgpages-modal").hidden = false;
    setTimeout(() => $("imgpages-input").focus(), 0);
  }

  function applyImgPages() {
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    if (!hit || hit.a.kind !== "image") {
      $("imgpages-modal").hidden = true;
      return;
    }
    const { targets } = imgPagesSpec();
    // Unreachable via the OK button (syncImgPages disables it), but Enter in the
    // field lands here too, so the guard stays.
    if (!targets.length) {
      toast("Chưa có trang hợp lệ để áp. Ví dụ: 1-3, 5, 8-10", "bad");
      return;
    }
    pushEdUndo();
    const src = hit.a;
    let added = 0;
    for (const idx of targets) {
      annotsFor(idx).push({
        id: ed.seq++,
        kind: "image",
        x: src.x,
        y: src.y,
        w: src.w,
        h: src.h,
        dataUrl: src.dataUrl,
        fmt: src.fmt,
      });
      added++;
    }
    $("imgpages-modal").hidden = true;
    syncOverlays();
    toast(`Đã áp ảnh sang ${added} trang.`, "good");
  }

  // ---- PNG rasterisation for baking ---------------------------------------

  function renderTextPng(text, fontSizePt, colorHex, opts) {
    const RS = 3; // supersample for crisp text
    const s = normTextStyle(opts);
    const fpx = fontSizePt * RS;
    // Same layout the on-screen box was measured with (fpx=sizePt*RS, upp=RS).
    const lay = layoutTextBox(text, s, measureCtx(), fpx, RS);
    const pad = Math.ceil(fpx * 0.15);
    const cw = Math.ceil(lay.width) + pad * 2;
    const chh = Math.ceil(lay.height) + pad * 2;
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = chh;
    const cx = c.getContext("2d");
    cx.font = textFont(fpx, s);
    cx.fillStyle = colorHex;
    cx.strokeStyle = colorHex;
    cx.textBaseline = "top";
    cx.globalAlpha = s.opacity;
    // Draw every glyph at its laid-out position; horizontal char-scale is applied
    // per glyph (translate → scaleX → fillText) so advances and drawing agree.
    for (const op of lay.ops) {
      cx.save();
      cx.translate(pad + op.x, pad + op.y);
      if (s.charScale !== 1) cx.scale(s.charScale, 1);
      cx.fillText(op.ch, 0, 0);
      cx.restore();
    }
    // Underline / strikethrough — canvas has neither; draw them from the engine's
    // decoration spans (already in scaled units).
    if (lay.decos.length) {
      cx.lineWidth = Math.max(1, fpx * 0.06);
      for (const d of lay.decos) {
        cx.beginPath();
        cx.moveTo(pad + d.x0, pad + d.y);
        cx.lineTo(pad + d.x1, pad + d.y);
        cx.stroke();
      }
    }
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt: cw / RS, hPt: chh / RS };
  }

  // Rasterise a whole arrow (line + filled head + optional label) to a PNG, for a
  // managed /Stamp appearance. Mirrors the on-screen SVG geometry so the appearance
  // matches the overlay. Returns the PNG bytes, its size in points, and the
  // overlay-space (y-down, scale-1) coordinate of its top-left corner (`ox,oy`) so
  // the caller can map it to the page exactly like the text Stamp does.
  function renderArrowPng(a) {
    const RS = 3; // supersample for crisp lines/text
    const w = a.width || 2;
    const hl = Math.max(8, w * 4); // head length
    const ha = Math.PI / 7; // head half-angle
    const fs = a.labelSize || 14;
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    // Filled-head tips (overlay points), same as the on-screen SVG.
    const p1 = { x: a.x2 - hl * Math.cos(ang - ha), y: a.y2 - hl * Math.sin(ang - ha) };
    const p2 = { x: a.x2 - hl * Math.cos(ang + ha), y: a.y2 - hl * Math.sin(ang + ha) };
    const pts = [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, p1, p2];

    // Label block (measured with the same default font renderTextPng/measureText use).
    const lines = a.label ? String(a.label).split("\n") : [];
    let lblW = 0, lp = null;
    if (lines.length) {
      const mctx = measureCtx();
      mctx.font = textFont(fs);
      for (const ln of lines) lblW = Math.max(lblW, mctx.measureText(ln || " ").width);
      const lblH = fs * 1.3 * lines.length;
      lp = arrowLabelPos(a, a.x1, a.y1, a.x2, a.y2, ang, hl, fs);
      pts.push({ x: lp.x - lblW / 2, y: lp.y - lblH / 2 });
      pts.push({ x: lp.x + lblW / 2, y: lp.y + lblH / 2 });
    }

    const pad = w + 2;
    const minX = Math.min(...pts.map((q) => q.x)) - pad;
    const minY = Math.min(...pts.map((q) => q.y)) - pad;
    const maxX = Math.max(...pts.map((q) => q.x)) + pad;
    const maxY = Math.max(...pts.map((q) => q.y)) + pad;
    const wPt = Math.max(1, maxX - minX);
    const hPt = Math.max(1, maxY - minY);

    const c = document.createElement("canvas");
    c.width = Math.ceil(wPt * RS);
    c.height = Math.ceil(hPt * RS);
    const cx = c.getContext("2d");
    const X = (x) => (x - minX) * RS;
    const Y = (y) => (y - minY) * RS;
    // Shaft.
    cx.strokeStyle = a.color;
    cx.lineWidth = w * RS;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    cx.beginPath();
    cx.moveTo(X(a.x1), Y(a.y1));
    cx.lineTo(X(a.x2), Y(a.y2));
    cx.stroke();
    // Filled arrowhead.
    cx.fillStyle = a.color;
    cx.beginPath();
    cx.moveTo(X(a.x2), Y(a.y2));
    cx.lineTo(X(p1.x), Y(p1.y));
    cx.lineTo(X(p2.x), Y(p2.y));
    cx.closePath();
    cx.fill();
    // Label text, centred on lp (matches the SVG's middle/central anchoring).
    if (lines.length) {
      cx.font = textFont(fs * RS);
      cx.fillStyle = a.color;
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      const lhpx = fs * 1.3 * RS;
      const top = Y(lp.y) - (lhpx * lines.length) / 2 + lhpx / 2;
      lines.forEach((ln, k) => cx.fillText(ln, X(lp.x), top + k * lhpx));
    }
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt, hPt, ox: minX, oy: minY };
  }

  function renderWatermarkPng(wm) {
    const RS = 2;
    const ctx = measureCtx();
    const fpx = wm.size * RS;
    ctx.font = textFont(fpx);
    const tw = Math.max(1, ctx.measureText(wm.text || " ").width);
    const th = fpx * 1.25;
    const ang = (-wm.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(ang));
    const sin = Math.abs(Math.sin(ang));
    const bw = Math.ceil(tw * cos + th * sin) + 4;
    const bh = Math.ceil(tw * sin + th * cos) + 4;
    const c = document.createElement("canvas");
    c.width = bw;
    c.height = bh;
    const cx = c.getContext("2d");
    cx.translate(bw / 2, bh / 2);
    cx.rotate(ang);
    cx.font = textFont(fpx);
    cx.fillStyle = wm.color;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(wm.text, 0, 0);
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt: bw / RS, hPt: bh / RS };
  }

  async function rasterRedacted(i, redacts, vp1) {
    const page = await state.pdf.getPage(i + 1);
    const RS = 2; // ~144 dpi
    const vp = page.getViewport({ scale: RS });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const cx = c.getContext("2d");
    // A page that carries round-trip annots of ours must be rasterised WITHOUT
    // annotations. importManaged lifted them into ed.annots and this bake writes them
    // back as stamps, so burning their old appearance in as well would show every
    // text box / image on the page TWICE — and a round-trip object the user had just
    // deleted would come back as un-removable pixels. Pages with none keep the old
    // behaviour (annotations rendered), so a foreign annotation elsewhere in the
    // document still survives redaction as pixels exactly as before.
    const hadManaged = ed._managedPages.has(i);
    await page.render({
      canvasContext: cx,
      viewport: vp,
      annotationMode: hadManaged ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE,
    }).promise;
    // Burn each box in *its own* colour so the original pixels are gone for good.
    for (const r of redacts) {
      cx.fillStyle = r.color || "#000";
      cx.fillRect(r.x * RS, r.y * RS, r.w * RS, r.h * RS);
    }
    return dataUrlToBytes(c.toDataURL("image/png"));
  }

  // ---- baking --------------------------------------------------------------

  // Editable payload stored in /NabuData so a re-opened file reconstructs the
  // overlay object. Geometry travels here too (not just the /Rect) so retyping /
  // restyling is lossless.
  // `src` is only used by the image kind: the data URL rebuilt from /NabuSrc (see
  // managedSrcBytes). Every other kind is fully described by `data` alone.
  function deserializeManaged(data, src) {
    if (!data || !data.k) return null;
    if (data.k === "text") {
      if (!data.text) return null;
      // normTextStyle fills defaults for any field an older file didn't store.
      const s = normTextStyle(data);
      return { id: ed.seq++, kind: "text", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 1, h: +data.h || 1, text: String(data.text),
               font: data.font || "sans", fontSize: +data.fontSize || 16,
               color: data.color || "#000000", bold: !!data.bold,
               italic: !!data.italic, underline: !!data.underline,
               strike: s.strike, align: s.align, lineHeight: s.lineHeight,
               paraSpacing: s.paraSpacing, letterSpacing: s.letterSpacing,
               wordSpacing: s.wordSpacing, charScale: s.charScale,
               indent: s.indent, listType: s.listType, opacity: s.opacity,
               _managed: true };
    }
    if (data.k === "arrow") {
      return { id: ed.seq++, kind: "arrow",
               x1: +data.x1 || 0, y1: +data.y1 || 0, x2: +data.x2 || 0, y2: +data.y2 || 0,
               color: data.color || "#ffd54a", width: +data.width || 2,
               label: data.label ? String(data.label) : undefined,
               labelEnd: data.labelEnd === "tail" ? "tail" : "head",
               labelSize: +data.labelSize || 14, _managed: true };
    }
    if (isVectorKind(data.k)) {
      // No `fill` key at all ⇒ stroke-only, which is also how a file written before
      // shapes round-tripped reads. `fill` is left OFF the object rather than set to
      // "none": renderAnnot and drawOneAnnot both test `a.fill && a.fill !== "none"`,
      // and an absent key is the shape a freshly-drawn stroke-only box has.
      const a = { id: ed.seq++, kind: data.k,
                  // A LITERAL, and never the remembered default colour — test:defaults
                  // enforces that (by substring, comments included) and it is right to:
                  // the remembered one is a live preference, so reading it here would
                  // silently re-colour every shape in an old file the day the user changes
                  // it. Black matches the text branch's fallback, and the branch is
                  // unreachable in practice anyway (serializeManaged always writes `color`);
                  // it exists so a hand-edited /NabuData still draws something visible.
                  color: data.color || "#000000", width: +data.width || 2,
                  _managed: true };
      if (data.k === "cloudpen") {
        // Junk points are dropped rather than tolerated: a NaN reaches cloudPathPoly's
        // Math.hypot, poisons the whole perimeter length and the cloud renders nowhere.
        const pts = (Array.isArray(data.pts) ? data.pts : [])
          .filter((p) => p && isFinite(+p.x) && isFinite(+p.y))
          .map((p) => ({ x: +p.x, y: +p.y }));
        // Fewer than 3 and cloudPathPoly returns null — an invisible, unselectable ghost
        // in ed.annots that a re-bake would silently drop. Refuse the import instead.
        if (pts.length < 3) return null;
        a.pts = pts;
        // Always true: the only cloudpen a writer can put in a file is a CLOSED scallop
        // loop (cloudPathPoly emits `Z` unconditionally), and renderAnnot draws the open,
        // still-being-clicked polygon down a different path entirely.
        a.closed = true;
      } else {
        a.x = +data.x || 0; a.y = +data.y || 0;
        a.w = +data.w || 1; a.h = +data.h || 1;
      }
      // Absent ⇒ leave `bump` off so bumpOf() falls back to the historical default,
      // which is exactly how a cloud drawn before the size control behaves.
      if (+data.bump) a.bump = +data.bump;
      if (data.fill && data.fill !== "none") {
        a.fill = data.fill;
        a.fillOpacity = data.fillOpacity != null ? +data.fillOpacity : 1;
      }
      return a;
    }
    if (data.k === "note") {
      return { id: ed.seq++, kind: "note", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 18, h: +data.h || 18, text: String(data.text || ""),
               color: data.color || "#ffd54a",
               replies: Array.isArray(data.replies) ? data.replies : [], _managed: true };
    }
    if (data.k === "image") {
      // No usable source bytes → refuse the import. stripManagedFromPage makes the
      // same call and refuses to remove it, so the image survives as a plain stamp
      // instead of being silently deleted on the next bake.
      if (!src) return null;
      return { id: ed.seq++, kind: "image", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 1, h: +data.h || 1,
               dataUrl: src, fmt: data.fmt === "jpg" ? "jpg" : "png", _managed: true };
    }
    return null;
  }

  // Attach `ref` to the page's /Annots array, creating it if absent.
  // Write one managed annotation (text Stamp with image /AP, or note Text annot)
  // into `page`, tagged with /NabuData. Returns true if it was written as a real
  // annotation; false means the caller should fall back to flattening (only text /
  // arrow / image on a rotated page).
  //
  // `share` is a per-bake Map (dataUrl → {imgRef, srcRef}) so the same picture
  // placed on many pages by "Áp ảnh/chữ ký cho nhiều trang" is embedded ONCE. That
  // is safe to share only because every managed annot is stripped in the same pass
  // before a re-bake — see stripManagedAnnots' deferred delete.
  async function addManagedAnnot(doc, page, a, map, share) {
    const ctx = doc.context;
    const dataHex = PDFHexString.fromText(JSON.stringify(serializeManaged(a)));
    // A page carrying /Rotate needs the appearance placed through /Matrix + a
    // re-derived /Rect (managed-codec.js apMatrixFor/apRectFor). Anything that is not
    // a clean quarter turn still falls through to flattening. BI-59.
    const angle = page.getRotation().angle;
    if (a.kind === "image") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const bytes = dataUrlToBytes(a.dataUrl);
      const fmt = a.fmt || sniffImage(bytes);
      if (!fmt) return false; // unknown format — flatten (drawOneAnnot sniffs again)
      const cached = share && share.get(a.dataUrl);
      let imgRef;
      let srcRef;
      if (cached) {
        imgRef = cached.imgRef;
        srcRef = cached.srcRef;
      } else {
        const img = fmt === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        imgRef = img.ref;
        // The ORIGINAL file bytes, verbatim, in a private FILTERLESS stream. They
        // cannot be recovered from the /AP image (pdf-lib re-encodes a PNG into raw
        // samples + an /SMask, throwing the container away), and neither string
        // carrier pdf-lib offers works here — measured on the shipped 1.17.1:
        //   · a /NabuData-style hex string costs ~1.46x the image and takes >1s to
        //     write for 1 MB, a literal string ~1.02x;
        //   · and BOTH PDFHexString.decodeText and PDFString.decodeText throw
        //     RangeError above ~150 KB (they spread the whole buffer through
        //     String.fromCharCode), so a signature PNG would be unreadable anyway.
        // A raw stream is 1.00x, ~5 ms for 2 MB, and reads back as bytes already.
        srcRef = ctx.register(PDFRawStream.of(ctx.obj({ NabuFmt: fmt }), bytes));
        if (share) share.set(a.dataUrl, { imgRef: imgRef, srcRef: srcRef });
      }
      const [bx, by] = map(a.x, a.y + a.h); // lower-left, the same anchor the flattened path uses
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, a.w, a.h],
        Resources: { XObject: { NabuImg: imgRef } },
      };
      // No /Matrix at all on an unrotated page: identical bytes to before BI-59.
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(a.w)} 0 0 ${f(a.h)} 0 0 cm /NabuImg Do Q`));
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, a.w, a.h, bx, by),
        AP: { N: ctx.register(apStream) },
      });
      annot.set(NABU_KIND, PDFName.of("image"));
      annot.set(NABU_DATA, dataHex);
      annot.set(NABU_SRC, srcRef);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (a.kind === "text") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      // Pass the whole annot as the style so alignment / spacing / lists / scale /
      // opacity all bake in (normTextStyle picks the fields it needs).
      const { bytes, wPt, hPt } = renderTextPng(a.text, a.fontSize, a.color, a);
      const img = await doc.embedPng(bytes);
      const padPt = a.fontSize * 0.15;
      const [bx, by] = map(a.x - padPt, a.y - padPt + hPt); // lower-left, matches flattened path
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, wPt, hPt],
        Resources: { XObject: { NabuImg: img.ref } },
      };
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(wPt)} 0 0 ${f(hPt)} 0 0 cm /NabuImg Do Q`));
      const apRef = ctx.register(apStream);
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, wPt, hPt, bx, by),
        AP: { N: apRef },
      });
      annot.set(NABU_KIND, PDFName.of("text"));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (a.kind === "arrow") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const { bytes, wPt, hPt, ox, oy } = renderArrowPng(a);
      const img = await doc.embedPng(bytes);
      const [bx, by] = map(ox, oy + hPt); // overlay top-left → PDF lower-left, like text
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, wPt, hPt],
        Resources: { XObject: { NabuImg: img.ref } },
      };
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(wPt)} 0 0 ${f(hPt)} 0 0 cm /NabuImg Do Q`));
      const apRef = ctx.register(apStream);
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, wPt, hPt, bx, by),
        AP: { N: apRef },
      });
      annot.set(NABU_KIND, PDFName.of("arrow"));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (isVectorKind(a.kind)) {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const shape = shapeAppearance(
        a,
        hexRgb(a.color),
        a.fill && a.fill !== "none" ? hexRgb(a.fill) : null,
        a.fillOpacity != null ? a.fillOpacity : 1
      );
      // A freehand cloud with fewer than 3 distinct points has no path at all. Falling
      // through to drawOneAnnot is the honest answer: it asks cloudPathPoly the same
      // question, gets the same null, and draws nothing — so the two writers agree.
      if (!shape) return false;
      // ONE anchor line for all four kinds: shapeAppearance already resolved the form's
      // overlay bottom-left, padding rule and all. Re-deriving it per kind here is four
      // chances to be off by one stroke width — invisible on screen, wrong in the file.
      const [bx, by] = map(shape.ox, shape.oy);
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, shape.wPt, shape.hPt],
      };
      // Stroke-only shapes get NO /Resources key at all — the common case writes the
      // smaller, simpler dict, and a form with nothing to resolve should not claim one.
      if (shape.resources) ap.Resources = shape.resources;
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(shape.ops));
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, shape.wPt, shape.hPt, bx, by),
        AP: { N: ctx.register(apStream) },
      });
      annot.set(NABU_KIND, PDFName.of(a.kind));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    // note — real Text annotation carrying the thread; marker drawn by the viewer.
    const c = hexRgb(a.color);
    const [rx1, ry1] = map(a.x, a.y + a.h);
    const [rx2, ry2] = map(a.x + a.w, a.y);
    const annot = ctx.obj({
      Type: "Annot", Subtype: "Text", Name: "Comment", Open: false, F: 4,
      Rect: [Math.min(rx1, rx2), Math.min(ry1, ry2), Math.max(rx1, rx2), Math.max(ry1, ry2)],
      Contents: PDFHexString.fromText(noteThreadText(a)),
      C: [c.red, c.green, c.blue],
    });
    annot.set(NABU_KIND, PDFName.of("note"));
    annot.set(NABU_DATA, dataHex);
    pushPageAnnot(doc, page, ctx.register(annot));
    return true;
  }

  const f = (n) => (+n).toFixed(2);
  // The original image bytes behind a managed image annot, or null when they can't
  // be trusted. `null` deliberately means "leave this annot alone": it is neither
  // imported as an editable object nor stripped on the next bake, so a file that has
  // been through another PDF editor loses nothing — the image simply stays a plain
  // stamp. We write the stream with NO /Filter, so any filter at all means someone
  // else re-encoded it and `contents` is no longer the image file.
  // Image bytes → the data URL the overlay <img> and the next bake both need.
  // Uses wire.js's pushB64Chunks, the one tested chunked encoder in the renderer:
  // btoa(String.fromCharCode(...wholeBuffer)) blows the stack on a real photo, and
  // BI-24 is explicit that no new general-purpose byte→base64 helper gets written.
  // One image needing one data: URL is the narrow case that legitimately needs the
  // string at all — do NOT generalise this to documents.
  // Every object a managed annot privately owns, collected for deletion: its /AP
  // form, that form's /NabuImg image (+ the /SMask a transparent PNG brings) and its
  // /NabuSrc stream, then the annot dict itself. Anything that doesn't look exactly
  // like our own output is skipped — worst case we keep the old growth, never a
  // dangling reference.
  // Actually free the collected objects. Deferred to the END of a whole-document
  // strip on purpose: an image source is SHARED by every page "Áp ảnh/chữ ký cho
  // nhiều trang" put it on, so deleting page 1's copy mid-loop would make page 2's
  // managedSrcBytes come back null and its annot would be kept AND re-written —
  // two stamps for one image. Duplicate refs are de-duped here, so sharing is free.
  // Unlink every previously-written managed annotation on `page`, so a re-bake
  // replaces rather than duplicates them, pushing what they own onto `trash` for
  // freeManagedTrash. Returns the count unlinked.
  //
  // Unlinking alone is NOT enough, and that was a real (if quiet) bug: pdf-lib keeps
  // every parsed object and writes them all back, so the appearance PNG of each
  // replaced stamp stayed in the file forever — a text box re-baked ten times
  // shipped ten copies of its PNG. With images (megabytes) that growth is impossible
  // to ignore, hence the chain delete. It is provably safe: pdf-lib's embedPng /
  // embedJpg hand out a FRESH ref per call (they never dedupe by content), and
  // /NabuImg is a resource name nothing else writes, so once the annot is gone
  // nothing can still point at its appearance.
  // Parse managed annotations out of the current document into live overlay
  // objects (per page) so they can be edited again. Read-only w.r.t. the PDF.
  async function importManaged() {
    if (!state.bytes) return 0;
    let doc;
    try { doc = await PDFDocument.load(state.bytes); } catch (_) { return 0; }
    const pages = doc.getPages();
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      const arr = pages[i].node.Annots();
      if (!arr) continue;
      for (let j = 0; j < arr.size(); j++) {
        const dict = doc.context.lookup(arr.get(j));
        if (!(dict instanceof PDFDict) || !dict.get(NABU_KIND)) continue;
        const dataObj = dict.get(NABU_DATA);
        if (!dataObj || typeof dataObj.decodeText !== "function") continue;
        let parsed;
        try { parsed = JSON.parse(dataObj.decodeText()); } catch (_) { continue; }
        let src = null;
        if (parsed && parsed.k === "image") {
          const raw = managedSrcBytes(doc, dict);
          if (raw) src = managedSrcDataUrl(raw);
        }
        const a = deserializeManaged(parsed, src);
        if (a) { annotsFor(i).push(a); ed._managedPages.add(i); count++; }
      }
    }
    return count;
  }

  // Pages with a /Rotate entry (common in scans) display rotated, but pdf-lib
  // draws in *unrotated* user space. Without compensating, baked PNGs (text
  // comment, image, watermark) come out rotated 90/180/270°. We pin the image's
  // visual lower-left to the already-mapped anchor and spin the glyphs back by
  // the page rotation so they read upright after the viewer applies it.
  //
  // WHICH PRIMITIVES NEED THAT, and why the answer is not "the images" (v0.2.52).
  // `map` = vp1.convertToPdfPoint, and the pdf.js scale-1 viewport already carries
  // the rotation — so anything whose geometry is built from INDEPENDENTLY MAPPED
  // POINTS is correct for free: drawLine per segment (draw / arrow line + head /
  // dim line + ticks / ✓✗ strokes), drawRectangle from min/max of two mapped
  // corners (box / highlight), drawEllipse from a mapped centre + mapped extents
  // (its semi-axes swap with the page, which is exactly right).
  // Anything that instead hands pdf-lib a LOCAL coordinate system and lets it
  // place that system needs `rotate:` explicitly, because the local axes are in
  // DISPLAY space while pdf-lib reads them as user space. Today that is
  // `drawImage` (text / image / watermark / the arrow + dim label PNGs) AND
  // `drawSvgPath` (cloud / cloudpen) — the second one was missed when revision
  // clouds landed after the v0.2.11 image fix, so khoanh mây baked spun on every
  // rotated page until v0.2.52. Measured on the shipped pdf.js 3.11.174 +
  // pdf-lib 1.17.1: drawSvgPath applies translate(x,y)·R(rotate)·scale(1,-1), and
  // R(pageAngle)·scale(1,-1) IS the display→user linear map convertToPdfPoint
  // implies, at all four angles; at 0° it is the identity, so unrotated documents
  // are bit-for-bit unchanged. `npm run test:rotate` pins all of the above per
  // kind and carries a guard case that fails if the option is removed. BI-45.
  //
  // `share` is the per-bake embed cache threaded down to addManagedAnnot; a bake
  // that doesn't pass one simply embeds every image separately (still correct).
  async function drawAnnots(doc, page, anns, vp1, mode, share) {
    const map = makeMap(vp1, mode);
    let failed = 0;
    for (const a of anns) {
      try {
        // Text boxes, notes, arrows and images go in as real, re-editable
        // annotations; only the rotated-page fallback (addManagedAnnot → false)
        // drops through to flatten.
        if (isManagedKind(a.kind)) {
          const done = await addManagedAnnot(doc, page, a, map, share);
          if (done) continue;
        }
        await drawOneAnnot(doc, page, a, map);
      } catch (err) {
        // Isolate failures: one bad annotation (e.g. a corrupt image) must not
        // wipe out every other pending edit in the same bake.
        failed++;
        console.error("drawAnnot failed:", a.kind, err);
      }
    }
    if (failed) toast(`Bỏ qua ${failed} mục lỗi khi áp dụng (ảnh hỏng?).`, "warn");
  }

  async function drawOneAnnot(doc, page, a, map) {
    if (a.kind === "highlight") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          color: hexRgb(a.color),
          opacity: 0.35,
        });
      } else if (a.kind === "draw") {
        const c = hexRgb(a.color);
        for (let k = 1; k < a.pts.length; k++) {
          const [sx, sy] = map(a.pts[k - 1].x, a.pts[k - 1].y);
          const [ex, ey] = map(a.pts[k].x, a.pts[k].y);
          page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color: c });
        }
      } else if (a.kind === "text") {
        const { bytes, wPt, hPt } = renderTextPng(a.text, a.fontSize, a.color, a);
        const img = await doc.embedPng(bytes);
        // The PNG carries ~0.15em padding; offset so the glyphs line up with
        // where the overlay (zero-padding) showed them.
        const padPt = a.fontSize * 0.15;
        const [bx, by] = map(a.x - padPt, a.y - padPt + hPt);
        page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
      } else if (a.kind === "box") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawRectangle(opts);
      } else if (a.kind === "ellipse") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2,
          xScale: Math.abs(x2 - x1) / 2,
          yScale: Math.abs(y2 - y1) / 2,
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawEllipse(opts);
      } else if (a.kind === "cloud") {
        // Scallop outline mapped like the freehand path: (0,0) of the SVG sits at
        // the padded top-left; drawSvgPath draws downward from there (it flips y),
        // so at rotation 0 the bake matches the overlay pixel-for-pixel.
        const { d, pad } = cloudPath(a.w, a.h, bumpOf(a));
        const [bx, by] = map(a.x - pad, a.y - pad);
        const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2, rotate: pageRotate(page) };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawSvgPath(d, opts);
      } else if (a.kind === "cloudpen") {
        const cp = cloudPathPoly(a.pts, bumpOf(a));
        if (cp) {
          const [bx, by] = map(cp.minX - cp.pad, cp.minY - cp.pad);
          const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2, rotate: pageRotate(page) };
          if (a.fill && a.fill !== "none") {
            opts.color = hexRgb(a.fill);
            opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
          }
          page.drawSvgPath(cp.d, opts);
        }
      } else if (SYMBOL_KINDS.has(a.kind)) {
        // Same strokes the overlay drew, endpoint-mapped one at a time — so page
        // rotation and the redaction "image" mode are handled by `map`, exactly
        // like arrow/dim. Round caps to match the SVG's stroke-linecap.
        const c = hexRgb(a.color);
        const w = Math.max(1, a.width || 2);
        for (const line of symbolStrokes(a.kind, a.x, a.y, a.w, a.h)) {
          for (let k = 1; k < line.length; k++) {
            const [sx, sy] = map(line[k - 1].x, line[k - 1].y);
            const [ex, ey] = map(line[k].x, line[k].y);
            page.drawLine({
              start: { x: sx, y: sy }, end: { x: ex, y: ey },
              thickness: w, color: c, lineCap: PDFLib.LineCapStyle.Round,
            });
          }
        }
      } else if (a.kind === "arrow") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // arrowhead: two short strokes back from the tip
        const ang = Math.atan2(ey - sy, ex - sx);
        const hl = Math.max(8, w * 4);
        const ha = Math.PI / 7;
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang - ha), y: ey - hl * Math.sin(ang - ha) },
          thickness: w,
          color: c,
        });
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang + ha), y: ey - hl * Math.sin(ang + ha) },
          thickness: w,
          color: c,
        });
        // Label — rendered to PNG (same path as text annots, so Vietnamese
        // diacritics embed reliably), centred just beyond the head or tail per
        // a.labelEnd.
        if (a.label) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.label, fs, a.color, {});
          // Anchor in overlay coords (y-down), matching the on-screen placement.
          const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
          const lp = arrowLabelPos(a, a.x1, a.y1, a.x2, a.y2, angO, hl, fs);
          const img = await doc.embedPng(bytes);
          const [bx, by] = map(lp.x - wPt / 2, lp.y + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "dim") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // End ticks: perpendicular in overlay (y-down) space, endpoints mapped.
        const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const nxO = -Math.sin(angO);
        const nyO = Math.cos(angO);
        const tick = Math.max(5, w * 3);
        for (const pt of [[a.x1, a.y1], [a.x2, a.y2]]) {
          const [t1x, t1y] = map(pt[0] - nxO * tick, pt[1] - nyO * tick);
          const [t2x, t2y] = map(pt[0] + nxO * tick, pt[1] + nyO * tick);
          page.drawLine({ start: { x: t1x, y: t1y }, end: { x: t2x, y: t2y }, thickness: w, color: c });
        }
        // Measured value — PNG (same Vietnamese-safe path as text/arrow labels).
        if (a.text) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.text, fs, a.color, {});
          const img = await doc.embedPng(bytes);
          const mxO = (a.x1 + a.x2) / 2 + nxO * (tick + fs * 0.7);
          const myO = (a.y1 + a.y2) / 2 + nyO * (tick + fs * 0.7);
          const [bx, by] = map(mxO - wPt / 2, myO + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "note") {
        // 1. Visible marker square so the note shows in any viewer (incl. ours).
        const c = hexRgb(a.color);
        const [mx, my] = map(a.x, a.y + a.h);
        page.drawRectangle({
          x: mx,
          y: my,
          width: a.w,
          height: a.h,
          color: c,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 0.5,
        });
        // 2. Real PDF Text annotation (sticky note) carrying the comment text.
        const [rx1, ry1] = map(a.x, a.y + a.h);
        const [rx2, ry2] = map(a.x + a.w, a.y);
        const ctx = doc.context;
        const ann = ctx.obj({
          Type: "Annot",
          Subtype: "Text",
          Name: "Comment",
          Rect: [Math.min(rx1, rx2), Math.min(ry1, ry2), Math.max(rx1, rx2), Math.max(ry1, ry2)],
          Contents: PDFHexString.fromText(noteThreadText(a)),
          Open: false,
          C: [c.red, c.green, c.blue],
        });
        const ref = ctx.register(ann);
        let arr = page.node.Annots();
        if (!arr) {
          arr = ctx.obj([]);
          page.node.set(PDFName.of("Annots"), arr);
        }
        arr.push(ref);
      } else if (a.kind === "image") {
        const bytes = dataUrlToBytes(a.dataUrl);
        // fmt was sniffed from magic bytes at selection time; fall back to a byte
        // sniff for any older in-memory annotation that predates this field.
        const fmt = a.fmt || sniffImage(bytes);
        const img = fmt === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [bx, by] = map(a.x, a.y + a.h);
        page.drawImage(img, { x: bx, y: by, width: a.w, height: a.h, rotate: pageRotate(page) });
      }
  }

  async function drawWatermark(doc, page, vp1, mode) {
    const { bytes, wPt, hPt } = renderWatermarkPng(ed.watermark);
    const img = await doc.embedPng(bytes);
    const map = makeMap(vp1, mode);
    const cx = (vp1.width - wPt) / 2;
    const cy = (vp1.height - hPt) / 2;
    const [bx, by] = map(cx, cy + hPt);
    page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, opacity: ed.watermark.opacity, rotate: pageRotate(page) });
  }

  async function bakeInPlace() {
    const doc = await PDFDocument.load(state.bytes);
    stripManagedAnnots(doc); // drop the previous round-trip copies; re-added from ed.annots below
    const share = new Map(); // one embed per distinct image across the whole bake
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const anns = annotsFor(i);
      if (!anns.length && !ed.watermark) continue;
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      await drawAnnots(doc, pages[i], anns, vp1, "orig", share);
      if (ed.watermark) await drawWatermark(doc, pages[i], vp1, "orig");
    }
    return await doc.save();
  }

  async function bakeWithRedaction() {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const share = new Map(); // see bakeInPlace
    // Copied pages carry the old round-trip annots. They are unlinked page by page
    // but freed only after the loop, because a shared image source must stay
    // readable while later pages are still being checked (see freeManagedTrash).
    const trash = [];
    const n = state.numPages;
    for (let i = 0; i < n; i++) {
      const anns = annotsFor(i);
      const redacts = anns.filter((a) => a.kind === "redact");
      const others = anns.filter((a) => a.kind !== "redact");
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      let page;
      let mode;
      if (redacts.length) {
        const png = await rasterRedacted(i, redacts, vp1);
        const img = await out.embedPng(png);
        page = out.addPage([vp1.width, vp1.height]);
        page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        mode = "image";
      } else {
        const [cp] = await out.copyPages(src, [i]);
        out.addPage(cp);
        page = cp;
        mode = "orig";
        stripManagedFromPage(out, page, trash); // copied page carried the old round-trip copies
      }
      if (others.length) await drawAnnots(out, page, others, vp1, mode, share);
      if (ed.watermark) await drawWatermark(out, page, vp1, mode);
    }
    freeManagedTrash(out, trash);
    return await out.save();
  }

  // Bake all pending overlay edits into state.bytes and re-render. Returns
  // whether anything was applied. Called by Save and on exit.
  async function bakePending() {
    if (ed._taCommit) ed._taCommit(); // an open editor's text must make the bake
    // `!hasAny()` alone was the bug: with every round-trip annot deleted there is
    // nothing to ADD but plenty to REMOVE, and returning early left them in the PDF —
    // so Ctrl+S and "Xong" both looked like they worked and changed nothing. BI-60.
    if (!hasAny() && !ed._importedManaged) return false;
    showOverlay("Đang áp dụng chỉnh sửa…");
    try {
      const anyRedact = Object.values(ed.annots).some((a) => a.some((x) => x.kind === "redact"));
      const bytes = anyRedact ? await bakeWithRedaction() : await bakeInPlace();
      // Only the annotated pages change pixels (watermark hits every page) — so we
      // can repaint just those instead of reloading the whole document.
      let changed = null;
      if (!ed.watermark) {
        changed = new Set();
        for (const k of Object.keys(ed.annots)) if (ed.annots[k].length) changed.add(+k);
        // Pages whose managed appearance changed (incl. a text/note just deleted,
        // so it's no longer in ed.annots) must repaint too.
        for (const k of ed._managedPages) changed.add(k);
      }
      if (window.DocHistory) window.DocHistory.pushUndo(); // one doc-level undo step per bake
      state.bytes = bytes;
      ed.annots = {};
      ed.watermark = null;
      ed.sel = null;
      ed._dirty = false;
      clearEdHistory(); // baked annotations can't be un-done at annotation level anymore
      await rerenderChanged(changed);
      // Mid-session save (still editing): pull the managed annots back in so text
      // boxes / notes stay editable and their baked copies stay hidden.
      if (ed.active && !ed._exiting) {
        ed._importedManaged = await importManaged(); // re-read: the count must track the FILE
        if (window.repaintRenderedPages) await window.repaintRenderedPages();
        syncOverlays();
      }
      toast("Đã áp dụng chỉnh sửa.", "good");
      return true;
    } catch (err) {
      toast("Lỗi áp dụng: " + (err.message || err), "bad");
      throw err;
    } finally {
      hideOverlay();
    }
  }

  // ---- watermark dialog ----------------------------------------------------

  function openWatermark() {
    $("wm-modal").hidden = false;
  }
  function applyWatermark() {
    const text = $("wm-text").value.trim();
    if (!text) {
      toast("Nhập nội dung watermark.", "bad");
      return;
    }
    pushEdUndo();
    ed.watermark = {
      text,
      size: Math.max(8, +$("wm-size").value || 56),
      angle: +$("wm-angle").value || 0,
      opacity: Math.min(1, Math.max(0.05, +$("wm-opacity").value || 0.22)),
      color: $("wm-color").value || "#888888",
    };
    $("wm-modal").hidden = true;
    syncOverlays();
    toast("Đã thêm watermark — bấm Áp dụng để ghi vào PDF.", "good");
  }

  // ---- measure / dimension tool -------------------------------------------

  // Format a measured value to the configured decimals, drop trailing zeros, and
  // append the unit ("10.00 m" → "10 m", "3.14159 m" → "3.14 m").
  function formatDim(value) {
    const dec = Math.max(0, Math.min(6, ed.measureDecimals | 0));
    let s = Number(value).toFixed(dec);
    if (dec > 0) s = s.replace(/\.?0+$/, "");
    return ed.measureUnit ? `${s} ${ed.measureUnit}`.trim() : s;
  }

  // Show the calibration dialog for the just-drawn known-length segment. Seeds the
  // inputs from the last-used unit/decimals so repeat calibrations are one keypress.
  function openDimModal() {
    $("dim-length").value = "";
    $("dim-unit").value = ed.measureUnit || "m";
    $("dim-decimals").value = String(ed.measureDecimals);
    $("dim-modal").hidden = false;
    setTimeout(() => $("dim-length").focus(), 0);
  }

  // OK on the calibration dialog: turn the entered real length into a scale ratio,
  // back-fill the pending segment's text, and keep the tool ready for the rest.
  function applyDim() {
    const p = ed._dimPending;
    if (!p) {
      $("dim-modal").hidden = true;
      return;
    }
    const real = parseFloat(String($("dim-length").value).replace(",", "."));
    if (!(real > 0)) {
      toast("Nhập chiều dài thật (số dương) của đoạn đã vẽ.", "bad");
      return;
    }
    ed.measureUnit = ($("dim-unit").value || "").trim();
    ed.measureDecimals = Math.max(0, Math.min(6, parseInt($("dim-decimals").value, 10) || 0));
    ed.measureCal = { unitsPerPoint: real / p.pdfDist };
    const hit = findAnnot(p.id);
    if (hit) hit.a.text = formatDim(real);
    ed._dimPending = null;
    $("dim-modal").hidden = true;
    renderLayer(p.layer, p.page);
    if (ed.tool === "measure") setTool("measure"); // refresh the scale status to "đã hiệu chuẩn"
    toast("Đã hiệu chuẩn tỷ lệ — kéo các đoạn khác để tự ghi kích thước.", "good");
  }

  // Cancel calibration: drop the pending (uncalibrated) segment entirely.
  function cancelDim() {
    const p = ed._dimPending;
    $("dim-modal").hidden = true;
    if (!p) return;
    ed.annots[p.page] = (ed.annots[p.page] || []).filter((x) => x.id !== p.id);
    if (ed.sel === p.id) ed.sel = null;
    dropLastEdUndo();
    ed._dimPending = null;
    renderLayer(p.layer, p.page);
  }

  // "Hiệu chuẩn lại": forget the scale so the next drawn segment recalibrates.
  function recalibrateMeasure() {
    ed.measureCal = null;
    if (ed.tool === "measure") setTool("measure");
    toast("Kéo một đoạn có kích thước đã biết để hiệu chuẩn lại.", "");
  }

  // ---- form fill -----------------------------------------------------------

  async function openForm() {
    showOverlay("Đang đọc biểu mẫu…");
    let doc;
    let fields;
    try {
      doc = await PDFDocument.load(state.bytes);
      fields = doc.getForm().getFields();
    } catch (e) {
      hideOverlay();
      toast("Không đọc được biểu mẫu: " + e.message, "bad");
      return;
    }
    hideOverlay();
    if (!fields.length) {
      toast("PDF này không có trường biểu mẫu (AcroForm).", "bad");
      return;
    }
    ed._formDoc = doc;
    buildFormUI(fields);
    $("form-modal").hidden = false;
  }

  function buildFormUI(fields) {
    const box = $("form-fields");
    box.innerHTML = "";
    ed._form = [];
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "form-row";
      const lab = document.createElement("label");
      lab.textContent = f.getName();
      let input;
      let kind;
      if (f instanceof PDFLib.PDFTextField) {
        kind = "text";
        input = document.createElement("input");
        input.type = "text";
        try {
          input.value = f.getText() || "";
        } catch (_) {}
      } else if (f instanceof PDFLib.PDFCheckBox) {
        kind = "check";
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = f.isChecked();
      } else if (f instanceof PDFLib.PDFDropdown) {
        kind = "dropdown";
        input = makeSelect(f.getOptions(), (f.getSelected() || [])[0]);
      } else if (f instanceof PDFLib.PDFRadioGroup) {
        kind = "radio";
        input = makeSelect(f.getOptions(), f.getSelected(), true);
      } else {
        kind = "skip";
        input = document.createElement("input");
        input.type = "text";
        input.disabled = true;
        input.placeholder = "(loại trường không hỗ trợ)";
      }
      row.appendChild(lab);
      row.appendChild(input);
      box.appendChild(row);
      ed._form.push({ f, kind, input });
    }
  }
  function makeSelect(options, selected, blank) {
    const sel = document.createElement("select");
    if (blank) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "—";
      sel.appendChild(o);
    }
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = o.textContent = opt;
      sel.appendChild(o);
    }
    if (selected) sel.value = selected;
    return sel;
  }

  async function applyForm() {
    showOverlay("Đang điền biểu mẫu…");
    try {
      for (const { f, kind, input } of ed._form) {
        if (kind === "text") f.setText(input.value);
        else if (kind === "check") input.checked ? f.check() : f.uncheck();
        else if (kind === "dropdown" && input.value) f.select(input.value);
        else if (kind === "radio" && input.value) f.select(input.value);
      }
      if ($("form-flatten").checked) ed._formDoc.getForm().flatten();
      if (window.DocHistory) window.DocHistory.pushUndo();
      state.bytes = await ed._formDoc.save();
      ed._form = null;
      ed._formDoc = null;
      $("form-modal").hidden = true;
      await renderAll();
      toast("Đã điền biểu mẫu.", "good");
    } catch (e) {
      toast("Lỗi điền biểu mẫu: " + e.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // ---- mode + palette wiring ----------------------------------------------

  // Which palette controls (data-ctl) are relevant per drawing tool.
  const TOOL_CTLS = {
    text: ["color", "font", "fontsize", "biu"],
    highlight: ["color"],
    draw: ["color", "penwidth"],
    box: ["color", "penwidth", "fill"],
    ellipse: ["color", "penwidth", "fill"],
    cloud: ["color", "penwidth", "fill", "cloudsize"],
    cloudpen: ["color", "penwidth", "fill", "cloudsize"],
    // No "arrowrev" here: reversing needs an arrow to reverse, and under the arrow
    // TOOL nothing is selected yet. It is a KIND_CTLS-only control (see below).
    arrow: ["color", "penwidth", "arrowlabel"],
    note: ["color"],
    image: [],
    redact: ["redact"],
    measure: ["color", "penwidth", "measure"],
    check: ["color", "penwidth"],
    cross: ["color", "penwidth"],
  };
  // Which controls an already-placed annotation of a given kind can tweak. Used
  // by the Select tool so the palette shows only what the *selected* item needs
  // (nothing when the selection is empty) instead of every control at once.
  const KIND_CTLS = {
    text: ["color", "font", "fontsize", "biu"],
    highlight: ["color"],
    draw: ["color", "penwidth"],
    box: ["color", "penwidth", "fill"],
    ellipse: ["color", "penwidth", "fill"],
    cloud: ["color", "penwidth", "fill", "cloudsize"],
    cloudpen: ["color", "penwidth", "fill", "cloudsize"],
    arrow: ["color", "penwidth", "arrowlabel", "arrowrev"],
    note: ["color"],
    image: ["imgpages"],
    redact: ["redact"],
    dim: ["color", "penwidth"],
    check: ["color", "penwidth"],
    cross: ["color", "penwidth"],
  };
  // Show the palette controls relevant to the current context: for a drawing
  // tool, the tool's controls; for Select, only the selected annotation's (or
  // none). Keeps the edit bar tidy instead of dumping every control under Select.
  function syncCtlVisibility(tool) {
    let show;
    if (tool === "select") {
      const hit = ed.sel != null ? findAnnot(ed.sel) : null;
      show = hit ? KIND_CTLS[hit.a.kind] || [] : [];
    } else {
      show = TOOL_CTLS[tool] || [];
    }
    document.querySelectorAll("#edit-bar [data-ctl]").forEach((el) => {
      el.hidden = !show.includes(el.dataset.ctl);
    });
    // Copy/Paste stay VISIBLE at all times and go grey instead, unlike the data-ctl
    // controls above which hide. A control that vanishes is one the user stops looking
    // for; "Dán" greyed out is what tells them a clipboard exists at all — and it is
    // enabled across pages and across an Áp dụng, which is the whole point of the
    // clip living outside `ed`.
    const bCopy = $("ed-copy");
    if (bCopy) bCopy.disabled = ed.sel == null;
    const bPaste = $("ed-paste");
    if (bPaste) bPaste.disabled = !clip || !clip.items.length;
    updateFmtPanel();
  }

  function setTool(tool) {
    // Leaving the cloud-pen tool abandons a polygon still being clicked out.
    if (ed._poly && tool !== "cloudpen") {
      const info = ed._poly;
      ed._poly = null;
      ed.annots[info.page] = (ed.annots[info.page] || []).filter((x) => x.id !== info.id);
      if (ed.sel === info.id) ed.sel = null;
      dropLastEdUndo();
      renderLayer(info.layer, info.page);
    }
    ed.tool = tool;
    document.querySelectorAll("#ed-tools .tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    // Show the colour this tool actually draws with, or picking ✓ would display the
    // shared default while stamping green — and picking Tô sáng would show red while
    // laying down yellow.
    const cpick = $("ed-color");
    if (cpick) cpick.value = ed[colorSlotFor(tool)];
    syncCtlVisibility(tool);
    // #ed-hint used to hold a per-tool instruction sentence for all 15 tools. Those
    // moved to Trợ giúp → Hướng dẫn sử dụng; the slot is now cleared on every tool
    // change and only ever holds TRANSIENT STATUS (see setEdStatus). Clearing here is
    // load-bearing: the cloud-pen's in-progress line and the measure scale below would
    // otherwise stay behind after switching tools.
    setEdStatus(tool === "measure" ? measureStatus() : "");
  }

  // Cài đặt → Màu chú thích mặc định. Persists the shared slot and applies it to THIS
  // session immediately, so the user sees the effect with the dialog still open (same
  // rule as the path-bar checkbox in app.js).
  //
  // Deliberately does NOT touch annotations already on the page: this is the colour new
  // objects get, exactly like ed.fontSize and ed.penWidth. Repainting a document's marks
  // because a preference changed would be an edit the user never asked for — and one
  // that would need its own undo step to take back.
  //
  // Returns the colour actually in force, so the caller's `<input>` settles on the stored
  // value rather than showing something untrue when the input was junk (same contract as
  // main's setOpenIn).
  function setDefaultColor(hex) {
    if (!HEX6.test(hex || "")) return ed.color;
    ed.color = String(hex).toLowerCase();
    try {
      localStorage.setItem(ANNOT_COLOR_KEY, ed.color);
    } catch (_) {
      /* the change still holds for this session, it just won't be remembered */
    }
    // Keep the edit bar honest if it is open: the picker shows whichever slot the
    // current tool draws with, which may or may not be the one just changed.
    const cpick = $("ed-color");
    if (cpick) cpick.value = ed[colorSlotFor(ed.tool)];
    return ed.color;
  }

  // The one writer for #ed-hint. Deliberately NOT a place for instructions — those
  // belong in help.js, where they are translated and cannot inflate the edit bar
  // (BI-41). Only state the user cannot get anywhere else goes here.
  function setEdStatus(text) {
    const el = $("ed-hint");
    if (el) el.textContent = text || "";
  }

  // Whether the measure tool has a scale yet. This is NOT a hint: the first drag
  // behaves completely differently in the two states (it opens the calibration dialog
  // asking for a real length, versus auto-labelling from the stored ratio), and
  // "Hiệu chuẩn lại" is shown for the tool either way — so with this line gone there
  // is no way at all to tell which mode you are in.
  function measureStatus() {
    return ed.measureCal ? `Tỷ lệ: đã hiệu chuẩn · ${ed.measureUnit || ""}`.trim() : "Tỷ lệ: chưa hiệu chuẩn";
  }

  // Fill the text-box "Font máy" optgroup from the sidecar's /fonts list. Runs
  // once; silently no-ops if the engine isn't ready or the call fails (built-in
  // choices still work). Mirrors text-edit.js's loader but targets #ed-font.
  let fontsLoaded = false;
  async function loadSystemFonts() {
    if (fontsLoaded) return;
    const grp = $("ed-font-system");
    if (!grp || typeof sidecar === "undefined" || sidecar.state !== "ready" || !sidecar.base) return;
    try {
      const res = await sidecarFetch("/fonts", { method: "GET" });
      const data = await res.json();
      if (!data.success || !Array.isArray(data.families)) return;
      const frag = document.createDocumentFragment();
      for (const name of data.families) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        frag.appendChild(o);
      }
      grp.appendChild(frag);
      fontsLoaded = true;
    } catch (_) {
      /* keep built-in font choices */
    }
  }

  async function enter() {
    if (!state.bytes) return;
    ed.active = true;
    ed.measureCal = null; // a different drawing has a different scale — recalibrate
    ed._dimPending = null;
    ed._dirty = false;
    clearEdHistory(); // fresh annotation-undo timeline per session
    $("edit-bar").hidden = false;
    $("btn-edit").classList.add("active");
    setTool("select");
    updateToolbar();
    // Pull previously-applied text boxes / notes back in as editable objects, then
    // repaint so their baked appearance (rendered by pdf.js) is hidden while the
    // live overlay owns them. No managed annots → nothing to hide, common fast path.
    const n = await importManaged();
    ed._importedManaged = n; // a later "delete them all" still owes the file a bake — BI-60
    if (n && window.repaintRenderedPages) await window.repaintRenderedPages();
    syncOverlays();
    syncUndoBtns();
    loadSystemFonts();
    if (window.updateComments) window.updateComments(); // switch panel to live notes
  }
  function leaveMode() {
    ed.active = false;
    ed.sel = null;
    $("edit-bar").hidden = true;
    $("fmt-panel").hidden = true;
    $("btn-edit").classList.remove("active");
    updateToolbar();
    if (typeof updateUndoRedo === "function") updateUndoRedo(); // hand Ctrl+Z back to doc history
    syncOverlays();
    if (window.updateComments) window.updateComments(); // back to baked-annotation notes
  }
  // "Xong": bake every pending edit into the PDF, then leave edit mode. Managed
  // annots that were merely re-imported (no user change) don't force a re-bake.
  async function exit() {
    if (ed._poly) closePoly(); // finalize (or drop) a cloud still being drawn
    ed._exiting = true; // bakePending must not re-import while we're leaving
    try {
      if (ed._dirty && (hasAny() || ed._importedManaged)) await bakePending();
      reset();
      clearEdHistory();
      leaveMode();
      // Back to view mode: repaint so the baked text/note appearances show again
      // (they were hidden by DISABLE while editing).
      if (window.repaintRenderedPages) await window.repaintRenderedPages();
    } finally {
      ed._exiting = false;
    }
  }
  // "Hủy bỏ": leave edit mode discarding everything not yet baked. Re-imported
  // managed annots aren't "unsaved" — only prompt when the user actually changed
  // something; on discard the untouched baked appearances simply reappear.
  async function discardExit() {
    const n = ed._dirty ? countAnnots() : 0;
    if (n && !(await window.uiConfirm(`Bỏ ${n} chỉnh sửa chưa ghi và thoát?`, { okText: "Bỏ & thoát", cancelText: "Ở lại" }))) return;
    reset();
    clearEdHistory();
    leaveMode();
    if (window.repaintRenderedPages) await window.repaintRenderedPages();
    if (n) toast("Đã bỏ các chỉnh sửa chưa ghi.", "");
  }

  function reset() {
    ed.annots = {};
    ed.watermark = null;
    ed.sel = null;
    ed.pendingImage = null;
    ed._poly = null;
    ed._dirty = false;
    ed._taCommit = null;
    ed._managedPages = new Set();
    ed._importedManaged = 0;
    clearEdHistory();
  }

  // ---- listeners -----------------------------------------------------------

  const viewer = $("viewer");
  viewer.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  viewer.addEventListener("dblclick", onDblClick);

  $("btn-edit").onclick = () => (ed.active ? exit() : enter()); // toggle-off = Xong (bake)
  $("ed-apply").onclick = exit; // "Xong" = bake pending edits AND leave edit mode
  $("ed-exit").onclick = discardExit; // "Hủy bỏ" = drop pending edits AND leave
  $("ed-delete").onclick = deleteSelected;
  $("ed-arrow-reverse").onclick = reverseSelectedArrow;
  $("ed-copy").onclick = () => {
    if (!copySelected()) toast("Chọn một mục trên trang trước khi sao chép.", "bad");
  };
  $("ed-paste").onclick = () => {
    if (!pasteClip()) toast("Chưa có mục nào được sao chép.", "bad");
  };

  // Ctrl+C / Ctrl+V for the object clipboard, ridden on the `copy` / `paste` DOM
  // events rather than on keydown. THAT IS NOT A STYLE CHOICE:
  //   · main.js's Edit menu uses `role: "copy"` / `role: "paste"`, and unlike the
  //     entries around them those roles do NOT set `registerAccelerator: false` — so
  //     the accelerator is claimed by the menu and a renderer `keydown` for Ctrl+C is
  //     not something we can rely on firing. What the roles DO cause is
  //     webContents.copy()/paste(), which dispatch these DOM events. Same reason
  //     capture.js hangs its OS-image paste off `paste`.
  //   · Capture phase, so this runs BEFORE capture.js's own bubble-phase `paste`
  //     listener and can decide which of the two owns the gesture.
  //
  // THE HAND-OFF RULE, and the reason paste is not simply "ours": an image on the OS
  // clipboard still belongs to capture.js's beginImagePaste flow. We bow out for it
  // (no preventDefault → the bubble listener runs as before), and only claim Ctrl+V
  // when the clipboard carries no image AND we have an object to paste. So neither
  // feature can shadow the other, in either order.
  document.addEventListener(
    "copy",
    (e) => {
      if (!ed.active || ed.sel == null) return;
      // A real text selection (or a focused field) is the user copying TEXT — leave it.
      if (isTypingTarget(e.target)) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      if (copySelected()) e.preventDefault();
    },
    true
  );
  // Right-click on a page while annotating → Sao chép / Dán / Xoá for OBJECTS, instead
  // of capture.js's image menu. Reuses capture.js's ONE menu widget (window.Capture.
  // showMenu) so there is a single menu look, a single dismiss behaviour, and opening
  // either kind closes the other — the arrangement openThumbMenu already follows.
  //
  // `stopImmediatePropagation`, NOT `stopPropagation`: capture.js listens for
  // `contextmenu` on the SAME node (`document`, capture phase), and stopPropagation
  // only stops the event moving to the next node — it does not stop another listener
  // on the node we are standing on. That is BI-30, measured the hard way for the pan
  // tool. editor.js loads before capture.js, so this capture-phase listener runs first.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!ed.active) return;
      const layer = e.target.closest && e.target.closest(".annot-layer");
      if (!layer) return; // not over a page — let the native/main-process menu have it
      if (!(window.Capture && window.Capture.showMenu)) return; // capture.js absent
      const i = +layer.dataset.index;
      const anEl = e.target.closest(".an");
      // Right-clicking an object SELECTS it first, unless it is already part of the
      // selection — then the group is kept, so "Sao chép" means the group. Exactly the
      // rule openThumbMenu uses for pages (BI-26's neighbour).
      if (anEl && anEl.dataset.kind !== "watermark") {
        const id = +anEl.dataset.id;
        if (!isSelected(id)) select(id);
      }
      // Nothing selected AND nothing on the clipboard → every entry would be greyed
      // out, so DON'T claim the gesture: bow out and let capture.js's image menu
      // ("Sao chép ảnh" / "Sao chép vùng…" / "Dán ảnh vào trang") open exactly as it
      // did before this menu existed. Right-clicking empty paper while annotating keeps
      // its old behaviour, and the object menu only appears when it can actually do
      // something.
      const hasClip = !!(clip && clip.items.length);
      if (ed.sel == null && !hasClip) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const n = selIds().length;
      const tr = (vi) => (window.t ? window.t(vi) : vi);
      window.Capture.showMenu(e.clientX, e.clientY, [
        {
          label: n > 1 ? tr("Sao chép") + ` (${n} mục)` : tr("Sao chép"),
          enabled: n > 0,
          onClick: copySelected,
        },
        { label: tr("Dán vào trang này"), enabled: hasClip, onClick: () => pasteClip(i) },
        { separator: true },
        {
          label: n > 1 ? tr("Xoá mục") + ` (${n} mục)` : tr("Xoá mục"),
          enabled: n > 0,
          danger: true,
          onClick: deleteSelected,
        },
      ]);
    },
    true
  );

  document.addEventListener(
    "paste",
    (e) => {
      if (!ed.active || !clip) return;
      if (isTypingTarget(e.target)) return; // Ctrl+V inside a textarea is plain text
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) if (it.type && it.type.indexOf("image/") === 0) return; // capture.js's
      e.preventDefault();
      e.stopPropagation(); // we own this gesture now — don't let capture.js re-handle it
      pasteClip();
    },
    true
  );
  $("ed-watermark").onclick = openWatermark;
  $("ed-form").onclick = openForm;
  $("ed-img-pages").onclick = openImgPages;
  $("imgpages-ok").onclick = applyImgPages;
  $("imgpages-cancel").onclick = () => ($("imgpages-modal").hidden = true);
  $("imgpages-input").addEventListener("input", syncImgPages);
  $("imgpages-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyImgPages();
    }
  });

  // Measure/dimension calibration dialog + re-calibrate button.
  $("dim-ok").onclick = applyDim;
  $("dim-cancel").onclick = cancelDim;
  $("dim-length").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyDim();
    }
  });
  $("ed-recalibrate").onclick = recalibrateMeasure;

  document.querySelectorAll("#ed-tools .tool").forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.tool;
      setTool(t);
      if (t === "image") chooseImage();
    };
  });

  $("ed-color").oninput = (e) => {
    const v = e.target.value;
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    // The remembered default follows what the picker is actually showing: the
    // SELECTED annotation's kind when there is one (under Select, recolouring a ✗
    // must update the ✗ default, not the shared draw colour), else the active tool's.
    // Anything without its own slot in COLOR_SLOTS lands on ed.color.
    //
    // This deliberately does NOT write the Cài đặt preference to disk: recolouring one
    // arrow mid-review is "this arrow", not "every arrow from now on". Only the Settings
    // picker persists (see setDefaultColor).
    ed[colorSlotFor(hit ? hit.a.kind : ed.tool)] = v;
    // Recolour EVERY selected object, not just the primary: with a Ctrl+click group,
    // changing the colour of one of them and silently leaving the rest is the kind of
    // half-applied edit users then have to undo by hand. The `color !== undefined`
    // guard is per-object (a redact carries its colour in the other picker).
    const targets = hit ? selAnnots().filter((a) => a.color !== undefined) : [];
    if (targets.length) {
      pushEdUndo("color:" + ed.sel); // a picker drag = one undo step
      for (const a of targets) a.color = v;
      syncOverlays();
    }
  };
  $("ed-redact-color").oninput = (e) => {
    ed.redactColor = e.target.value;
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "redact") {
        pushEdUndo("rcolor:" + ed.sel);
        hit.a.color = ed.redactColor;
        syncOverlays();
      }
    }
  };
  $("ed-fontsize").oninput = (e) => {
    ed.fontSize = Math.max(6, +e.target.value || 16);
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "text") {
        pushEdUndo("fsize:" + ed.sel);
        hit.a.fontSize = ed.fontSize;
        const m = measureText(hit.a.text, ed.fontSize, textStyle(hit.a));
        hit.a.w = m.w;
        hit.a.h = m.h;
        syncOverlays();
      }
    }
  };
  $("ed-font").onchange = (e) => {
    ed.font = e.target.value || "sans";
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "text") {
        pushEdUndo();
        hit.a.font = ed.font;
        const m = measureText(hit.a.text, hit.a.fontSize, textStyle(hit.a));
        hit.a.w = m.w;
        hit.a.h = m.h;
        syncOverlays();
      }
    }
  };
  // B / I / U toggles. preventDefault on mousedown keeps an open text editor
  // focused; the click toggles the flag and (for the selected text) re-measures.
  [["ed-bold", "bold"], ["ed-italic", "italic"], ["ed-underline", "underline"]].forEach(([id, prop]) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => {
      b.classList.toggle("active");
      ed[prop] = b.classList.contains("active");
      if (ed.sel != null) {
        const hit = findAnnot(ed.sel);
        if (hit && hit.a.kind === "text") {
          pushEdUndo();
          hit.a[prop] = ed[prop];
          const m = measureText(hit.a.text, hit.a.fontSize, textStyle(hit.a));
          hit.a.w = m.w;
          hit.a.h = m.h;
          syncOverlays();
        }
      }
    });
  });
  // ---- text-box Format panel (paragraph / spacing / list / arrange) --------
  const INDENT_STEP = 18; // pt per indent click (~0.25")

  // Apply a formatting field to the palette default (for new boxes) AND, when a
  // text box is selected, to that box — re-measuring when the change alters size.
  function applyTextFmt(annotKey, value, opts) {
    const o = opts || {};
    ed[o.edKey || annotKey] = value;
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "text") {
        pushEdUndo((o.undoKey || "fmt:" + annotKey) + ":" + ed.sel);
        hit.a[annotKey] = value;
        if (o.remeasure) {
          const m = measureText(hit.a.text, hit.a.fontSize, textStyle(hit.a));
          hit.a.w = m.w;
          hit.a.h = m.h;
        }
        syncOverlays();
      }
    }
    syncFmtPanel();
  }

  // Move the selected text box relative to its page (Arrange → centre / edges).
  // a.w/a.h are in the same point space as a.x/a.y and the page size (dataset.w/h).
  function arrangeSelected(kind) {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (!hit || hit.a.kind !== "text") return;
    const a = hit.a;
    const layer = document.querySelector(`#viewer .page-wrap[data-index="${hit.page}"] .annot-layer`);
    const pageW = layer ? +layer.dataset.w : 0;
    const pageH = layer ? +layer.dataset.h : 0;
    if (!pageW || !pageH) return;
    pushEdUndo("arrange:" + kind + ":" + ed.sel);
    if (kind === "center-h" || kind === "center-both") a.x = (pageW - a.w) / 2;
    if (kind === "center-v" || kind === "center-both") a.y = (pageH - a.h) / 2;
    if (kind === "left") a.x = 0;
    if (kind === "right") a.x = pageW - a.w;
    if (kind === "top") a.y = 0;
    if (kind === "bottom") a.y = pageH - a.h;
    syncOverlays();
  }

  // Populate the panel from the selected text box (or palette defaults when none),
  // without clobbering the control the user is actively editing.
  function syncFmtPanel() {
    const panel = $("fmt-panel");
    if (!panel || panel.hidden) return;
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    const s = hit && hit.a.kind === "text" ? normTextStyle(hit.a) : normTextStyle(edTextStyle());
    const active = document.activeElement;
    const setVal = (id, v) => {
      const el = $(id);
      if (el && el !== active) el.value = v;
    };
    panel.querySelectorAll("#fmt-align .fmt-ic").forEach((b) =>
      b.classList.toggle("active", b.dataset.align === s.align)
    );
    $("fmt-bullet").classList.toggle("active", s.listType === "bullet");
    $("fmt-number").classList.toggle("active", s.listType === "number");
    if ($("fmt-strike") !== active) $("fmt-strike").checked = s.strike;
    setVal("fmt-linehl", s.lineHeight);
    setVal("fmt-para", s.paraSpacing);
    setVal("fmt-letter", s.letterSpacing);
    setVal("fmt-word", s.wordSpacing);
    setVal("fmt-scale", Math.round(s.charScale * 100));
    setVal("fmt-opacity", Math.round(s.opacity * 100));
    $("fmt-opacity-val").textContent = Math.round(s.opacity * 100) + "%";
  }

  // Show the panel only in a text context (Text tool active, or a text box selected).
  function updateFmtPanel() {
    const panel = $("fmt-panel");
    if (!panel) return;
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    const selText = !!(hit && hit.a.kind === "text");
    panel.hidden = !(ed.active && (ed.tool === "text" || selText));
    if (!panel.hidden) syncFmtPanel();
  }

  // Alignment buttons (mousedown-preventDefault keeps any open editor focused).
  document.querySelectorAll("#fmt-align .fmt-ic").forEach((b) => {
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => applyTextFmt("align", b.dataset.align, { undoKey: "align" }));
  });
  // Indent −/＋
  const bumpIndent = (delta) => {
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    const cur = hit && hit.a.kind === "text" ? hit.a.indent || 0 : ed.indent;
    applyTextFmt("indent", Math.max(0, cur + delta), { remeasure: true, undoKey: "indent" });
  };
  [["fmt-indent-dec", -1], ["fmt-indent-inc", 1]].forEach(([id, dir]) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => bumpIndent(dir * INDENT_STEP));
  });
  // Bullet / number (clicking the active type turns the list off)
  const toggleList = (type) => {
    const hit = ed.sel != null ? findAnnot(ed.sel) : null;
    const cur = hit && hit.a.kind === "text" ? hit.a.listType : ed.listType;
    applyTextFmt("listType", cur === type ? "none" : type, { remeasure: true, undoKey: "list" });
  };
  [["fmt-bullet", "bullet"], ["fmt-number", "number"]].forEach(([id, type]) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => toggleList(type));
  });
  {
    const c = $("fmt-strike");
    if (c) c.addEventListener("change", () => applyTextFmt("strike", c.checked, { undoKey: "strike" }));
  }
  // Numeric spacing / scale / opacity (live via 'input', coalesced undo per field)
  $("fmt-linehl").addEventListener("input", (e) =>
    applyTextFmt("lineHeight", Math.max(0.5, +e.target.value || 1.3), { remeasure: true, undoKey: "lineh" }));
  $("fmt-para").addEventListener("input", (e) =>
    applyTextFmt("paraSpacing", Math.max(0, +e.target.value || 0), { remeasure: true, undoKey: "para" }));
  $("fmt-letter").addEventListener("input", (e) =>
    applyTextFmt("letterSpacing", +e.target.value || 0, { remeasure: true, undoKey: "letter" }));
  $("fmt-word").addEventListener("input", (e) =>
    applyTextFmt("wordSpacing", +e.target.value || 0, { remeasure: true, undoKey: "word" }));
  $("fmt-scale").addEventListener("input", (e) =>
    applyTextFmt("charScale", Math.max(0.2, (+e.target.value || 100) / 100), { remeasure: true, undoKey: "scale" }));
  $("fmt-opacity").addEventListener("input", (e) => {
    const v = Math.max(0.1, (+e.target.value || 100) / 100);
    $("fmt-opacity-val").textContent = Math.round(v * 100) + "%";
    applyTextFmt("opacity", v, { edKey: "textOpacity", undoKey: "opacity" });
  });
  // Arrange (page-relative)
  [
    ["fmt-center-h", "center-h"], ["fmt-center-v", "center-v"], ["fmt-center-both", "center-both"],
    ["fmt-page-left", "left"], ["fmt-page-right", "right"], ["fmt-page-top", "top"], ["fmt-page-bottom", "bottom"],
  ].forEach(([id, kind]) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => arrangeSelected(kind));
  });

  $("ed-penwidth").oninput = (e) => {
    ed.penWidth = Math.max(1, +e.target.value || 2);
    // Applies to the whole selection, same reasoning as the colour picker above.
    const targets = selAnnots().filter((a) =>
      ["draw", "box", "ellipse", "cloud", "cloudpen", "arrow", "check", "cross"].includes(a.kind)
    );
    if (targets.length) {
      pushEdUndo("pwidth:" + ed.sel);
      for (const a of targets) a.width = ed.penWidth;
      syncOverlays();
    }
  };
  // Arrow label position (head/tail). Sets the default for new arrows and, if an
  // arrow is selected, moves its existing label live.
  $("ed-arrowlabel").onchange = (e) => {
    const v = e.target.value === "tail" ? "tail" : "head";
    ed.arrowLabelEnd = v;
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && hit.a.kind === "arrow") {
        pushEdUndo("arrowlabel:" + ed.sel);
        hit.a.labelEnd = v;
        syncOverlays();
      }
    }
  };
  // Cloud scallop size (smaller = denser, hugs the marked area more tightly).
  $("ed-cloudsize").oninput = (e) => {
    const v = Math.min(CLOUD_BUMP_MAX, Math.max(CLOUD_BUMP_MIN, +e.target.value || CLOUD_BUMP));
    ed.cloudBump = v;
    $("ed-cloudsize-val").textContent = String(v);
    if (ed.sel != null) {
      const hit = findAnnot(ed.sel);
      if (hit && (hit.a.kind === "cloud" || hit.a.kind === "cloudpen")) {
        pushEdUndo("cloudsize:" + ed.sel);
        hit.a.bump = v;
        syncOverlays();
      }
    }
  };
  // Interior fill: picking a colour turns fill on (and clears the transparent
  // toggle); the toggle turns it back off. Both update the selected shape live.
  function applyFillToSel() {
    if (ed.sel == null) return;
    const hit = findAnnot(ed.sel);
    if (hit && ["box", "ellipse", "cloud", "cloudpen"].includes(hit.a.kind)) {
      pushEdUndo("fill:" + ed.sel);
      hit.a.fill = effFill();
      hit.a.fillOpacity = ed.fillOpacity;
      syncOverlays();
    }
  }
  $("ed-fill").oninput = (e) => {
    ed.fillColor = e.target.value;
    ed.fillOn = true;
    $("ed-fill-none").checked = false;
    applyFillToSel();
  };
  $("ed-fill-none").onchange = (e) => {
    ed.fillOn = !e.target.checked;
    applyFillToSel();
  };
  $("ed-fill-opacity").oninput = (e) => {
    const pct = Math.min(100, Math.max(0, +e.target.value || 0));
    ed.fillOpacity = pct / 100;
    $("ed-fill-opacity-val").textContent = pct + "%";
    // Adjusting opacity implies a fill is wanted — turn transparency off.
    if (ed.fillOn === false && pct > 0) {
      ed.fillOn = true;
      $("ed-fill-none").checked = false;
    }
    applyFillToSel();
  };

  $("wm-cancel").onclick = () => ($("wm-modal").hidden = true);
  $("wm-ok").onclick = applyWatermark;
  $("form-cancel").onclick = () => {
    ed._form = null;
    ed._formDoc = null;
    $("form-modal").hidden = true;
  };
  $("form-ok").onclick = applyForm;

  window.addEventListener("keydown", (e) => {
    if (!ed.active) return;
    // A modal on top owns the keyboard. Without this, focus sitting on a modal BUTTON
    // (not an input, so `typing` below is false) leaks keys down here: Delete would
    // silently destroy the selected annotation behind the dialog, a bare letter would
    // switch tools, and Esc would abandon a half-drawn polygon instead of closing the
    // dialog. Trợ giúp → Hướng dẫn sử dụng made this reachable — it opens over a live
    // annotate session — but the same hole was already there for Watermark / Điền form /
    // Áp nhiều trang / Hiệu chuẩn. Safe to bail on all of them: every one of those four
    // modals has its own Hủy button (index.html) and its inputs carry their own keydown
    // listeners, so nothing in them depends on this handler.
    if (document.querySelector(".modal:not([hidden])")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    // A polygon cloud in progress: Enter closes it; Esc / Delete abandon it.
    // Handle here before the generic ladders so they don't corrupt _poly state.
    if (ed._poly && !typing && ["Enter", "Escape", "Delete", "Backspace"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Enter") closePoly();
      else cancelPoly();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !typing && ed.sel != null) {
      e.preventDefault();
      deleteSelected();
    }
    // Esc ladder: abort the drag in progress → deselect → back to the Select
    // tool. (Open textareas handle their own Esc and stopPropagation.) Never
    // auto-exits the mode — that would bake/discard without the user asking.
    if (e.key === "Escape" && !typing) {
      if (drag) {
        e.preventDefault();
        cancelDrag();
      } else if (ed.sel != null) {
        e.preventDefault();
        deselect();
      } else if (ed.tool !== "select") {
        e.preventDefault();
        ed.pendingImage = null; // a pending image placement is cancelled too
        setTool("select");
      }
    }
    // Ctrl+C fallback for the object clipboard. The `copy` DOM event above is the
    // primary route; this covers the case where Chromium declines to dispatch one
    // because there is no text selection to copy. Safe to have both: copySelected() is
    // idempotent, so a double fire stores the same clip twice and changes nothing.
    // Paste has NO such fallback on purpose — a double fire there would insert two
    // objects, so it stays on the single `paste` event, which webContents.paste()
    // reliably dispatches (capture.js has shipped on that same guarantee for releases).
    if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !typing && ed.sel != null) {
      const sel = window.getSelection && window.getSelection();
      if (!(sel && String(sel).length)) copySelected();
    }
    // Single-key tool shortcuts (no modifiers, not while typing) — mirror the
    // toolbar; each letter is shown in that tool's tooltip.
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && e.key.length === 1) {
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        setTool(tool);
        if (tool === "image") chooseImage();
      }
    }
  });

  // ---- public surface (consumed by app.js) ---------------------------------

  // Live overlay notes (comments) for the Comments panel — reflects unsaved edits
  // too. Sorted by page so the panel reads top-to-bottom.
  function getComments() {
    const out = [];
    for (const k of Object.keys(ed.annots)) {
      for (const a of ed.annots[k]) {
        if (a.kind === "note") out.push({ id: a.id, page: +k, text: a.text || "", replies: a.replies || [], color: a.color });
      }
    }
    return out.sort((p, q) => p.page - q.page);
  }
  // Panel click → select the note and scroll it into view (user double-clicks to
  // edit). Returns false if the id isn't a live note on any page.
  function focusNote(id) {
    const hit = findAnnot(id);
    if (!hit || hit.a.kind !== "note") return false;
    if (typeof scrollToPage === "function") scrollToPage(hit.page);
    select(id);
    return true;
  }

  window.Editor = {
    get active() {
      return ed.active;
    },
    // Pending, un-applied annotation edits this edit session (for the close guard).
    // `_importedManaged` is in here for the same reason as in exit(): "I deleted every
    // text box" IS an unsaved edit, and gating on hasAny() alone let it close silently.
    hasUnsaved: () => ed._dirty && (hasAny() || ed._importedManaged > 0),
    syncOverlays,
    bakePending,
    reset,
    beginImagePaste, // paste an OS-clipboard image onto a page (Ctrl+V)
    undo: edUndo, // annotation-level (pre-bake) — routed from Ctrl+Z while active
    redo: edRedo,
    getComments, // Comments panel data source while editing
    focusNote, // Comments panel → jump to + select a note
    // Cài đặt → Màu chú thích mặc định. The preference is READ and WRITTEN only here, so
    // app.js never grows a second copy of the storage key or the hex validation.
    getDefaultColor: () => ed.color,
    setDefaultColor,
  };
})();
