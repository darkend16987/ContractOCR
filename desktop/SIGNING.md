# Ký số & SmartScreen

Hiện tại các bản build **chưa được ký số** (unsigned). Tài liệu này giải thích hệ
quả, cách người dùng vẫn cài được an toàn, và cách bật ký số sau này.

## Vì sao Windows cảnh báo?

Windows SmartScreen hiện hộp **"Windows protected your PC"** với mọi file `.exe`
chưa tích lũy đủ uy tín — **kể cả file đã ký bằng cert thường (OV)**. Đây là hành
vi bình thường với phần mềm mới, không phải app bị nhiễm.

## Cách người dùng cài (khi chưa ký)

1. Tải installer từ trang Releases.
2. (Khuyến nghị) Kiểm tra checksum — xem mục dưới.
3. Bấm đúp để chạy. Nếu hiện "Windows protected your PC":
   - Bấm **More info**
   - Bấm **Run anyway**
4. Cài/chạy như bình thường.

> Gợi ý đưa vào hướng dẫn người dùng cuối: kèm ảnh chụp 2 bước "More info → Run
> anyway" để người không rành kỹ thuật không hoang mang.

## Kiểm tra tính toàn vẹn (checksum)

Sau khi build, sinh checksum:

```bash
pnpm run checksums          # ghi dist-app/SHA256SUMS.txt
```

Đính kèm `SHA256SUMS.txt` vào mỗi GitHub Release. Người dùng đối chiếu trên máy họ:

```powershell
Get-FileHash .\NabuPDF-0.0.1-x64.exe -Algorithm SHA256
```

Giá trị trùng với dòng trong `SHA256SUMS.txt` ⇒ file tải về nguyên vẹn.

## Bật ký số sau này

Đã để sẵn chỗ cắm trong `electron-builder.yml` (mục `win:`, đang comment). Thứ tự
ưu tiên đề xuất:

### (A) Azure Trusted Signing — ~$10/tháng, gỡ SmartScreen nhanh, không cần token cứng
1. Tạo tài nguyên **Trusted Signing Account** trên Azure, xác minh danh tính
   (cá nhân hoặc tổ chức), tạo **Certificate Profile**.
2. Bỏ comment khối `azureSignOptions` trong `electron-builder.yml`, điền
   `publisherName / endpoint / certificateProfileName / codeSigningAccountName`.
3. Đăng nhập Azure CLI (hoặc đặt biến môi trường service principal) rồi build:
   `pnpm run build`. electron-builder sẽ ký qua dịch vụ cloud.

### (B) Cert truyền thống (EV/OV) qua file .pfx / token
1. Mua cert từ Sectigo/DigiCert… **EV** gỡ SmartScreen ngay (cần token cứng/HSM);
   **OV** rẻ hơn nhưng SmartScreen vẫn cảnh báo tới khi tích lũy uy tín.
2. Đặt biến môi trường khi build:
   ```bash
   set CSC_LINK=C:\path\to\cert.pfx
   set CSC_KEY_PASSWORD=••••••
   pnpm run build
   ```
   electron-builder tự ký từ `CSC_LINK` — không cần thêm khối config.

> **Auto-update:** một khi đã ký, các bản OTA tải về cũng được ký ⇒ không còn
> cảnh báo SmartScreen khi installer chạy lúc cập nhật.
