# Phát hành & Auto-update (OTA)

Auto-update dùng `electron-updater` với **GitHub Releases** làm kênh phân phối.
Chỉ bản **NSIS (cài đặt)** tự cập nhật. Từ nay chỉ build & phát hành bản NSIS —
không còn build bản portable .exe nữa (các bản portable đã phát hành trước đây
vẫn chạy được nhưng không tự cập nhật; người dùng cần tải tay bản cài đặt mới).

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

> `publish` trong `electron-builder.yml` trỏ **`darkend16987/NabuPDF-Releases`**
> (đổi từ `darkend16987/NabuPDF` ở v0.2.63 — repo mã nguồn và repo phát hành tách đôi).
>
> **Máy đã cài bản cũ vẫn hỏi repo CŨ.** `app-update.yml` được electron-builder ghi vào
> *bên trong* bộ cài, nên bản v0.2.62 đã cài trên máy người dùng sẽ mãi mãi kiểm tra
> `darkend16987/NabuPDF` — không có cách nào báo cho nó biết. Vì vậy **v0.2.63 được phát
> hành lên CẢ HAI repo**: repo cũ nhận đúng một lần để những máy đó nhảy sang được (bản
> 0.2.63 chúng tải về đã trỏ repo mới), từ v0.2.64 trở đi chỉ phát hành ở repo mới.
> Đăng thiếu repo cũ = toàn bộ máy đang cài **im lặng** ngừng nhận cập nhật.

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
   pnpm run release              # build NSIS, đẩy lên GitHub Releases
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
