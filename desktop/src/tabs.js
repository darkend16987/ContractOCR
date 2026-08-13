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

const fs = require("fs");
const path = require("path");
const { BaseWindow, WebContentsView, screen } = require("electron");
const Session = require("./session");

// Height (DIP) of the tab strip, below the native title bar.
const TAB_STRIP_H = 40;

// How far outside the strip a drop has to land before it means "tear this tab
// out" rather than "my hand wobbled while reordering". Generous on purpose: an
// accidental tear is far more annoying than a tear that needs a longer drag.
const TEAR_PAD_X = 24;
const TEAR_PAD_Y = 60;

let deps = null;
function configure(d) {
  deps = d;
}

const tabbedWindows = new Set();
let _seq = 0; // monotonic tab id source (unique across all windows)
let _focused = null; // most-recently-focused TabbedWindow
// Monotonic "who was on top most recently" stamp. Electron exposes no window
// z-order, and document views overlap constantly, so a page dropped where two
// windows overlap has to be resolved somehow: focus recency is the honest proxy
// (the window you can see at that spot is, in practice, the one you touched last).
// Only classifyPageDrop uses it — the tab strips it does not affect.
let _focusTick = 0;

class TabbedWindow {
  // `bounds` (optional) places the window explicitly — used when a torn-out tab
  // should land where the user dropped it instead of at the default position.
  constructor({ bounds } = {}) {
    this.base = new BaseWindow({
      width: 1360,
      height: 880,
      ...(bounds || {}),
      minWidth: 900,
      minHeight: 600,
      title: "Nabu PDF",
      icon: deps.iconPath,
      backgroundColor: "#0f172a",
    });
    this.tabs = []; // [{ id, view, title, dirty, path, pendingPath }]
    this.activeId = null;
    // Full-screen reading mode: the tab strip gives up its band so the document
    // really gets the whole screen. Mirrors the OS full-screen state, which can
    // also change without us (window controls) — see the listeners below.
    this._presenting = false;
    // tabId -> { promise, resolve } while a close decision is in flight.
    this._pendingClose = new Map();
    this._forceClose = false;
    // True from the moment this window starts tearing down. While it is set the
    // window's tab list is transient and must not be written to the session file.
    this._closing = false;

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
    bindTabKeys(this.strip.webContents);
    this.strip.webContents.loadFile(path.join(deps.RENDERER, "shell.html"));
    // The strip may finish loading after the first tab is created — re-push state
    // once it's ready so it never misses the initial render.
    this.strip.webContents.once("did-finish-load", () => this._emit());

    this.base.on("resize", () => {
      this._layout();
      Session.schedule(); // remember where the user put this window
    });
    this.base.on("move", () => Session.schedule());
    this.base.on("focus", () => {
      _focused = this;
      this._focusSeq = ++_focusTick;
    });
    this.base.on("close", (e) => this._onClose(e));
    this.base.on("closed", () => this._onClosed());
    // Full screen can also be left without asking us (window controls, OS
    // gesture, Esc handled by the platform). Following the real state is what
    // stops a renderer being stranded with its toolbar hidden.
    this.base.on("enter-full-screen", () => this._applyPresentation(true));
    this.base.on("leave-full-screen", () => this._applyPresentation(false));

    tabbedWindows.add(this);
    _focused = this;
    this._focusSeq = ++_focusTick; // a brand-new window is on top
    this._layout();
  }

  _contentSize() {
    const b = this.base.getContentBounds();
    return { w: Math.max(0, b.width), h: Math.max(0, b.height) };
  }

  _layout() {
    if (this.base.isDestroyed()) return;
    const { w, h } = this._contentSize();
    // Reading mode collapses the strip to nothing rather than detaching it: the
    // view stays in the tree with every listener intact, so leaving the mode is a
    // pure resize and can't lose the strip's state.
    const stripH = this._presenting ? 0 : TAB_STRIP_H;
    this.strip.setBounds({ x: 0, y: 0, width: w, height: stripH });
    const tab = this._active();
    if (tab) {
      tab.view.setBounds({ x: 0, y: stripH, width: w, height: Math.max(0, h - stripH) });
    }
  }

