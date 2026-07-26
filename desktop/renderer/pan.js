"use strict";

/**
 * Nabu PDF — hand tool / pan.
 *
 * WHAT IT IS. Until now the viewer had no way to drag the page around: `#viewer`
 * is a plain `overflow:auto` box, so at 250% on an A1 drawing the only way to
 * move was the scrollbars. Every mainstream reader solves this with a hand tool,
 * and they all landed on the same three gestures, which is what this file does:
 *
 *   - a Hand tool you switch to (button + `H`; `V` goes back to selecting text)
 *     — Acrobat, Foxit and pdf.js all use H for exactly this;
 *   - HOLD SPACE to borrow the hand tool for one drag, then snap back to the
 *     tool you were on (Acrobat; also Photoshop/Figma, so it is muscle memory);
 *   - DRAG WITH THE MIDDLE BUTTON to pan from any tool at any time
 *     (PDF-XChange). This one works even while annotating, because no existing
 *     handler in this app looks at button 1 — see `shouldPan`.
 *
 * WHY IT IS ITS OWN FILE, AND WHY THE LOGIC IS SPLIT IN TWO. The decision "does
 * this gesture pan?" reads SIX pieces of state that live in four other modules
 * (annotation mode, text-edit mode, copy-image mode, the current tool, the space
 * key, what is under the cursor). That is precisely the shape of thing that
 * breaks silently later, and the renderer has no automated tests (see
 * docs/REGRESSION-GUARD.md §1). So the decision is a PURE function with no DOM
 * in sight, this file is `require()`-able from node like page-range.js is, and
 * desktop/test/pan-logic.test.js pins every combination.
 *
 * Everything below the `module.exports` line is the DOM half and never runs
 * under node.
 *
 * Loaded as a classic <script> AFTER app.js (it uses `$`, `state`, `isTyping`
 * from the shared scope) and BEFORE editor.js / capture.js.
 */
