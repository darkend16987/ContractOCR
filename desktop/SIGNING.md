# Ký số & SmartScreen

Các bản build hiện **chưa được ký số**. Tài liệu này nói rõ ký số *thật sự* mua được
gì (và **không** mua được gì), các đường đi khả thi **cho một đơn vị ở Việt Nam**, và
cách bật khi đã có chứng chỉ.

> Rà soát lại 2026-07-26. Bản trước của tài liệu này nói “**EV** gỡ SmartScreen ngay”
> và xếp Azure Trusted Signing là lựa chọn số 1 — **cả hai nay đều sai**, và một trong
> hai đường đó **không mở cho Việt Nam**. Chi tiết bên dưới.

---

## 1. Sự thật cần nắm trước khi tiêu tiền

**Không có loại chứng chỉ nào gỡ được cảnh báo SmartScreen ngay lập tức.** Microsoft
ghi thẳng trong tài liệu dành cho lập trình viên (cập nhật 2026-05-04):

> *“EV certificates no longer bypass SmartScreen. … Paying a premium for EV solely to
> avoid SmartScreen warnings is no longer justified.”*
> — [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

Bảng hành vi lần tải đầu tiên, theo chính tài liệu đó:

| Cách phát hành | Lần tải đầu |
|---|---|
| **Microsoft Store** | ✅ Không cảnh báo — Microsoft ký lại |
| Ký bằng chứng chỉ hợp lệ (OV **hoặc** EV) | ⚠️ Vẫn cảnh báo tới khi tích luỹ uy tín — nhưng **hiện đúng tên nhà phát hành** |
| Không ký / tự ký | ⚠️ “Windows protected your PC”, phải bấm *Run anyway* |

Uy tín tích luỹ **tự động theo lượt tải sạch**, mất *vài tuần và hàng trăm lượt cài*,
và **không có cơ chế nộp đơn xin duyệt** cho máy người dùng thường.

### Vậy ký số để làm gì?

Ba lợi ích thật, đều đáng tiền, chỉ là không phải “hết cảnh báo ngay”:

1. **Uy tín cộng dồn qua các bản phát hành.** File **không ký** phải xây lại uy tín
   **từ số 0 cho mỗi phiên bản** — với nhịp OTA của dự án này thì gần như vĩnh viễn
   không thoát cảnh báo. File ký bằng **cùng một danh tính** thì uy tín chuyển tiếp
   được. Đây là lý do mạnh nhất.
2. **Hiện đúng tên nhà phát hành** thay vì “Unknown publisher” — khác biệt lớn về
   cảm nhận, nhất là với khách doanh nghiệp.
3. **Smart App Control** (Windows 11) **chặn thẳng** file không ký, không cho bấm
   “Run anyway” như SmartScreen. Máy nào bật tính năng này thì bản không ký là
   **không chạy được**, chứ không phải “cảnh báo rồi vẫn chạy”.

---

## 2. Chặn đường: Azure Artifact Signing **không mở cho Việt Nam**

Azure Trusted Signing (đổi tên thành **Azure Artifact Signing** năm 2026, ~10 USD/tháng,
không cần token cứng) là lựa chọn rẻ và hợp CI/CD nhất — nhưng bị giới hạn địa lý:

> *“Public Trust certificates are available to organizations in the United States,
> Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan,
> South Korea, Singapore, Switzerland, Norway, and Israel. **Individual developers must
> be located in the United States or Canada.**”*
> — [Quickstart: Set up Artifact Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart)

**Việt Nam không có trong cả hai danh sách** ⇒ pháp nhân Việt Nam **không đăng ký được**
Public Trust của dịch vụ này. Khối `azureSignOptions` trong `electron-builder.yml` giữ
lại chỉ để dùng khi nào có pháp nhân ở vùng được hỗ trợ. Đừng mất thời gian thử trước
khi giải quyết được chuyện pháp nhân.

---

## 3. Các đường đi khả thi, xếp theo khuyến nghị

### (A) Chứng chỉ OV từ CA thương mại + cloud HSM — **khuyến nghị**

CA thương mại (Sectigo, DigiCert, SSL.com, GlobalSign) **có** cấp cho pháp nhân Việt Nam.

Từ tháng 6/2023, quy định CA/Browser Forum bắt buộc khoá riêng nằm trên phần cứng đạt
**FIPS 140-2 Level 2** trở lên ⇒ **không còn CA nào giao file `.pfx` trần**. Hai cách nhận khoá:

| Cách | Ưu | Nhược |
|---|---|---|
| **Token USB** gửi về VN | Rẻ hơn | Phải cắm token vào máy build ⇒ **không tự động hoá được**, hỏng/mất là kẹt |
| **Cloud HSM** (DigiCert KeyLocker · SSL.com eSigner · Sectigo cloud signing) | Ký được từ CI, không phụ thuộc máy vật lý | Đắt hơn, thêm một nhà cung cấp phải tin |

Với dự án này, **cloud HSM đáng hơn**: quy trình phát hành đã tự động
(`npm run release` → GitHub Releases → OTA), cắm token thủ công sẽ phá vỡ nó.

**Chọn OV, không phải EV.** EV đắt hơn đáng kể mà **không** còn ưu thế nào về
SmartScreen (mục 1). Chỉ chọn EV nếu khách doanh nghiệp *yêu cầu bằng văn bản*.

⚠️ Từ **2026-03-01**, chứng chỉ tin cậy công cộng có hạn tối đa **460 ngày** (~15 tháng)
— tính chi phí gia hạn theo chu kỳ đó, đừng tính theo 3 năm như trước.

⚠️ **Đổi chứng chỉ = mất uy tín đã tích luỹ.** Uy tín gắn với danh tính ký, nên mỗi lần
gia hạn/đổi CA là một lần rủi ro quay lại vạch xuất phát ⇒ chọn xong thì bám lấy.

### (B) Microsoft Store — **cách duy nhất hết cảnh báo hoàn toàn**

App phát hành qua Store được **Microsoft ký lại**, không bao giờ hiện cảnh báo.
electron-builder có target `appx`. Nhưng phải khảo sát trước, không hiển nhiên chạy được:

- sidecar Python (`sidecar.exe`, PyInstaller onedir) chạy trong container MSIX;
- cache trọng số OCR tải về lần đầu (vài trăm MB) ghi vào thư mục user;
- helper `.NET` gọi Windows cert store để ký PDF bằng USB token của người dùng —
  đây là chỗ dễ vướng chính sách Store nhất;
- OTA tự cập nhật phải nhường cho cơ chế cập nhật của Store.

Xứng đáng làm một spike riêng. Không phải việc cấu hình một buổi.

### (C) Giữ nguyên: không ký + checksum — **hiện tại**

Chấp nhận được lúc này, nhưng nhớ cái giá ở mục 1: uy tín **không bao giờ** tích luỹ vì
mỗi bản phát hành là một file mới không ký, và máy bật Smart App Control thì **không
chạy được**.

---

## 4. Cách người dùng cài khi chưa ký

1. Tải installer từ trang Releases.
2. (Khuyến nghị) Đối chiếu checksum — xem mục 6.
3. Bấm đúp. Nếu hiện “Windows protected your PC”: bấm **More info** → **Run anyway**.

> Nên kèm ảnh chụp hai bước này trong tài liệu hướng dẫn người dùng cuối.

---

## 5. Bật ký số khi đã có chứng chỉ

Đã kiểm chứng trên **electron-builder 25.1.8** đang khoá trong `pnpm-lock.yaml`
(đọc trực tiếp schema ở `app-builder-lib/out/options/winOptions.d.ts` và phần cài đặt
ở `out/codeSign/windowsSignAzureManager.js`).

### (A) Chứng chỉ OV/EV — token hoặc cloud HSM

Đường qua biến môi trường, **không cần thêm khối cấu hình nào**:

```bash
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=...
pnpm run build
```

Với **cloud HSM** thì không có `.pfx`; nhà cung cấp đưa một `signtool` thay thế hoặc một
CSP/KSP. Lúc đó dùng `win.signtoolOptions.sign` trỏ tới module ký tuỳ biến. Lưu ý các
trường `win.certificateFile` / `win.publisherName`… ở **cấp trên cùng đã bị đánh dấu
deprecated** ở v25 — dùng `win.signtoolOptions.<field>`.

### (B) Azure Artifact Signing — *chỉ khi có pháp nhân ở vùng được hỗ trợ*

```yaml
win:
  azureSignOptions:
    endpoint: https://eus.codesigning.azure.net   # phải khớp region của tài khoản
    certificateProfileName: <profile>
    codeSigningAccountName: <account>
```

Ba điểm mà bản trước của tài liệu này ghi sai:

1. **Không có trường `publisherName`** trong `azureSignOptions`. Schema chỉ nhận
   `endpoint` / `certificateProfileName` / `codeSigningAccountName`; **mọi khoá lạ được
   truyền thẳng thành tham số CLI cho `Invoke-TrustedSigning`** ⇒ thừa một khoá là hỏng
   lệnh ký. (`publisherName` thuộc `signtoolOptions`, tức đường signtool.)
2. **`az login` là KHÔNG đủ.** electron-builder xác thực bằng `EnvironmentCredential`,
   tức đọc **biến môi trường**: bắt buộc `AZURE_TENANT_ID` + `AZURE_CLIENT_ID`, kèm
   **một trong** `AZURE_CLIENT_SECRET` · `AZURE_CLIENT_CERTIFICATE_PATH` ·
   `AZURE_USERNAME`+`AZURE_PASSWORD`. Thiếu là fail ngay lúc khởi tạo.
3. Lúc ký, electron-builder **tự cài module PowerShell** `TrustedSigning` phiên bản
   `0.4.1` từ PSGallery (`-Scope CurrentUser`), có thể kèm `Install-PackageProvider NuGet`.
   Máy build phải ra được PSGallery. (Dự án này đã từng vấp chuyện quyền lúc đóng gói —
   xem bẫy `winCodeSign` trong `HANDOFF.md`.)

### Sau khi ký

Bản OTA tải về cũng được ký ⇒ uy tín cộng dồn đúng như mục 1.3. **Đừng sửa file sau khi
ký** — chữ ký hỏng là mất trắng phần uy tín của file đó.

---

## 6. Kiểm tra tính toàn vẹn (checksum)

```bash
pnpm run checksums          # ghi dist-app/SHA256SUMS.txt
```

Đính `SHA256SUMS.txt` vào mỗi GitHub Release. Người dùng đối chiếu:

```powershell
Get-FileHash .\NabuPDF-0.2.43-x64.exe -Algorithm SHA256
```

Giá trị trùng với dòng trong `SHA256SUMS.txt` ⇒ file tải về nguyên vẹn.

---

## 7. Việc cần quyết

1. **Pháp nhân ký dưới tên ai?** Tên trong chứng chỉ chính là tên hiện trong hộp thoại
   SmartScreen, và **đổi về sau là mất uy tín**. Quyết trước khi mua.
2. **Token hay cloud HSM?** Cloud HSM giữ được quy trình phát hành tự động hiện có.
3. **Có làm spike Microsoft Store không?** Đây là cách duy nhất *thật sự* hết cảnh báo;
   ba rủi ro kỹ thuật đã liệt ở mục 3(B).
