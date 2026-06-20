# ContractOCR Desktop — Roadmap

Xem kiến trúc & quyết định ở [DESIGN.md](DESIGN.md). Dựng môi trường máy mới: [SETUP.md](SETUP.md).

## Phases

| Phase | Mục tiêu | "Done khi" |
|-------|----------|------------|
| **P0 — Vỏ native** | Chứng minh đóng gói chạy được | Mở portable .exe trên máy Windows sạch → UI hiện → OCR 1 file chạy local không lỗi |
| **P1 — PDF core** | Đọc + tổ chức trang | Viewer + merge/split/insert/reorder/rotate/delete → lưu PDF mới |
| **P2 — Tích hợp OCR** | Nối core sẵn có vào UI | Upload PDF scan → bóc field tùy chỉnh → xuất Excel |
| **P3 — Nén + Searchable** | Native binary | Ghostscript nén (presets) + OCRmyPDF searchable layer |
| **P4 — Overlay edit** | Editor | Annotate + watermark + form fill + redact → lưu |
| **P5 — Hoàn thiện** | Phát hành | Auto-update, installer ký số, settings local/cloud AI, bundle weights offline |

**MVP = P0 + P1 + P2.**

---

## Phase 0 — Task breakdown (làm trước, rủi ro cao nhất)

- [x] **T0.1** Chốt Hybrid vs chỉ-Paddle → **Hybrid** (quyết định D3)
- [x] **T0.2** Skeleton Electron: `main` spawn sidecar trên port động + poll `/health`
- [x] **T0.3** Sidecar entry `sidecar.py` (đọc `--port`, chạy uvicorn với `app` từ `api.py`)
- [x] **T0.4** PyInstaller spec `sidecar.spec` (collect_all torch/paddle/vietocr/paddleocr)
- [x] **T0.5** `electron-builder.yml` → target portable + nsis, bundle `dist/sidecar` vào extraResources
- [x] **T0.6** Renderer P0 tối giản: ping `/health` + test OCR 1 ảnh
- [x] **T0.6b** Fix `src/utils/config.py` cho frozen mode (ghi uploads/results vào `%LOCALAPPDATA%\ContractOCR` thay vì cạnh exe)
- [x] **T0.7** Cài deps: venv **Python 3.12** (`.venv/`) + `requirements.txt` + `requirements-build.txt`; `desktop/` qua pnpm (electron binary OK). Quyết định D6: dùng 3.12 vì vietocr không tương thích 3.13.
- [x] **T0.8a** Migrate `src/ocr/engine.py` sang **paddleocr 3.x** API (`predict()`, `dt_polys`, `use_textline_orientation`, `enable_mkldnn=False`) + import torch trước paddle (DLL order Windows). Pin `requirements.txt`.
- [x] **T0.8b** Validate sidecar: `sidecar.py --port` → `/health` = `{ok, hybrid}`, `/ocr` đọc đúng tiếng Việt có dấu ("Biên bản nghiệm thu"). Hybrid OCR end-to-end OK.
- [ ] **T0.8c** ▶️ **(bạn chạy GUI)** `cd desktop && pnpm start` — mở cửa sổ Electron, xác nhận spawn sidecar + UI test OCR (phần GUI cần chạy tương tác trên máy bạn)
- [ ] **T0.9** ▶️ Build sidecar: `npm run build:sidecar` → iterate PyInstaller cho tới khi `dist/sidecar/sidecar.exe --port 8000` chạy được
- [ ] **T0.10** ▶️ Build app: `npm run build` → test portable .exe trên **máy Windows sạch (không có Python)**
- [ ] **T0.11** Chốt chiến lược model weights (tải lần đầu vs bundle) sau khi đo size thực tế

▶️ = cần chạy trên máy bạn; tôi không tự chạy được build nặng/đóng gói ở đây.

## Phase 1 — PDF core (đang làm)

Chạy hoàn toàn trong renderer (pdf.js xem + pdf-lib sửa cấu trúc) — không cần Python.
Tài liệu canonical = `state.bytes` (Uint8Array); mỗi thao tác dựng lại bytes bằng pdf-lib rồi re-render.