(function () {
  // ---- pure decision logic (no DOM — tested by test/pan-logic.test.js) ------

  const MIDDLE = 1; // MouseEvent.button for the middle button/wheel click

  /**
   * Should this pointerdown start a pan drag?
   *
   * ctx:
   *   button          MouseEvent.button (0 left, 1 middle, 2 right)
   *   hasDoc          a document is open
   *   tool            "hand" | "select" — the persistent cursor tool
   *   spaceHeld       space is held down right now (temporary hand)
   *   overlayEditing  window.Editor.active
   *   textEditing     window.TextEdit.active
   *   capturing       window.Capture.active (copy-image marquee)
   *   onInteractive   the cursor is over a note marker / control
   *
   * The rules, in order, and why each one exists:
   *   1. Nothing open ⇒ nothing to pan.
   *   2. Middle button ⇒ ALWAYS pan. Safe by inspection: editor.js `onDown`,
   *      capture.js `onDown` and text-edit.js all bail on `button !== 0`, so the
   *      middle button is unclaimed everywhere in this app. That is what makes
   *      "pan while annotating" free of conflicts.
   *   3. Right button ⇒ never. It belongs to the context menus (capture.js
   *      `showPageMenu`, app.js `openThumbMenu`, and the native menu in main).
   *   4. Left button while another MODE owns the left button ⇒ never. Annotating,
   *      text-editing and copy-image each drag with the left button for their own
   *      purpose; stealing it would break them.
   *   5. Left button only pans when the hand tool is on, or space is held.
   *   6. …and not on a note marker or control, or the hand tool would eat the
   *      click that opens a comment.
   */
  function shouldPan(ctx) {
    const c = ctx || {};
    if (!c.hasDoc) return false;
    if (c.button === MIDDLE) return true;
    if (c.button !== 0) return false;
    if (c.overlayEditing || c.textEditing || c.capturing) return false;
    if (!(c.tool === "hand" || c.spaceHeld)) return false;
    if (c.onInteractive) return false;
    return true;
  }

  /**
   * Scroll offsets for a drag from `from` to `to`, given where the scroll box
   * started. Dragging the page right moves the viewport LEFT — hence the minus,
   * which is the whole reason this tiny function is pinned by a test. Clamping
   * to the scrollable range is left to the DOM, which does it for free.
   */
  function panScroll(start, from, to) {
    return {
      left: start.left - (to.x - from.x),
      top: start.top - (to.y - from.y),
    };
  }

  /**
   * Which cursor tool a single keypress selects, or null to leave the key alone.
   *
   * `H`/`V` are ALSO annotation-tool shortcuts (editor.js TOOL_KEYS: h =
   * highlight, v = select). editor.js only acts on them while its mode is on, so
   * the two never collide as long as this returns null there — that check is not
   * optional, or one keypress would fire both.
   */
  function keyTool(ev, ctx) {
    const c = ctx || {};
    const e = ev || {};
    if (!c.hasDoc || !c.viewerVisible) return null;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return null;
    if (c.typing || c.focusInteractive) return null;
    if (c.overlayEditing || c.textEditing) return null; // editor.js owns h/v there
    const k = String(e.key == null ? "" : e.key).toLowerCase();
    if (k === "h") return "hand";
    if (k === "v") return "select";
    return null;
  }

  /**
   * Should this keydown be taken as "hold space to pan"?
   *
   * `focusInteractive` is the one that matters: space ACTIVATES a focused button
   * in every browser, so claiming it blindly would break keyboard operation of
   * the whole toolbar. `repeat` is deliberately NOT excluded — the key repeats
   * while held and each repeat must keep preventing the viewer's page-scroll.
   *
   * `viewerVisible` keeps the key out of the compare and overlay views, which
   * replace the page view entirely and own their own scrolling.
   */
  function claimsSpace(ev, ctx) {
    const c = ctx || {};
    const e = ev || {};
    if (e.key !== " " && e.code !== "Space") return false;
    if (!c.hasDoc || !c.viewerVisible) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (c.typing || c.focusInteractive) return false;
    if (c.overlayEditing || c.textEditing || c.capturing) return false;
    return true;
  }

  const api = { shouldPan, panScroll, keyTool, claimsSpace, MIDDLE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // ---- DOM half ------------------------------------------------------------

  const TOOL_KEY = "nabu-cursor-tool";
  // A drag shorter than this is a click that wobbled, not a pan — used only to
  // decide whether the trailing `click` has to be swallowed.
  const CLICK_SLOP_PX = 4;
  // Things inside a page that answer to a click of their own.
  const INTERACTIVE = ".note-marker, .note-popup, button, a, input, select, textarea, [contenteditable]";

  const pan = {
    tool: "select",
    space: false,
    drag: null, // { id, sx, sy, sl, st, moved }
    swallowClick: false,
  };

  function viewer() {
    return $("viewer");
  }

  function editingNow() {
    // BI-28: `.active` is a GETTER on both modules, never a method.
    return !!(window.Editor && window.Editor.active) || !!(window.TextEdit && window.TextEdit.active);
  }

  // isTyping() lives in app.js. Guarded rather than called bare (BI-14): this is
  // a safety check, so a missing symbol should degrade, not throw inside a
  // keydown handler and swallow the rest of it.
  function typingNow() {
    return typeof isTyping === "function" ? isTyping() : false;
  }

  // Space and single letters must not be stolen from a focused control — that is
  // how the toolbar stays operable from the keyboard.
  function focusInteractive() {
    const el = document.activeElement;
    return !!(el && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  }

  function ctx(extra) {
    const base = {
      hasDoc: !!(state && state.bytes && state.numPages),
      tool: pan.tool,
      spaceHeld: pan.space,
      overlayEditing: !!(window.Editor && window.Editor.active),
      textEditing: !!(window.TextEdit && window.TextEdit.active),
      capturing: !!(window.Capture && window.Capture.active),
      typing: typingNow(),
      focusInteractive: focusInteractive(),
      // Same test app.js uses for its own arrow-key navigation: the compare and
      // overlay views hide the page view and scroll themselves.
      viewerVisible: !!(viewer() && viewer().offsetParent !== null),
    };
    return Object.assign(base, extra || {});
  }

  // `pan-ready` = the cursor promises a drag will move the page (and the text
  // layer stands down). `panning` = a drag is happening right now.
  function sync() {
    const armed = (pan.tool === "hand" || pan.space) && !editingNow() && !!(state && state.bytes);
    document.body.classList.toggle("pan-ready", armed);
    const b = $("btn-hand");
    if (b) b.classList.toggle("active", pan.tool === "hand");
  }

  function setTool(next) {
    const t = next === "hand" ? "hand" : "select";
    if (pan.tool === t) {
      sync();
      return;
    }
    pan.tool = t;
    try {
      localStorage.setItem(TOOL_KEY, t);
    } catch (_) {
      /* private mode / quota — the tool still works, it just won't be remembered */
    }
    sync();
  }

  // ---- the drag ------------------------------------------------------------

  function onPointerDown(e) {
    if (pan.drag) return;
    if (!shouldPan(ctx({ button: e.button, onInteractive: isInteractive(e.target) }))) return;
    const v = viewer();
    if (!v) return;
    // preventDefault kills the text selection AND the middle-click autoscroll.
    // stopImmediatePropagation — not stopPropagation — is what keeps editor.js /
    // capture.js from seeing a drag that is not theirs: they listen on THIS SAME
    // element, and stopPropagation only stops the event reaching the next node,
    // never other listeners on the node you are already in. capture.js registers
    // its own capture-phase listener on the viewer after this one, so plain
    // stopPropagation let it through. (Caught by _pan-probe.html.)
    e.preventDefault();
    e.stopImmediatePropagation();
    pan.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, sl: v.scrollLeft, st: v.scrollTop, moved: false };
    try {
      v.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture unavailable — the window-level listeners below still finish the drag */
    }
    document.body.classList.add("panning");
  }

  function onPointerMove(e) {
    const d = pan.drag;
    if (!d || e.pointerId !== d.id) return;
    const v = viewer();
    if (!v) return;
    e.preventDefault();
    if (Math.abs(e.clientX - d.sx) > CLICK_SLOP_PX || Math.abs(e.clientY - d.sy) > CLICK_SLOP_PX) d.moved = true;
    const next = panScroll({ left: d.sl, top: d.st }, { x: d.sx, y: d.sy }, { x: e.clientX, y: e.clientY });
    v.scrollLeft = next.left;
    v.scrollTop = next.top;
  }

  function endDrag(e) {
    const d = pan.drag;
    if (!d) return;
    if (e && e.pointerId != null && e.pointerId !== d.id) return;
    const v = viewer();
    if (v) {
      try {
        v.releasePointerCapture(d.id);
      } catch (_) {
        /* already released (pointercancel / lostpointercapture) */
      }
    }
    pan.swallowClick = d.moved;
    pan.drag = null;
    document.body.classList.remove("panning");
    sync();
  }

  function isInteractive(t) {
    return !!(t && t.closest && t.closest(INTERACTIVE));
  }

  // ---- wiring --------------------------------------------------------------

  const v0 = viewer();
  if (v0) {
    // Capture phase: for a target inside the viewer this runs before every
    // bubble-phase listener the other modules registered on the viewer itself.
    v0.addEventListener("pointerdown", onPointerDown, true);
    // Belt and braces. preventDefault on pointerdown is specified to suppress the
    // compatibility mouse events, but the whole point of this listener is to not
    // depend on that: if a mousedown does slip through mid-drag, it stops here
    // instead of reaching editor.js.
    v0.addEventListener(
      "mousedown",
      (e) => {
        if (!pan.drag) return;
        e.preventDefault();
        e.stopImmediatePropagation(); // same-element listeners too — see onPointerDown
      },
      true
    );
    // A pan that actually moved must not also count as a click on whatever was
    // under the finger when it started.
    v0.addEventListener(
      "click",
      (e) => {
        if (!pan.swallowClick) return;
        pan.swallowClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );
    v0.addEventListener("auxclick", (e) => {
      if (e.button === MIDDLE) e.preventDefault();
    });
  }
  // Pointer capture retargets move/up to the viewer, and they still bubble to
  // window — so one pair of window listeners covers both the captured and the
  // (unlikely) uncaptured case.
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", endDrag, true);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("lostpointercapture", endDrag, true);

  window.addEventListener("keydown", (e) => {
    if (claimsSpace(e, ctx())) {
      e.preventDefault(); // otherwise space page-scrolls the viewer
      if (!pan.space) {
        pan.space = true;
        sync();
      }
      return;
    }
    const t = keyTool(e, ctx());
    if (t) {
      e.preventDefault();
      setTool(t);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== " " && e.code !== "Space") return;
    if (!pan.space) return;
    pan.space = false;
    sync();
  });
  // Alt-tabbing away while holding space would otherwise leave the hand cursor
  // stuck on, with no keyup ever arriving.
  window.addEventListener("blur", () => {
    pan.space = false;
    endDrag();
    sync();
  });

  const btn = $("btn-hand");
  if (btn) btn.onclick = () => setTool(pan.tool === "hand" ? "select" : "hand");

  try {
    if (localStorage.getItem(TOOL_KEY) === "hand") pan.tool = "hand";
  } catch (_) {
    /* unreadable storage — start on the text-selection tool */
  }
  sync();

  // Spelled out rather than built with Object.assign: Object.assign READS a
  // getter on the source and copies the resulting VALUE, so `Pan.tool` would
  // have been frozen at whatever the tool was when this file loaded — a stale
  // reading with no symptom until something asked. (Caught by _pan-probe.html.)
  window.Pan = {
    shouldPan,
    panScroll,
    keyTool,
    claimsSpace,
    MIDDLE,
    setTool,
    sync,
    get tool() {
      return pan.tool;
    },
    get active() {
      return !!pan.drag;
    },
  };
})();
