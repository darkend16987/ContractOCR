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

## Phase 1 — PDF core (✅ xong, GUI tested)

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
- [x] **T1.6** ✅ Test GUI: viewer render + view/reorder/rotate/merge/insert/tách/delete/save chạy tốt trên file thật.
- [ ] **T1.7** Refactor renderer sang module/React khi UI phình (hiện tại vanilla JS, đủ dùng).

## Phase 2 — Tích hợp OCR (✅ xong, GUI tested)

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
- [x] **T2.3a** Venv 3.12 dựng xong trên máy này (winget Python 3.12.10 + deps ~3GB).
- [x] **T2.3b** Test headless backend OK: `/health`, `/templates` (5 mẫu), `/extract` (ảnh HĐ
  tiếng Việt synthetic → OCR đọc đúng dấu → Gemini phân loại "Hợp đồng mua bán" + bóc đủ field,
  ngày chuẩn hóa DD/MM/YYYY), `/export` excel/csv/json (openpyxl mở được, header đúng nhãn VN).
- [x] **T2.3c** ✅ Test GUI end-to-end OK: mở PDF scan → Bóc tách → sửa field → xuất Excel.
- [ ] **T2.4** (tùy chọn) Bóc tách nhiều hợp đồng/1 lần → nhiều record → 1 Excel nhiều dòng.

## Phase 3 — Searchable PDF (✅ code + test backend xong) · Nén (⬜ chưa)

Searchable: tự ghép lớp text vô hình từ OCR engine sẵn có — **không cần tesseract/OCRmyPDF**.

- [x] **T3.0** `engine.recognize_boxes(image)` → `[(text, [x0,y0,x1,y1])]` cho Hybrid + Paddle
  (Auto delegate; base raise NotImplementedError). Tái dùng Paddle detect + VietOCR recognize.
- [x] **T3.1** Endpoint `POST /searchable` (api.py): nhận PDF base64 → mỗi trang render pixmap
  (PyMuPDF, mặc định 200 dpi) → OCR lấy box → chèn text vô hình (`render_mode=3`) lên đúng trang
  gốc (giữ nguyên nội dung) bằng font DejaVuSans → trả PDF base64. Giới hạn 100 trang.
- [x] **T3.2** UI: nút **Searchable** → gửi `state.bytes` → lưu `*-searchable.pdf` qua dialog.
- [x] **T3.3** Test backend end-to-end (`.venv`): PDF "scan" ảnh chữ VN → `/searchable` → PDF ra
  giữ ảnh gốc + lớp text trích xuất được, **dấu tiếng Việt nguyên vẹn**. PASS.
- [ ] **T3.4** ▶️ Test GUI: mở PDF scan → Searchable → mở file ra ở app khác, thử Ctrl+F / bôi-copy.
- [x] **T3.5** **Nén PDF** (PyMuPDF, **không cần Ghostscript binary**): endpoint `/compress` +
  nút "Nén" + modal chọn mức. `doc.rewrite_images(dpi_threshold/dpi_target/quality)` hạ ảnh độ phân
  giải cao + `subset_fonts()` + `save(deflate,garbage=4,clean,deflate_images,deflate_fonts)`. Presets:
  screen(96/q45) · ebook(150/q65) · printer(300/q85) · lossless(chỉ dọn rác). Nếu nén làm phình thì
  trả lại bản gốc. Test backend: ảnh ~360dpi/A4 → screen 6%, ebook 53%, printer 80%, lossless 100% — PASS.
- [ ] **T3.5b** ▶️ Test GUI nén: mở PDF nhiều ảnh → Nén (thử các mức) → kiểm tra size giảm + mở xem được.
- [ ] **T3.6** (P5) Bundle DejaVuSans.ttf vào PyInstaller + xác minh `pymupdf` collect đủ.

## Phase 4 — Overlay edit (✅ code xong, chờ test GUI)

Chạy hoàn toàn ở renderer (`editor.js`, pdf-lib) — không cần Python. Annotation lưu ở
không gian điểm scale-1 (top-left); bake vào `state.bytes` qua pdf-lib khi "Áp dụng".
Text/watermark tiếng Việt render qua canvas hệ thống rồi nhúng PNG (tránh nhúng font Unicode).

- [x] **T4.0** Khung editor: nút "Chỉnh sửa" bật thanh công cụ + khoá thao tác trang khi đang sửa
  (giữ page index ổn định). Overlay layer/SVG per-page, scale theo zoom, hook vào `renderViewer`.
- [x] **T4.1** Annotation: hộp văn bản (textarea inline — Electron không có `window.prompt`),
  tô sáng, vẽ tay (SVG path), chèn ảnh/chữ ký (`<input type=file>` → dataURL). Chọn/di chuyển/đổi
  cỡ + xoá (phím Delete). Màu/cỡ chữ/độ dày nét chỉnh được, áp lên mục đang chọn.
- [x] **T4.2** Watermark: text chéo, mờ, màu/góc tùy chỉnh → áp mọi trang.
- [x] **T4.3** Redact **an toàn**: trang có redact được raster hoá (burn ô đen) rồi thay nội dung
  trang bằng ảnh → text gốc bị xoá thật, không trích xuất lại được. Trang khác giữ vector.
- [x] **T4.4** Điền form AcroForm: text/checkbox/dropdown/radio + tùy chọn flatten (khoá giá trị).
- [x] **T4.5** Validate headless API pdf-lib (drawRectangle/drawLine/embedPng/drawImage/copyPages/
  getForm + class field) trên đúng bản vendored — 12/12 pass. `convertToPdfPoint` có ở pdf.js 3.11.
- [ ] **T4.6** ▶️ Test GUI: bật Chỉnh sửa → thêm text/highlight/draw/ảnh/watermark/redact/form →
  Áp dụng → Lưu → mở lại kiểm tra; xác nhận redact xoá được text gốc (copy/search không ra).
- [ ] **T4.7** (đã biết) Text/ảnh trên trang **đã xoay** đặt đúng vị trí (anchor qua `convertToPdfPoint`)
  nhưng có thể lệch hướng; redact/highlight/draw đúng mọi góc xoay. Khuyến nghị annotate trước khi xoay.

## Ghi chú thực thi

- **Onedir, không onefile**: torch giải nén onefile rất chậm + dễ lỗi. Spec tạo `dist/sidecar/`.
- **PyInstaller sẽ lỗi `ModuleNotFoundError` vài vòng đầu** — đó là bình thường với torch/paddle.
  Đọc tên module thiếu → thêm vào `hiddenimports` trong `sidecar.spec`.
- **Console sidecar bật** ở P0 (`console=True`) để đọc log OCR khi debug; tắt ở P5.
- **Model weights** (VietOCR `vgg_transformer`, Paddle det/rec) tải về cache lần chạy đầu →
  máy sạch cần internet lần đầu. Task T0.11/P5 sẽ bundle sẵn cache cho offline tuyệt đối.
