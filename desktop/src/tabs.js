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

// ---- split view geometry (docs/RESEARCH-2026-09-08-split-view.md) ----------
//
// One window can show the ACTIVE TAB (full renderer, editable) beside up to two
// READ-ONLY view panes. The panes belong to the WINDOW, not to a tab, which is why
// nothing in the tab lifecycle below has to know about them.
//
// Every number here was MEASURED, not chosen (probe P-D, §10.3 of that doc): with a
// 900px-tall pane, the main renderer's toolbar + breadcrumb + status bar eat
//   380px → 52% of the pane AND the page starts scrolling sideways (broken)
//   420px → 49%      470px → 44%      620px → 34%      700px → 30%      1360px → 21%
// so 620 is the lowest width the editable pane is still usable at, and 420 is the
// hard floor where it stops being merely cramped and starts being wrong.
const SPLIT_GUTTER = 6; // draggable divider between panes
const MAIN_MIN_W = 620;
const MAIN_HARD_MIN_W = 420;
// A read-only pane carries a single-line header (filename + page + zoom), nothing
// that wraps, so its floor is set by "can you read a page in it", not by chrome.
const VIEW_MIN_W = 260;
const VIEW_HARD_MIN_W = 180;

// Default split when the user has not dragged the divider yet: the editable pane
// keeps the lion's share, because it is the one carrying a full toolbar.
const DEFAULT_RATIOS = { 1: [0.6, 0.4], 2: [0.5, 0.25, 0.25] };

// Read-only panes per window. Two, so the whole layout tops out at three panes —
// the number the feature was scoped to, and the number the width budget supports
// (620 + 6 + 260 + 6 + 260 = 1152px of content; see MAIN_MIN_W above).
const MAX_VIEW_PANES = 2;

// Do two paths point at the same document? Windows is case-insensitive and hands
// back both separator styles depending on where a path came from (a dialog, argv,
// a drop), so a plain === would miss a reload the user is entitled to.
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, "");
  const x = norm(a);
  const y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function sumOf(a) {
  let s = 0;
  for (const x of a) s += x;
  return s;
}

// `ratios` as the user last left them, sanitised into k positive fractions summing
// to 1. Anything unusable (wrong length, NaN, zero or negative share, a stored file
// from an older version) falls back to the default rather than to a pane of width 0 —
// a zero-width pane is a renderer the user cannot see and cannot close.
function normalizeRatios(ratios, k) {
  const def = DEFAULT_RATIOS[k - 1] || [1];
  if (!Array.isArray(ratios) || ratios.length !== k) return def.slice();
  const clean = ratios.map((r) => (Number.isFinite(r) && r > 0 ? r : 0));
  const total = sumOf(clean);
  if (!(total > 0) || clean.some((r) => r <= 0)) return def.slice();
  return clean.map((r) => r / total);
}

// Round fractional widths to integers whose sum is EXACTLY `total` (largest
// remainder). Rounding each pane independently is what leaves a 1px seam or a 1px
// overlap at odd window widths, and a seam between two native views shows through as
// a flickering line of desktop.
function largestRemainderRound(w, total) {
  const floors = w.map((x) => Math.max(0, Math.floor(x)));
  let left = Math.round(total) - sumOf(floors);
  const order = w
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let n = 0; n < order.length && left > 0; n++, left--) floors[order[n].i]++;
  // `left < 0` means the floors already overshot (only reachable with junk input);
  // take the excess back from the widest pane so nothing ever goes negative.
  while (left < 0) {
    let widest = 0;
    for (let i = 1; i < floors.length; i++) if (floors[i] > floors[widest]) widest = i;
    if (floors[widest] <= 0) break;
    floors[widest]--;
    left++;
  }
  return floors;
}

