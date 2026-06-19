# ContractOCR Desktop (Phase 0)

Vỏ Electron + Python sidecar (FastAPI OCR). Xem [../DESIGN.md](../DESIGN.md) và
[../ROADMAP.md](../ROADMAP.md).

## Kiến trúc nhanh

- `src/main.js` — Electron main: chọn port trống → spawn sidecar → poll `/health` → load UI.
- `src/sidecar.js` — spawn `python sidecar.py` (dev) hoặc `sidecar.exe` (đóng gói) + health check.
- `src/preload.js` — đưa base URL của sidecar vào renderer an toàn (`window.sidecar`).
- `renderer/` — UI P0 tối giản (test `/health` + OCR 1 ảnh).
- Sidecar Python: `../sidecar.py` (chạy `app` từ `../api.py`), đóng gói bằng `../sidecar.spec`.

## Chạy ở chế độ dev (chưa freeze Python)

Cần Python env đã cài `requirements.txt` và đặt `GEMINI_API_KEY` trong `../.env`.

```bash
# từ thư mục gốc repo
pip install -r requirements.txt -r requirements-build.txt

# từ thư mục desktop/
npm install
npm start        # Electron spawn `python ../sidecar.py --port <port động>`
```

## Đóng gói portable .exe

```bash
# 1) Freeze sidecar Python → ../dist/sidecar/sidecar.exe (onedir)
npm run build:sidecar
#    Iterate: chạy `../dist/sidecar/sidecar.exe --port 8000`, nếu ModuleNotFoundError
#    thì thêm module vào `extra_hiddenimports` trong ../sidecar.spec rồi build lại.

# 2) Đóng Electron + bundle sidecar → desktop/dist-app/
npm run build    # tạo ContractOCR-<ver>-portable.exe và bản nsis

# 3) Test bản portable trên MÁY WINDOWS SẠCH (không cài Python).
```

## Lưu ý

- Lần chạy đầu sidecar tải model weights (VietOCR/Paddle) về cache → cần internet 1 lần.
  Để offline tuyệt đối, bundle sẵn cache (task P5).
- Console sidecar đang bật (`console=True` trong spec) để debug; tắt khi phát hành.
