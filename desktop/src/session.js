"use strict";

// ---------------------------------------------------------------------------
// Session persistence — which documents were open, in which windows, so the next
// launch can put them back.
//
// SCOPE, deliberately narrow: this file remembers **paths**, never content.
// Unsaved work belongs to crash recovery (the recovery:* handlers in main.js),
// which snapshots real bytes. Keeping the two apart means a bug here can never
// cost anyone a document — the worst case is a tab that doesn't come back.
//
// The on-disk shape (userData/session.json):
//   { v: 1, restore: true, windows: [ { bounds, maximized, active, tabs: [path] } ] }
//
// `restore` doubles as the user's Settings toggle: main has to know it before any
// renderer exists, so it cannot live in the renderer's localStorage.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const VERSION = 1;
const DEBOUNCE_MS = 1000;

let file = null;
let snapshot = null; // () => { windows: [...] }
let anyClosing = null; // () => bool — true while a window is mid-teardown
let timer = null;
let enabled = true;
let loaded = null; // what we read at startup, handed to the restorer once

function configure(d) {
  file = d.file;
  snapshot = d.snapshot;
  anyClosing = d.anyClosing || (() => false);
  loaded = readFile();
  if (loaded && typeof loaded.restore === "boolean") enabled = loaded.restore;
}

function readFile() {
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and anything that hand-edits this
    // file on Windows (PowerShell's Set-Content, Notepad) will leave one behind.
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (!raw || raw.v !== VERSION) return null;
    return raw;
  } catch (_) {
    return null; // missing or corrupt — start fresh, never throw at launch
  }
}

// The windows recorded by the previous run. Read once; the caller decides what
// to do with them.
function previousWindows() {
  return loaded && Array.isArray(loaded.windows) ? loaded.windows : [];
}

function isEnabled() {
  return enabled;
}

function setEnabled(on) {
  enabled = !!on;
  saveNow(); // persist the flag immediately — it must survive a crash too
  return enabled;
}

function write(data) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file); // atomic-ish: never leave a half-written session
    return true;
  } catch (_) {
    return false; // session memory is a convenience; failing to save is not fatal
  }
}

function saveNow() {
  if (!file || !snapshot) return false;
  cancel();
  // While a window is tearing down the picture is transient (tabs already gone,
  // window not yet removed). Writing then would record a half-closed app, so
  // wait and let whoever finishes the teardown trigger the real save.
  if (anyClosing && anyClosing()) {
    schedule();
    return false;
  }
  const snap = snapshot() || { windows: [] };
  return write({ v: VERSION, restore: enabled, windows: snap.windows || [] });
}

function schedule() {
  if (!file) return;
  clearTimeout(timer);
  timer = setTimeout(saveNow, DEBOUNCE_MS);
}

function cancel() {
  clearTimeout(timer);
  timer = null;
}

module.exports = { configure, previousWindows, isEnabled, setEnabled, saveNow, schedule, cancel };
