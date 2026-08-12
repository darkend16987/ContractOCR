"use strict";

/**
 * Nabu PDF — moving pages between two open documents (docs/SPEC-page-drag.md).
 *
 * Two ways in, one pipe out:
 *   • drag a page out of the page column and drop it in ANOTHER WINDOW's column;
 *   • right-click → "Chuyển trang sang tài liệu khác…", which also reaches tabs —
 *     two tabs of one window can never be drag targets for each other, because
 *     only the active tab's view is attached to the window (SPEC §4).
 *
 * What this file does NOT do, on purpose:
 *   • It writes no PDF logic. Pages are lifted with the same copyPages call
 *     extractSelected uses and land through the same insertBuffersAt the "Chèn
 *     trang" button uses, so undo, the ● dirty mark, autosave and crash recovery
 *     all come along for free (pushUndo → markDirty).
 *   • It never addresses another window. It hands pages to main at a screen
 *     position, or to a destination id main itself handed us (BI-55).
 *   • It never touches the same-document reorder drag. A drop inside its own
 *     window is classified "self" by main and this file is not involved (BI-57).
 *
 * COPY is the default (SPEC §9.2): the source keeps its pages, and only a
 * Shift-drop — or the "Xoá khỏi bản gốc" button on the toast — removes them, and
 * only after the destination has confirmed the insert (BI-56). The worst failure
 * this ordering can produce is a duplicated page: visible, and one Ctrl+Z away.
 *
 * Loaded as a classic script after app.js, so it reads `state`, `toast`,
 * `insertBuffersAt`, `thumbGapAt`, `showThumbGapCue` and friends out of the shared
 * script scope — same arrangement as capture.js / find-replace.js. Its own exports
 * go on window.PageMove and app.js calls them guarded (BI-14).
 */
