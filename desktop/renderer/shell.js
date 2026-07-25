"use strict";

// Tab strip logic. Renders the tab list pushed from main (tabs:state) and sends
// intents back (activate / close / new / reorder). No document logic lives here —
// each tab is a full renderer in its own WebContentsView.

(function () {
  const tabsEl = document.getElementById("tabs");
  const addEl = document.getElementById("add");

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

  if (window.shellBridge && window.shellBridge.onState) {
    window.shellBridge.onState(render);
  }
})();
