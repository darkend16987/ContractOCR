"use strict";

const { contextBridge } = require("electron");

// The sidecar port is passed to the renderer via the loadFile query string.
// Expose a tiny, safe surface — just the local base URL — to the page.
const params = new URLSearchParams(globalThis.location.search);
const port = params.get("port");

contextBridge.exposeInMainWorld("sidecar", {
  port,
  baseUrl: port ? `http://127.0.0.1:${port}` : null,
});
