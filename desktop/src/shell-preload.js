"use strict";

// Bridge for the tab strip (renderer/shell.html). Minimal surface: receive the
// tab list from main, and send tab intents (new / activate / close) back.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellBridge", {
  // cb receives { tabs: [{ id, title, dirty, active }], split: { panes, max,
  // gutters, chrome, names } }. `split` is pure geometry plus file NAMES — the
  // strip draws the dividers with it and never learns who owns a pane (BI-55).
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("tabs:state", handler);
    return () => ipcRenderer.removeListener("tabs:state", handler);
  },
  newTab: () => ipcRenderer.send("tabs:new-tab"),
  activate: (id) => ipcRenderer.send("tabs:activate", id),
  close: (id) => ipcRenderer.send("tabs:close", id),
  // A tab drag finished. `order` is the strip's new left-to-right order; main
  // pairs it with the real cursor position to decide reorder / move / tear out.
  dragEnd: (id, order) => ipcRenderer.send("tabs:drag-end", { id, order }),
  // Right-click on a tab — main pops a native menu for it.
  tabMenu: (id) => ipcRenderer.send("tabs:context-menu", id),

  // ---- split view ---------------------------------------------------------
  // The ◫ button: same command the View menu's Ctrl+\ runs.
  toggleSplit: () => ipcRenderer.send("split:toggle"),
  // A divider was dragged. `ratios` are fractions of the usable width, one per
  // pane INCLUDING the editable one. Sent live during the drag (throttled to a
  // frame by the strip) — main clamps and re-lays out; it is the source of truth
  // for the window's shape, exactly as it is for full screen (BI-22).
  setSplitRatios: (ratios) => ipcRenderer.send("split:ratios", ratios),
  // …and main answers with the geometry it ACTUALLY used, so the handle follows
  // the real boundary instead of the pointer. That is what keeps the minimum pane
  // widths in one file (src/tabs.js) instead of copied into this renderer.
  onSplitGeom: (cb) => {
    const handler = (_e, geom) => cb(geom);
    ipcRenderer.on("split:geom", handler);
    return () => ipcRenderer.removeListener("split:geom", handler);
  },
});
