"use strict";

/**
 * Nabu PDF — renderer (Phase 6: native text editing).
 *
 * Unlike the P4 overlay editor (which draws *on top* of the page), this edits the
 * page's real text: it asks the sidecar for the text spans on the current page,
 * shows a clickable box over each one, and on "Áp dụng" sends the edits back. The
 * backend physically removes the old glyphs (redaction) and redraws the new text
 * in place — so the original text is gone, not merely covered.
 *
 * Only works on PDFs that carry a real text layer (exported from Word/Excel/…),
 * not scans/flattened images — those report has_text:false and we tell the user
 * to use OCR/Searchable instead.
 *
 * Coordinates: span boxes come back in PDF-point space, top-left origin, which is
 * exactly the pdf.js scale-1 viewport space — so on screen they're just `* scale`
 * (same convention as editor.js). Shares app.js globals (classic-script scope):
 * state, $, toast, showOverlay/hideOverlay, renderAll, updateToolbar, scrollToPage,
 * sidecarFetch, u8ToB64, sidecar.
 */

(function () {
  const te = {
    active: false,
    page: -1, // page index being edited
    spans: [], // [{ id, text, bbox, size, font, color, flags }]
    edits: {}, // spanId -> { page, bbox, new_text, size, color, bold, italic, underline, bg, font }
    meta: null, // /text-spans response (width/height/rotation)
    editing: null, // span id currently open in a textarea (null = none)
    lastSpanId: null, // last span clicked (target for toolbar control changes)
  };

  // ---- formatting controls (text colour / bg / font / size / B I U) --------

  function packedToHex(c) {
    const n = typeof c === "number" ? c : 0;
    return "#" + (((n >> 16) & 255) << 16 | ((n >> 8) & 255) << 8 | (n & 255)).toString(16).padStart(6, "0");
  }
  // PyMuPDF span flags: bit1 (2)=italic, bit4 (16)=bold.
  function flagsBold(f) {
    return !!(f & 16);
  }
  function flagsItalic(f) {
    return !!(f & 2);
  }
  function setFmtBtn(id, on) {
    const b = $(id);
    if (b) b.classList.toggle("active", !!on);
  }
  // Push a span's (or its pending edit's) style into the toolbar controls.
  function syncControls(sp) {
    const ed = te.edits[sp.id];
    $("te-font").value = ed ? ed.font || "default" : "default";
    $("te-size").value = String(ed ? ed.size : Math.round(sp.size * 10) / 10);
    $("te-color").value = ed ? ed.color : packedToHex(sp.color);
    $("te-bg-on").checked = ed ? !!ed.bg : false;
    if (ed && ed.bg) $("te-bg").value = ed.bg;
    setFmtBtn("te-bold", ed ? ed.bold : flagsBold(sp.flags));
    setFmtBtn("te-italic", ed ? ed.italic : flagsItalic(sp.flags));
    setFmtBtn("te-underline", ed ? ed.underline : false);
  }
  // Read the current toolbar control values into a style object.
  function readControls() {
    return {
      font: $("te-font").value || "default",
      size: Math.max(4, parseFloat($("te-size").value) || 11),
      color: $("te-color").value || "#000000",
      bg: $("te-bg-on").checked ? $("te-bg").value : null,
      bold: $("te-bold").classList.contains("active"),
      italic: $("te-italic").classList.contains("active"),
      underline: $("te-underline").classList.contains("active"),
    };
  }

  // The span a toolbar control change should affect: the one being edited, else
  // the last one clicked.
  function targetSpanId() {
    return te.editing != null ? te.editing : te.lastSpanId;
  }
  // Ensure a staged edit exists for a span (seeded from its current text/style).
  function ensureEdit(spId) {
    const sp = te.spans.find((s) => s.id === spId);
    if (!sp) return null;
    if (!te.edits[spId]) {
      te.edits[spId] = {
        page: te.page,
        bbox: sp.bbox,
        origin: sp.origin,
        new_text: sp.text,
        size: Math.round(sp.size * 10) / 10,
        color: packedToHex(sp.color),
        bg: null,
        bold: flagsBold(sp.flags),
        italic: flagsItalic(sp.flags),
        underline: false,
        font: "default",
      };
    }
    return te.edits[spId];
  }
  // A toolbar formatting control changed → apply it to the target span's edit.
  function onControlChange() {
    const id = targetSpanId();
    if (id == null) return;
    const ed = ensureEdit(id);
    if (!ed) return;
    const st = readControls();
    const open = document.querySelector(".span-input");
    if (open) ed.new_text = open.value; // don't lose in-progress typing
    ed.size = st.size;
    ed.color = st.color;
    ed.bg = st.bg;
    ed.bold = st.bold;
    ed.italic = st.italic;
    ed.underline = st.underline;
    ed.font = st.font;
    renderBoxes();
    updateHint();
  }

  // ---- page + layer helpers ------------------------------------------------

  // The page whose centre is closest to the viewer's vertical centre.
  function currentPageIndex() {
    const wraps = [...document.querySelectorAll("#viewer .page-wrap")];
    if (!wraps.length) return state.selected.size ? Math.min(...state.selected) : 0;
    const vr = $("viewer").getBoundingClientRect();
    const mid = vr.top + vr.height / 2;
    let best = 0;
    let bestDist = Infinity;
    for (const w of wraps) {
      const r = w.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestDist) {
        bestDist = d;
        best = +w.dataset.index;
      }
    }
    return best;
  }

  function layerForPage(i) {
    const wrap = document.querySelector(`#viewer .page-wrap[data-index="${i}"]`);
    if (!wrap) return null;
    let layer = wrap.querySelector(".tedit-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "tedit-layer";
      wrap.appendChild(layer);
    }
    const canvas = wrap.querySelector("canvas");
    if (canvas) {
      layer.style.width = (parseFloat(canvas.style.width) || canvas.width) + "px";
      layer.style.height = (parseFloat(canvas.style.height) || canvas.height) + "px";
    }
    return layer;
  }

  function clearLayers() {
    document.querySelectorAll("#viewer .tedit-layer").forEach((l) => l.remove());
  }

  // ---- rendering -----------------------------------------------------------

  function renderBoxes() {
    clearLayers();
    const layer = layerForPage(te.page);
    if (!layer) return;
    layer.innerHTML = "";
    const s = state.scale;
    for (const sp of te.spans) {
      const [x0, y0, x1, y1] = sp.bbox;
      const box = document.createElement("div");
      box.className = "span-box" + (te.edits[sp.id] ? " edited" : "");
      box.style.left = x0 * s + "px";
      box.style.top = y0 * s + "px";
      box.style.width = Math.max(4, x1 - x0) * s + "px";
      box.style.height = Math.max(6, y1 - y0) * s + "px";
      box.title = "Bấm để sửa: " + sp.text;
      box.dataset.id = String(sp.id);
      box.addEventListener("click", () => beginEdit(sp, box));
      layer.appendChild(box);
    }
  }

  function beginEdit(sp, box) {
    const layer = box.parentElement;
    if (!layer) return;
    // Commit any other open editor first.
    layer.querySelectorAll(".span-input").forEach((t) => t.blur());

    te.editing = sp.id;
    te.lastSpanId = sp.id;
    syncControls(sp); // reflect this span's style in the toolbar controls

    const ta = document.createElement("textarea");
    ta.className = "span-input";
    ta.value = te.edits[sp.id] ? te.edits[sp.id].new_text : sp.text;
    ta.style.left = box.style.left;
    ta.style.top = box.style.top;
    ta.style.minWidth = box.style.width;
    ta.style.fontSize = Math.max(9, sp.size * state.scale * 0.92) + "px";
    layer.appendChild(ta);
    ta.focus();
    ta.select();

    let done = false;
    // Stage the edit into te.edits. Keeps it if text OR style changed from the
    // original span; otherwise drops it. Returns whether an edit is now staged.
    const stage = () => {
      const val = ta.value;
      const st = readControls();
      const styleChanged =
        st.bold !== flagsBold(sp.flags) ||
        st.italic !== flagsItalic(sp.flags) ||
        st.underline ||
        st.bg ||
        st.font !== "default" ||
        Math.abs(st.size - sp.size) > 0.01 ||
        st.color.toLowerCase() !== packedToHex(sp.color).toLowerCase();
      if (val !== sp.text || styleChanged) {
        te.edits[sp.id] = {
          page: te.page,
          bbox: sp.bbox,
          origin: sp.origin,
          new_text: val,
          size: st.size,
          color: st.color,
          bg: st.bg,
          bold: st.bold,
          italic: st.italic,
          underline: st.underline,
          font: st.font,
        };
        return true;
      }
      delete te.edits[sp.id];
      return false;
    };
    const commit = () => {
      if (done) return;
      done = true;
      ta.remove();
      te.editing = null;
      stage();
      renderBoxes();
      updateHint();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ta.remove();
      te.editing = null;
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Enter = stage this edit AND write it to the PDF immediately.
        e.preventDefault();
        done = true;
        ta.removeEventListener("blur", commit);
        ta.remove();
        te.editing = null;
        stage();
        renderBoxes();
        updateHint();
        apply();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ta.blur(); // stage only (Áp dụng later)
      } else if (e.key === "Escape") {
        e.preventDefault();
        ta.removeEventListener("blur", commit);
        cancel();
      }
    });
  }

  function updateHint() {
    const n = Object.keys(te.edits).length;
    const hint = $("te-hint");
    if (hint) {
      hint.textContent = n
        ? `${n} đoạn đã sửa — bấm Áp dụng để ghi vào PDF.`
        : `${te.spans.length} đoạn chữ trên trang ${te.page + 1}. Bấm vào đoạn để sửa.`;
    }
    const apply = $("te-apply");
    if (apply) apply.disabled = n === 0;
  }

  // ---- lifecycle -----------------------------------------------------------

  async function enter() {
    if (te.active) return exit();
    if (!state.bytes) {
      toast("Mở PDF trước.", "bad");
      return;
    }
    if (sidecar.state !== "ready" || !sidecar.base) {
      toast("Engine chưa sẵn sàng.", "bad");
      return;
    }
    const page = currentPageIndex();
    showOverlay("Đang đọc chữ trên trang…");
    let data;
    try {
      const res = await sidecarFetch("/text-spans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes), page }),
      });
      data = await res.json();
    } catch (e) {
      hideOverlay();
      toast("Lỗi đọc chữ: " + e.message, "bad");
      return;
    }
    hideOverlay();
    if (!data.success) {
      toast("Đọc chữ lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    if (!data.has_text) {
      toast("Trang này là ảnh scan — không có chữ để sửa. Hãy dùng Searchable hoặc Bóc tách.", "bad");
      return;
    }

    te.active = true;
    te.page = page;
    te.spans = data.spans || [];
    te.meta = data;
    te.edits = {};
    $("tedit-bar").hidden = false;
    document.body.classList.add("text-editing");
    $("btn-text-edit").classList.add("active");
    if (data.rotation) {
      toast("Trang đang xoay — ô chữ có thể lệch vị trí; nên sửa trước khi xoay.", "");
    }
    updateToolbar();
    scrollToPage(page);
    renderBoxes();
    updateHint();
  }

  async function apply() {
    const edits = Object.values(te.edits);
    if (!edits.length) {
      toast("Chưa sửa đoạn nào.", "");
      return;
    }
    showOverlay("Đang ghi thay đổi vào PDF…");
    try {
      const res = await sidecarFetch("/edit-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_b64: u8ToB64(state.bytes), edits }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("Sửa lỗi: " + (data.error || data.detail || "không rõ"), "bad");
        return;
      }
      if (window.History) window.History.pushUndo();
      state.bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
      const n = edits.length;
      await exit(new Set([te.page])); // only the edited page changed — repaint just it
      toast(`Đã ghi ${n} sửa đổi vào PDF.`, "good");
    } catch (e) {
      toast("Lỗi sửa: " + e.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // Leave edit mode and redraw cleanly (drops the box layer; shows latest bytes).
  // `changed` (a Set of page indices) is passed only by the apply path, where the
  // bytes were rewritten — then we repaint just those pages. A plain toggle-off
  // leaves the bytes untouched, so dropping the box layer is all that's needed.
  async function exit(changed) {
    te.active = false;
    te.spans = [];
    te.edits = {};
    te.page = -1;
    te.meta = null;
    te.editing = null;
    te.lastSpanId = null;
    const bar = $("tedit-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("text-editing");
    const btn = $("btn-text-edit");
    if (btn) btn.classList.remove("active");
    updateToolbar();
    clearLayers();
    if (changed && state.bytes) await rerenderChanged(changed);
  }

  // Re-place boxes after a re-render (e.g. zoom). No-op when inactive.
  function syncOverlays() {
    if (!te.active) {
      clearLayers();
      return;
    }
    renderBoxes();
  }

  function reset() {
    te.active = false;
    te.page = -1;
    te.spans = [];
    te.edits = {};
    te.meta = null;
    te.editing = null;
    te.lastSpanId = null;
    const bar = $("tedit-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("text-editing");
    const btn = $("btn-text-edit");
    if (btn) btn.classList.remove("active");
    clearLayers();
  }

  // ---- wiring --------------------------------------------------------------

  $("btn-text-edit").onclick = enter;
  $("te-apply").onclick = apply;
  $("te-exit").onclick = () => exit();

  // Format toggle buttons: preventDefault on mousedown so the open span textarea
  // keeps focus (clicking a button would otherwise blur+commit it).
  ["te-bold", "te-italic", "te-underline"].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      b.classList.toggle("active");
      onControlChange();
    });
  });
  // Selects / colour / size inputs: apply on change (these legitimately take focus).
  ["te-font", "te-size", "te-color", "te-bg", "te-bg-on"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", onControlChange);
  });

  // ---- public surface (consumed by app.js) ---------------------------------

  window.TextEdit = {
    get active() {
      return te.active;
    },
    syncOverlays,
    reset,
  };
})();
