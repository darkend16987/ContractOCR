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
    edits: {}, // spanId -> { page, bbox, new_text, size, color }
    meta: null, // /text-spans response (width/height/rotation)
  };

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
    const commit = () => {
      if (done) return;
      done = true;
      const val = ta.value;
      ta.remove();
      if (val !== sp.text) {
        te.edits[sp.id] = {
          page: te.page,
          bbox: sp.bbox,
          origin: sp.origin,
          new_text: val,
          size: sp.size,
          color: sp.color,
        };
      } else {
        delete te.edits[sp.id];
      }
      renderBoxes();
      updateHint();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ta.remove();
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ta.blur();
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
      state.bytes = Uint8Array.from(atob(data.data_b64), (ch) => ch.charCodeAt(0));
      const n = edits.length;
      await exit(); // re-renders from the new bytes
      toast(`Đã ghi ${n} sửa đổi vào PDF.`, "good");
    } catch (e) {
      toast("Lỗi sửa: " + e.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // Leave edit mode and redraw cleanly (drops the box layer; shows latest bytes).
  async function exit() {
    te.active = false;
    te.spans = [];
    te.edits = {};
    te.page = -1;
    te.meta = null;
    const bar = $("tedit-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("text-editing");
    const btn = $("btn-text-edit");
    if (btn) btn.classList.remove("active");
    updateToolbar();
    if (state.bytes) await renderAll();
    else clearLayers();
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

  // ---- public surface (consumed by app.js) ---------------------------------

  window.TextEdit = {
    get active() {
      return te.active;
    },
    syncOverlays,
    reset,
  };
})();
