"use strict";

/*
 * Digital signing UI (PKI, USB token). Standalone renderer module — shares the
 * global scope with app.js (classic scripts) and only READS its globals
 * (state, $, toast, showOverlay/hideOverlay, baseName, window.Editor,
 * window.desktop). It never touches the overlay editor's internals; the visible
 * signature is placed by a self-contained rubber-band that reuses the same
 * pdf.js viewport mapping (convertToPdfPoint) the rest of the app uses.
 *
 * Flow: pick certificate → (optional) drag a rectangle on a page → main process
 * inserts the signature placeholder + our rendered appearance, the token signs
 * (its own PIN dialog), we splice the CMS in and Save As a NEW file. Signing is
 * terminal: editing + re-saving a signed file invalidates it (we warn).
 */

(function () {
  let signCerts = []; // last scan, so we can map thumbprint → name/email
  let pickedImage = null; // { bytes, name } for the visible appearance

  const byId = (id) => document.getElementById(id);

  function dataUrlToBytes(u) {
    const b = atob(u.split(",")[1]);
    const a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }

  function loadImage(bytes) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([bytes]));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Không đọc được ảnh.")); };
      img.src = url;
    });
  }

  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // --- certificate list -------------------------------------------------------

  function certLabel(c) {
    const name = c.cn || c.subject || c.thumbprint;
    const org = c.org ? " — " + c.org : "";
    let exp = "";
    try { exp = " (HSD: " + fmtDate(new Date(c.notAfter)) + ")"; } catch (_) {}
    return (c.expired ? "[HẾT HẠN] " : "") + name + org + exp;
  }

  async function scanCerts() {
    const sel = byId("sign-cert");
    const ok = byId("sign-ok");
    sel.innerHTML = "<option value=''>Đang tìm chứng thư…</option>";
    ok.disabled = true;
    let r;
    try {
      r = await window.desktop.signing.listCerts();
    } catch (e) {
      r = { ok: false, error: e.message || String(e) };
    }
    if (!r.ok) {
      sel.innerHTML = "<option value=''>Lỗi đọc chứng thư</option>";
      toast("Không đọc được chứng thư: " + (r.error || ""), "bad");
      return;
    }
    signCerts = r.certs || [];
    if (!signCerts.length) {
      sel.innerHTML = "<option value=''>Không tìm thấy chứng thư (cắm token rồi Làm mới)</option>";
      return;
    }
    sel.innerHTML = "";
    signCerts.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.thumbprint;
      o.textContent = certLabel(c);
      sel.appendChild(o);
    });
    ok.disabled = false;
  }

  function certByThumb(t) {
    return signCerts.find((c) => c.thumbprint === t) || null;
  }

  // --- dialog -----------------------------------------------------------------

  function refreshOkLabel() {
    byId("sign-ok").textContent = byId("sign-visible").checked
      ? "Tiếp: kéo khung trên trang"
      : "Ký ngay";
  }

  async function openDialog() {
    if (!state || !state.bytes) { toast("Mở PDF trước khi ký.", "warn"); return; }
    pickedImage = null;
    byId("sign-image-name").textContent = "Chưa chọn";
    byId("sign-image-clear").hidden = true;
    refreshOkLabel();
    byId("sign-modal").hidden = false;
    scanCerts();
  }

  function closeDialog() { byId("sign-modal").hidden = true; }

  async function pickImage() {
    let files;
    try {
      files = await window.desktop.openFiles({
        multi: false,
        filters: [{ name: "Ảnh", extensions: ["png", "jpg", "jpeg"] }],
      });
    } catch (_) { return; }
    if (!files || !files.length) return;
    const file = files[0];
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    pickedImage = { bytes, name: file.name };
    byId("sign-image-name").textContent = file.name;
    byId("sign-image-clear").hidden = false;
  }

  // --- appearance rasteriser --------------------------------------------------

  // Render the visible signature (border + optional image + text lines) to a PNG
  // whose pixel aspect matches the drawn rectangle, so the main process can map it
  // onto the widget with no distortion.
  async function renderSignaturePng(opts) {
    const RS = Math.min(4, Math.max(2, Math.round((window.devicePixelRatio || 1) * 2)));
    const W = Math.max(1, Math.round(opts.cssW * RS));
    const H = Math.max(1, Math.round(opts.cssH * RS));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const cx = c.getContext("2d");

    // Legible over any content.
    cx.fillStyle = "rgba(255,255,255,0.72)";
    cx.fillRect(0, 0, W, H);
    const lw = Math.max(1, Math.round(RS));
    cx.strokeStyle = "#1a56c4";
    cx.lineWidth = lw;
    cx.strokeRect(lw / 2, lw / 2, W - lw, H - lw);

    const pad = Math.round(Math.min(W, H) * 0.06) + lw;
    let textX = pad;

    if (opts.image) {
      const side = H - pad * 2;
      const iw = opts.image.width, ih = opts.image.height;
      const scale = Math.min(side / iw, side / ih);
      const dw = Math.max(1, iw * scale), dh = Math.max(1, ih * scale);
      cx.drawImage(opts.image, pad, pad + (side - dh) / 2, dw, dh);
      textX = pad + side + pad;
    }

    const lines = [];
    if (opts.name) lines.push({ t: "Ký bởi: " + opts.name, bold: true });
    lines.push({ t: "Ngày: " + opts.dateText, bold: false });
    if (opts.reason) lines.push({ t: "Lý do: " + opts.reason, bold: false });
    if (opts.location) lines.push({ t: "Nơi: " + opts.location, bold: false });

    const boxW = W - textX - pad;
    const boxH = H - pad * 2;
    const lineH = boxH / lines.length;
    const fontPx = Math.max(6, Math.min(lineH * 0.72, boxW * 0.12));
    cx.textBaseline = "middle";
    cx.fillStyle = "#0b2e6b";
    lines.forEach((ln, k) => {
      cx.font = (ln.bold ? "bold " : "") + fontPx + "px sans-serif";
      const y = pad + lineH * k + lineH / 2;
      fillClipped(cx, ln.t, textX, y, boxW);
    });

    return dataUrlToBytes(c.toDataURL("image/png"));
  }

  // Draw text, truncating with an ellipsis if it overflows maxW.
  function fillClipped(cx, text, x, y, maxW) {
    if (cx.measureText(text).width <= maxW) { cx.fillText(text, x, y); return; }
    let s = text;
    while (s.length > 1 && cx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    cx.fillText(s + "…", x, y);
  }

  // --- rubber-band placement --------------------------------------------------

  function pageAt(x, y) {
    for (const wrap of document.querySelectorAll("#viewer .page-wrap")) {
      const canvas = wrap.querySelector("canvas") || wrap;
      const rect = canvas.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { index: +wrap.dataset.index, rect };
      }
    }
    return null;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Let the user drag one rectangle on a page; resolve with
  // { pageIndex, rect:[x1,y1,x2,y2] PDF pts, cssW, cssH } or null if cancelled.
  function pickRect() {
    return new Promise((resolve) => {
      document.body.style.cursor = "crosshair";
      const hint = document.createElement("div");
      hint.textContent = "Kéo chuột để vẽ khung chữ ký trên trang. Esc để huỷ.";
      hint.style.cssText =
        "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;" +
        "background:#1a56c4;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;";
      document.body.appendChild(hint);

      const box = document.createElement("div");
      box.style.cssText =
        "position:fixed;z-index:9998;border:2px dashed #1a56c4;background:rgba(26,86,196,.12);" +
        "pointer-events:none;display:none;";
      document.body.appendChild(box);

      let start = null, cur = null;

      const setBox = (x0, y0, x1, y1) => {
        box.style.display = "block";
        box.style.left = Math.min(x0, x1) + "px";
        box.style.top = Math.min(y0, y1) + "px";
        box.style.width = Math.abs(x1 - x0) + "px";
        box.style.height = Math.abs(y1 - y0) + "px";
      };

      const cleanup = () => {
        document.removeEventListener("mousedown", md, true);
        document.removeEventListener("mousemove", mm, true);
        document.removeEventListener("mouseup", mu, true);
        document.removeEventListener("keydown", key, true);
        box.remove(); hint.remove();
        document.body.style.cursor = "";
      };

      function md(e) {
        const p = pageAt(e.clientX, e.clientY);
        if (!p) return;
        start = { x: e.clientX, y: e.clientY, p };
        cur = { x: e.clientX, y: e.clientY };
        setBox(start.x, start.y, cur.x, cur.y);
        e.preventDefault();
      }
      function mm(e) {
        if (!start) return;
        const r = start.p.rect;
        cur = { x: clamp(e.clientX, r.left, r.right), y: clamp(e.clientY, r.top, r.bottom) };
        setBox(start.x, start.y, cur.x, cur.y);
        e.preventDefault();
      }
      function mu(e) {
        if (!start) return;
        const r = start.p.rect;
        const ex = clamp((cur || start).x, r.left, r.right);
        const ey = clamp((cur || start).y, r.top, r.bottom);
        cleanup();
        const cssW = Math.abs(ex - start.x), cssH = Math.abs(ey - start.y);
        if (cssW < 8 || cssH < 8) { toast("Khung quá nhỏ — thử lại.", "warn"); resolve(null); return; }
        const m = state.pageMetas && state.pageMetas[start.p.index];
        if (!m || !m.vp) { resolve(null); return; }
        const lx0 = start.x - r.left, ly0 = start.y - r.top;
        const lx1 = ex - r.left, ly1 = ey - r.top;
        const a = m.vp.convertToPdfPoint(lx0, ly0);
        const b = m.vp.convertToPdfPoint(lx1, ly1);
        const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        resolve({ pageIndex: start.p.index, rect, cssW, cssH });
      }
      function key(e) {
        if (e.key === "Escape") { cleanup(); resolve(null); }
      }

      document.addEventListener("mousedown", md, true);
      document.addEventListener("mousemove", mm, true);
      document.addEventListener("mouseup", mu, true);
      document.addEventListener("keydown", key, true);
    });
  }

  // --- sign + save ------------------------------------------------------------

  function explainError(res) {
    switch (res.reason) {
      case "cancelled": return "Đã huỷ ký (không nhập PIN hoặc không truy cập được khoá trên token).";
      case "no_cert": return "Không tìm thấy chứng thư đã chọn — token còn cắm không?";
      case "tsa": return "Lấy dấu thời gian (TSA) thất bại: " + (res.error || "") + " — kiểm tra URL hoặc để trống ô TSA.";
      case "rotated": return res.error || "Trang xoay chưa hỗ trợ chữ ký nhìn thấy.";
      case "load": return res.error || "Không mở được PDF để ký.";
      default: return "Ký thất bại: " + (res.error || "lỗi không xác định");
    }
  }

  async function doSign(cfg) {
    showOverlay("Đang chuẩn bị ký…");
    try {
      if (window.Editor) await window.Editor.bakePending();

      let appearance = null;
      if (cfg.place) {
        let image = null;
        if (pickedImage) {
          try { image = await loadImage(pickedImage.bytes); } catch (_) { /* skip bad image */ }
        }
        const cert = certByThumb(cfg.thumbprint);
        const png = await renderSignaturePng({
          cssW: cfg.place.cssW,
          cssH: cfg.place.cssH,
          name: cfg.name || (cert && cert.cn) || "",
          reason: cfg.reason,
          location: cfg.location,
          dateText: fmtDate(new Date()),
          image,
        });
        appearance = { pageIndex: cfg.place.pageIndex, rect: cfg.place.rect, imagePng: png };
      }

      showOverlay("Đang ký — nhập mã PIN trên hộp thoại của token…");
      const res = await window.desktop.signing.apply({
        bytes: state.bytes,
        thumbprint: cfg.thumbprint,
        tsaUrl: cfg.tsa || undefined,
        meta: { name: cfg.name, reason: cfg.reason, location: cfg.location, contactInfo: cfg.email || "" },
        appearance,
      });
      if (!res.ok) { hideOverlay(); toast(explainError(res), "bad"); return; }

      // Keep the busy overlay up through the write — signing offloads to a
      // utilityProcess now, so the window stays responsive and the spinner
      // actually animates (it used to be hidden here, leaving the save blank).
      showOverlay("Đang lưu file đã ký…");
      const suggested = baseName(state.name || "tai-lieu") + "-daky.pdf";
      const save = await window.desktop.savePdf(res.bytes, suggested);
      hideOverlay();
      if (save.saved) {
        toast("Đã ký & lưu: " + save.path, "good");
        setTimeout(
          () => toast("Lưu ý: đừng chỉnh sửa rồi lưu đè file đã ký — chữ ký sẽ mất hiệu lực.", "warn"),
          1000
        );
      }
    } catch (e) {
      hideOverlay();
      toast("Lỗi ký: " + (e.message || e), "bad");
    }
  }

  function onOk() {
    const thumbprint = byId("sign-cert").value;
    if (!thumbprint) { toast("Chọn một chứng thư số.", "warn"); return; }
    const cert = certByThumb(thumbprint);
    const cfg = {
      thumbprint,
      name: (cert && cert.cn) || "",
      email: (cert && cert.email) || "",
      reason: byId("sign-reason").value.trim(),
      location: byId("sign-location").value.trim(),
      tsa: byId("sign-tsa").value.trim(),
    };
    const visible = byId("sign-visible").checked;
    closeDialog();
    if (!visible) { doSign({ ...cfg, place: null }); return; }
    pickRect().then((place) => {
      if (!place) { toast("Đã huỷ đặt chữ ký.", ""); return; }
      doSign({ ...cfg, place });
    });
  }

  // --- wiring -----------------------------------------------------------------

  function wire() {
    const mi = byId("mi-sign");
    if (mi) mi.onclick = openDialog;
    byId("sign-cancel").onclick = closeDialog;
    byId("sign-ok").onclick = onOk;
    byId("sign-refresh").onclick = scanCerts;
    byId("sign-visible").onchange = refreshOkLabel;
    byId("sign-image-pick").onclick = pickImage;
    byId("sign-image-clear").onclick = () => {
      pickedImage = null;
      byId("sign-image-name").textContent = "Chưa chọn";
      byId("sign-image-clear").hidden = true;
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
