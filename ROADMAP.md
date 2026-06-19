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

## Ghi chú thực thi

- **Onedir, không onefile**: torch giải nén onefile rất chậm + dễ lỗi. Spec tạo `dist/sidecar/`.
- **PyInstaller sẽ lỗi `ModuleNotFoundError` vài vòng đầu** — đó là bình thường với torch/paddle.
  Đọc tên module thiếu → thêm vào `hiddenimports` trong `sidecar.spec`.
- **Console sidecar bật** ở P0 (`console=True`) để đọc log OCR khi debug; tắt ở P5.
- **Model weights** (VietOCR `vgg_transformer`, Paddle det/rec) tải về cache lần chạy đầu →
  máy sạch cần internet lần đầu. Task T0.11/P5 sẽ bundle sẵn cache cho offline tuyệt đối.