// Pane widths for `usable` px of content (i.e. window width minus the gutters).
// Three tiers on purpose: preferred minimums, then hard floors, then "the window is
// smaller than even the floors" — where the ONLY honest answer is to share out what
// there is proportionally. The function never returns a negative width and never
// refuses to produce a layout: a caller that has already been told to split must get
// something drawable, and it is the UI's job (not the geometry's) to say the window
// is too narrow.
function solveWidths(usable, n, ratios) {
  const k = n + 1;
  const fr = normalizeRatios(ratios, k);
  let mins = [MAIN_MIN_W].concat(new Array(n).fill(VIEW_MIN_W));
  if (sumOf(mins) > usable) mins = [MAIN_HARD_MIN_W].concat(new Array(n).fill(VIEW_HARD_MIN_W));
  if (sumOf(mins) > usable) mins = new Array(k).fill(0);

  let w = fr.map((f, i) => Math.max(mins[i], f * usable));
  // Over budget: claw back only from panes that still have room above their floor,
  // in proportion to how much room each has. Bounded loop — the proportional step
  // converges, but a guard is cheaper than trusting floating point to land exactly.
  for (let guard = 0; guard < 8 && sumOf(w) - usable > 1e-9; guard++) {
    const over = sumOf(w) - usable;
    const slack = w.map((x, i) => x - mins[i]);
    const room = sumOf(slack);
    if (room <= 1e-9) break; // everyone is on their floor; the round below absorbs it
    const take = Math.min(over, room);
    w = w.map((x, i) => x - (slack[i] / room) * take);
  }
  const short = usable - sumOf(w);
  if (short > 1e-9) w = w.map((x, i) => x + fr[i] * short);
  return largestRemainderRound(w, usable);
}

