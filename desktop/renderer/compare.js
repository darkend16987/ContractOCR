"use strict";

/**
 * Nabu PDF — PDF compare view.
 *
 * Self-contained overlay feature. Picks two PDFs, POSTs them to the sidecar
 * /compare endpoint (page + line diff), then renders them side-by-side with the
 * differing lines boxed on the page and listed in a detail panel.
 *
 * Reuses globals declared at the top level of app.js (classic scripts share the
 * global lexical scope): sidecarFetch, toast, showOverlay, hideOverlay, u8ToB64,
 * toU8, sidecar, pdfjsLib. Nothing here touches the main viewer `state`, so the
 * open document and every existing tool are unaffected.
 */
(function () {
  const el = (id) => document.getElementById(id);

  const cmp = {
    a: null, // { name, bytes: Uint8Array }
    b: null,
    report: null,
    pages: null,
    idx: 0, // current aligned page index (0-based)
    pdfA: null, // pdfjs document proxy
    pdfB: null,
    scale: 1.1,
  };

  function reset() {
    cmp.a = cmp.b = cmp.report = cmp.pages = null;
    cmp.idx = 0;
    if (cmp.pdfA) { try { cmp.pdfA.destroy(); } catch (_) {} cmp.pdfA = null; }
    if (cmp.pdfB) { try { cmp.pdfB.destroy(); } catch (_) {} cmp.pdfB = null; }
  }

  // ---- pick-files modal ----------------------------------------------------

  function open() {
    if (typeof sidecar !== "undefined" && sidecar.state !== "ready") {
      toast("Engine chưa sẵn sàng.", "bad");
      return;
    }
    reset();
    el("cmp2-a-name").textContent = "Chưa chọn";
    el("cmp2-b-name").textContent = "Chưa chọn";
    el("cmp2-mode").value = "auto";
    updateRunBtn();
    el("cmp2-modal").hidden = false;
  }

  function updateRunBtn() {
    el("cmp2-run").disabled = !(cmp.a && cmp.b);
  }

  async function pick(which) {
    const files = await window.desktop.openPdf({ multi: false });
    if (!files.length) return;
    const f = files[0];
    const entry = { name: f.name, bytes: toU8(f.data) };
    if (which === "a") {
      cmp.a = entry;
      el("cmp2-a-name").textContent = f.name;
    } else {
      cmp.b = entry;
      el("cmp2-b-name").textContent = f.name;
    }
    updateRunBtn();
  }

  async function run() {
    if (!cmp.a || !cmp.b) return;
    const mode = el("cmp2-mode").value || "auto";
    el("cmp2-modal").hidden = true;
    showOverlay(
      mode === "text"
        ? "Đang so sánh văn bản…"
        : "Đang so sánh (có thể OCR — tài liệu nhiều trang sẽ lâu)…"
    );
    try {
      const res = await sidecarFetch("/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_a_b64: u8ToB64(cmp.a.bytes),
          pdf_b_b64: u8ToB64(cmp.b.bytes),
          mode,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("So sánh lỗi: " + (data.error || data.detail || "không rõ"), "bad");
        return;
      }
      cmp.report = data;
      cmp.pages = data.pages;
      // Copy the bytes for pdf.js — getDocument may detach the passed buffer.
      cmp.pdfA = await pdfjsLib.getDocument({ data: cmp.a.bytes.slice(), isEvalSupported: false }).promise;
      cmp.pdfB = await pdfjsLib.getDocument({ data: cmp.b.bytes.slice(), isEvalSupported: false }).promise;
      const changed = data.summary.changed_pages || [];
      cmp.idx = changed.length ? changed[0] : 0;
      openView();
    } catch (err) {
      toast("Lỗi so sánh: " + err.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // ---- result view ---------------------------------------------------------

  function openView() {
    el("compare-view").hidden = false;
    renderSummary();
    renderPageList();
    renderCurrent();
  }

  function closeView() {
    el("compare-view").hidden = true;
    reset();
  }

  function renderSummary() {
    const s = cmp.report.summary;
    el("compare-summary").textContent = s.identical
      ? `Hai tài liệu giống nhau (${s.compared} trang).`
      : `${s.changed_pages.length}/${s.compared} trang khác nhau · A: ${s.pages_a} trang · B: ${s.pages_b} trang`;
  }

  function statusBadge(status) {
    if (status === "same") return "";
    if (status === "only_a") return " (chỉ A)";
    if (status === "only_b") return " (chỉ B)";
    return " ●";
  }

  function renderPageList() {
    const box = el("compare-pagelist");
    box.innerHTML = "";
    for (const pg of cmp.pages) {
      const b = document.createElement("button");
      b.className = "cmp-pagebtn " + pg.status + (pg.index === cmp.idx ? " active" : "");
      b.textContent = "Trang " + (pg.index + 1) + statusBadge(pg.status);
      b.dataset.idx = String(pg.index);
      b.onclick = () => {
        cmp.idx = pg.index;
        renderCurrent();
      };
      box.appendChild(b);
    }
  }

  function highlightPageBtn() {
    for (const b of el("compare-pagelist").children) {
      b.classList.toggle("active", Number(b.dataset.idx) === cmp.idx);
    }
  }

  async function renderCurrent() {
    const pg = cmp.pages.find((p) => p.index === cmp.idx);
    if (!pg) return;
    el("compare-pagenum").textContent = `Trang ${cmp.idx + 1} / ${cmp.report.summary.compared}`;
    await Promise.all([
      renderSide("a", cmp.pdfA, pg),
      renderSide("b", cmp.pdfB, pg),
    ]);
    renderDiffPanel(pg);
    highlightPageBtn();
  }

  async function renderSide(side, pdf, pg) {
    const host = el(side === "a" ? "compare-a" : "compare-b");
    host.innerHTML = "";
    const meta = side === "a" ? pg.meta_a : pg.meta_b;
    if (!meta) {
      const d = document.createElement("div");
      d.className = "cmp-missing";
      d.textContent = side === "a" ? "Không có trang này trong file A" : "Không có trang này trong file B";
      host.appendChild(d);
      return;
    }
    let page;
    try {
      page = await pdf.getPage(cmp.idx + 1);
    } catch (_) {
      return;
    }
    const vp = page.getViewport({ scale: cmp.scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    const wrap = document.createElement("div");
    wrap.className = "cmp-page";
    wrap.style.width = vp.width + "px";
    wrap.style.height = vp.height + "px";
    wrap.appendChild(canvas);
    host.appendChild(wrap);
    try {
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
    } catch (_) {
      return;
    }
    drawBoxes(wrap, pg, side);
  }

  // Overlay diff boxes. Line bbox is in scale-1 PDF-point space (same as the
  // text-edit spans), so on screen it's simply bbox * scale.
  function drawBoxes(wrap, pg, side) {
    const s = cmp.scale;
    for (const op of pg.diffs) {
      let lines, cls;
      if (op.type === "replace") {
        lines = side === "a" ? op.a : op.b;
        cls = "cmp-box-replace";
      } else if (op.type === "delete") {
        if (side !== "a") continue;
        lines = op.a;
        cls = "cmp-box-del";
      } else {
        // insert
        if (side !== "b") continue;
        lines = op.b;
        cls = "cmp-box-ins";
      }
      for (const ln of lines) {
        if (!ln.bbox) continue;
        const [x0, y0, x1, y1] = ln.bbox;
        const box = document.createElement("div");
        box.className = "cmp-box " + cls;
        box.style.left = x0 * s + "px";
        box.style.top = y0 * s + "px";
        box.style.width = Math.max(3, x1 - x0) * s + "px";
        box.style.height = Math.max(6, y1 - y0) * s + "px";
        wrap.appendChild(box);
      }
    }
  }

  function renderDiffPanel(pg) {
    const box = el("compare-diffs");
    box.innerHTML = "";
    if (pg.status === "same") {
      box.innerHTML = '<p class="cmp-nodiff">Trang này giống nhau.</p>';
      return;
    }
    const head = document.createElement("div");
    head.className = "cmp-diffs-head";
    head.textContent = "Khác biệt ở trang " + (pg.index + 1);
    box.appendChild(head);

    for (const op of pg.diffs) {
      const row = document.createElement("div");
      row.className = "cmp-diffrow " + op.type;
      if (op.type === "replace" && op.words) {
        row.appendChild(wordSide("A", op.words.a, "del"));
        row.appendChild(wordSide("B", op.words.b, "ins"));
      } else if (op.type === "replace") {
        row.appendChild(textSide("A", op.a.map((l) => l.text), "del"));
        row.appendChild(textSide("B", op.b.map((l) => l.text), "ins"));
      } else if (op.type === "delete") {
        row.appendChild(textSide("A — đã xoá", op.a.map((l) => l.text), "del"));
      } else {
        row.appendChild(textSide("B — đã thêm", op.b.map((l) => l.text), "ins"));
      }
      box.appendChild(row);
    }
  }

  function textSide(label, lines, cls) {
    const d = document.createElement("div");
    d.className = "cmp-side " + cls;
    const h = document.createElement("span");
    h.className = "cmp-side-h";
    h.textContent = label;
    d.appendChild(h);
    const p = document.createElement("div");
    p.className = "cmp-side-t";
    p.textContent = lines.join("\n");
    d.appendChild(p);
    return d;
  }

  function wordSide(label, segs, cls) {
    const d = document.createElement("div");
    d.className = "cmp-side " + cls;
    const h = document.createElement("span");
    h.className = "cmp-side-h";
    h.textContent = label;
    d.appendChild(h);
    const p = document.createElement("div");
    p.className = "cmp-side-t";
    for (const seg of segs) {
      const sp = document.createElement("span");
      sp.textContent = seg.t + " ";
      if (seg.op === "change") sp.className = "cmp-wd " + cls;
      p.appendChild(sp);
    }
    d.appendChild(p);
    return d;
  }

  // ---- navigation ----------------------------------------------------------

  function step(delta) {
    const n = cmp.report.summary.compared;
    cmp.idx = Math.min(n - 1, Math.max(0, cmp.idx + delta));
    renderCurrent();
  }

  function nextDiff(dir) {
    const changed = cmp.report.summary.changed_pages;
    if (!changed.length) {
      toast("Không có trang khác nhau.", "");
      return;
    }
    let target;
    if (dir > 0) {
      target = changed.find((i) => i > cmp.idx);
      if (target === undefined) target = changed[0]; // wrap
    } else {
      const before = changed.filter((i) => i < cmp.idx);
      target = before.length ? before[before.length - 1] : changed[changed.length - 1];
    }
    cmp.idx = target;
    renderCurrent();
  }

  // ---- wiring --------------------------------------------------------------

  function init() {
    const on = (id, fn) => {
      const e = el(id);
      if (e) e.onclick = fn;
    };
    on("cmp2-pick-a", () => pick("a"));
    on("cmp2-pick-b", () => pick("b"));
    on("cmp2-cancel", () => (el("cmp2-modal").hidden = true));
    on("cmp2-run", run);
    on("compare-close", closeView);
    on("compare-prev", () => step(-1));
    on("compare-next", () => step(1));
    on("compare-prev-diff", () => nextDiff(-1));
    on("compare-next-diff", () => nextDiff(1));
    // Esc closes the result view (only when it's open).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el("compare-view").hidden) closeView();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.Compare = { open };
})();
