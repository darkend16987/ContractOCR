"use strict";

// Bridge for a READ-ONLY split-view pane (renderer/view.html).
//
// Deliberately the smallest surface in the app, and the smallness IS the feature:
// this renderer shows a document the user is editing in ANOTHER renderer, so it must
// not be able to
//   · write anything (no dialog:save-*, no file:write-pdf, no recovery:*),
//   · reach the sidecar (no OCR / translate / compress / decrypt),
//   · or name another renderer — main routes everything and the pane is identified
//     by `e.sender`, never by an id it hands over (BI-55).
// Compare src/preload.js (277 lines, 43 channels) with the eight below.
//
// The pane also never asks for a document: main pushes one in. That is what keeps
// "which file may this pane read" a decision main owns.

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("viewPane", {
  // Told main the page is listening. Main holds back the document until this
  // arrives, so a slow load can never miss its own file:open.
  ready: () => ipcRenderer.send("view:ready"),

  // { name, path, data: Uint8Array, savedAt } — the document as it is ON DISK.
  // A read-only pane deliberately shows the SAVED file, not the bytes being edited
  // next door: it gives the staleness an explainable rule ("this is the last save")
  // and keeps 120 MB of document out of the IPC channel between two renderers.
  onOpen: (cb) => on("view:open", cb),

  // Source went away (file deleted, tab closed, user cleared the pane).
  onClear: (cb) => on("view:clear", cb),

  // Main pane saved this same path — reload so the pane stops showing yesterday.
  onReload: (cb) => on("view:reload", cb),

  // { canEdit } — header facts only main can know, chiefly "is this the same
  // document as the editable pane?". No ids, no titles of other renderers.
  onState: (cb) => on("view:state", cb),

  // "Which document should this pane show?" — main pops a NATIVE menu at the
  // cursor and acts on the answer itself. The pane never receives the list, so it
  // never learns what else is open (BI-55); it only asks the question.
  pickSource: () => ipcRenderer.send("view:pick-source"),

  // "Sửa file này" — hand this pane's document to the editable pane. Main decides
  // whether that is activating an existing tab or opening a new one.
  editThis: () => ipcRenderer.send("view:edit-this"),

  // Close this pane. Main resolves WHICH pane from e.sender.
  close: () => ipcRenderer.send("view:close"),
});
