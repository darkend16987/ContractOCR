"use strict";

/*
 * "Managed annotation" codec — the private PDF object layer behind editable
 * annotations. Lifted out of editor.js at v0.2.49; every body was verified
 * byte-identical to v0.2.48's editor.js before the move.
 *
 * WHAT A MANAGED ANNOT IS. Text boxes, comment notes, arrows and inserted images
 * are written as REAL PDF annotations (so Foxit/Acrobat show them) that ALSO carry
 * a private `/NabuData` payload, plus — for images — a `/NabuSrc` stream holding the
 * ORIGINAL image file bytes. Re-opening the file reads those back and rebuilds live,
 * editable overlay objects instead of finding flattened pixels.
 *
 * WHY IT LIVES IN ITS OWN FILE (docs/REGRESSION-GUARD.md §1, BI-37 / BI-38). This is
 * the highest-consequence code in the editor: a mistake here does not look like a bug,
 * it looks like the user's inserted image quietly disappearing from their contract, or
 * the file doubling in size on every save. Two invariants carry that weight:
 *   · `managedSrcBytes` returns null — meaning "LEAVE THIS ANNOT ALONE" — for anything
 *     that doesn't look exactly like our own output. A foreign editor that re-compressed
 *     our stream makes the annot read-only, never deleted.
 *   · `stripManagedFromPage` takes `trash` and defers freeing to `freeManagedTrash`,
 *     because ONE image source is shared by every page "Áp ảnh cho nhiều trang" put it
 *     on. Freeing mid-loop makes page 2's lookup return null → its annot is kept AND
 *     re-written → two stamps for one image. The parameter is not optional politeness.
 *
 * EXPOSURE — the `wire.js` tier of §2 (bare names at classic-script top level), same as
 * annot-text.js / annot-geom.js: the call sites in editor.js did not change, so its side
 * of the move is a pure deletion. `module.exports` for node, `window.ManagedCodec` for a
 * probe. MUST be loaded BEFORE editor.js (and AFTER wire.js + annot-text.js).
 *
 * WHAT DELIBERATELY STAYED IN editor.js:
 *   · `deserializeManaged` — mints ids from `ed.seq`, so it needs editor state.
 *   · `addManagedAnnot` (and its `f` formatter) — calls the canvas rasterisers
 *     `renderTextPng` / `renderArrowPng`, so it cannot run outside a browser.
 *   · `URL_TOKEN` — belongs to the undo snapshot pool, not to this codec.
 */

