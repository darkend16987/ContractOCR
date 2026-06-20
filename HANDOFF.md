# Handoff — ContractOCR → PDF Suite

> Bàn giao trạng thái để tiếp tục ở session/máy khác. Đọc kèm:
> [DESIGN.md](DESIGN.md) (kiến trúc), [ROADMAP.md](ROADMAP.md) (tiến độ chi tiết),
> [SETUP.md](SETUP.md) (dựng môi trường).

_Cập nhật: 2026-06-20 · branch `claude/vietnamese-ocr-ai-iSvwV`_

## Tình trạng: MVP (P0+P1+P2) xong, đã test GUI

| Phase | Trạng thái |
|-------|-----------|
| P0 — Vỏ Electron + sidecar | ✅ Code xong. Build .exe (T0.9/T0.10) **chưa làm**. |
| P1 — PDF core (xem/ghép/tách/chèn/xoay/xóa/sắp xếp/lưu) | ✅ Xong, GUI tested. |
| P2 — OCR + bóc tách field + xuất Excel/CSV/JSON | ✅ Xong, GUI tested + backend headless tested. |
| P3 — Nén (Ghostscript) + searchable (OCRmyPDF) | ⬜ Chưa bắt đầu. |
| P4 — Overlay edit (annotate/watermark/form/redact) | ⬜ Chưa bắt đầu. |
| P5 — Đóng gói portable .exe, auto-update, bundle weights | ⬜ Chưa bắt đầu. |

## Chạy app (dev)

```powershell
cd desktop
pnpm install      # nếu máy mới (postinstall tự vendor pdf libs)
pnpm start        # UI PDF hiện ngay; badge "OCR: sẵn sàng" nếu có .venv 3.12
```

OCR cần `.venv` Python 3.12 ở gốc repo + `GEMINI_API_KEY` trong `.env`. Xem [SETUP.md](SETUP.md).

## Máy hiện tại (máy đã làm P1/P2)

- `.venv/` = Python **3.12.10** (winget `Python.Python.3.12`), deps đã cài (~3GB: torch 2.12 cpu, paddle 3.3.1, vietocr, google-genai, openpyxl, fastapi…).
- Model weights PaddleOCR/VietOCR đã tải về cache user (`~/.paddlex`, `~/.cache`) → chạy nhanh.
- `.env` có `GEMINI_API_KEY`. Máy này còn cả Python 3.13 (mặc định `py`), nhưng app dùng `.venv` 3.12.
- ⚠️ Máy **mới** chưa có gì: phải dựng lại `.venv` 3.12 theo SETUP.md trước khi dùng OCR. PDF core (P1) chạy không cần Python.

## Bản đồ code

**Desktop (Electron, renderer thuần JS — chưa React):**
- `desktop/src/main.js` — lazy sidecar (UI load ngay), IPC: `dialog:open-pdf|save-pdf|save-file`, `sidecar:status|restart`.
- `desktop/src/sidecar.js` — spawn sidecar port động, ưu tiên `.venv` 3.12, poll `/health`.
- `desktop/src/preload.js` — bridge `window.desktop` (openPdf/savePdf/saveFile/sidecar status).
- `desktop/renderer/index.html` + `app.css` + `app.js` — toàn bộ UI + logic PDF/OCR.
- `desktop/renderer/vendor/` — pdf-lib UMD + pdfjs-dist **v3** UMD (offline; `scripts/vendor-libs.js`).

**Backend (Python sidecar, FastAPI):**
- `api.py` — endpoints: `/health`, `/ocr`, `/templates`, `/extract`, `/export`.
- `src/ocr/engine.py` — Hybrid PaddleOCR detect + VietOCR recognize (paddle 3.x).
- `src/agents/gemini_agent.py` + `field_templates.py` — bóc field + 5 mẫu.
- `src/output/writer.py` — JSON/Excel/CSV/Markdown/GoogleSheet writers.
- `sidecar.py` — entry uvicorn (đọc `--port`).

## Bẫy đã giải (đừng "sửa cho mới")

- **Python phải 3.12** (không 3.13) — vietocr thiếu wheel cp313. paddle/paddleocr **3.x** (numpy 2).
- **pdfjs v3 (UMD)**, không v4 (ESM-only vỡ trên `file://`).
- **CSP meta + `file://`** chặn worker pdf.js → đã bỏ CSP meta.
- **`[hidden]{display:none!important}`** trong app.css — bắt buộc, nếu không `.overlay`/`.ext-panel` (`display:flex`) đè `hidden` → che màn lúc khởi động.
- Sidecar **lazy/non-blocking** — đừng cho UI chờ `/health` (vi phạm D5).

## Bước tiếp theo (gợi ý)

1. **P3 — Nén + searchable** (sidecar): bundle Ghostscript binary → endpoint `/compress` (presets screen/ebook/printer). OCRmyPDF → `/searchable` (cần Ghostscript + tesseract; cân nhắc vì đã có engine OCR riêng — có thể tự ghép text layer thay vì tesseract).
2. **P4 — Overlay edit** (renderer, pdf-lib): text box, highlight, vẽ tay, chèn ảnh, watermark, điền form, redact. Lưu đè bytes như các op P1.
3. **P5 — Đóng gói**: `pnpm run build:sidecar` (PyInstaller, iterate ModuleNotFoundError) → `pnpm run build` (electron-builder portable+nsis). Test trên máy Windows sạch. Chốt chiến lược weights (T0.11).

MVP đã chạy được — ưu tiên P5 (đóng gói) nếu muốn phát hành sớm, hoặc P4 (edit) nếu muốn đủ tính năng trước.