- [x] **T1.0** Tách sidecar OCR thành **lazy/non-blocking**: UI PDF mở tức thì, sidecar boot nền,
  trạng thái đẩy về renderer qua IPC `sidecar:status` (badge starting/ready/error). Quyết định D5.
  → cũng cho phép dev P1 trên máy chỉ có Python 3.13 (sidecar lỗi nhưng PDF vẫn chạy).
- [x] **T1.1** Vendor offline `pdf-lib` (UMD) + `pdfjs-dist` **v3** (UMD) vào `renderer/vendor/`
  qua `scripts/vendor-libs.js` (chạy `postinstall`). Dùng v3 vì v4 chỉ có ESM → vỡ trên `file://`.
- [x] **T1.2** Viewer: pdf.js render thumbnails (sidebar) + trang lớn (zoom 40–300%), chọn trang
  (click / Ctrl / Shift), cuộn tới trang.
- [x] **T1.3** Thao tác trang (pdf-lib): xoay ±90°, xóa, **kéo-thả sắp xếp lại**, ghép nhiều PDF,
  chèn trang từ PDF khác, tách trang chọn → PDF mới.
- [x] **T1.4** Lưu qua dialog native (IPC `dialog:save-pdf` / `dialog:open-pdf`), Ctrl+S, kéo-thả mở file.
- [x] **T1.5** Validate headless ops pdf-lib (reorder/rotate/merge/insert/delete/extract) — page count đúng.
- [ ] **T1.6** ▶️ **(bạn chạy GUI)** `cd desktop && pnpm start` — xác nhận viewer render + các thao tác trên file thật.
- [ ] **T1.7** Refactor renderer sang module/React khi UI phình (hiện tại vanilla JS, đủ dùng).

## Phase 2 — Tích hợp OCR (code xong, chờ test runtime)

Tận dụng backend sẵn có (OCR engine + gemini_agent + writers). Code xong cả backend + UI.
**Test runtime cần venv Python 3.12 + deps + `GEMINI_API_KEY`** (máy hiện tại chưa có).

- [x] **T2.0** Backend endpoints mới trong `api.py`:
  - `GET /templates` → 5 mẫu field (default/mua_ban/lao_dong/dich_vu/generic).
  - `POST /extract` → images→OCR từng trang→ghép text→Gemini classify+extract→record field.
  - `POST /export` → records→xlsx/csv/json (writers cũ)→trả base64 cho app lưu.
  - CORS mở `allow_methods=["*"]` (cần GET); Gemini agent tạo lazy (cần key).
- [x] **T2.1** UI panel bóc tách: chọn mẫu field + phạm vi (tất cả/đang chọn) → rasterize trang →
  `/extract` → bảng field **sửa được** + loại văn bản + text OCR thô (collapsible).
- [x] **T2.2** Xuất: nút Excel/CSV/JSON → `/export` → lưu qua dialog native (IPC `dialog:save-file`).
- [ ] **T2.3** ▶️ **(cần venv)** Test end-to-end: PDF scan thật → bóc field → xuất Excel mở được.
- [ ] **T2.4** (tùy chọn) Bóc tách nhiều hợp đồng/1 lần → nhiều record → 1 Excel nhiều dòng.

## Ghi chú thực thi

- **Onedir, không onefile**: torch giải nén onefile rất chậm + dễ lỗi. Spec tạo `dist/sidecar/`.
- **PyInstaller sẽ lỗi `ModuleNotFoundError` vài vòng đầu** — đó là bình thường với torch/paddle.
  Đọc tên module thiếu → thêm vào `hiddenimports` trong `sidecar.spec`.
- **Console sidecar bật** ở P0 (`console=True`) để đọc log OCR khi debug; tắt ở P5.
- **Model weights** (VietOCR `vgg_transformer`, Paddle det/rec) tải về cache lần chạy đầu →
  máy sạch cần internet lần đầu. Task T0.11/P5 sẽ bundle sẵn cache cho offline tuyệt đối.
