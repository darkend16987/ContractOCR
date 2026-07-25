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
});