  // ---- full-screen reading mode -------------------------------------------

  // Enter/leave full screen for this window. Main owns the flag; renderers are
  // told afterwards so their chrome matches what the window is actually doing.
  setPresentation(on) {
    const want = !!on;
    if (this.base.isDestroyed()) return false;
    if (want !== this.base.isFullScreen()) {
      try {
        this.base.setFullScreen(want);
      } catch (_) {
        return false; // platform refused — leave everything as it was
      }
    }
    this._applyPresentation(want);
    return true;
  }

  _applyPresentation(on) {
    if (this._presenting === !!on) return;
    this._presenting = !!on;
    this._layout();
    // Every tab, not just the active one: switching tabs inside the mode must not
    // land on a renderer that still thinks it has a toolbar.
    for (const t of this.tabs) this._sendPresentation(t);
  }

  _sendPresentation(tab) {
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
    try {
      tab.view.webContents.send("window:presentation", this._presenting);
    } catch (_) {
      /* renderer gone */
    }
  }

  handleTabKey(input) {
    if (!input || input.type !== "keyDown" || input.alt) return false;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod) return false;
    if (input.key === "Tab") {
      this.cycleTab(input.shift ? -1 : 1);
      return true;
    }
    if (input.shift) return false;
    if (/^[1-9]$/.test(input.key)) {
      // Ctrl+9 jumps to the LAST tab (browser convention), 1..8 are positional.
      const n = parseInt(input.key, 10);
      const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (tab) this.activateTab(tab.id);
      return true;
    }
    return false;
  }

  // Adopt a new tab order from the strip. Purely a permutation of `this.tabs` —
  // the active view stays attached and nothing re-renders, so reordering can never
  // disturb a document. Ctrl+1..9 follow the new visual order for free.
  reorderTabs(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length !== this.tabs.length) return;
    const byId = new Map(this.tabs.map((t) => [t.id, t]));
    const next = [];
    for (const id of orderedIds) {
      const t = byId.get(id);
      if (t) {
        next.push(t);
        byId.delete(id);
      }
    }
    // A stale list (a tab closed mid-drag) must never silently drop a live tab.
    if (next.length !== this.tabs.length) return;
    this.tabs = next;
    this._emit();
  }

  cycleTab(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    if (i === -1) return;
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    if (next) this.activateTab(next.id);
  }

  _active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }
  _tab(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  // Create a new document tab. openPath (optional) is an absolute .pdf to load
  // once its renderer is ready. The new tab becomes active.
  //
  //   deferred    park the document — the tab shows its filename but the PDF is
  //               only read the first time the tab is activated. Session restore
  //               uses this: opening ten 100MB documents at launch would blow out
  //               memory for tabs the user may never look at (docs/PERF-MEMORY.md).
  //   background  don't steal focus from the current tab.
  //
  //   combinePaths  a batch handed over by Explorer's "Gộp bằng Nabu PDF" verb.
  //                 Mutually exclusive with openPath: this tab opens the merge
  //                 dialog PRE-FILLED with those files and holds no document of
  //                 its own until the user confirms the merge. combineDropped is
  //                 how many the batch cap removed, so the dialog can say so
  //                 rather than quietly showing a short list.
  createTab({ openPath, combinePaths, combineDropped = 0, deferred = false, background = false } = {}) {
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
    bindTabKeys(wc);
    wc.loadFile(path.join(deps.RENDERER, "index.html"));
    if (openPath || combinePaths) {
      wc.once("did-finish-load", () => {
        // This tab is spoken for. Tell the renderer so it declines to host the
        // crash-recovery prompt — that belongs to a genuinely empty tab, and
        // without this a slow-loading document races it (renderer/app.js
        // checkRecovery fires on a 1.2s timer). A combine tab is spoken for too:
        // it is about to put a modal on screen, which a recovery prompt would
        // land behind.
        try {
          wc.send("tab:reserved");
        } catch (_) {
          /* renderer gone */
        }
        if (combinePaths) deps.sendCombineToView(wc, combinePaths, combineDropped);
        else if (!deferred) deps.sendFileToView(wc, openPath);
      });
    }

    const tab = {
      id,
      view,
      title: openPath ? path.basename(openPath) : "Nabu PDF",
      dirty: false,
      path: openPath || null,
      pendingPath: deferred && openPath ? openPath : null,
    };
    this.tabs.push(tab);
    // A tab born while the window is in reading mode must start with matching
    // chrome, and it isn't listening yet at this point.
    if (this._presenting) wc.once("did-finish-load", () => this._sendPresentation(tab));
    if (background) this._emit();
    else this.activateTab(id);
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
    this._sendPresentation(next); // its chrome must match this window's mode
    this._wakeDeferred(next);
    try {
      next.view.webContents.focus();
    } catch (_) {
      /* focus is best-effort */
    }
    this._emit();
  }

  // A restored tab parked by session restore reads its document the first time
  // it is looked at. Cleared before sending so a second activation can't load
  // the same file twice over whatever the user has since done to it.
  _wakeDeferred(tab) {
    if (!tab || !tab.pendingPath) return;
    const p = tab.pendingPath;
    tab.pendingPath = null;
    const wc = tab.view.webContents;
    try {
      if (wc.isLoading()) wc.once("did-finish-load", () => deps.sendFileToView(wc, p));
      else deps.sendFileToView(wc, p);
    } catch (_) {
      /* renderer gone — the tab is about to disappear anyway */
    }
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
        // The user closed their way down to nothing — record that empty state
        // now, so the next launch doesn't hand back the last tab they shut.
        // (Closing the WINDOW with tabs still in it is the opposite case: see
        // _guardAndClose, which saves *before* tearing anything down.)
        Session.saveNow();
        this._closing = true;
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

  // ---- moving house: detach / adopt / tear out ----------------------------
  //
  // These are deliberately separate from destroyTab. destroyTab DEMOLISHES a tab
  // (its webContents is closed); detachTab only MOVES it, leaving the renderer —
  // and therefore the open document, its undo history and any live editing
  // session — completely untouched. Mixing the two loses the user's work
  // (BI-15/BI-16 in docs/REGRESSION-GUARD.md).

  // Screen rect (DIP) of this window's tab strip: the drop zone. Same coordinate
  // space as screen.getCursorScreenPoint(), which is why the hit test can be a
  // plain rectangle comparison.
  stripScreenRect() {
    if (this.base.isDestroyed()) return null;
    const b = this.base.getContentBounds();
    return { x: b.x, y: b.y, width: b.width, height: TAB_STRIP_H };
  }

  // Screen rect (DIP) of the ACTIVE document view — the drop zone for pages
  // dragged out of another window's page column (docs/SPEC-page-drag.md §3.2).
  // Deliberately the same arithmetic as _layout: strip band first, document
  // below it, and no band at all while presenting. Reading it any other way
  // would put the hit test and the pixels on screen out of step.
  docViewScreenRect() {
    if (this.base.isDestroyed()) return null;
    const b = this.base.getContentBounds();
    const stripH = this._presenting ? 0 : TAB_STRIP_H;
    const height = Math.max(0, b.height - stripH);
    if (!height || !b.width) return null;
    return { x: b.x, y: b.y + stripH, width: b.width, height };
  }

  // Take a tab out of this window WITHOUT closing its webContents. Returns the
  // tab record, which the caller MUST hand to another window — an unadopted tab
  // is an orphaned renderer holding a whole document in RAM with no way to close
  // it. Refuses while a close prompt is in flight for that tab, so the dialog can
  // never outlive the window it belongs to.
  detachTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    if (this._pendingClose.has(id)) return null;
    const tab = this.tabs[idx];
    const wasActive = this.activeId === id;
    try {
      this.base.contentView.removeChildView(tab.view);
    } catch (_) {
      /* already detached */
    }
    // Out of tabs[] *before* anything can close this window, or _onClosed would
    // close the webContents we just promised to hand over.
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeId = null;
      this._emit();
    } else if (wasActive) {
      const nextTab = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeId = null; // force activateTab to re-attach
      this.activateTab(nextTab.id);
    } else {
      this._emit();
    }
    return tab;
  }

  // Take over a tab detached from another window. Its webContents keeps every
  // listener it already had — nav hardening, context menu, key router — and the
  // key router resolves its owner at keypress time, so it follows the tab here
  // without being rebound (rebinding would double every shortcut).
  adoptTab(tab) {
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return null;
    this.tabs.push(tab);
    this.activateTab(tab.id); // id is new to this window, so this really attaches
    return tab;
  }

  // Hand a tab to another window. The source window closes if that emptied it —
  // with no unsaved-changes guard, because nothing was lost: the document left
  // with the tab, dirty flag and all.
  moveTabTo(id, target) {
    if (!target || target === this || target.base.isDestroyed()) return false;
    const tab = this.detachTab(id);
    if (!tab) return false;
    target.adoptTab(tab);
    target.focus();
    if (!this.tabs.length) this.closeEmpty();
    return true;
  }

  // Pull a tab out into a window of its own, placed at `point` (screen DIP).
  // Refuses on the last tab: that would only rebuild the window it came from,
  // and it is the source of every "empty window" bug.
  tearOutTab(id, point) {
    if (this.tabs.length < 2) return null;
    const src = this.base.getBounds();
    const at = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : { x: src.x + 60, y: src.y + 60 };
    const tab = this.detachTab(id);
    if (!tab) return null;
    const born = new TabbedWindow({ bounds: placeTornWindow(at, src) });
    born.adoptTab(tab);
    born.focus();
    return born;
  }

  // Close a window that has no tabs left. Skips the guard on purpose — there is
  // nothing left in here to save.
  closeEmpty() {
    this._forceClose = true;
    if (!this.base.isDestroyed()) this.base.close();
  }

  // Native-window close (the ✕ on the title bar): guard every tab in turn.
  _onClose(e) {
    if (this._forceClose || (deps.isQuitting && deps.isQuitting())) return; // allow
    e.preventDefault();
    this._guardAndClose();
  }

  async _guardAndClose() {
    // Capture the session BEFORE the teardown starts eating tabs: closing a
    // window means "put this back next time", not "forget it".
    Session.saveNow();
    this._closing = true;
    for (const tab of [...this.tabs]) {
      if (!this._tab(tab.id)) continue;
      const proceed = await this.closeTab(tab.id, { closeIfEmpty: false });
      if (!proceed) {
        this._closing = false; // the window lives on — resume recording it
        Session.schedule();
        return; // a cancel aborts the whole-window close
      }
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
    this._closing = false; // gone from the set; no longer suppresses saves
    if (_focused === this) _focused = null;
    if (tabbedWindows.size) {
      // One window of several closed — the session is now the ones left.
      Session.saveNow();
    } else {
      // The LAST window just went. Leave the file exactly as _guardAndClose (or
      // destroyTab) left it: that is the state the user is meant to get back.
      Session.cancel();
    }
    if (!tabbedWindows.size && deps.onAllClosed) deps.onAllClosed();
  }

  // Update a tab's title/dirty/path from its doc renderer (tab:meta), then repaint.
  setMeta(viewWebContents, meta) {
    const tab = this.tabs.find((t) => t.view.webContents === viewWebContents);
    if (!tab) return;
    if (meta && typeof meta.title === "string") tab.title = meta.title;
    if (meta && typeof meta.dirty === "boolean") tab.dirty = meta.dirty;
    // The renderer is the authority on which file this tab holds — it changes on
    // open, on Save As, and back to null when the document is closed.
    if (meta && "path" in meta) tab.path = typeof meta.path === "string" && meta.path ? meta.path : null;
    this._emit();
  }

  // webContents of THIS window's active tab. For a page dropped by hand this is
  // the only sane destination: inactive views are detached from the content tree,
  // so they are not on screen and nothing was aimed at them.
  activeDocContents() {
    const t = this._active();
    return t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
  }

  _emit() {
    // Every change to the tab set funnels through here, which makes it the one
    // place that has to remember the session.
    Session.schedule();
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

// ---- keyboard routing ------------------------------------------------------

// The window that owns a webContents right now — looked up on every keypress,
// never captured in a closure. A tab can change windows (tearing), so a listener
// holding on to "its" window would end up driving the wrong one, possibly one
// that has already been destroyed (BI-17).
function ownerOf(webContents) {
  const d = findDoc(webContents);
  if (d) return d.tw;
  return findByStrip(webContents);
}

// Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1..9. These can't be menu accelerators without
// littering the menu with nine hidden entries, so they're intercepted before the
// page sees them — which also means they work while a text field has focus.
// Ctrl+T (new tab) and Ctrl+W (close tab) ARE menu accelerators, see main.js.
function bindTabKeys(webContents) {
  webContents.on("before-input-event", (e, input) => {
    const owner = ownerOf(webContents);
    if (owner && owner.handleTabKey(input)) e.preventDefault();
  });
}

// ---- drop classification (pure) --------------------------------------------

// What does a drop at `point` mean? Free of Electron and of the DOM so it can be
// unit-tested with plain numbers — the drag gesture itself is the one part of
// this feature a machine cannot exercise (docs/TABS-2B-DESIGN.md §2.2).
//
//   rects     [{ key, rect }] — every visible window's strip, source included
//   sourceKey the window the tab is being dragged from
//
// Order matters: the source strip wins an exact hit even if another window's
// strip overlaps it, so reordering never turns into a move by accident.
function classifyDrop(point, sourceKey, rects, pad) {
  const list = Array.isArray(rects) ? rects.filter((t) => t && t.rect) : [];
  const src = list.find((t) => t.key === sourceKey);
  // No usable cursor position → do the harmless thing.
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { action: "reorder", key: sourceKey };
  }
  const px = pad && Number.isFinite(pad.x) ? pad.x : TEAR_PAD_X;
  const py = pad && Number.isFinite(pad.y) ? pad.y : TEAR_PAD_Y;
  const inside = (r, gx, gy) =>
    point.x >= r.x - gx && point.x <= r.x + r.width + gx && point.y >= r.y - gy && point.y <= r.y + r.height + gy;

  if (src && inside(src.rect, 0, 0)) return { action: "reorder", key: sourceKey };
  for (const t of list) {
    if (t.key !== sourceKey && inside(t.rect, 0, 0)) return { action: "move", key: t.key };
  }
  // Just past the edge of its own strip: still a reorder. Tearing needs intent.
  if (src && inside(src.rect, px, py)) return { action: "reorder", key: sourceKey };
  return { action: "tear", key: null };
}

// ---- page drop classification (pure) ---------------------------------------

// What does a PAGE drop at `point` mean? Same shape and spirit as classifyDrop —
// plain numbers, no Electron, no DOM, unit-tested (test/page-drop.test.js) —
// but over the DOCUMENT views instead of the tab strips, because a page lands in
// another document's page column, not in its tab strip.
//
//   rects     [{ key, rect, z }] — every visible window's document view, source
//             included. `z` is the focus-recency stamp; among the windows under
//             the cursor the HIGHEST z wins, which is how an overlap resolves to
//             the window the user can actually see there.
//   sourceKey the window the pages are being dragged from
//
// Three outcomes, and the two harmless ones are deliberately identical to
// "do nothing":
//   self  — ended inside its own window: the in-column reorder that has shipped
//           since v0.2.41 owns this gesture, and this feature must never take it
//           over (BI-57). Main sends nothing at all.
//   send  — hand the pages to that window.
//   none  — no target (empty desktop, another app, no cursor): nothing happens.
//
// Note the missing `pad`: unlike a tab, a page has nowhere to be "torn out" to,
// so just-outside-a-window must mean nothing rather than something (P7).
function classifyPageDrop(point, sourceKey, rects) {
  const list = Array.isArray(rects) ? rects.filter((t) => t && t.rect) : [];
  // No usable cursor position → do the harmless thing, exactly as classifyDrop does.
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { action: "none", key: null };
  const inside = (r) =>
    point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
  const src = list.find((t) => t.key === sourceKey);
  if (src && inside(src.rect)) return { action: "self", key: sourceKey };
  const zOf = (t) => (Number.isFinite(t.z) ? t.z : 0);
  let best = null;
  for (const t of list) {
    if (t.key === sourceKey || !inside(t.rect)) continue;
    if (!best || zOf(t) > zOf(best)) best = t;
  }
  return best ? { action: "send", key: best.key } : { action: "none", key: null };
}

// A screen point (DIP) expressed in the target document view's own client
// coordinates, so the target renderer can hand it straight to elementFromPoint.
// DIP and CSS px are the same number here because nothing in this app ever calls
// setZoomFactor — the viewer zooms with a CSS transform inside the page instead.
function docViewLocalPoint(rect, point) {
  if (!rect || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Math.round(point.x - rect.x), y: Math.round(point.y - rect.y) };
}

// Every window that could receive dragged pages right now, with the recency stamp
// classifyPageDrop needs. Minimised windows are left out: they have a bounds
// rectangle but nothing visible to aim at.
function pageDropTargets() {
  const out = [];
  for (const tw of tabbedWindows) {
    if (tw.base.isDestroyed() || tw.base.isMinimized()) continue;
    const rect = tw.docViewScreenRect();
    if (rect) out.push({ key: tw, rect, z: tw._focusSeq || 0 });
  }
  return out;
}

// Bounds for a torn-out window: under the cursor, keeping the source window's
// size, but always clamped inside the work area of the display it was dropped on
// so a tab can never be flung off-screen.
function placeTornWindow(point, srcBounds) {
  const area = screen.getDisplayNearestPoint(point).workArea;
  const width = Math.min(Math.max(600, srcBounds.width), Math.max(600, area.width - 40));
  const height = Math.min(Math.max(400, srcBounds.height), Math.max(400, area.height - 40));
  // Offset so the tab lands roughly under the pointer that dropped it.
  const x = Math.min(Math.max(Math.round(point.x) - 140, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(point.y) - TAB_STRIP_H, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

// A tab drag finished in `sourceTw`'s strip. `order` is the strip's own DOM
// order; `point` is the cursor in screen DIP, read by MAIN — renderer screen
// coordinates inside a WebContentsView are off by the window frame and must not
// be trusted (docs/TABS-2B-DESIGN.md §2.3).
function handleDragEnd(sourceTw, { id, order, point } = {}) {
  if (!sourceTw || sourceTw.base.isDestroyed()) return;
  const rects = [];
  for (const tw of tabbedWindows) {
    if (tw.base.isDestroyed() || tw.base.isMinimized()) continue;
    const rect = tw.stripScreenRect();
    if (rect) rects.push({ key: tw, rect });
  }
  const d = classifyDrop(point, sourceTw, rects, null);
  if (d.action === "move" && d.key && d.key !== sourceTw) {
    if (sourceTw.moveTabTo(id, d.key)) return;
  } else if (d.action === "tear") {
    if (sourceTw.tearOutTab(id, point)) return;
  }
  // Anything that did not move is just a reorder (or a refused tear, which snaps
  // back to whatever the strip is already showing).
  sourceTw.reorderTabs(order);
}

// ---- session snapshot / restore --------------------------------------------

// True while any window is mid-teardown, i.e. its tab list is a lie in progress.
function anyClosing() {
  for (const tw of tabbedWindows) if (tw._closing) return true;
  return false;
}

// Plain-data picture of what is open right now. Paths only — a tab holding an
// unsaved or brand-new document has nothing to point at and is simply left out;
// its content is crash recovery's department (src/session.js header).
//
// `from` overrides the live window set; only the tests pass it.
function snapshotSession(from) {
  const windows = [];
  for (const tw of from || tabbedWindows) {
    if (tw.base.isDestroyed() || tw._closing) continue;
    const tabs = [];
    let active = 0;
    for (const t of tw.tabs) {
      if (!t.path) continue;
      if (t.id === tw.activeId) active = tabs.length;
      tabs.push(t.path);
    }
    if (!tabs.length) continue;
    // Normal (un-maximised) bounds, so un-maximising a restored window puts it
    // back where it was rather than somewhere arbitrary.
    const b = tw.base.getNormalBounds ? tw.base.getNormalBounds() : tw.base.getBounds();
    windows.push({ bounds: b, maximized: !!tw.base.isMaximized(), active, tabs });
  }
  return { windows };
}

// Rebuild the windows recorded by a previous run. Returns how many were made, so
// the caller can fall back to a plain empty window when there was nothing usable.
function restoreSession(list) {
  if (!Array.isArray(list)) return 0;
  let made = 0;
  for (const w of list) {
    if (!w || !Array.isArray(w.tabs)) continue;
    // Files the user has since moved or deleted are dropped without comment —
    // an error dialog per missing file at launch would be worse than the loss.
    const paths = w.tabs.filter((p) => typeof p === "string" && p && safeExists(p));
    if (!paths.length) continue;
    const active = Math.min(Math.max(0, w.active | 0), paths.length - 1);
    const tw = new TabbedWindow({ bounds: sanitizeBounds(w.bounds) });
    // Only the tab the user was last looking at reads its PDF now. The rest are
    // parked and wake on first activation (see createTab's `deferred`).
    paths.forEach((p, i) => tw.createTab({ openPath: p, deferred: i !== active, background: true }));
    const target = tw.tabs[active] || tw.tabs[0];
    if (target) tw.activateTab(target.id);
    if (w.maximized) {
      try {
        tw.base.maximize();
      } catch (_) {
        /* not fatal */
      }
    }
    made++;
  }
  return made;
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

// Only trust stored bounds if they land on a display that still exists — monitors
// get unplugged, and a window restored onto one that is gone is invisible.
function sanitizeBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return undefined;
  try {
    const area = screen.getDisplayMatching(b).workArea;
    const visibleX = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
    const visibleY = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
    if (visibleX < 120 || visibleY < 60) return undefined; // effectively off-screen
  } catch (_) {
    return undefined;
  }
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

// ---- module-level lookups (used by main.js IPC reroute) -------------------

function findDoc(webContents) {
  for (const tw of tabbedWindows) {
    const tab = tw.tabs.find((t) => t.view && t.view.webContents === webContents);
    if (tab) return { tw, tab };
  }
  return null;
}

// The inverse of findDoc: which tab carries this id, in any window. Used by the
// "Chuyển trang tới…" menu, whose entries are tab ids.
function findTabById(id) {
  for (const tw of tabbedWindows) {
    const tab = tw.tabs.find((t) => t.id === id);
    if (tab) return { tw, tab };
  }
  return null;
}

// Every OTHER open tab, as a candidate destination for pages. Unlike a hand-thrown
// page (which can only land in a visible view) the menu can address an INACTIVE
// tab too: its renderer is alive and holds its whole document, it is merely
// detached from the window's content tree.
//
// `window` is the window's number as a user would count them (1-based, creation
// order). `wc` is here for main to talk to and MUST NOT be forwarded to a
// renderer — a renderer that could name another renderer could read its document
// (BI-55).
function pageTargetTabs(exceptWc) {
  const out = [];
  let wi = 0;
  for (const tw of tabbedWindows) {
    if (tw.base.isDestroyed()) continue;
    wi++;
    const isOwn = exceptWc ? tw.tabs.some((t) => t.view && t.view.webContents === exceptWc) : false;
    for (const t of tw.tabs) {
      if (!t.view || t.view.webContents.isDestroyed()) continue;
      if (t.view.webContents === exceptWc) continue;
      out.push({
        id: t.id,
        title: t.title || "document.pdf",
        window: wi,
        sameWindow: isOwn,
        wc: t.view.webContents,
      });
    }
  }
  return out;
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

// `opts` carries the non-openPath ways a brand-new window can be spoken for —
// today just an Explorer combine batch. Passed through verbatim to createTab so
// this wrapper never has to know what they mean.
function createTabbedWindow(openPath, opts) {
  const tw = new TabbedWindow();
  if (openPath) tw.createTab({ openPath });
  else tw.createTab(opts || {});
  return tw;
}

// Where a batch of paths handed to an existing window should land. Kept pure and
// exported because this routing IS the whole user-visible behaviour of the
// "Mở file mới trong" setting, and getting it wrong is how BI-8 happened —
// see test/tabs-logic.test.js.
//
//   fillCurrent  the asking tab is still empty, so it takes paths[0] rather than
//                being left blank beside a new one
//   openIn       "tab" (new tabs in the asking window) | "window" (one new
//                window, the asking one untouched)
//
// Two rules worth stating out loud:
//   · An EMPTY tab means the user is filling *this* window, not adding a document
//     alongside one — so the preference stands down and the whole batch stays
//     here. Otherwise picking 3 files in a blank window would leave that window
//     blank and open another.
//   · With "window" and several files picked at once, they become tabs of ONE new
//     window. One window per file would mean one renderer process per file: a
//     30-file selection would be a resource event, not a service.
function planOpen(paths, { fillCurrent = false, openIn = "tab" } = {}) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p);
  const fill = fillCurrent && list.length ? list[0] : null;
  const rest = fill ? list.slice(1) : list;
  const toNewWindow = openIn === "window" && !fillCurrent;
  return { fill, sameWindow: toNewWindow ? [] : rest, newWindow: toNewWindow ? rest : [] };
}

function count() {
  return tabbedWindows.size;
}

// Live windows, in creation order — used to build the "move tab to window" menu.
function allWindows() {
  return [...tabbedWindows].filter((tw) => !tw.base.isDestroyed());
}

// How a window is named in that menu: by the document it is currently showing.
function windowLabel(tw) {
  const t = tw && tw._active();
  const title = (t && t.title) || "Nabu PDF";
  const extra = tw && tw.tabs.length > 1 ? ` (+${tw.tabs.length - 1})` : "";
  return (title.length > 40 ? title.slice(0, 37) + "…" : title) + extra;
}

module.exports = {
  configure,
  createTabbedWindow,
  planOpen,
  findDoc,
  findByStrip,
  findTabById,
  pageTargetTabs,
  focusedTabbedWindow,
  allDocContents,
  activeContents,
  allWindows,
  windowLabel,
  handleDragEnd,
  classifyDrop,
  classifyPageDrop,
  docViewLocalPoint,
  pageDropTargets,
  snapshotSession,
  restoreSession,
  sanitizeBounds,
  anyClosing,
  count,
  TabbedWindow,
  TAB_STRIP_H,
};