// THE one place split-view geometry is decided. Pure — no Electron, no DOM — so it
// is unit-tested (test/split-layout.test.js) and so `_layout` and every hit test can
// share it. `docViewScreenRect`'s comment already states the rule this obeys:
// reading the layout anywhere with different arithmetic puts the hit test and the
// pixels on screen out of step.
//
//   panes   how many READ-ONLY view panes (0, 1 or 2)
//   ratios  [main, view1?, view2?] fractions; see normalizeRatios
//
// `chrome` is the tab-strip view. It is only a 40px band when nothing is split; the
// moment a pane appears it takes the WHOLE window and the document views sit on top
// of it, so the gutters are the only place it is exposed — that is what lets it own
// the divider drag without a renderer process of its own (probe P-A).
function splitRects(w, h, { stripH = TAB_STRIP_H, panes = 0, ratios } = {}) {
  const W = Math.max(0, Math.round(w) || 0);
  const H = Math.max(0, Math.round(h) || 0);
  const y = Math.max(0, Math.min(Math.round(stripH) || 0, H));
  const ph = Math.max(0, H - y);
  const n = Math.max(0, Math.min(2, Math.round(panes) || 0));

  if (!n) {
    return {
      chrome: { x: 0, y: 0, width: W, height: y },
      main: { x: 0, y, width: W, height: ph },
      views: [],
      gutters: [],
    };
  }

  const usable = Math.max(0, W - n * SPLIT_GUTTER);
  const widths = solveWidths(usable, n, ratios);
  const rects = [];
  const gutters = [];
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    rects.push({ x, y, width: widths[i], height: ph });
    x += widths[i];
    if (i < widths.length - 1) {
      gutters.push({ x, y, width: SPLIT_GUTTER, height: ph });
      x += SPLIT_GUTTER;
    }
  }
  return {
    chrome: { x: 0, y: 0, width: W, height: H },
    main: rects[0],
    views: rects.slice(1),
    gutters,
  };
}

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
    // Split view: up to two READ-ONLY panes (renderer/view.html) beside the active
    // tab. They belong to the WINDOW, not to a tab — which is why nothing in the tab
    // lifecycle below (activate / destroy / detach / tear out / Ctrl+W / Ctrl+Tab)
    // has to know they exist. [{ view, path, name, ready, pending }]
    this.viewPanes = [];
    // Divider position as [main, view1?, view2?] fractions, or null for the default.
    // Reset to null whenever the pane COUNT changes: a ratio for two panes means
    // nothing for three, and splitRects would fall back anyway.
    this.paneRatios = null;
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

  // Live panes, dropping any whose renderer has already gone. Every consumer of the
  // pane list goes through this, so a destroyed view can never reach setBounds.
  _livePanes() {
    return this.viewPanes.filter((p) => p && p.view && !p.view.webContents.isDestroyed());
  }

  // The geometry this window is showing right now. ONE call, shared by _layout and
  // by every hit test, so the pixels on screen and the rectangles we test against
  // can never drift apart (the rule docViewScreenRect already states below).
  _rects() {
    const { w, h } = this._contentSize();
    // Reading mode collapses the strip to nothing rather than detaching it: the
    // view stays in the tree with every listener intact, so leaving the mode is a
    // pure resize and can't lose the strip's state.
    const stripH = this._presenting ? 0 : TAB_STRIP_H;
    return splitRects(w, h, { stripH, panes: this._livePanes().length, ratios: this.paneRatios });
  }

  _layout() {
    if (this.base.isDestroyed()) return;
    const r = this._rects();
    // The chrome view is a 40px band with nothing split, and the WHOLE window as
    // soon as a pane appears — the document views then sit on top of it and the
    // gutters are the only place it shows through. That is what lets it own the
    // divider drag with no renderer process of its own (probe P-A).
    //
    // It stays at the BOTTOM of the z-order because it is added once in the
    // constructor and never re-added: addChildView on an existing child promotes it
    // to the top (electron.d.ts:14226), so re-adding the chrome view would bury
    // every document behind it.
    this.strip.setBounds(r.chrome);
    const tab = this._active();
    if (tab) tab.view.setBounds(r.main);
    const panes = this._livePanes();
    for (let i = 0; i < panes.length; i++) {
      if (r.views[i]) panes[i].view.setBounds(r.views[i]);
    }
  }

  // ---- split view: read-only panes ---------------------------------------
  //
  // A pane shows a document AS SAVED ON DISK. It never writes, never registers a
  // docId, never autosaves — so "the same file in two panes" cannot turn into "the
  // second save ate the first", and that is the whole reason panes are read-only
  // (docs/RESEARCH-2026-09-08-split-view.md §4.2).

  // Open a read-only pane. `openPath` (optional) is the document it should show.
  // Returns the pane, or null when the window already has the maximum.
  addViewPane({ openPath = null } = {}) {
    if (this.base.isDestroyed()) return null;
    if (this._livePanes().length >= MAX_VIEW_PANES) return null;
    const view = new WebContentsView({
      webPreferences: {
        preload: deps.viewPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    deps.hardenNav(view.webContents);
    deps.attachContextMenu(view.webContents);
    const pane = { view, path: null, name: null, ready: false, pending: null };
    this.viewPanes.push(pane);
    this.base.contentView.addChildView(view);
    view.webContents.loadFile(path.join(deps.RENDERER, "view.html"));
    this.paneRatios = null; // the pane count changed; the old split no longer applies
    this._layout();
    this._emit(); // _emit() is also what remembers the session (Session.schedule)
    if (openPath) this.setPaneSource(pane, openPath);
    return pane;
  }

  // Point a pane at a file. A pane that has not finished loading parks the request
  // and the view:ready handler flushes it — main pushes documents, panes never ask.
  setPaneSource(pane, openPath) {
    if (!pane || !openPath) return false;
    pane.path = openPath;
    pane.name = path.basename(openPath);
    if (!pane.ready) {
      pane.pending = openPath;
      this._emit();
      return true;
    }
    pane.pending = null;
    deps.sendFileToPane(pane.view.webContents, openPath);
    this._emit();
    return true;
  }

  // A pane's renderer says it is listening. Flush whatever was parked for it.
  paneReady(webContents) {
    const pane = this.viewPanes.find((p) => p.view && p.view.webContents === webContents);
    if (!pane) return;
    pane.ready = true;
    if (pane.pending) {
      const p = pane.pending;
      pane.pending = null;
      deps.sendFileToPane(webContents, p);
    }
    // The pane missed every view:state sent while it was loading — including the
    // one that decides whether "Sửa file này" is on its header.
    this._emitPanes();
  }

  // The active tab saved to `savedPath` — every pane showing that same file is now
  // looking at yesterday, so re-read it from disk. This is the ONLY thing that keeps
  // "read-only pane shows the last save" honest.
  reloadPanesForPath(savedPath) {
    if (!savedPath) return;
    for (const pane of this._livePanes()) {
      if (pane.path && samePath(pane.path, savedPath)) {
        deps.sendFileToPane(pane.view.webContents, pane.path, "view:reload");
      }
    }
  }

  closeViewPane(target) {
    const idx = typeof target === "number" ? target : this.viewPanes.indexOf(target);
    const pane = this.viewPanes[idx];
    if (!pane) return false;
    this.viewPanes.splice(idx, 1);
    try {
      this.base.contentView.removeChildView(pane.view);
    } catch (_) {
      /* already detached */
    }
    try {
      // Unlike a TAB (BI-15: detach must never close a webContents, because the tab
      // is being handed to another window), a pane is genuinely finished here — and
      // an Electron renderer process costs ~80 MB just to exist (measured, §10.4),
      // so leaving one parked would be a slow leak per split the user ever opened.
      if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close();
    } catch (_) {
      /* older Electron: drop the reference instead */
    }
    this.paneRatios = null;
    this._layout();
    this._emit();
    return true;
  }

  closeViewPaneByContents(webContents) {
    const idx = this.viewPanes.findIndex((p) => p.view && p.view.webContents === webContents);
    return idx === -1 ? false : this.closeViewPane(idx);
  }

  // Divider dragged. `ratios` comes from the chrome renderer as fractions of the
  // usable width; splitRects clamps anything unusable, so no validation here beyond
  // "it is an array of the right length".
  setPaneRatios(ratios) {
    const k = this._livePanes().length + 1;
    if (!Array.isArray(ratios) || ratios.length !== k) return false;
    this.paneRatios = ratios.slice();
    this._layout();
    // Echo back the geometry main ACTUALLY used, so the handle on screen sits where
    // the boundary between two views is rather than where the pointer wished it
    // were. The widths went through solveWidths, which enforces minimum pane widths
    // the strip deliberately does not know — those numbers exist once, in this file.
    //
    // Deliberately NOT _emit(): this fires on every pointermove of a drag, and
    // _emit() rebuilds the strip's whole DOM — including the very handle holding
    // the pointer capture, which would end the drag on its first frame.
    try {
      const r = this._rects();
      if (this.strip && !this.strip.webContents.isDestroyed()) {
        this.strip.webContents.send("split:geom", { gutters: r.gutters, chrome: r.chrome });
      }
    } catch (_) {
      /* strip gone — the drag is over anyway */
    }
    Session.schedule();
    return true;
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
  //
  // With the window split this is the EDITABLE pane's rectangle, not the whole
  // band: the read-only panes cannot receive pages (they never write), so a drop on
  // one must not be read as a drop on the document beside it.
  docViewScreenRect() {
    if (this.base.isDestroyed()) return null;
    const b = this.base.getContentBounds();
    const r = this._rects().main;
    if (!r || !r.width || !r.height) return null;
    return { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height };
  }

  // The READ-ONLY panes' rectangles in screen coordinates (DIP), left to right.
  //
  // These exist for one caller: classifyPageDrop, which needs to tell "the user
  // aimed at a pane and it cannot take pages" apart from "the user let go over the
  // desktop". Silence is the right answer to the second and the wrong answer to the
  // first — a drop that lands on a document-shaped area and does nothing at all is
  // indistinguishable from a bug.
  //
  // Rectangles rather than a per-window hit test on purpose: which surface a point
  // belongs to is a question about ALL the windows at once (they overlap, and the
  // one in front wins), and that resolution already lives — pure and tested — in
  // classifyPageDrop. A second hit test here would be a weaker copy of it.
  viewPaneScreenRects() {
    if (this.base.isDestroyed()) return [];
    const b = this.base.getContentBounds();
    const r = this._rects();
    const n = this._livePanes().length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = r.views[i];
      if (v && v.width > 0 && v.height > 0) out.push({ x: b.x + v.x, y: b.y + v.y, width: v.width, height: v.height });
    }
    return out;
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
    // Read-only panes die with the window. Nobody adopts them (unlike a torn-out
    // tab, BI-16) because a pane holds no unsaved work — it is a view onto a file
    // that is still on disk.
    for (const p of this.viewPanes) {
      try {
        if (p.view && !p.view.webContents.isDestroyed()) p.view.webContents.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.viewPanes = [];
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
    // The chrome renderer needs the split shape for two jobs: light up the ◫ button,
    // and draw + drag the gutters. It gets GEOMETRY and pane NAMES only — never a
    // webContents id and never another renderer's identity (BI-55).
    const r = this._rects();
    const split = {
      panes: this._livePanes().length,
      max: MAX_VIEW_PANES,
      gutters: r.gutters,
      chrome: r.chrome,
      names: this._livePanes().map((p) => p.name || ""),
    };
    try {
      this.strip.webContents.send("tabs:state", { tabs, split });
    } catch (_) {
      /* strip not ready yet — did-finish-load re-emits */
    }
    this._emitPanes();
  }

  // Push each read-only pane the one fact only main knows: whether the document it
  // is showing is ALSO the one open in the editable pane. When it is, "Sửa file
  // này" has nothing to do, so the pane hides the button rather than offering a
  // dead one — and the pane never has to learn another renderer's identity to find
  // that out (BI-55). Paths and booleans only.
  _emitPanes() {
    const t = this._active();
    const mainPath = (t && t.path) || null;
    for (const pane of this._livePanes()) {
      try {
        // No `canPick` twin: the source menu always has something in it ("Mở file
        // khác…" at the very least), so a flag for it would be a constant `true`.
        pane.view.webContents.send("view:state", {
          canEdit: !!(pane.path && !samePath(pane.path, mainPath)),
        });
      } catch (_) {
        /* pane still loading — paneReady emits again once it is listening */
      }
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
//   rects     [{ key, rect, z, panes }] — every visible window's document view,
//             source included. `z` is the focus-recency stamp; among the windows
//             under the cursor the HIGHEST z wins, which is how an overlap resolves
//             to the window the user can actually see there. `panes` (optional) is
//             that window's READ-ONLY split-view rectangles.
//   sourceKey the window the pages are being dragged from
//
// Four outcomes, and the two harmless ones are deliberately identical to
// "do nothing":
//   self     — ended inside its own window: the in-column reorder that has shipped
//              since v0.2.41 owns this gesture, and this feature must never take it
//              over (BI-57). Main sends nothing at all.
//   send     — hand the pages to that window.
//   readonly — ended on a split-view pane. Those panes never write, so they cannot
//              take pages; this is reported so the SOURCE can say why instead of
//              swallowing a gesture the user aimed carefully.
//   none     — no target (empty desktop, another app, no cursor): nothing happens.
//
// The source window's OWN panes answer "readonly" too, and that does not touch
// BI-57: the in-column reorder lives entirely inside the source renderer's DOM, and
// a pane is a different WebContentsView the renderer's drag never reaches. The
// `self` branch above still owns every point inside the source DOCUMENT.
//
// Note the missing `pad`: unlike a tab, a page has nowhere to be "torn out" to,
// so just-outside-a-window must mean nothing rather than something (P7).
function classifyPageDrop(point, sourceKey, rects) {
  const list = Array.isArray(rects) ? rects.filter((t) => t && t.rect) : [];
  // No usable cursor position → do the harmless thing, exactly as classifyDrop does.
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { action: "none", key: null };
  const inside = (r) =>
    !!r && point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
  const src = list.find((t) => t.key === sourceKey);
  if (src && inside(src.rect)) return { action: "self", key: sourceKey };
  const zOf = (t) => (Number.isFinite(t.z) ? t.z : 0);
  // At most ONE hit per window: a window's document view and its panes are laid out
  // side by side by splitRects and never overlap, so the two branches below are
  // mutually exclusive and the winner is decided purely by z (the window in front).
  let best = null;
  for (const t of list) {
    let action = null;
    if (t.key !== sourceKey && inside(t.rect)) action = "send";
    else if (Array.isArray(t.panes) && t.panes.some(inside)) action = "readonly";
    if (!action) continue;
    if (!best || zOf(t) > zOf(best)) best = { key: t.key, z: zOf(t), action };
  }
  return best ? { action: best.action, key: best.key } : { action: "none", key: null };
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
    // `panes` travels with the window so classifyPageDrop can answer "readonly"
    // for a drop aimed at a split-view pane rather than reporting nothing.
    if (rect) out.push({ key: tw, rect, z: tw._focusSeq || 0, panes: tw.viewPaneScreenRects() });
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
    const w = { bounds: b, maximized: !!tw.base.isMaximized(), active, tabs };
    // Split view, and ONLY when there is one. Two reasons for the `if`:
    //  · session.json is read by every version, including ones released before this
    //    feature; leaving the keys out entirely for the overwhelmingly common
    //    unsplit window keeps those files byte-identical to what shipped before.
    //  · `v` stays 1 on purpose. Bumping it would make every currently installed
    //    copy discard the session it already has — losing real open documents to
    //    add an optional layout hint is a bad trade. Old files simply have no
    //    `panes` key, and restoreSession treats that as "no split", which is right.
    const panes = tw._livePanes();
    if (panes.length) {
      // A pane with no document yet is recorded as null rather than dropped: the
      // COUNT is what the ratios are indexed by, so losing an empty pane would
      // shift the divider positions of the ones beside it.
      w.panes = panes.map((p) => p.path || null);
      if (Array.isArray(tw.paneRatios) && tw.paneRatios.length === panes.length + 1) w.ratios = tw.paneRatios.slice();
    }
    windows.push(w);
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
    // Split view. Panes come back AFTER the tabs, because addViewPane resets the
    // divider positions every time the pane count changes — so the stored ratios
    // can only be applied once the final count is in place.
    if (Array.isArray(w.panes) && w.panes.length) {
      for (const p of w.panes.slice(0, MAX_VIEW_PANES)) {
        // Same rule as a tab: a file the user has since moved or deleted is dropped
        // silently. The PANE still opens (empty) so the layout the user left is the
        // layout they get back — only its content is missing, and it says so.
        tw.addViewPane({ openPath: typeof p === "string" && p && safeExists(p) ? p : null });
      }
      if (Array.isArray(w.ratios)) tw.setPaneRatios(w.ratios);
    }
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

// Which window owns this read-only pane? Panes are addressed ONLY this way — by the
// webContents that sent the IPC — so a pane can never name itself, let alone another
// renderer (BI-55).
function findViewPane(webContents) {
  for (const tw of tabbedWindows) {
    const pane = tw.viewPanes.find((p) => p.view && p.view.webContents === webContents);
    if (pane) return { tw, pane };
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

// Every DOCUMENT renderer (sidecar status, app-wide broadcasts). Read-only panes are
// deliberately NOT here: they have no sidecar bridge and nothing to do with any of it.
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
  findViewPane,
  splitRects,
  samePath,
  MAX_VIEW_PANES,
  SPLIT_GUTTER,
  MAIN_MIN_W,
  MAIN_HARD_MIN_W,
  VIEW_MIN_W,
  VIEW_HARD_MIN_W,
  anyClosing,
  count,
  TabbedWindow,
  TAB_STRIP_H,
};
