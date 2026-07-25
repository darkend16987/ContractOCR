"use strict";

// Tab strip logic. Renders the tab list pushed from main (tabs:state) and sends
// intents back (activate / close / new). No document logic lives here — each tab
// is a full renderer in its own WebContentsView.

(function () {
  const tabsEl = document.getElementById("tabs");
  const addEl = document.getElementById("add");

  function truncTitle(t) {
    const s = String(t || "document.pdf");
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  function render(state) {
    const tabs = (state && state.tabs) || [];
    tabsEl.textContent = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t.active ? " active" : "") + (t.dirty ? " dirty" : "");
      el.title = t.title || "document.pdf";

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
