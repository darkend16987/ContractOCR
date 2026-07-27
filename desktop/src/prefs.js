"use strict";

// ---------------------------------------------------------------------------
// Main-process user preferences (userData/prefs.json).
//
// WHY NOT localStorage: everything in here is a decision main has to make
// *before* it can ask a renderer — where to put a file handed over by Explorer
// ("Open with"), for instance, is decided while no document window may exist at
// all. Same reason session.js keeps its `restore` flag on disk.
//
// WHY NOT session.json: that file's value is its narrow scope — it records paths
// and nothing else, so a bug in it can never cost a document (see its header).
// A general settings bag does not belong in it.
//
// Shape:  { v: 1, openIn: "tab" | "window" }
//
// Every value is validated on the way IN (from disk, which a human may have
// edited, and from IPC, which is renderer-supplied) and falls back to the
// default rather than propagating junk into window routing.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const VERSION = 1;

// Where a file opened while a document window already exists should land.
//   "tab"    — a new tab in the window that asked (the behaviour before this
//              setting existed, and the default)
//   "window" — a new window, leaving the current one untouched
const OPEN_IN = ["tab", "window"];

const DEFAULTS = Object.freeze({ openIn: "tab" });

let file = null;
let values = { ...DEFAULTS };

function configure(d) {
  file = d && d.file;
  values = { ...DEFAULTS, ...readFile() };
}

function readFile() {
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and anything that hand-edits this
    // file on Windows (PowerShell's Set-Content, Notepad) will leave one behind.
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (!raw || raw.v !== VERSION) return null;
    const out = {};
    if (OPEN_IN.includes(raw.openIn)) out.openIn = raw.openIn;
    return out;
  } catch (_) {
    return null; // missing or corrupt — start from defaults, never throw at launch
  }
}

function write() {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, ...values }));
    fs.renameSync(tmp, file); // atomic-ish: never leave a half-written file
    return true;
  } catch (_) {
    return false; // a preference that failed to persist is not worth crashing over
  }
}

function getOpenIn() {
  return values.openIn;
}

// Returns the value actually stored, so the caller (and the renderer's select)
// can settle on it rather than assuming the write took the requested value.
function setOpenIn(v) {
  values.openIn = OPEN_IN.includes(v) ? v : DEFAULTS.openIn;
  write();
  return values.openIn;
}

module.exports = { configure, getOpenIn, setOpenIn, OPEN_IN, DEFAULTS };