// WRAPPED IN AN IIFE, unlike annot-text.js / annot-geom.js — and that is not stylistic.
// This file needs pdf-lib's `PDFName` / `PDFRawStream` / `PDFDict` / `degrees` by BARE
// NAME (the function bodies below are byte-identical to editor.js's, which had them in
// scope). Declaring those at the top level of a classic script puts them in the SHARED
// global scope, where `degrees` collides with `app.js:17`
// (`const { PDFDocument, degrees } = window.PDFLib`) — two top-level `const`s of one
// name is a SyntaxError, app.js dies, and every script after it loses `$`. The whole app
// went white. node's require() cannot see this at all (no shared global scope): all 537
// grid cases passed while the app was broken. Only the Electron probe caught it.
// So: pdf-lib stays PRIVATE in here, and the public surface is published explicitly at
// the bottom. Lesson recorded in BI-14 — when hoisting code into a classic script, check
// the DESTRUCTURED BINDINGS for collisions, not just the function names.
(function () {
  // The browser gets the UMD global from vendor/pdf-lib.min.js (loaded first in
  // index.html); node (tests) resolves the same 1.17.1 from node_modules, which
  // `npm run vendor` copies verbatim into renderer/vendor — byte-identical, so answers
  // measured in node apply to the build.
  const _PDFLib =
    (typeof window !== "undefined" && window.PDFLib) ||
    (typeof require === "function" ? require("pdf-lib") : null);
  if (!_PDFLib) throw new Error("managed-codec: pdf-lib unavailable (load vendor/pdf-lib.min.js first)");
  const { PDFName, PDFRawStream, PDFDict, degrees } = _PDFLib;

  // `pushB64Chunks` (wire.js) and `normTextStyle` (annot-text.js) are bare names in the
  // shared classic-script scope; in node they come from their modules. Resolved lazily
  // inside the functions that need them so this file has no load-order trap of its own
  // beyond the documented "after wire.js / annot-text.js".
  function _pushB64Chunks(parts, bytes) {
    if (typeof pushB64Chunks === "function") return pushB64Chunks(parts, bytes);
    return require("./wire.js").pushB64Chunks(parts, bytes);
  }
  function _normTextStyle(a) {
    if (typeof normTextStyle === "function") return normTextStyle(a);
    return require("./annot-text.js").normTextStyle(a);
  }

  // ---- the private keys ----------------------------------------------------

  // Kinds that round-trip as real annotations rather than being flattened to pixels.
  const MANAGED_KINDS = new Set(["text", "note", "image", "arrow"]);
  const NABU_KIND = PDFName.of("NabuKind");
  const NABU_DATA = PDFName.of("NabuData");
  // Private carrier for an image's ORIGINAL file bytes — see addManagedAnnot's
  // image branch for why the bytes can't live in /NabuData like every other kind.
  const NABU_SRC = PDFName.of("NabuSrc");
  const NABU_IMG = PDFName.of("NabuImg"); // the appearance's one XObject resource name
  const P_ANNOTS = PDFName.of("Annots");

  function isManagedKind(k) { return MANAGED_KINDS.has(k); }

  // ---- bytes / images -----------------------------------------------------

  // Identify an image by its magic bytes — pdf-lib can only embed PNG or JPEG, and
  // the file's reported MIME is unreliable (empty for some files, wrong for others).
  // Returns "png", "jpg", or null (unsupported: webp/gif/bmp/svg/…).
  function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return "png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    return null;
  }

  function strToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  // ---- coordinate mapping -------------------------------------------------

  function makeMap(vp1, mode) {
    if (mode === "image") return (x, y) => [x, vp1.height - y];
    return (x, y) => {
      const r = vp1.convertToPdfPoint(x, y);
      return [r[0], r[1]];
    };
  }

  function pageRotate(page) {
    return degrees(page.getRotation().angle);
  }

  // ---- the /NabuData payload ----------------------------------------------

  // Editable payload stored in /NabuData so a re-opened file reconstructs the
  // overlay object. Geometry travels here too (not just the /Rect) so retyping /
  // restyling is lossless.
  function serializeManaged(a) {
    if (a.kind === "text") {
      const s = _normTextStyle(a);
      return { k: "text", x: a.x, y: a.y, w: a.w, h: a.h, text: a.text,
               font: a.font, fontSize: a.fontSize, color: a.color,
               bold: !!a.bold, italic: !!a.italic, underline: !!a.underline,
               strike: s.strike, align: s.align, lineHeight: s.lineHeight,
               paraSpacing: s.paraSpacing, letterSpacing: s.letterSpacing,
               wordSpacing: s.wordSpacing, charScale: s.charScale,
               indent: s.indent, listType: s.listType, opacity: s.opacity };
    }
    if (a.kind === "arrow") {
      return { k: "arrow", x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2,
               color: a.color, width: a.width || 2,
               label: a.label || "", labelEnd: a.labelEnd === "tail" ? "tail" : "head",
               labelSize: a.labelSize || 14 };
    }
    // Geometry only — the pixels travel in the /NabuSrc stream, not in here.
    if (a.kind === "image") {
      return { k: "image", x: a.x, y: a.y, w: a.w, h: a.h, fmt: a.fmt === "jpg" ? "jpg" : "png" };
    }
    // note
    return { k: "note", x: a.x, y: a.y, w: a.w, h: a.h, text: a.text || "",
             color: a.color, replies: a.replies || [] };
  }

  function pushPageAnnot(doc, page, ref) {
    let arr = page.node.Annots();
    if (!arr) { arr = doc.context.obj([]); page.node.set(P_ANNOTS, arr); }
    arr.push(ref);
  }

  // ---- reading an image back ----------------------------------------------

  // The original image bytes behind a managed image annot, or null when they can't
  // be trusted. `null` deliberately means "leave this annot alone": it is neither
  // imported as an editable object nor stripped on the next bake, so a file that has
  // been through another PDF editor loses nothing — the image simply stays a plain
  // stamp. We write the stream with NO /Filter, so any filter at all means someone
  // else re-encoded it and `contents` is no longer the image file.
  function managedSrcBytes(doc, dict) {
    try {
      const ref = dict.get(NABU_SRC);
      if (!ref) return null;
      const st = doc.context.lookup(ref);
      if (!(st instanceof PDFRawStream) || !st.contents || !st.contents.length) return null;
      const d = st.dict || st;
      if (d.get && d.get(PDFName.of("Filter"))) return null;
      return sniffImage(st.contents) ? st.contents : null;
    } catch (_) {
      return null;
    }
  }

  // Image bytes → the data URL the overlay <img> and the next bake both need.
  // Uses wire.js's pushB64Chunks, the one tested chunked encoder in the renderer:
  // btoa(String.fromCharCode(...wholeBuffer)) blows the stack on a real photo, and
  // BI-24 is explicit that no new general-purpose byte→base64 helper gets written.
  // One image needing one data: URL is the narrow case that legitimately needs the
  // string at all — do NOT generalise this to documents.
  function managedSrcDataUrl(bytes) {
    const parts = [];
    _pushB64Chunks(parts, bytes);
    return "data:image/" + (sniffImage(bytes) === "jpg" ? "jpeg" : "png") + ";base64," + parts.join("");
  }

  // ---- replacing / freeing ------------------------------------------------

  // Every object a managed annot privately owns, collected for deletion: its /AP
  // form, that form's /NabuImg image (+ the /SMask a transparent PNG brings) and its
  // /NabuSrc stream, then the annot dict itself. Anything that doesn't look exactly
  // like our own output is skipped — worst case we keep the old growth, never a
  // dangling reference.
  function collectManagedChain(doc, dict, annotRef, out) {
    const ctx = doc.context;
    try {
      const src = dict.get(NABU_SRC);
      if (src) out.push(src);
      const apDict = ctx.lookup(dict.get(PDFName.of("AP")));
      const nRef = apDict && apDict.get && apDict.get(PDFName.of("N"));
      if (nRef) {
        const form = ctx.lookup(nRef);
        const fd = form && (form.dict || form);
        const resDict = fd && fd.get && ctx.lookup(fd.get(PDFName.of("Resources")));
        const xoDict = resDict && resDict.get && ctx.lookup(resDict.get(PDFName.of("XObject")));
        const imgRef = xoDict && xoDict.get && xoDict.get(NABU_IMG);
        if (imgRef) {
          const img = ctx.lookup(imgRef);
          const sm = img && (img.dict || img).get && (img.dict || img).get(PDFName.of("SMask"));
          if (sm) out.push(sm);
          out.push(imgRef);
        }
        out.push(nRef);
      }
    } catch (_) {
      /* leave whatever we could not walk in place */
    }
    out.push(annotRef);
  }

  // Actually free the collected objects. Deferred to the END of a whole-document
  // strip on purpose: an image source is SHARED by every page "Áp ảnh/chữ ký cho
  // nhiều trang" put it on, so deleting page 1's copy mid-loop would make page 2's
  // managedSrcBytes come back null and its annot would be kept AND re-written —
  // two stamps for one image. Duplicate refs are de-duped here, so sharing is free.
  function freeManagedTrash(doc, trash) {
    const uniq = new Map();
    for (const r of trash) if (r) uniq.set(String(r), r);
    for (const r of uniq.values()) {
      try { doc.context.delete(r); } catch (_) { /* already gone / not an indirect ref */ }
    }
  }

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
  function stripManagedFromPage(doc, page, trash) {
    const arr = page.node.Annots();
    if (!arr) return 0;
    const bin = trash || [];
    let removed = 0;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const ref = arr.get(i);
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict) || !dict.get(NABU_KIND)) continue;
      // A managed image whose source bytes we can't read is not ours to replace:
      // importManaged skipped it too, so ed.annots holds no copy and removing it
      // would delete the user's image outright.
      if (String(dict.get(NABU_KIND)) === "/image" && !managedSrcBytes(doc, dict)) continue;
      arr.remove(i);
      collectManagedChain(doc, dict, ref, bin);
      removed++;
    }
    if (!trash) freeManagedTrash(doc, bin); // single-page call: nothing left to share with
    return removed;
  }
  function stripManagedAnnots(doc) {
    const trash = [];
    let removed = 0;
    for (const page of doc.getPages()) removed += stripManagedFromPage(doc, page, trash);
    freeManagedTrash(doc, trash);
    return removed;
  }

  // node (tests) takes the module export. The browser needs these reachable BY BARE NAME
  // from editor.js, and the IIFE above means they are no longer top-level declarations —
  // so publish them onto the global object explicitly. A global *property* resolves for a
  // bare-name read exactly like a top-level `const` would, and unlike one it cannot
  // SyntaxError against another script's declaration (that is the whole point).
  // Safe to Object.assign here because every entry is a plain function or constant: the
  // v0.2.45 trap (Object.assign copies a getter's VALUE, freezing it) needs a getter,
  // and this surface has none. Do not add one without revisiting this.
  const _SURFACE = {
    MANAGED_KINDS, NABU_KIND, NABU_DATA, NABU_SRC, NABU_IMG, P_ANNOTS,
    isManagedKind, sniffImage, strToBytes, makeMap, pageRotate,
    serializeManaged, pushPageAnnot, managedSrcBytes, managedSrcDataUrl,
    collectManagedChain, freeManagedTrash, stripManagedFromPage, stripManagedAnnots,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = _SURFACE;
  if (typeof window !== "undefined") {
    window.ManagedCodec = _SURFACE; // the name a probe/test can assert on
    Object.assign(window, _SURFACE); // the bare names editor.js calls
  }
})();
