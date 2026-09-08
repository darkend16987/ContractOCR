"use strict";

// Tab strip logic. Renders the tab list pushed from main (tabs:state) and sends
// intents back (activate / close / new / reorder). No document logic lives here —
// each tab is a full renderer in its own WebContentsView.

(function () {
  const tabsEl = document.getElementById("tabs");
  const addEl = document.getElementById("add");
  const splitEl = document.getElementById("split");
  const guttersEl = document.getElementById("gutters");

  function truncTitle(t) {
    const s = String(t || "document.pdf");
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  // ---- drag to reorder ----------------------------------------------------
  // The strip reorders its own DOM live while dragging (so the user sees the tab
  // move), then reports the final order to main on drop. Main owns the real order
  // and echoes a fresh tabs:state back, which re-renders authoritatively — so a
  // rejected/stale reorder simply snaps back.

  // The tab the dragged one should be inserted BEFORE, from the pointer's x.
  function dropTargetAt(x) {
    for (const el of tabsEl.querySelectorAll(".tab:not(.dragging)")) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) return el;
    }
    return null;
  }

  // The strip's current left-to-right order, or null if the DOM is in a state we
  // don't trust — main rejects a bad list anyway, but there's no point sending one.
  function currentOrder() {
    const ids = [...tabsEl.querySelectorAll(".tab")].map((el) => Number(el.dataset.id));
    return ids.length && ids.every((n) => Number.isFinite(n)) ? ids : null;
  }

  tabsEl.addEventListener("dragover", (ev) => {
    const dragging = tabsEl.querySelector(".tab.dragging");
    if (!dragging) return;
    ev.preventDefault(); // required for the drop to be allowed
    const before = dropTargetAt(ev.clientX);
    if (before) tabsEl.insertBefore(dragging, before);
    else tabsEl.appendChild(dragging);
  });
  tabsEl.addEventListener("drop", (ev) => ev.preventDefault());

  function render(state) {
    const tabs = (state && state.tabs) || [];
    tabsEl.textContent = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t.active ? " active" : "") + (t.dirty ? " dirty" : "");
      el.title = t.title || "document.pdf";
      el.dataset.id = String(t.id);
      el.draggable = true;

      const dot = document.createElement("span");
      dot.className = "dot";

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = truncTitle(t.title);

      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.title = "Đóng tab";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        window.shellBridge.close(t.id);
      });

      el.appendChild(dot);
      el.appendChild(title);
      el.appendChild(close);

      el.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          // Middle-click closes the tab.
          ev.preventDefault();
          window.shellBridge.close(t.id);
        } else if (ev.button === 0) {
          window.shellBridge.activate(t.id);
        }
      });

      el.addEventListener("dragstart", (ev) => {
        el.classList.add("dragging");
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = "move";
          // Firefox/Chromium need *some* payload or the drag never starts.
          try {
            ev.dataTransfer.setData("text/plain", String(t.id));
          } catch (_) {
            /* ignore */
          }
        }
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        // Main decides what this drop meant — reorder here, move to another
        // window, or tear out into a new one. It is the only side that can read
        // a trustworthy cursor position: screen coordinates reported to a
        // WebContentsView are off by the window frame (TABS-2B-DESIGN §2.3).
        window.shellBridge.dragEnd(t.id, currentOrder());
      });

      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        window.shellBridge.tabMenu(t.id);
      });

      tabsEl.appendChild(el);
    }
    // Keep the active tab in view when the strip overflows.
    const active = tabsEl.querySelector(".tab.active");
    if (active && active.scrollIntoView) active.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  addEl.addEventListener("click", () => window.shellBridge.newTab());

  // ---- split view: the dividers -------------------------------------------
  //
  // When the window is split, main gives THIS view the whole window instead of a
  // 40px band and stacks the document views on top of it, so the only pixels left
  // to us are the 6px gutters. That is what lets the divider be dragged without a
  // process, an overlay, or a transparent window of its own (probe P-A).
  //
  // The drag uses setPointerCapture, MEASURED against the HTML5 alternative
  // (probe P-B, docs/RESEARCH-2026-09-08-split-view.md §10.2): an HTML5 drag fires
  // no `drag` events in between (0 of 15) and leaks a stray `drop` into the
  // document underneath, while pointer capture delivered all 15 moves even with
  // the pointer deep inside a sibling view's territory.
  //
  // `e.clientX` needs no correction here — unlike the screen coordinates a
  // WebContentsView reports (docs/TABS-2B-DESIGN.md §2.3) — precisely because this
  // view covers the whole content area while split, so its client origin IS the
  // window's content origin.

  const GUTTER_W = 6; // must match SPLIT_GUTTER in src/tabs.js
  let geom = null; // { gutters: [{x,y,width,height}], chrome: {width,height} }
  let drag = null; // { i, el, pointerId, widths, usable }

  // Pane widths implied by the gutter positions. Derived rather than sent because
  // the gutters ARE the boundaries: deriving cannot disagree with what is drawn.
  function widthsFromGeom(g) {
    const out = [];
    let left = 0;
    for (const gut of g.gutters) {
      out.push(Math.max(0, gut.x - left));
      left = gut.x + gut.width;
    }
    out.push(Math.max(0, g.chrome.width - left));
    return out;
  }

  function placeGutters() {
    if (!geom) return;
    const els = guttersEl.children;
    for (let i = 0; i < els.length && i < geom.gutters.length; i++) {
      const r = geom.gutters[i];
      els[i].style.left = r.x + "px";
      els[i].style.top = r.y + "px";
      els[i].style.width = r.width + "px";
      els[i].style.height = r.height + "px";
    }
  }

  function onDragMove(ev) {
    if (!drag) return;
    const w = drag.widths.slice();
    // Only the two panes either side of THIS divider change; the rest keep the
    // widths the user already chose, which is what makes dragging the left gutter
    // of a three-pane layout feel local instead of re-flowing everything.
    const leftEdge = w.slice(0, drag.i).reduce((a, b) => a + b, 0) + drag.i * GUTTER_W;
    const pairTotal = w[drag.i] + w[drag.i + 1];
    let a = ev.clientX - leftEdge;
    // A tiny floor only so the ratios stay positive — the REAL minimum widths live
    // in src/tabs.js and are applied by main, which then echoes the geometry back.
    a = Math.max(1, Math.min(pairTotal - 1, a));
    w[drag.i] = a;
    w[drag.i + 1] = pairTotal - a;
    const usable = drag.usable || w.reduce((x, y) => x + y, 0) || 1;
    window.shellBridge.setSplitRatios(w.map((x) => x / usable));
  }

  function endDrag() {
    if (!drag) return;
    try {
      drag.el.releasePointerCapture(drag.pointerId);
    } catch (_) {
      /* capture already lost — that is the very case this handler exists for */
    }
    drag.el.classList.remove("dragging");
    document.body.classList.remove("dragging-gutter");
    drag = null;
  }

  function makeGutter(i) {
    const el = document.createElement("div");
    el.className = "gutter";
    el.title = "Kéo để đổi tỷ lệ";
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !geom) return;
      ev.preventDefault();
      const widths = widthsFromGeom(geom);
      if (i + 1 >= widths.length) return;
      drag = {
        i,
        el,
        pointerId: ev.pointerId,
        widths,
        usable: geom.chrome.width - geom.gutters.length * GUTTER_W,
      };
      el.setPointerCapture(ev.pointerId);
      el.classList.add("dragging");
      document.body.classList.add("dragging-gutter");
    });
    el.addEventListener("pointermove", onDragMove);
    el.addEventListener("pointerup", endDrag);
    // MANDATORY, not belt-and-braces: capture is lost when the window loses focus,
    // when the pointer is cancelled by the OS, or when an Alt-Tab happens mid-drag.
    // Without this the drag would outlive the gesture that started it — the exact
    // shape of bug BI-58 warns about.
    el.addEventListener("lostpointercapture", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return el;
  }

  function renderSplit(split) {
    const n = (split && split.panes) || 0;
    splitEl.classList.toggle("on", n > 0);
    splitEl.title = n > 0 ? "Đóng khung xem (Ctrl+\\)" : "Chia đôi màn hình (Ctrl+\\)";
    geom = split && split.gutters ? { gutters: split.gutters, chrome: split.chrome } : null;
    // Never rebuild while a divider is being held: the element carrying the pointer
    // capture would be destroyed and the drag would die on its first frame.
    if (drag) return;
    const want = geom ? geom.gutters.length : 0;
    while (guttersEl.children.length > want) guttersEl.removeChild(guttersEl.lastChild);
    while (guttersEl.children.length < want) guttersEl.appendChild(makeGutter(guttersEl.children.length));
    placeGutters();
  }

  splitEl.addEventListener("click", () => window.shellBridge.toggleSplit());

  if (window.shellBridge && window.shellBridge.onState) {
    window.shellBridge.onState((state) => {
      render(state);
      renderSplit(state && state.split);
    });
  }
  if (window.shellBridge && window.shellBridge.onSplitGeom) {
    window.shellBridge.onSplitGeom((g) => {
      if (!g || !g.gutters) return;
      geom = g;
      placeGutters();
    });
  }
})();