(function () {
  const D = () => (window.desktop && window.desktop.pages) || null;
  const tr = (vi, params) => (window.t ? window.t(vi, params) : vi);

  // How long the cursor has to rest on a collapsed page column before it springs
  // open. Not instant on purpose: crossing a window on the way to another one is
  // ordinary, and a column that flicks in and out on every pass is noise (P12).
  const SPRING_MS = 300;

  // ---- source side ---------------------------------------------------------

  // The pages this document is currently offering, plus a fingerprint of the
  // document they were measured against. Set before a transfer, read when main
  // asks us to export, and cleared only after the whole transfer has resolved —
  // clearing it any earlier would answer main's export request with "nothing".
  let offered = null;

  function fingerprint() {
    return {
      docId: state.docId || null,
      numPages: state.numPages || 0,
      len: state.bytes ? state.bytes.length : 0,
    };
  }

  // Has this document changed under us since the pages were offered? Deleting by
  // stale indices would remove pages the user never pointed at, so a transfer that
  // straddles an edit keeps its originals and says so.
  function unchanged(fp) {
    const now = fingerprint();
    return !!fp && fp.docId === now.docId && fp.numPages === now.numPages && fp.len === now.len;
  }

  // Which pages a grab acts on: the page itself, or the whole ticked set when the
  // grabbed page is part of it. The rule lives in page-range.js so it can be
  // unit-tested (npm run test:pagedrop) — moving pages the user never selected is
  // exactly the kind of silent damage that net exists for.
  function pagesFor(index) {
    return window.PageRange ? window.PageRange.actionSet(index, state.selected) : [index];
  }

  function offer(indices) {
    offered = { indices: [...indices], fp: fingerprint() };
    return offered;
  }

  // Why this document cannot take pages right now — a code, not a sentence, so
  // main stays language-free and the SOURCE window words it (P13).
  function whyBlocked() {
    if (typeof licBlocked === "function" && licBlocked()) return "pro";
    if (!state.bytes || !state.numPages) return "empty";
    if (window.Editor && window.Editor.active) return "busy-annot";
    if (window.TextEdit && window.TextEdit.active) return "busy-text";
    return null;
  }

  const BLOCK_TEXT = {
    pro: "Tính năng này cần kích hoạt bản quyền.",
    empty: "Tài liệu đích chưa mở file nào.",
    "busy-annot": "Tài liệu đích đang chú thích dở.",
    "busy-text": "Tài liệu đích đang sửa chữ dở.",
    "not-column": "Thả vào cột trang (danh sách trang bên trái) của cửa sổ đích.",
    busy: "Tài liệu đích đang bận — thử lại sau.",
    "no-target": "Không tìm thấy tài liệu đích.",
    "same-doc": "Đó chính là tài liệu này.",
    "no-pages": "Không có trang nào để chuyển.",
    // Refused by THIS document, not by the destination — hence the different voice.
    "src-busy": "Đang chú thích / sửa chữ dở — bấm Xong trước khi chuyển trang.",
    "export-failed": "Không bóc được trang ra khỏi tài liệu này.",
    "insert-failed": "Tài liệu đích không chèn được trang.",
  };
  const blockText = (code) => tr(BLOCK_TEXT[code] || "Không chuyển được trang sang tài liệu đích.");

  // Report a finished transfer, at the SOURCE — that is where the hand that
  // started it is looking (P13). On a copy the toast carries the button that turns
  // it into a move, which is also how a user who never learned Shift finds the
  // move at all.
  function reportSent(res, indices, fp, moved) {
    if (!res || !res.ok) {
      // A drop that landed nowhere is not a failure and must stay silent: it is the
      // ordinary way to abandon a drag.
      if (res && res.action === "none") return;
      if (res && res.reason) toast(blockText(res.reason), "bad");
      return;
    }
    const n = res.inserted || indices.length;
    const where = res.target ? ` → ${res.target}` : "";
    if (moved) {
      toast(tr("Đã chuyển {n} trang{where}.", { n, where }), "good");
      return;
    }
    toast(tr("Đã copy {n} trang{where}.", { n, where }), "good", {
      label: tr("Xoá khỏi bản gốc"),
      onClick: () => removeOriginals(indices, fp),
    });
  }

  // The second half of a move. Refuses on a document that changed since the pages
  // were offered, because the indices it holds would then point somewhere else.
  async function removeOriginals(indices, fp) {
    if (!unchanged(fp)) {
      toast(tr("Tài liệu đã thay đổi — không xoá trang gốc nữa."), "warn");
      return;
    }
    await deletePages(indices);
  }

  // ---- source: answering main ---------------------------------------------

  function answerCanAccept(msg) {
    const d = D();
    if (!d || !msg) return;
    const block = whyBlocked();
    if (block) return d.reply({ reqId: msg.reqId, ok: false, block });
    // `at` present = a page is being dropped at that point; resolve it to a real
    // insert gap here, because only this renderer can see its own page column.
    // `at` absent = the menu path, which appends at the end (SPEC §4.1, T8).
    const gap = msg.at ? gapAt(msg.at.x, msg.at.y) : state.numPages;
    if (gap == null) return d.reply({ reqId: msg.reqId, ok: false, block: "not-column" });
    d.reply({ reqId: msg.reqId, ok: true, gap });
  }

  // Main asks this document to hand over the pages it offered. This is the only
  // place bytes leave a document, and it only ever exports what `offered` names.
  async function answerExport(msg) {
    const d = D();
    if (!d || !msg) return;
    const fail = (reason) => d.reply({ reqId: msg.reqId, ok: false, reason });
    if (!offered || !offered.indices.length) return fail("no-pages");
    if (!state.bytes) return fail("no-pages");
    // A live annotation / text-edit session is NOT in state.bytes yet — it is baked on
    // "Xong". Exporting now would send pages with the work-in-progress silently missing,
    // and a Shift-move would then delete the original underneath a session still editing
    // it. The toolbar already freezes page operations in this state; the drag gesture
    // never did (that predates this feature), so the refusal lands here.
    const busy = whyBlocked();
    if (busy === "busy-annot" || busy === "busy-text") return fail("src-busy");
    const indices = offered.indices.filter((i) => i >= 0 && i < state.numPages);
    if (!indices.length) return fail("no-pages");
    showOverlay(tr("Đang chuẩn bị trang…"));
    try {
      const { PDFDocument } = window.PDFLib;
      const src = await PDFDocument.load(state.bytes);
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, indices);
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save();
      d.reply({
        reqId: msg.reqId,
        ok: true,
        bytes,
        count: indices.length,
        name: state.name || "document.pdf",
      });
    } catch (err) {
      fail("export-failed");
    } finally {
      hideOverlay();
    }
  }

  // ---- target side --------------------------------------------------------

  let springTimer = null;
  let springOpened = false; // WE opened the column and owe the user its old state

  const collapsed = () => {
    const ws = document.querySelector(".workspace");
    return !!(ws && ws.classList.contains("sidebar-collapsed"));
  };

  const hits = (el, x, y) => {
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return !!r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  function cancelSpringTimer() {
    clearTimeout(springTimer);
    springTimer = null;
  }

  // Spring-loaded page column: resting the cursor on the collapsed column's tab
  // opens it, so there is something to aim at. Anything else — a pass across the
  // window, a drag that ends elsewhere — leaves the layout exactly as it was.
  function maybeSpring(x, y) {
    if (!collapsed()) return;
    if (!hits($("sidebar-expand"), x, y)) return cancelSpringTimer();
    if (springTimer) return;
    springTimer = setTimeout(() => {
      springTimer = null;
      if (!collapsed()) return;
      toggleSidebar(false);
      springOpened = true;
    }, SPRING_MS);
  }

  // Give the column back the state we found it in: the drag went somewhere else, so
  // a column we sprang open owes the user its old state (P12).
  function settleSpring() {
    cancelSpringTimer();
    if (!springOpened) return;
    springOpened = false;
    toggleSidebar(true);
  }

  // Pages really landed here — open the column and KEEP it open, whether we sprang it
  // or it was closed all along. The menu route arrives without any hover at all, so
  // this is the only thing that lets a user see where pages they just sent went
  // (§9.4). It also drops our claim on the column: hover-end must not close it now.
  function keepColumnOpen() {
    cancelSpringTimer();
    springOpened = false;
    if (collapsed()) toggleSidebar(false);
  }

  // Which insert gap a point in this window's client coordinates means, or null
  // when it means nothing (outside the column, or the column is put away).
  //
  // The above-or-below decision is delegated to app.js's thumbGapAt, the same
  // function the in-column reorder drag uses. Re-deriving it here is how the cue
  // and the resulting page order drift apart (the BI-33 lesson), so it is not
  // re-derived.
  function gapAt(x, y) {
    const wrap = $("thumbs");
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return null; // column collapsed → nothing to aim at
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const el = document.elementFromPoint(x, y);
    const div = el && el.closest ? el.closest(".thumb") : null;
    if (div && div.dataset && div.dataset.index != null) {
      return thumbGapAt(div, +div.dataset.index, { clientY: y });
    }
    // Inside the column but not on a page (the padding under the last one): the end
    // of the document is the only gap that point can mean.
    return state.numPages;
  }

  const clampGap = (g) => Math.min(Math.max(0, Math.floor(Number(g)) || 0), state.numPages);

  // Pages are being dragged over this window. ~12 of these a second, so it stays
  // cheap: one hit test and the same two-bar cue the reorder drag draws.
  function onHover(at) {
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    if (whyBlocked()) return; // a document that cannot accept shows no promise it can
    maybeSpring(at.x, at.y);
    const gap = gapAt(at.x, at.y);
    if (gap == null) clearThumbCues();
    else showThumbGapCue(gap);
  }

  function onHoverEnd() {
    clearThumbCues();
    settleSpring();
  }

  // Main asks this document to insert pages. The reply is the ONLY thing that lets
  // the source delete its originals, so it says ok exactly when the document really
  // grew (BI-56).
  async function answerReceive(msg) {
    const d = D();
    if (!d || !msg) return;
    const fail = (block) => d.reply({ reqId: msg.reqId, ok: false, block });
    const block = whyBlocked();
    if (block) return fail(block);
    const bytes = typeof toU8 === "function" ? toU8(msg.bytes) : msg.bytes;
    if (!bytes || !bytes.length) return fail("no-bytes");
    clearThumbCues();
    const gap = clampGap(msg.gap);
    const before = state.numPages;
    try {
      await insertBuffersAt([bytes], gap);
    } catch (err) {
      return fail("insert-failed");
    }
    const inserted = state.numPages - before;
    if (inserted <= 0) return fail("insert-failed");
    // Only now, and only on success: a column we sprang open for a drop that then
    // failed must go back to being closed, and the hover-end still to come does exactly
    // that as long as we have not dropped our claim on it (P12).
    keepColumnOpen(); // pages really landed — show the user where
    if (msg.from) toast(tr("Đã nhận {n} trang từ {from}.", { n: inserted, from: msg.from }), "good");
    d.reply({ reqId: msg.reqId, ok: true, inserted });
  }

  // ---- the two entry points ------------------------------------------------

  // A page drag began in this window's column. Deliberately cheap and always
  // called, including for a plain reorder: main answers a same-window drop with
  // silence, so the shipped reorder gesture is untouched.
  function dragStart(index) {
    const d = D();
    if (!d) return;
    // Deliberately NOT gated on the licence here. Reordering inside one document is
    // free (reorderPage calls no gate), so a Free user drags pages every day; refusing
    // at the grab would make a cross-window drop end in silence. Let it travel instead
    // — the destination answers "pro" from whyBlocked() and the source says so out
    // loud, which is an explanation rather than a dead gesture. The actual insert is
    // gated three ways over: can-accept, insertBuffersAt, and the menu's own
    // gateProFeature (BI-26).
    offer(pagesFor(index));
    d.dragStart();
  }

  // …and ended. Main pairs it with the real cursor position; a drop inside this
  // window comes back as "self" and nothing happens here.
  async function dragEnd(shift) {
    const d = D();
    if (!d || !offered) return;
    const { indices, fp } = offered;
    let res = null;
    try {
      res = await d.dragEnd();
    } finally {
      offered = null; // only now: main asks us to export DURING the call above
    }
    if (!res || res.action !== "send") return;
    const moved = !!shift && res.ok && unchanged(fp);
    if (moved) await deletePages(indices);
    reportSent(res, indices, fp, moved);
  }

  // "Chuyển trang sang tài liệu khác…" — the path that does not need a drag, and
  // the only one that can reach another TAB.
  async function openSendMenu(clientX, clientY, index) {
    const d = D();
    if (!d || !window.Capture || !window.Capture.showMenu) return;
    if (typeof gateProFeature === "function" && gateProFeature()) return;
    const indices = pagesFor(index);
    if (!indices.length) return;
    let targets = [];
    try {
      targets = (await d.targets()) || [];
    } catch (_) {
      targets = [];
    }
    const entries = [
      { header: tr("Copy {n} trang tới (nối vào cuối)", { n: indices.length }) },
    ];
    if (!targets.length) {
      entries.push({ label: tr("Không có tài liệu nào khác đang mở"), enabled: false });
    } else {
      const manyWindows = new Set(targets.map((t) => t.window)).size > 1;
      for (const t of targets) {
        const where = manyWindows || !t.sameWindow ? tr("Cửa sổ {w} · ", { w: t.window }) : "";
        const why = t.accepts ? "" : ` — ${shortBlock(t.block)}`;
        entries.push({
          label: `${where}${t.title}${why}`,
          enabled: !!t.accepts,
          onClick: () => sendTo(t.id, indices),
        });
      }
    }
    window.Capture.showMenu(clientX, clientY, entries);
  }

  // Short enough to sit inside a menu label, where the full sentence would not.
  const SHORT_BLOCK = {
    empty: "chưa mở file",
    "busy-annot": "đang chú thích",
    "busy-text": "đang sửa chữ",
    pro: "cần bản quyền",
    busy: "đang bận",
  };
  const shortBlock = (code) => tr(SHORT_BLOCK[code] || "không nhận được");

  async function sendTo(tabId, indices) {
    const d = D();
    if (!d) return;
    const fp = fingerprint();
    offer(indices);
    let res = null;
    try {
      res = await d.sendTo(tabId);
    } finally {
      offered = null;
    }
    reportSent(res, indices, fp, false);
  }

  // ---- wiring -------------------------------------------------------------

  const d0 = D();
  if (d0) {
    d0.onCanAccept(answerCanAccept);
    d0.onExport(answerExport);
    d0.onReceive(answerReceive);
    d0.onHover(onHover);
    d0.onHoverEnd(onHoverEnd);
  }

  window.PageMove = {
    dragStart,
    dragEnd,
    openSendMenu,
    // For the tests / for app.js to check the feature is really here.
    gapAt,
  };
})();
