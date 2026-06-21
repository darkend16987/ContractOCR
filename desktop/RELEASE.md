# Phát hành & Auto-update (OTA)

Auto-update dùng `electron-updater` với **GitHub Releases** làm kênh phân phối.
Chỉ bản **NSIS (cài đặt)** tự cập nhật; bản **portable .exe không tự update**
(người dùng tải tay bản mới).

## Cơ chế

- App đã cài kiểm tra update ~4 giây sau khi mở (`src/updater.js`).
- Nếu có bản mới → tải nền → hỏi "Khởi động lại & cập nhật / Để sau".
- Nếu chọn "Để sau" → bản mới tự cài khi thoát app.
- Dev và bản portable: tự động bỏ qua (no-op).

## Điều kiện để OTA hoạt động

electron-updater so sánh `version` trong `package.json` với file `latest.yml`
trên Release mới nhất. Mỗi Release **phải** có đủ:

- `NabuPDF-<ver>-x64.exe` (NSIS installer)
- `NabuPDF-<ver>-x64.exe.blockmap` (electron-builder sinh kèm — cho update vi sai)
- `latest.yml` (manifest electron-updater đọc)

> `publish` trong `electron-builder.yml` đã trỏ `darkend16987/ContractOCR` (slug repo
> GitHub vẫn là ContractOCR dù sản phẩm đổi tên Nabu PDF — đổi repo thì sửa lại đây).

## Quy trình cắt một bản phát hành

1. **Tăng version** trong `desktop/package.json` (vd `0.0.1` → `0.0.2`).
   Auto-update chỉ nhận ra bản mới khi version cao hơn.

2. **Build lại sidecar nếu code Python đổi** (xem HANDOFF — bẫy PyInstaller/venv):
   ```bash
   pnpm run build:sidecar
   ```

3. **Build + publish** (cần token GitHub có quyền `repo`):
   ```bash
   set GH_TOKEN=ghp_xxx          # PowerShell: $env:GH_TOKEN="ghp_xxx"
   pnpm run release              # build NSIS + portable, đẩy lên GitHub Releases
   ```
   Lệnh này tạo (hoặc cập nhật) một Release **draft** kèm `latest.yml`, `.exe`,
   `.blockmap`.

4. **Checksum** (vì chưa ký số) rồi đính kèm:
   ```bash
   pnpm run checksums            # dist-app/SHA256SUMS.txt
   ```
   Tải `SHA256SUMS.txt` lên cùng Release.

5. **Publish Release** trên GitHub (bỏ trạng thái draft). Từ lúc này, các máy đã
   cài bản cũ sẽ tự thấy bản mới ở lần mở app kế tiếp.

## Không có CI? Build tay vẫn được

Không bắt buộc GitHub Actions. Có thể bỏ qua `--publish always`, build cục bộ
(`pnpm run build`) rồi **tự kéo-thả** `latest.yml` + `.exe` + `.blockmap` +
`SHA256SUMS.txt` vào một Release tạo bằng tay. Miễn là 3 file đầu nằm trong
Release mới nhất, OTA vẫn chạy.

## Lưu ý khi chưa ký số

Bản OTA tải về vẫn **unsigned** → khi installer chạy lúc cập nhật, Windows có thể
lại hiện SmartScreen. Ký số (xem `SIGNING.md`) sẽ làm bước cập nhật mượt hoàn toàn.
