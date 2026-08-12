"use strict";

/**
 * Nabu PDF — Tìm & Thay thế (find & replace in the PDF's real text).
 *
 * WHAT IT IS. The toolbar's Ctrl+F box is a *reader's* search: it runs on pdf.js text
 * items, folds diacritics, and only paints highlights. This is an *editor's* search —
 * it finds the same words in the sidecar's view of the document (PyMuPDF spans) and
 * can rewrite them.
 *
 * WHY THE TWO ARE SEPARATE AND STAY SEPARATE. pdf.js text items and PyMuPDF spans cut
 * a line into different pieces, so one system's "12 kết quả" is not the other's. Using
 * pdf.js to count and PyMuPDF to replace would show a count the replace step could not
 * honour. So Find & Replace owns its query end to end, and Ctrl+F is untouched — which
 * also means this feature cannot regress it. Deliberate consequence: the two boxes can
 * report different numbers, because Ctrl+F ignores diacritics ("hop dong" finds "hợp
 * đồng") and this one does NOT. Folding is right for reading and wrong for writing:
 * replacing a folded match would strip the user's diacritics out of their contract.
 *
 * WHY THERE IS NO "/text-replace" ENDPOINT. Writing goes through /edit-text, exactly
 * the payload renderer/text-edit.js sends when a human edits a run by hand. That path
 * already solved the hard parts — redaction that removes glyphs and nothing else
 * (BI-23), "keep the original font" with its glyph-coverage ladder (BI-21), the
 * hscale/vscale geometry recovery so replacement text neither overflows its neighbour
 * nor changes line height (BI-25), and rotated pages. A second write path would have to
 * re-earn all of it. The sidecar only gained a READ endpoint, /text-find.
 *
 * SCOPE, SAID PLAINLY. A match is replaceable when it sits inside ONE span. A match
 * split across two spans (a word that changes font or goes bold half way, "Bên **A**")
 * is found, counted and highlighted — but marked not-replaceable rather than half
 * rewritten. Scanned PDFs have no text at all and are sent to OCR instead.
 *
 * Structure follows pan.js: the arithmetic on top is DOM-free and `require()`-able from
 * node (desktop/test/find-replace.test.js), the DOM half is behind the
 * `typeof document === "undefined"` gate below. Only `window.FindReplace` is exported —
 * no bare globals, the page-range.js discipline for new code (BI-14, §2).
 */

// ---------------------------------------------------------------------------
// Pure half — every number that can be silently wrong lives here.
// ---------------------------------------------------------------------------

// PyMuPDF span flags: bit 1 (2) = italic, bit 4 (16) = bold. Same constants
// text-edit.js reads; kept local so this file stays require()-able on its own.
function flagsBold(f) {
  return !!(f & 16);
}
function flagsItalic(f) {
  return !!(f & 2);
}
function packedToHex(c) {
  const n = typeof c === "number" ? c : 0;
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

// Replace `occs` (half-open {start,end} into `text`) with `replacement`.
//
// RIGHT TO LEFT, always. Splicing left to right changes the length of everything
// after the cut, so the second occurrence's offsets — which were measured against the
// ORIGINAL string — would point at the wrong characters. That failure is silent: the
// call succeeds, the PDF is written, and a word two lines down quietly loses a letter.
function spliceOccurrences(text, occs, replacement) {
  const s = String(text == null ? "" : text);
  const list = (occs || [])
    .filter((o) => o && o.end > o.start && o.start >= 0 && o.end <= s.length)
    .slice()
    .sort((a, b) => b.start - a.start);
  let out = s;
  let prevStart = Infinity;
  for (const o of list) {
    if (o.end > prevStart) continue; // overlapping range — skip rather than corrupt
    out = out.slice(0, o.start) + replacement + out.slice(o.end);
    prevStart = o.start;
  }
  return out;
}

// Highlight box for the matched substring, in the same PDF-point space as bbox_view.
// Interpolated across the span by character count — the span's own box is all the
// geometry /text-find carries, and this is the approximation Ctrl+F already uses
// (fracStart/fracEnd in app.js drawSearchLayer). A cross-span hit spans its whole
// union box (start 0 → end length), so it comes out exact.
function hitRect(hit) {
  const [x0, y0, x1, y1] = hit.bbox_view || hit.bbox;
  const len = Math.max(1, (hit.span_text || "").length);
  const w = x1 - x0;
  const a = Math.max(0, Math.min(len, hit.start)) / len;
  const b = Math.max(0, Math.min(len, hit.end)) / len;
  return { x0: x0 + a * w, y0, x1: x0 + Math.max(b, a) * w, y1 };
}

// One /edit-text edit for a span, given every occurrence in it to replace.
// Field for field what text-edit.js apply() sends, so the sidecar cannot tell the two
// callers apart. orig_text/orig_size are what let the backend reproduce the geometry
// the document drew this run at (BI-25) — dropping them makes replacements come out
// too long and too tall.
function editForSpan(hit, occs, replacement) {
  return {
    page: hit.page,
    bbox: hit.bbox,
    origin: hit.origin,
    new_text: spliceOccurrences(hit.span_text, occs, replacement),
    size: hit.size,
    color: packedToHex(hit.color),
    bg: null,
    bold: flagsBold(hit.flags),
    italic: flagsItalic(hit.flags),
    underline: false,
    // "" would make the backend fall back to a default face; the span's own font name
    // is what asks it to keep the original (BI-21).
    font: hit.font || "default",
    orig_text: hit.span_text,
    orig_size: hit.size,
  };
}

// Identity of the span a hit belongs to, within ONE /text-find response. Cross-span
// hits get no key: they are never replaced and never grouped, and their `span` field
// points at the first span of their line, which a real span also uses.
function spanKey(hit) {
  return hit.replaceable ? hit.page + ":" + hit.span : null;
}

// All replaceable hits → one edit per span, every occurrence in that span at once.
// Grouping matters for more than efficiency: /edit-text redacts the span's box and
// redraws it from new_text, so two separate edits on the SAME span would each rebuild
// it from the original text and the second would undo the first.
function groupEdits(hits, replacement) {
  const byKey = new Map();
  for (const h of hits || []) {
    const k = spanKey(h);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, { hit: h, occs: [] });
    byKey.get(k).occs.push({ start: h.start, end: h.end });
  }
  const out = [];
  for (const { hit, occs } of byKey.values()) out.push(editForSpan(hit, occs, replacement));
  return out;
}

