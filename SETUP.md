# Setup trên máy mới (dev)

Hướng dẫn dựng lại môi trường dev đã được kiểm chứng (Windows). Xem kiến trúc ở
[DESIGN.md](DESIGN.md), tiến độ ở [ROADMAP.md](ROADMAP.md).

> ⚠️ Các phiên bản dưới đây KHÔNG tùy tiện đổi — chúng là bộ đã giải xong "dependency hell"
> (xem mục Gotcha). Đặc biệt: **Python 3.12** (không phải 3.13) và **paddle 3.x** (không phải 2.x).

## Yêu cầu máy

- **Python 3.12** (bắt buộc — 3.13 không cài được vietocr; 3.11 cũng chạy được nếu cần)
- **Node.js ≥ 20** + **pnpm ≥ 10**
- Git
- (Tùy chọn) Docker — không cần cho dev native

## 1. Python sidecar (OCR engine)

```powershell
# từ thư mục gốc repo
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-build.txt
```

Tải ~3GB (torch + paddlepaddle + paddlex). Lần chạy OCR đầu tiên sẽ tải thêm **model weights**
(PaddleOCR detection + VietOCR) về cache user (`~/.paddlex`, `~/.cache`) — cần internet lần đầu.

Tạo file `.env` ở gốc repo (xem `.env.example`), tối thiểu:

```
GEMINI_API_KEY=...        # cho bóc tách field (OCR thuần không cần)
OCR_ENGINE=hybrid
```

### Kiểm tra sidecar chạy

```powershell
.\.venv\Scripts\python.exe sidecar.py --port 8123
# mở tab khác: GET http://127.0.0.1:8123/health  -> {"status":"ok","engine":"hybrid"}
```

## 2. Electron desktop shell

```powershell
cd desktop
pnpm install          # tải Electron + pdf-lib/pdfjs-dist; postinstall vendor libs vào renderer/vendor/
pnpm start            # mở app: UI PDF hiện ngay; sidecar OCR boot ở nền (badge starting->ready)
```

Từ P1, **UI PDF (xem/ghép/tách/chèn/xoay/xóa/sắp xếp/lưu) chạy không cần Python** — sidecar OCR
là lazy. Máy chỉ có Python 3.13 (không có `.venv` 3.12): PDF vẫn chạy đủ, badge OCR sẽ báo `lỗi`.
Muốn dùng OCR thì dựng `.venv` 3.12 ở mục 1.

Nếu thiếu file trong `renderer/vendor/` (pdf-lib.min.js, pdf.min.js, pdf.worker.min.js), chạy lại
`pnpm run vendor`. Nếu `pnpm install` báo "Ignored build scripts: electron", chạy
`node node_modules/electron/install.js` một lần (file `pnpm-workspace.yaml` lẽ ra đã xử lý).

## 3. Đóng gói portable .exe (Phase 0 — T0.9/T0.10)

```powershell
cd desktop
pnpm run build:sidecar   # PyInstaller -> ../dist/sidecar/sidecar.exe (onedir)
#   iterate: chạy ../dist/sidecar/sidecar.exe --port 8000; nếu ModuleNotFoundError
#   thì thêm tên module vào extra_hiddenimports trong ../sidecar.spec rồi build lại
pnpm run build           # electron-builder -> desktop/dist-app/*-portable.exe
# test bản portable trên máy Windows sạch (không cài Python)
```

## Gotcha đã giải (đừng "sửa lại cho mới")

| Vấn đề | Nguyên nhân | Cách giải (đã áp dụng) |
|--------|------------|----------------------|
| Python 3.13 cài fail | vietocr ghim dep cũ thiếu wheel cp313 | Dùng **Python 3.12** |
| pnpm bỏ qua build Electron | pnpm 11 chặn script | `desktop/pnpm-workspace.yaml` (`allowBuilds`) |
| `import paddle 2.x` lỗi numpy ABI | paddle 2.x cần numpy 1.x ⟂ vietocr cần numpy 2.x | Dùng **paddle/paddleocr 3.x** (numpy 2.x) |
| torch `WinError 127 shm.dll` | paddle nạp DLL trước torch | `import torch` đầu `src/ocr/engine.py` |
| paddleocr API vỡ | 2.x→3.x đổi `predict()`, `dt_polys`, bỏ `show_log` | `engine.py` đã migrate |
| paddle 3.3 `ConvertPirAttribute...` | bug PIR+oneDNN | `enable_mkldnn=False` |

Tất cả fix code nằm trong `src/ocr/engine.py` và pin trong `requirements.txt`.
