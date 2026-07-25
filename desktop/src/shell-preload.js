"use strict";

// Bridge for the tab strip (renderer/shell.html). Minimal surface: receive the
// tab list from main, and send tab intents (new / activate / close) back.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellBridge", {
  // cb receives { tabs: [{ id, title, dirty, active }] }.
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
});