// Sort key mirroring the order /text-find returns hits in (page, top, left, offset).
function hitOrder(h) {
  const [x0, y0] = h.bbox_view || h.bbox;
  return [h.page, Math.round(y0 * 10) / 10, Math.round(x0 * 10) / 10, h.start];
}
function cmpOrder(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Where the cursor lands in a FRESH hit list after a replacement.
//
// The list is re-fetched after every write (see runFind), because a write invalidates
// more than the hit it consumed: other matches in the same span shift, a cross-span
// match over that span goes stale, and the replacement text may itself contain the
// query. Re-scanning kills all three at once — the only thing left to decide is where
// to resume, and that is this function.
//
// `anchor.start` is the offset just PAST the inserted text, so a match created by the
// replacement itself ("hợp đồng" → "phụ lục hợp đồng") is stepped over instead of
// being offered again forever. Wraps to 0 when nothing is left after the anchor.
function indexAtOrAfter(hits, anchor) {
  if (!hits || !hits.length) return -1;
  if (!anchor) return 0;
  const a = [anchor.page, Math.round(anchor.top * 10) / 10, Math.round(anchor.left * 10) / 10, anchor.start];
  for (let i = 0; i < hits.length; i++) {
    if (cmpOrder(hitOrder(hits[i]), a) >= 0) return i;
  }
  return 0; // past the last match — wrap to the top, like every editor's Find Next
}

// Step the cursor, wrapping at both ends.
function stepIndex(cur, total, dir) {
  if (total <= 0) return -1;
  return ((cur + dir) % total + total) % total;
}

// Counts for the status line: total found, how many can actually be rewritten.
function summarise(hits) {
  const total = (hits || []).length;
  let crossing = 0;
  for (const h of hits || []) if (!h.replaceable) crossing++;
  return { total, crossing, replaceable: total - crossing };
}

const PURE = {
  flagsBold,
  flagsItalic,
  packedToHex,
  spliceOccurrences,
  hitRect,
  editForSpan,
  spanKey,
  groupEdits,
  hitOrder,
  indexAtOrAfter,
  stepIndex,
  summarise,
};

if (typeof module !== "undefined" && module.exports) module.exports = PURE;

// ---------------------------------------------------------------------------
// DOM half — skipped entirely under node, exactly like pan.js.
// ---------------------------------------------------------------------------
if (typeof document !== "undefined") {
  (function () {
    const fr = {
      open: false,
      hits: [],
      cur: -1,
      query: "",
      busy: false,
      // Set while this module is the one rewriting the document, so invalidate()
      // doesn't fire a second scan on top of the anchored one applyEdits already
      // schedules. See invalidate().
      suppress: false,
      // A message that must SURVIVE refreshStatus(): an error, the "this is a scan"
      // hint, the truncation warning. Without this they were written and then wiped
      // one line later, because setBusy(false) → refreshStatus() → "Không tìm thấy
      // kết quả nào." — so every failure in here, including "PDF quá lớn", reached
      // the user as "not found". {msg, kind} | null, cleared by the next scan.
      sticky: null,
      // The query/options changed since the last scan, so `hits` answers a question
      // the user is no longer asking. Highlights stay (they are still true of the
      // current bytes, BI-50) but the two Thay buttons go dark: replacing would
      // rewrite matches of the OLD query with the NEW replacement text.
      stale: false,
      // The last scan hit /text-find's max_hits ceiling and stopped early, and the
      // page it stopped on. Kept on `fr` — not just written into `sticky` — because
      // "Thay tất cả" has to know: its confirm text is the only place that promises
      // the user what the action covers, and "toàn bộ tài liệu" is false here.
      truncated: false,
      truncatedPage: 0,
      // Scan generation. A whole-document walk takes seconds on a big file, so two
      // can easily be in flight (Enter pressed twice, a replace re-scan overlapping
      // a manual one). Without this the SLOWER one lands last and wins, and the
      // user is told "không tìm thấy" about a query they already replaced.
      runSeq: 0,
      abort: null,
    };

    // TWO ceilings, because reading and writing travel differently.
    //
    // Finding goes through /text-find-bin: the request body IS the PDF, so the limit
    // is the sidecar's raw-bytes ceiling (_MAX_PDF_BIN in api.py) — 1 GB, which no
    // real document reaches. Replacing still goes through /edit-text, whose request is
    // base64 JSON and therefore still capped at _MAX_PDF_B64 (src/pdf/util.py, ~200 MB
    // of document). So a 300 MB drawing set can be SEARCHED but not rewritten, and the
    // UI has to say that plainly instead of letting the user press Thay and collect an
    // error. Making the write path binary too is a separate job: /edit-text is the most
    // dangerous function in the app (BI-21/23/25) and does not get refactored in the
    // same change as a search fix.
    const MAX_FIND_BIN = 1000000000;
    const MAX_EDIT_B64 = 280000000;

    // Would /edit-text refuse this document? Same arithmetic the base64 encoder does.
    function overWriteLimit() {
      return !!state.bytes && Math.ceil(state.bytes.length / 3) * 4 > MAX_EDIT_B64;
    }

    const $ = (id) => document.getElementById(id);
    // Runtime strings go through i18n's t() with {name} substitution. Guarded because
    // this file is also loadable before i18n has initialised; every key below has an
    // entry in i18n.js's EN table (a missing one is not an error — t() returns its
    // input — which is exactly why they are easy to forget, see BI-10's neighbour).
    const tr = (vi, params) => (window.t ? window.t(vi, params) : vi);

    // ---- highlight layers ---------------------------------------------------

    function clearLayers() {
      document.querySelectorAll("#viewer .fr-layer").forEach((l) => l.remove());
    }

    // Repaint page `i`'s highlights. Called on (re)render of that page and after
    // every scale change, so it must be cheap and idempotent.
    function drawLayer(i) {
      const m = state.pageMetas && state.pageMetas[i];
      if (!m || !m.wrap) return;
      const old = m.wrap.querySelector(".fr-layer");
      if (old) old.remove();
      if (!fr.open || !fr.hits.length) return;
      const mine = [];
      for (let k = 0; k < fr.hits.length; k++) if (fr.hits[k].page === i) mine.push(k);
      if (!mine.length) return;

      const canvas = m.wrap.querySelector("canvas");
      const layer = document.createElement("div");
      layer.className = "fr-layer";
      layer.style.width = (canvas && parseFloat(canvas.style.width)) || m.cw + "px";
      layer.style.height = (canvas && parseFloat(canvas.style.height)) || m.ch + "px";
      // The scale THIS layer was built at. applyScaleToDom reads it to stretch the
      // layer mid-zoom before the repaint catches up — same contract as .search-layer
      // and .note-layer (BI-36).
      layer.dataset.pscale = String(state.scale);
      const s = state.scale;
      for (const k of mine) {
        const h = fr.hits[k];
        const r = PURE.hitRect(h);
        const el = document.createElement("div");
        el.className =
          "fr-hl" + (k === fr.cur ? " current" : "") + (h.replaceable ? "" : " locked");
        el.style.left = r.x0 * s + "px";
        el.style.top = r.y0 * s + "px";
        el.style.width = Math.max(2, r.x1 - r.x0) * s + "px";
        el.style.height = Math.max(4, r.y1 - r.y0) * s + "px";
        el.dataset.hi = String(k);
        if (!h.replaceable) {
          el.title = tr("Từ khoá bị chia làm nhiều đoạn định dạng — không thay tự động được");
        }
        layer.appendChild(el);
      }
      m.wrap.appendChild(layer);
    }

    function drawAllLayers() {
      if (!state.pageMetas) return;
      for (let i = 0; i < state.numPages; i++) {
        if (state.pageMetas[i] && state.pageMetas[i].wrap.dataset.rendered === "1") drawLayer(i);
      }
    }

    // ---- status -------------------------------------------------------------

    function setStatus(msg, kind) {
      const el = $("fr-status");
      if (!el) return;
      el.textContent = msg || "";
      el.className = "fr-status" + (kind ? " " + kind : "");
    }

    // Button enablement only. Split out of refreshStatus() because that function has
    // early returns for "no query" and "no matches", and the buttons were left in
    // whatever state setBusy() last put them — enabled, with zero hits behind them.
    function syncButtons() {
      const { total, replaceable } = PURE.summarise(fr.hits);
      const cur = fr.hits[fr.cur];
      // `stale` locks writing, not navigating: stepping through last scan's matches
      // is harmless, replacing against them is not.
      const lockWrite = fr.busy || fr.stale || overWriteLimit();
      $("fr-replace-one").disabled = !(cur && cur.replaceable) || lockWrite;
      $("fr-replace-all").disabled = !replaceable || lockWrite;
      $("fr-prev").disabled = total < 1 || fr.busy;
      $("fr-next").disabled = total < 1 || fr.busy;
      const go = $("fr-go");
      if (go) go.disabled = fr.busy;
    }

    function refreshStatus() {
      syncButtons();
      // Order matters. A real message (error / scan / truncated) outranks the running
      // count, and the count must never be able to overwrite it — that clobbering is
      // exactly what made every failure look like "Không tìm thấy kết quả nào."
      if (fr.sticky) return setStatus(fr.sticky.msg, fr.sticky.kind);
      const typed = (($("fr-find") || {}).value || "").trim();
      if (fr.stale) {
        if (!typed) return setStatus("");
        return setStatus(
          fr.hits.length
            ? tr("Đang hiện kết quả cũ — nhấn Enter để tìm lại.")
            : tr("Nhấn Enter (hoặc nút Tìm) để quét tài liệu."),
          "warn"
        );
      }
      const { total, crossing } = PURE.summarise(fr.hits);
      if (!fr.query) return setStatus("");
      if (!total) return setStatus(tr("Không tìm thấy kết quả nào."), "warn");
      const i = fr.cur >= 0 ? fr.cur + 1 : 0;
      // The document being too big to WRITE outranks the crossing count: it disables
      // both Thay buttons, so saying why is more useful than saying how many.
      if (overWriteLimit()) {
        return setStatus(
          tr("{i}/{n} kết quả · tài liệu quá lớn để thay tự động — dùng Nén trước", { i, n: total }),
          "warn"
        );
      }
      const msg = crossing
        ? tr("{i}/{n} kết quả · {k} vị trí không thay tự động được", { i, n: total, k: crossing })
        : tr("{i}/{n} kết quả", { i, n: total });
      setStatus(msg, crossing ? "warn" : "");
    }

    // Show a message that outlives the next refreshStatus().
    function setSticky(msg, kind) {
      fr.sticky = { msg, kind: kind || "" };
      refreshStatus();
    }

    function setBusy(on) {
      fr.busy = !!on;
      // fr-case/fr-word were missing here, so an option could be toggled mid-scan and
      // start a second walk of the same document on top of the first.
      for (const id of ["fr-replace-one", "fr-replace-all", "fr-prev", "fr-next", "fr-replace", "fr-go", "fr-case", "fr-word"]) {
        const el = $(id);
        if (el) el.disabled = !!on;
      }
      // NOT disabled: a disabled input drops keystrokes and loses focus, so typing
      // during a scan silently ate characters. readOnly refuses the edit and keeps
      // the caret where it is.
      const inp = $("fr-find");
      if (inp) inp.readOnly = !!on;
      if (!on) refreshStatus();
    }

    // The query no longer matches what is on screen. Called on every edit to the find
    // box and on every option toggle — NOT a scan, which is the whole point: a scan is
    // a walk of the entire document on the sidecar and only the user asks for one.
    function markStale(msg) {
      fr.stale = true;
      fr.sticky = msg ? { msg, kind: "warn" } : null;
      if (!($("fr-find").value || "").trim()) {
        // Emptied the box — there is nothing the old highlights could still mean.
        fr.hits = [];
        fr.cur = -1;
        fr.query = "";
        drawAllLayers();
      }
      refreshStatus();
    }

    // ---- the scan -----------------------------------------------------------

    // Re-read the document. `anchor` (optional) says where to put the cursor
    // afterwards; without one the cursor goes to the first hit.
    async function runFind(anchor) {
      const q = ($("fr-find").value || "").trim();
      fr.query = q;
      fr.sticky = null;
      fr.stale = false;
      // Cleared here, at the top, not only on the success path: every early return
      // below (empty query, oversized file, request error) would otherwise leave the
      // PREVIOUS scan's truncation flag standing behind the next "Thay tất cả".
      fr.truncated = false;
      fr.truncatedPage = 0;
      if (!q) {
        fr.hits = [];
        fr.cur = -1;
        drawAllLayers();
        setStatus("");
        refreshStatus();
        return;
      }
      if (!state.bytes) return;
      if (state.bytes.length > MAX_FIND_BIN) {
        fr.hits = [];
        fr.cur = -1;
        drawAllLayers();
        setSticky(tr("PDF quá lớn để tìm (giới hạn ~1GB)."), "bad");
        return;
      }

      // Claim this generation before the first await; everything after checks that it
      // still owns it, so a superseded scan neither paints nor clears the UI.
      const seq = ++fr.runSeq;
      if (fr.abort) {
        try {
          fr.abort.abort();
        } catch (_) {}
      }
      const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
      fr.abort = ac;

      setBusy(true);
      setStatus(tr("Đang tìm…"));
      try {
        // /text-find-bin, NOT /text-find: the JSON route carries the document as
        // base64, which is ~33% more bytes to build and hand over, and capped the
        // whole feature at ~200 MB — the exact size a several-hundred-page drawing
        // set reaches, which is precisely the document nobody can search by hand.
        // Here the request body IS the PDF (the /compress-bin move, BI-49) and only
        // the small JSON answer comes back. A Blob keeps the bytes in Blink's blob
        // store instead of the JS heap (BI-24 in spirit).
        const qs =
          "?query=" +
          encodeURIComponent(q) +
          "&match_case=" +
          ($("fr-case").checked ? "true" : "false") +
          "&whole_word=" +
          ($("fr-word").checked ? "true" : "false");
        const res = await sidecarFetch("/text-find-bin" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          signal: ac ? ac.signal : undefined,
          body: new Blob([state.bytes], { type: "application/pdf" }),
        });
        let data = null;
        try {
          data = await res.json();
        } catch (_) {} // a 4xx/5xx with a non-JSON body must not read as "no matches"
        if (seq !== fr.runSeq) return; // a newer scan owns the UI now
        if (!data || !data.success) {
          fr.hits = [];
          fr.cur = -1;
          drawAllLayers();
          // FastAPI's `detail` is a string for HTTPException but a LIST for a 422, and
          // an object would reach the user as "[object Object]".
          let msg = (data && (data.error || data.detail)) || (res.status ? "HTTP " + res.status : null);
          if (msg && typeof msg !== "string") msg = JSON.stringify(msg);
          setSticky(tr("Lỗi tìm: {msg}", { msg: msg || tr("không rõ") }), "bad");
          return;
        }
        fr.hits = data.hits || [];
        fr.truncated = !!data.truncated;
        fr.truncatedPage = data.truncated_page || 0;
        if (!data.has_text) {
          fr.cur = -1;
          drawAllLayers();
          setSticky(
            tr('PDF này không có chữ thật (bản scan) — chạy "OCR văn bản" trong Công cụ trước.'),
            "bad"
          );
          return;
        }
        fr.cur = fr.hits.length ? PURE.indexAtOrAfter(fr.hits, anchor) : -1;
        drawAllLayers();
        if (fr.cur >= 0) await goTo(fr.cur, true);
        if (seq !== fr.runSeq) return;
        // After goTo, which repaints the count — otherwise this warning is written and
        // immediately overwritten by "{i}/{n} kết quả".
        if (fr.truncated) {
          setSticky(
            fr.truncatedPage
              ? tr("Quá nhiều kết quả — chỉ hiện {n} vị trí đầu tiên, dừng quét ở trang {p}.", {
                  n: fr.hits.length,
                  p: fr.truncatedPage,
                })
              : tr("Quá nhiều kết quả — chỉ hiện {n} vị trí đầu tiên.", { n: fr.hits.length }),
            "warn"
          );
        } else {
          refreshStatus();
        }
      } catch (err) {
        if (seq !== fr.runSeq || (err && err.name === "AbortError")) return;
        setSticky(tr("Lỗi tìm: {msg}", { msg: err.message }), "bad");
      } finally {
        // Only the generation that still owns the UI may release the busy lock; a
        // superseded scan clearing it would re-enable every button mid-flight.
        if (seq === fr.runSeq) {
          fr.abort = null;
          setBusy(false);
        }
      }
    }

    // ---- navigation ---------------------------------------------------------

    async function goTo(i, quiet) {
      if (!fr.hits.length) return;
      fr.cur = ((i % fr.hits.length) + fr.hits.length) % fr.hits.length;
      const h = fr.hits[fr.cur];
      await renderPageCanvas(h.page); // no-op if already painted; also redraws the layer
      drawLayer(h.page);
      document.querySelectorAll(".fr-hl.current").forEach((e) => e.classList.remove("current"));
      const el = document.querySelector(`.fr-layer .fr-hl[data-hi="${fr.cur}"]`);
      if (el) {
        el.classList.add("current");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        scrollToPage(h.page);
      }
      if (!quiet) refreshStatus();
      else refreshStatus();
    }

    function step(dir) {
      if (!fr.hits.length) return;
      goTo(PURE.stepIndex(fr.cur, fr.hits.length, dir));
    }

    // ---- writing ------------------------------------------------------------

    // Shared tail of both replace paths: POST the edits, swap the bytes, repaint the
    // touched pages, then RE-SCAN. Returns false if nothing was written.
    async function applyEdits(edits, anchor, doneMsg) {
      if (!edits.length) return false;
      setBusy(true);
      fr.suppress = true; // rerenderChanged below must not trigger an un-anchored scan
      showOverlay(tr("Đang thay thế…"));
      try {
        const res = await sidecarFetch("/edit-text?raw=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: pdfJsonBody(state.bytes, { edits }),
        });
        // application/pdf = success (body IS the document); JSON = failure. Same
        // contract text-edit.js relies on.
        const ct = res.headers.get("content-type") || "";
        if (!res.ok || ct.includes("json")) {
          let msg = res.statusText || tr("không rõ");
          try {
            const data = await res.json();
            msg = data.error || data.detail || msg;
          } catch (_) {}
          toast(tr("Thay thế lỗi: {msg}", { msg }), "bad");
          return false;
        }
        const buf = await res.arrayBuffer();
        // BI-3: the undo step goes in BEFORE state.bytes moves.
        if (window.DocHistory) window.DocHistory.pushUndo();
        state.bytes = new Uint8Array(buf);
        const pages = new Set(edits.map((e) => e.page));
        await rerenderChanged(pages);
        toast(doneMsg, "good");
        return true;
      } catch (err) {
        toast(tr("Lỗi thay thế: {msg}", { msg: err.message }), "bad");
        return false;
      } finally {
        hideOverlay();
        setBusy(false);
        fr.suppress = false;
        // Always re-scan, success or not: on success the document moved under the old
        // offsets, and on failure the list may still be stale from an earlier write.
        await runFind(anchor);
      }
    }

    async function replaceCurrent() {
      const h = fr.hits[fr.cur];
      if (!h || !h.replaceable) return;
      const rep = $("fr-replace").value || "";
      const [left, top] = h.bbox_view || h.bbox;
      // Resume PAST the text we are about to insert, so a replacement that contains
      // the query is not offered again immediately.
      const anchor = { page: h.page, top, left, start: h.start + rep.length };
      await applyEdits(
        [PURE.editForSpan(h, [{ start: h.start, end: h.end }], rep)],
        anchor,
        tr("Đã thay 1 vị trí.")
      );
    }

    async function replaceAll() {
      const rep = $("fr-replace").value || "";
      const edits = PURE.groupEdits(fr.hits, rep);
      const { crossing, replaceable } = PURE.summarise(fr.hits);
      if (!edits.length) return;
      // Confirm first: "Thay tất cả" is the one action here that rewrites the whole
      // document in a single step, and the count is the only thing that tells the user
      // whether their query was as specific as they thought.
      //
      // "trong toàn bộ tài liệu" is a PROMISE, and it is only true when the scan
      // reached the last page. /text-find stops at max_hits (5000) — measured: a
      // common word in a 600-page file stops the walk on page 28, i.e. 5% in. Saying
      // "toàn bộ tài liệu" there makes the one dialog whose entire job is to prevent a
      // surprise into the thing that causes it: the user replaces 5000 of many more,
      // is told it is done, and the rest sit untouched.
      const head = fr.truncated
        ? tr("Thay {n} vị trí trong phần tài liệu đã quét?", { n: replaceable })
        : tr("Thay {n} vị trí trong toàn bộ tài liệu?", { n: replaceable });
      const notes = [];
      if (fr.truncated) {
        notes.push(
          fr.truncatedPage
            ? tr(
                "Lượt quét dừng ở trang {p} vì chạm trần {m} kết quả — phần sau CHƯA được quét. Thay xong hãy bấm Tìm lại để xử lý nốt.",
                { p: fr.truncatedPage, m: fr.hits.length }
              )
            : tr(
                "Lượt quét dừng sớm vì chạm trần {m} kết quả — phần sau CHƯA được quét. Thay xong hãy bấm Tìm lại để xử lý nốt.",
                { m: fr.hits.length }
              )
        );
      }
      if (crossing) {
        notes.push(
          tr("{k} vị trí bị chia làm nhiều đoạn định dạng sẽ được GIỮ NGUYÊN.", { k: crossing })
        );
      }
      const ok = await uiConfirm(head + (notes.length ? "\n\n" + notes.join("\n\n") : ""), {
        title: tr("Thay tất cả"),
        okText: tr("Thay tất cả"),
        cancelText: tr("Hủy"),
      });
      if (!ok) return;
      await applyEdits(edits, null, tr("Đã thay {n} vị trí.", { n: replaceable }));
    }

    // ---- open / close -------------------------------------------------------

    function canRun() {
      // BI-26: Ctrl+H is an entry point with no button id, so the licence gate has to
      // be checked here in the FUNCTION, not only by the click guard on the button.
      if (gateProFeature()) return false;
      if (!state.bytes) {
        toast(tr("Mở PDF trước."), "bad");
        return false;
      }
      if (sidecar.state !== "ready" || !sidecar.base) {
        toast(tr("Engine chưa sẵn sàng."), "bad");
        return false;
      }
      // BI-2: the overlay editor and the text editor both own the document's bytes
      // while they are active. Rewriting underneath either one desyncs every pending
      // edit, so refuse rather than try to reconcile.
      if (window.Editor && window.Editor.active) {
        toast(tr('Thoát "Chú thích" trước khi dùng Tìm & Thay thế.'), "bad");
        return false;
      }
      if (window.TextEdit && window.TextEdit.active) {
        toast(tr('Thoát "Sửa nội dung" trước khi dùng Tìm & Thay thế.'), "bad");
        return false;
      }
      return true;
    }

    // Park the panel just under whatever chrome is currently on top. A fixed `top` in
    // CSS cannot work: row 1 of the toolbar wraps (measured 57px at 1920 up to 98px at
    // 1366), the breadcrumb strip is optional, and the annotate/text bars add more —
    // so any constant is wrong at some window width and the panel lands ON the
    // toolbar. `main`'s top edge already is the answer, whatever is stacked above it.
    function placePanel() {
      const panel = $("fr-panel");
      const main = document.querySelector("main");
      if (!panel || !main) return;
      const top = Math.max(8, Math.round(main.getBoundingClientRect().top) + 12);
      panel.style.top = top + "px";
    }

    function openPanel() {
      if (!canRun()) return;
      fr.open = true;
      $("fr-panel").hidden = false;
      placePanel();
      const inp = $("fr-find");
      // Carry over whatever is in the toolbar's find box — the user has usually just
      // typed it there and should not have to type it twice.
      const tb = $("find-input");
      if (!inp.value && tb && tb.value.trim()) inp.value = tb.value.trim();
      inp.focus();
      inp.select();
      // Carried over, NOT scanned. Opening the panel is not a request to walk a
      // 480-page document; pressing Enter is.
      markStale();
    }

    function closePanel() {
      fr.open = false;
      fr.hits = [];
      fr.cur = -1;
      fr.query = "";
      fr.stale = false;
      fr.sticky = null;
      fr.truncated = false;
      fr.truncatedPage = 0;
      // Closing the panel abandons the question, so abandon the scan answering it —
      // otherwise a 480-page walk keeps the sidecar busy for a panel nobody can see.
      fr.runSeq++;
      if (fr.abort) {
        try {
          fr.abort.abort();
        } catch (_) {}
        fr.abort = null;
      }
      if (fr.busy) setBusy(false);
      const p = $("fr-panel");
      if (p) p.hidden = true;
      clearLayers();
    }

    // EVERY hit is an offset into a span of one exact version of the document. The
    // moment the bytes change — our own replacement, an undo, a rotate, a deleted
    // page, a watermark bake — the whole list is fiction: offsets have moved, and
    // after a page delete the `page` numbers point somewhere else entirely, so a
    // stale highlight would sit over innocent text and "Thay" would rewrite it.
    //
    // So this is wired into renderAll() and rerenderChanged(), the two funnels every
    // byte-level change goes through, rather than into each caller. Cheap when the
    // panel is closed (the first line returns).
    function invalidate() {
      if (!fr.open) return;
      fr.hits = [];
      fr.cur = -1;
      clearLayers();
      if (fr.suppress) return refreshStatus(); // applyEdits re-scans itself, with an anchor
      // Not re-scanned automatically: a rotate or a page delete would otherwise cost a
      // full document walk the user never asked for. The list is dropped either way —
      // BI-50 is about not KEEPING stale offsets, not about refetching them.
      if (fr.query) markStale(tr("Tài liệu vừa thay đổi — nhấn Enter để tìm lại."));
      else refreshStatus();
    }

    // Wipe every trace — used when the document is replaced under us.
    function reset() {
      closePanel();
      const f = $("fr-find");
      const r = $("fr-replace");
      if (f) f.value = "";
      if (r) r.value = "";
      setStatus("");
    }

    // ---- wiring -------------------------------------------------------------

    const btn = $("btn-find-replace");
    if (btn) btn.onclick = openPanel;
    const closeBtn = $("fr-close");
    if (closeBtn) closeBtn.onclick = closePanel;
    $("fr-prev").onclick = () => step(-1);
    $("fr-next").onclick = () => step(1);
    $("fr-replace-one").onclick = replaceCurrent;
    $("fr-replace-all").onclick = replaceAll;
    $("fr-go").onclick = () => runFind(null);
    // An option toggle changes the answer, so the old one is stale — but it does NOT
    // scan on its own, for the same reason typing doesn't.
    $("fr-case").onchange = () => markStale();
    $("fr-word").onchange = () => markStale();

    // NOT search-as-you-type. Every scan is a whole-document walk on the sidecar —
    // base64 the entire PDF, reopen it, get_text("dict") every page — which is
    // milliseconds on a 3-page contract and tens of seconds on a 480-page A1 set. It
    // used to run 350 ms after each keystroke, so typing "2026" cost four of those
    // walks and the answers raced each other home. Typing now only marks the result
    // stale; Enter or the Tìm button is what asks for the walk.
    $("fr-find").addEventListener("input", () => markStale());
    $("fr-find").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Same query as the last scan → step through the matches we already have.
        // Anything else → scan.
        if (!fr.stale && fr.hits.length && fr.query === ($("fr-find").value || "").trim()) {
          step(e.shiftKey ? -1 : 1);
        } else if (!fr.busy) {
          runFind(null);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    });
    $("fr-replace").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    });

    // Click a highlight to make it the current one.
    document.addEventListener("click", (e) => {
      if (!fr.open) return;
      const hl = e.target.closest && e.target.closest(".fr-hl");
      if (!hl) return;
      const i = parseInt(hl.dataset.hi, 10);
      if (!Number.isNaN(i)) goTo(i);
    });

    // Ctrl+H. Registered here rather than in app.js's shortcut block so the whole
    // feature stays in one file; isTyping() is not consulted on purpose — Ctrl+H
    // should open the panel even from inside the toolbar's find box.
    // The chrome above the viewer changes height on resize (row 1 rewraps), so the
    // panel has to be re-parked or it drifts onto the toolbar.
    window.addEventListener("resize", () => {
      if (fr.open) placePanel();
    });

    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "h") return;
      e.preventDefault();
      if (fr.open) closePanel();
      else openPanel();
    });

    window.FindReplace = {
      get active() {
        return fr.open;
      },
      open: openPanel,
      close: closePanel,
      reset,
      invalidate,
      // Called by applyScaleToDom / renderPageCanvas so highlights follow zoom and
      // lazily-rendered pages (BI-36).
      syncOverlays: drawAllLayers,
      drawLayer,
      hasHits: () => fr.open && fr.hits.length > 0,
    };
    // The pure helpers, under a name a probe or test can assert on.
    window.FindReplace.pure = PURE;
  })();
}
