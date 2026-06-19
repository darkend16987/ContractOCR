"use strict";

// window.sidecar is injected by preload.js (base URL of the local FastAPI sidecar).
const base = window.sidecar && window.sidecar.baseUrl;

const baseEl = document.getElementById("base");
const healthEl = document.getElementById("health");
const outEl = document.getElementById("out");

baseEl.textContent = base || "(không có port)";

// 1. Confirm the sidecar is reachable.
async function checkHealth() {
  try {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    healthEl.textContent = `${data.status} · engine=${data.engine}`;
    healthEl.className = "pill ok";
  } catch (err) {
    healthEl.textContent = `lỗi: ${err.message}`;
    healthEl.className = "pill bad";
  }
}

// 2. Read a file as base64 (strip the data URL prefix the /ocr endpoint doesn't want).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 3. POST the image to /ocr and show the extracted text.
async function runOcr() {
  const file = document.getElementById("file").files[0];
  if (!file) {
    outEl.textContent = "Hãy chọn 1 file ảnh trước.";
    return;
  }
  outEl.textContent = "Đang OCR…";
  try {
    const b64 = await fileToBase64(file);
    const res = await fetch(`${base}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [b64] }),
    });
    const data = await res.json();
    outEl.textContent = data.success
      ? data.full_text || "(không trích được text)"
      : `Lỗi: ${data.error}`;
  } catch (err) {
    outEl.textContent = `Lỗi gọi sidecar: ${err.message}`;
  }
}

document.getElementById("run").addEventListener("click", runOcr);
checkHealth();
