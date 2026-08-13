# Nabu PDF Desktop

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

## Đóng gói bản cài đặt (.exe)

```bash
# 1) Freeze sidecar Python → ../dist/sidecar/sidecar.exe (onedir)
npm run build:sidecar
#    Iterate: chạy `../dist/sidecar/sidecar.exe --port 8000`, nếu ModuleNotFoundError
#    thì thêm module vào `extra_hiddenimports` trong ../sidecar.spec rồi build lại.

# 2) Đóng Electron + bundle sidecar → desktop/dist-app/
npm run build    # tạo NabuPDF-<ver>-x64.exe (NSIS) — không còn build bản portable

# 3) Test bản cài đặt trên MÁY WINDOWS SẠCH (không cài Python).
```

> **Trình cài đặt có ghi registry.** `build/installer.nsh` (khai trong `nsis.include`) thêm
> verb chuột phải **"Gộp bằng Nabu PDF"** cho file `.pdf` lúc cài và **xoá** lúc gỡ. Nó
> **không** chạy ở dev, nên `npm start` sẽ không có verb — chỉ bản đã cài mới có. Sau khi cài,
> kiểm bằng:
>
> ```
> reg query "HKCU\Software\Classes\SystemFileAssociations\.pdf\shell\NabuCombine" /s
> ```
>
> Phải thấy `MUIVerb` (tiếng Việt đúng, **không** mojibake — nếu sai thì `installer.nsh` mất
> BOM UTF-8), `MultiSelectModel=Player`, và `command` trỏ đúng exe. Nửa runtime nằm ở
> `src/shell-combine.js`; lưới là `npm run test:combine`. Ràng buộc đầy đủ: `docs/REGRESSION-GUARD.md`
> **BI-62**.

## Lưu ý

- Lần chạy đầu sidecar tải model weights (VietOCR/Paddle) về cache → cần internet 1 lần.
  Để offline tuyệt đối, bundle sẵn cache (task P5).
- Console sidecar đang bật (`console=True` trong spec) để debug; tắt khi phát hành.
