"use strict";

// ---------------------------------------------------------------------------
// Tabbed window shell (Lớp 1).
//
// A TabbedWindow is one BaseWindow whose content area holds:
//   • a fixed "tab strip" WebContentsView (renderer/shell.html) at the top, and
//   • N document WebContentsViews below it — each loads the UNCHANGED
//     renderer/index.html, so every tab is a full, independent PDF renderer with
//     its own singular `state`, history, autosave and recovery. Only the ACTIVE
//     document view is attached to the content tree at a time; inactive views
//     stay alive (their renderer keeps running) but detached.
//
// This isolates the tab change to the window layer: the battle-tested per-doc
// renderer is reused verbatim, one instance per tab.
//
// main.js injects its process-level helpers via configure() so this module stays
// free of app wiring (no circular require).
// ---------------------------------------------------------------------------

const path = require("path");
const { BaseWindow, WebContentsView } = require("electron");

// Height (DIP) of the tab strip, below the native title bar.
const TAB_STRIP_H = 40;

let deps = null;
function configure(d) {
  deps = d;
}

const tabbedWindows = new Set();
let _seq = 0; // monotonic tab id source (unique across all windows)
let _focused = null; // most-recently-focused TabbedWindow

class TabbedWindow {
  constructor() {
    this.base = new BaseWindow({
      width: 1360,
      height: 880,
      minWidth: 900,
      minHeight: 600,
      title: "Nabu PDF",
      icon: deps.iconPath,
      backgroundColor: "#0f172a",
    });
    this.tabs = []; // [{ id, view, title, dirty }]
    this.activeId = null;
    // tabId -> { promise, resolve } while a close decision is in flight.
    this._pendingClose = new Map();
    this._forceClose = false;

    // Tab strip: its own view + renderer (shell.html). Never detached.
    this.strip = new WebContentsView({
      webPreferences: {
        preload: deps.shellPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.base.contentView.addChildView(this.strip);
    this.strip.webContents.loadFile(path.join(deps.RENDERER, "shell.html"));
    // The strip may finish loading after the first tab is created — re-push state
    // once it's ready so it never misses the initial render.
    this.strip.webContents.once("did-finish-load", () => this._emit());

    this.base.on("resize", () => this._layout());
    this.base.on("focus", () => {
      _focused = this;
    });
    this.base.on("close", (e) => this._onClose(e));
    this.base.on("closed", () => this._onClosed());

    tabbedWindows.add(this);
    _focused = this;
    this._layout();
  }

  _contentSize() {
    const b = this.base.getContentBounds();
    return { w: Math.max(0, b.width), h: Math.max(0, b.height) };
  }

  _layout() {
    if (this.base.isDestroyed()) return;
    const { w, h } = this._contentSize();
    this.strip.setBounds({ x: 0, y: 0, width: w, height: TAB_STRIP_H });
    const tab = this._active();
    if (tab) {
      tab.view.setBounds({ x: 0, y: TAB_STRIP_H, width: w, height: Math.max(0, h - TAB_STRIP_H) });
    }
  }

  _active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }
  _tab(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  // Create a new document tab. openPath (optional) is an absolute .pdf to load
  // once its renderer is ready. The new tab becomes active.
  createTab({ openPath } = {}) {
    const id = ++_seq;
    const view = new WebContentsView({
      webPreferences: {
        preload: deps.docPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    deps.hardenNav(wc);
    deps.attachContextMenu(wc);
    wc.loadFile(path.join(deps.RENDERER, "index.html"));
    if (openPath) {
      wc.once("did-finish-load", () => deps.sendFileToView(wc, openPath));
    }

    const tab = { id, view, title: "Nabu PDF", dirty: false };
    this.tabs.push(tab);
    this.activateTab(id);
    this._emit();
    return tab;
  }

  activateTab(id) {
    const next = this._tab(id);
    if (!next) return;
    if (this.activeId === id) {
      this._layout();
      return;
    }
    const prev = this._active();
    if (prev && prev.id !== id) {
      try {
        this.base.contentView.removeChildView(prev.view);
      } catch (_) {
        /* view already gone */
      }
    }
    this.activeId = id;
    this.base.contentView.addChildView(next.view);
    this._layout();
    try {
      next.view.webContents.focus();
    } catch (_) {
      /* focus is best-effort */
    }
    this._emit();
  }

  // Ask a tab's renderer whether it may close, then destroy it on "proceed".
  // Returns the decision (true = closed, false = user cancelled).
  async closeTab(id, { closeIfEmpty = true } = {}) {
    const tab = this._tab(id);
    if (!tab) return true;
    const proceed = await this._requestClose(tab);
    if (proceed && this._tab(id)) this.destroyTab(id, { closeIfEmpty });
    return proceed;
  }

  // Send "window:before-close" to the tab's renderer and return a promise that
  // resolves once it answers via window:force-close (proceed) or
  // window:close-cancelled (cancel). Re-entrant calls share one promise.
  _requestClose(tab) {
    const existing = this._pendingClose.get(tab.id);
    if (existing) {
      this.activateTab(tab.id);
      return existing.promise;
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    this._pendingClose.set(tab.id, { promise, resolve });
    this.activateTab(tab.id); // surface the doc the prompt is about
    try {
      tab.view.webContents.send("window:before-close");
    } catch (_) {
      // Renderer is gone — nothing to lose, allow the close.
      this._resolveClose(tab.id, true);
    }
    return promise;
  }

  // Called from main when the doc renderer answers a close request.
  _resolveClose(tabId, proceed) {
    const e = this._pendingClose.get(tabId);
    if (e) {
      this._pendingClose.delete(tabId);
      e.resolve(proceed);
    }
  }

  destroyTab(id, { closeIfEmpty = true } = {}) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    const wasActive = this.activeId === id;
    try {
      this.base.contentView.removeChildView(tab.view);
    } catch (_) {
      /* already detached */
    }
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch (_) {
      /* older Electron without webContents.close(): drop the ref instead */
    }
    this.tabs.splice(idx, 1);
    this._pendingClose.delete(id);

    if (this.tabs.length === 0) {
      this.activeId = null;
      if (closeIfEmpty) {
        this._forceClose = true;
        if (!this.base.isDestroyed()) this.base.close();
      } else {
        this._emit();
      }
      return;
    }
    if (wasActive) {
      const nextTab = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeId = null; // force activateTab to re-attach
      this.activateTab(nextTab.id);
    } else {
      this._emit();
    }
  }

  // Native-window close (the ✕ on the title bar): guard every tab in turn.
  _onClose(e) {
    if (this._forceClose || (deps.isQuitting && deps.isQuitting())) return; // allow
    e.preventDefault();
    this._guardAndClose();
  }

  async _guardAndClose() {
    for (const tab of [...this.tabs]) {
      if (!this._tab(tab.id)) continue;
      const proceed = await this.closeTab(tab.id, { closeIfEmpty: false });
      if (!proceed) return; // a cancel aborts the whole-window close
    }
    this._forceClose = true;
    if (!this.base.isDestroyed()) this.base.close();
  }

  _onClosed() {
    for (const t of this.tabs) {
      try {
        if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.tabs = [];
    try {
      if (this.strip && !this.strip.webContents.isDestroyed()) this.strip.webContents.close();
    } catch (_) {
      /* ignore */
    }
    tabbedWindows.delete(this);
    if (_focused === this) _focused = null;
    if (!tabbedWindows.size && deps.onAllClosed) deps.onAllClosed();
  }

  // Update a tab's title/dirty from its doc renderer (tab:meta), then repaint.
  setMeta(viewWebContents, meta) {
    const tab = this.tabs.find((t) => t.view.webContents === viewWebContents);
    if (!tab) return;
    if (meta && typeof meta.title === "string") tab.title = meta.title;
    if (meta && typeof meta.dirty === "boolean") tab.dirty = meta.dirty;
    this._emit();
  }

  _emit() {
    if (!this.strip || this.strip.webContents.isDestroyed()) return;
    const tabs = this.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      dirty: t.dirty,
      active: t.id === this.activeId,
    }));
    try {
      this.strip.webContents.send("tabs:state", { tabs });
    } catch (_) {
      /* strip not ready yet — did-finish-load re-emits */
    }
  }

  focus() {
    if (!this.base.isDestroyed()) {
      this.base.show();
      this.base.focus();
    }
  }
}

// ---- module-level lookups (used by main.js IPC reroute) -------------------

function findDoc(webContents) {
  for (const tw of tabbedWindows) {
    const tab = tw.tabs.find((t) => t.view && t.view.webContents === webContents);
    if (tab) return { tw, tab };
  }
  return null;
}

function findByStrip(webContents) {
  for (const tw of tabbedWindows) {
    if (tw.strip && tw.strip.webContents === webContents) return tw;
  }
  return null;
}

function focusedTabbedWindow() {
  if (_focused && tabbedWindows.has(_focused) && !_focused.base.isDestroyed()) return _focused;
  for (const tw of tabbedWindows) if (!tw.base.isDestroyed()) return tw;
  return null;
}

function allDocContents() {
  const out = [];
  for (const tw of tabbedWindows) {
    for (const t of tw.tabs) {
      if (t.view && !t.view.webContents.isDestroyed()) out.push(t.view.webContents);
    }
  }
  return out;
}

// webContents of the focused window's active tab (menu/updater target).
function activeContents() {
  const tw = focusedTabbedWindow();
  if (!tw) return null;
  const t = tw._active();
  return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
}

function createTabbedWindow(openPath) {
  const tw = new TabbedWindow();
  tw.createTab(openPath ? { openPath } : {});
  return tw;
}

function count() {
  return tabbedWindows.size;
}

module.exports = {
  configure,
  createTabbedWindow,
  findDoc,
  findByStrip,
  focusedTabbedWindow,
  allDocContents,
  activeContents,
  count,
  TabbedWindow,
  TAB_STRIP_H,
};
