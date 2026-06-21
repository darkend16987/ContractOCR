# Nabu PDF — Hướng dẫn sử dụng

Bộ công cụ PDF chạy trên máy (xem · ghép · tách · xoay · khoanh vùng · ghi chú · watermark ·
redact · **sửa chữ gốc** · nén · tạo PDF tìm-kiếm-được · OCR + bóc tách hợp đồng). Toàn bộ xử lý
diễn ra **ngay trên máy bạn** — file PDF không bị gửi lên mạng (trừ tính năng "Bóc tách" dùng AI, xem mục 6).

---

## 1. Cần copy gì vào USB

Chỉ cần **một file duy nhất**, chọn 1 trong 2 kiểu:

| Kiểu | File copy vào USB | Dùng khi |
|------|-------------------|----------|
| **Bản chạy thẳng (khuyên dùng)** | `NabuPDF-0.0.1-portable.exe` (~407 MB) | Cắm USB, chạy luôn, không cài. Tiện mang đi nhiều máy. |
| **Bản cài đặt** | `NabuPDF-0.0.1-x64.exe` (~407 MB) | Cài cố định vào 1 máy (tạo shortcut, gỡ qua Control Panel). |

Hai file này nằm ở: `D:\GitHub\ContractOCR\desktop\dist-app\`

> **Không cần** copy thư mục `win-unpacked`, không cần cài Python, không cần `.venv`. Mọi thứ đã
> gói sẵn trong file `.exe`.

---

## 2. Cách chạy

### Cách A — Bản chạy thẳng (portable)
1. Copy `NabuPDF-0.0.1-portable.exe` vào USB (hoặc ổ cứng máy đích).
2. Nháy đúp để chạy. Lần đầu nó tự giải nén ra thư mục tạm (mất ~10–20 giây) rồi mở cửa sổ app.
3. Xong. Không để lại gì trên máy (ngoài cache model, xem mục 4).

### Cách B — Bản cài đặt (installer)
1. Copy `NabuPDF-0.0.1-x64.exe` vào máy đích.
2. Nháy đúp → chọn thư mục cài → Next → Install.
3. Chạy từ Start Menu / shortcut desktop. Gỡ qua **Settings → Apps** như phần mềm thường.

---

## 3. Lưu ý quan trọng lần chạy đầu trên máy mới

1. **Cảnh báo SmartScreen / Windows Defender** — vì app **chưa ký số** (chưa mua chứng chỉ), Windows
   có thể hiện "Windows protected your PC". Bấm **More info → Run anyway** (Thêm thông tin → Vẫn chạy).
   Đây là cảnh báo bình thường cho phần mềm tự đóng gói, không phải virus.

2. **Engine OCR khởi động chậm lần đầu** — góc phải app có badge **"OCR: …"**. App PDF dùng được
   **ngay lập tức**, nhưng engine OCR (chạy ngầm) cần ~10–40 giây để tải xong. Khi badge chuyển
   **"OCR: sẵn sàng"** thì các nút Searchable / Bóc tách mới bật.

3. **Lần OCR đầu tiên cần Internet** — model nhận dạng chữ (PaddleOCR + VietOCR) **không** nằm trong
   file `.exe`; lần đầu dùng OCR/Searchable/Bóc tách trên một máy mới, chúng tự tải về (~vài trăm MB)
   và lưu vào cache của máy đó. **Các lần sau chạy offline bình thường.**
   → Mẹo: nếu máy đích không có mạng, hãy mở app + chạy thử OCR 1 lần ở nơi **có mạng** trước, để nó
   tải model; sau đó mang sang chỗ không mạng vẫn dùng được.

---

## 4. Tính năng nào chạy offline, tính năng nào cần mạng

| Nhóm tính năng | Cần mạng? | Ghi chú |
|----------------|-----------|---------|
| Xem · ghép · tách · chèn · xoay · xóa · sắp xếp · **Lưu** | ❌ Không | Chạy hoàn toàn offline, không cần engine OCR. |
| Chỉnh sửa overlay: chú thích, khoanh vùng, ghi chú, watermark, redact, điền form | ❌ Không | Offline. |
| **Sửa chữ gốc** · **Nén PDF** | ❌ Không | Offline (dùng thư viện PDF gói sẵn). |
| **Searchable** (PDF tìm-kiếm-được) | ⚠️ Lần đầu | Cần engine OCR; lần đầu/máy mới tải model (mục 3.3). |
| **Bóc tách** hợp đồng (OCR + AI) | ✅ Có | Cần model OCR **và** key AI (mục 6). |

Cache model lưu ở: `C:\Users\<tên-bạn>\.paddlex` (và `.cache`). Xóa được nếu cần giải phóng ổ; lần
sau dùng OCR sẽ tải lại.

---

## 5. "Sửa chữ gốc" dùng được với loại PDF nào

- ✅ **PDF có chữ thật** (xuất từ Word/Excel, in-ra-PDF): bấm **"Sửa chữ"** → các đoạn chữ hiện viền
  bấm được → sửa trực tiếp (kể cả tiếng Việt có dấu) → **Áp dụng** → **Lưu**. Chữ cũ bị xóa thật,
  chữ mới thay đúng chỗ.
- ❌ **PDF scan (ảnh chụp/scan giấy)**: không có ký tự để sửa. App sẽ báo *"trang này là ảnh scan,
  không có chữ để sửa"* → hãy dùng **Searchable** hoặc **Bóc tách** thay thế.

Giới hạn đã biết: sửa trong phạm vi từng đoạn (không tự dàn lại dòng); chữ dài hơn ô cũ sẽ tự co nhỏ;
font có thể hơi khác nếu file gốc dùng font đặc biệt.

---

## 6. Tính năng "Bóc tách" (OCR + AI) — nhập API key trong app

"Bóc tách" tự đọc hợp đồng và rút các trường (số HĐ, ngày, bên A/B…) bằng AI Google Gemini, nên cần
**API key**. Đây là tính năng **duy nhất** gửi nội dung lên dịch vụ ngoài.

Nhập key **ngay trong app**, không cần đụng tới file hay biến môi trường:

1. Mở app → bấm nút **⚙** (góc phải, cạnh badge OCR).
2. **Dán** API key vào ô → bấm **Lưu**.
3. Xong. Key được lưu an toàn trên máy này (`%LOCALAPPDATA%\Nabu PDF\settings.json`), **lần sau
   không phải nhập lại**. Đổi key thì mở lại ⚙ và dán key mới.

> Chưa có key? Lấy miễn phí tại **aistudio.google.com/apikey**.
> Không nhập key thì các tính năng PDF + OCR + Searchable vẫn chạy bình thường; chỉ "Bóc tách" mới cần.

---

## 7. Khắc phục sự cố thường gặp

| Hiện tượng | Cách xử lý |
|-----------|-----------|
| Badge kẹt ở "OCR: …" mãi không sẵn sàng | Lần đầu đang tải model (cần mạng) — chờ; hoặc máy đang tải xong. Nếu sau vài phút vẫn lỗi → kiểm tra mạng. |
| "OCR: lỗi" | Thường do lần đầu không có mạng để tải model, hoặc thiếu RAM. Nối mạng rồi mở lại app. |
| SmartScreen chặn | More info → Run anyway (mục 3.1). |
| Bóc tách báo thiếu key | Bấm ⚙ → dán API key → Lưu (mục 6). |
| App mở chậm lần đầu | Bình thường — portable giải nén + engine OCR tải ngầm. Lần sau nhanh hơn. |
| Máy yếu, OCR chậm | Engine chạy trên CPU; PDF nhiều trang sẽ lâu. Các thao tác PDF thường (xem/ghép/sửa chữ) vẫn nhanh. |

---

## 8. Yêu cầu máy đích

- Windows 10/11 **64-bit**.
- ~2 GB trống cho app (portable giải nén tạm) + ~1 GB cho cache model (lần đầu OCR).
- Khuyến nghị ≥ 8 GB RAM để OCR mượt.
- Internet cho **lần đầu** dùng OCR (và mỗi lần dùng "Bóc tách").

---

*Phiên bản: 0.0.1 · Đóng gói portable + installer cho Windows x64.*
