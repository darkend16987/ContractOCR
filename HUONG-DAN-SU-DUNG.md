# Nabu PDF — Hướng dẫn sử dụng

Bộ công cụ PDF chạy trên máy (xem · ghép · tách · xoay · khoanh vùng · mũi tên · ghi chú · watermark ·
redact · **sửa chữ gốc** · nén · so sánh & **chồng lớp bản vẽ** · tạo PDF tìm-kiếm-được · OCR + bóc tách hợp đồng). Toàn bộ xử lý
diễn ra **ngay trên máy bạn** — file PDF không bị gửi lên mạng (trừ tính năng "Bóc tách" dùng AI, xem mục 6).

---

## 1. Cần copy gì vào USB

Chỉ cần **một file duy nhất**:

| Kiểu | File tải về | Dùng khi |
|------|-------------|----------|
| **Bản cài đặt** | `NabuPDF-0.2.51-x64.exe` (~455 MB) | Cài vào máy (tạo shortcut, gỡ qua Control Panel), **tự cập nhật** khi có bản mới. |

> **Từ v0.2.48 không còn bản portable.** Các bản trước có
> `NabuPDF-<ver>-portable.exe`; nó đã bị bỏ khỏi quy trình đóng gói vì bản cài đặt tự
> cập nhật được (OTA) còn portable thì không, nên người dùng portable cứ mắc ở bản cũ.
> Nếu bạn đang dùng portable: tải bản cài đặt ở trên, nó sẽ tự cập nhật từ nay.

**Tải ở đâu:** trang phát hành — <https://github.com/darkend16987/NabuPDF/releases/latest>
(kèm `SHA256SUMS.txt` để đối chiếu file tải về nếu cần).

> Nếu bạn tự build trên máy phát triển thì file nằm ở `desktop\dist-app\` trong thư mục dự án.

> **Không cần** copy thư mục `win-unpacked`, không cần cài Python, không cần `.venv`. Mọi thứ đã
> gói sẵn trong file `.exe`.

---

## 2. Cách chạy

1. Copy `NabuPDF-0.2.51-x64.exe` vào máy đích.
2. Nháy đúp → chọn thư mục cài → Next → Install.
3. Chạy từ Start Menu / shortcut desktop. Gỡ qua **Settings → Apps** như phần mềm thường.
4. Các bản sau app **tự tải và tự cập nhật**, không phải làm lại bước 1–3.

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
| Chỉnh sửa overlay: chú thích, khoanh vùng, mũi tên (kèm nhãn), ghi chú (kèm bình luận), watermark, redact, điền form | ❌ Không | Offline. |
| **Sửa chữ gốc** · **Nén PDF** | ❌ Không | Offline (dùng thư viện PDF gói sẵn). |
| **So sánh** 2 PDF · **So sánh & Chồng lớp bản vẽ** (CAD/Revit) | ⚠️ Cần engine | Cần engine bật (badge OCR). Bản vẽ chạy offline; PDF scan cần tải model OCR như mục 3.3. |
| **Chuyển đổi**: Khoá file (đặt mật khẩu) · Xuất ảnh trong PDF · Trang PDF → ảnh · Ảnh → PDF | ❌ Không | Offline (thư viện PDF gói sẵn). Gom trong nút **Chuyển đổi** trên thanh công cụ + menu "Chuyển đổi". |
| **Searchable** (PDF tìm-kiếm-được) | ⚠️ Lần đầu | Cần engine OCR; lần đầu/máy mới tải model (mục 3.3). |
| **Bóc tách** hợp đồng (OCR + AI) | ✅ Có | Cần model OCR **và** key AI (mục 6). |

> 💡 **Mẹo kéo–thả ở cột trang (thumbnail):**
> - **Sắp xếp trang:** kéo một trang thả lên trang khác để đổi vị trí.
> - **Chèn file PDF bằng kéo–thả:** kéo file `.pdf` từ Windows thả vào **khe giữa hai trang** ở cột
>   thumbnail — trang sẽ được chèn ngay tại vị trí đó (thả vào nửa trên = chèn phía trước trang, nửa
>   dưới = chèn phía sau). Thả nhiều file cùng lúc cũng được. Không cần mở hộp thoại chọn vị trí.
> - Vẫn dùng được nút **Chèn / Ghép** với hộp thoại chọn vị trí như cũ; kéo–thả chỉ là lối tắt.

> ⌨️ **Menu & phím tắt** (thanh menu trên cùng: Tập tin · Chỉnh sửa · Trang · Chuyển đổi · Hiển thị · Trợ giúp):
> - **Ctrl+O** Mở · **Ctrl+S** Lưu · **Ctrl+Shift+S** Lưu thành…
>   (Ctrl+S ghi đè thẳng vào file đang mở; file kéo–thả/chưa lưu thì hỏi nơi lưu.)
> - **Ctrl+Z** Hoàn tác · **Ctrl+Y** Làm lại.
> - **Ctrl + / Ctrl − / Ctrl 0** Phóng to / Thu nhỏ / Cỡ gốc 100%.
> - **Ctrl + lăn chuột** phóng to/thu nhỏ **bám theo con trỏ**. Trang bám tay ngay lập tức (hơi mềm
>   một nhịp) rồi **tự làm nét khi bạn dừng lại** — đó là cách Acrobat/Foxit làm, và là lý do zoom
>   không còn giật từng nấc.
> - **Vừa bề ngang / Vừa chiều dọc** (nút cạnh ô zoom) — "Vừa chiều dọc" hợp văn bản khổ ngang (landscape).
> - **↑ / ↓** (ở cửa sổ xem trang) nhảy sang trang trước / trang kế.
> - **Delete** Xóa trang đang chọn.
>
> 💡 **Cột trang chạy theo bạn:** cuộn tài liệu tới đâu, thumbnail trang đó **sáng lên** (số trang đổi
> màu) và cột trang **tự trượt** để trang đó luôn nằm trong khung nhìn. Đây chỉ là dấu "bạn đang ở đây"
> — nó **không** đổi các trang bạn đã tick chọn, nên Xoá/Tách trang vẫn nhắm đúng những trang bạn chọn.

> 🖨️ **In tài liệu (Ctrl+P):**
> - **Chọn trang ngay trong hộp thoại của Nabu** — ô **"Trang cần in"**: gõ `1-2`, `1-3, 5, 8-10`…
>   **Để trống là in tất cả.** Dòng chữ ngay dưới ô luôn cho bạn xem trước *"Sẽ in mấy trang, những
>   trang nào"* trước khi bấm In, và nút **In** tự khoá nếu không nhận ra trang nào.
> - **Nên dùng ô này thay vì mở hộp thoại của hệ thống để chọn trang.** Khoảng trang trong hộp thoại
>   của Windows đếm theo **TỜ giấy in ra**, còn ô của Nabu đếm theo **trang tài liệu** — với tài liệu
>   thường thì hai cách ra cùng kết quả, nhưng ô của Nabu luôn đúng ý bạn hơn.
> - **Mỗi trang tài liệu luôn in gọn trong đúng một tờ giấy**, ở mọi khổ (A4 → A0, Letter, Legal) và
>   giữ nguyên tỷ lệ — không bao giờ bị đẩy phần dưới sang tờ sau, không bị cắt, không bị kéo méo.
>   Nếu khổ giấy có tỷ lệ khác trang tài liệu thì phần chênh là **dải trắng** ở hai mép.
> - Tài liệu có **cả trang dọc và trang ngang** vẫn in đúng — mỗi trang một tờ. Trang ngang nằm gọn
>   giữa tờ giấy dọc (nên nhỏ hơn); muốn nó lấp trọn tờ giấy thì chọn **Hướng giấy → Ngang** cho các
>   trang đó, hoặc tách chúng ra in riêng.

Cache model lưu ở: `C:\Users\<tên-bạn>\.paddlex` (và `.cache`). Xóa được nếu cần giải phóng ổ; lần
sau dùng OCR sẽ tải lại.

---

## 5. "Sửa chữ gốc" dùng được với loại PDF nào

- ✅ **PDF có chữ thật** (xuất từ Word/Excel, in-ra-PDF): bấm **"Sửa chữ"** → các đoạn chữ hiện viền
  bấm được → sửa trực tiếp (kể cả tiếng Việt có dấu) → **Áp dụng** → **Lưu**. Chữ cũ bị xóa thật,
  chữ mới thay đúng chỗ.
- ❌ **PDF scan (ảnh chụp/scan giấy)**: không có ký tự để sửa. App sẽ báo *"trang này là ảnh scan,
  không có chữ để sửa"* → hãy dùng **Searchable** hoặc **Bóc tách** thay thế.

> **Chọn font khi sửa:** ô **Font** có **"Giữ nguyên (font gốc)"** (mặc định — giữ đúng font của đoạn
> đang sửa) và nhóm **"Font máy"** liệt kê font cài trên máy. Chọn font máy → chữ sửa dùng đúng font đó.

Giới hạn đã biết: sửa trong phạm vi từng đoạn (không tự dàn lại dòng); chữ dài hơn ô cũ sẽ tự co nhỏ.

> **Chèn chữ ký:** dùng nút **Chèn ảnh / chữ ký** → chọn ảnh chữ ký rồi bấm lên trang để đặt.
> Nên dùng **PNG nền trong** để chữ ký không có hộp trắng đè lên tài liệu (ảnh JPG có nền đặc — app sẽ
> nhắc). Chỉ nhận **PNG / JPG**.
> ⚠️ Đây là **dán ảnh chữ ký**, không phải **chữ ký số** (digital signature có chứng thư CA). App
> hiện chưa hỗ trợ chữ ký số pháp lý.

> **Ảnh vẫn sửa lại được sau khi Lưu:** giống hộp văn bản và ghi chú, ảnh/chữ ký bạn chèn **không bị
> "dán chết"** vào trang. Mở lại file → bấm **Chỉnh sửa** → ảnh lại là một đối tượng riêng: kéo để
> **di chuyển**, kéo **4 góc** để **đổi cỡ**, **Delete** để **xoá**, và vẫn dùng được **"Áp ảnh/chữ ký
> cho nhiều trang"**.
> - **Giữ Shift** khi kéo góc → co giãn **đúng tỷ lệ** (không bị méo). Áp dụng cho cả khoanh vùng
>   chữ nhật/elip, tô sáng và ô che (redact).
> - Ngoại lệ: trang **đã bị xoay** (PDF có `/Rotate`, thường gặp ở bản scan) thì ảnh vẫn dán chết như
>   trước — giống hộp văn bản và mũi tên trên trang xoay.
> - Ảnh chèn ở các bản **trước v0.2.48** đã dán chết rồi thì không lấy lại được thành đối tượng; chỉ
>   ảnh chèn từ bản này trở đi mới sửa lại được.

> **Mũi tên kèm nhãn:** chọn công cụ **Mũi tên**, kéo để vẽ — thả ra là hiện ô nhập chữ ngay ở **đầu mũi tên**
> (gõ nhãn rồi Enter, bỏ trống/Esc nếu không cần). Muốn sửa nhãn sau: **bấm đúp** vào mũi tên.

> **Vẽ tay thành đoạn thẳng (giữ Shift):** chọn công cụ **Vẽ tay** (phím `D`), giữ chuột kéo như thường.
> Muốn một đoạn **thẳng** thì **giữ thêm Shift** — đoạn đang vẽ duỗi thẳng từ chỗ bạn nhấn Shift tới con
> trỏ, rê chuột để chỉnh hướng và độ dài. **Thả Shift ra là vẽ tay tiếp** từ đúng đầu mút đó, nên một nét
> có thể vừa có đoạn thẳng vừa có đoạn nguệch ngoạc. Tiện để gạch chân một dòng hợp đồng hay kẻ một đường
> dẫn thẳng mà không phải đổi công cụ.

> **Dấu ✓ và ✗:** hai công cụ riêng trên thanh chú thích (phím `K` cho ✓, `J` cho ✗) — chỉ là **ký hiệu**,
> không kèm ô vuông, nên tích thẳng vào ô checkbox có sẵn trong hợp đồng được.
> - **Bấm một cái** → ra dấu **cỡ mặc định** ngay tại chỗ bấm (bấm sát mép trang thì dấu tự lùi vào cho
>   nằm trọn trong trang). **Kéo** → tự chọn cỡ.
> - Đổi **Màu** và **Nét** (độ dày) như các công cụ vẽ khác. Mỗi loại **nhớ màu riêng** — mặc định ✓ xanh
>   lá, ✗ đỏ — nên đổi màu dấu ✗ không làm đổi màu bút tô sáng hay vẽ tay.
> - Đã đặt rồi vẫn **chọn / kéo di chuyển / kéo 4 góc đổi cỡ** được (giữ Shift để giữ đúng tỷ lệ), và
>   **Ctrl+Z** hoàn tác được.
> - Lưu ý: sau khi bấm **Xong**, dấu ✓/✗ được **dán chết** vào trang (như vẽ tay và khoanh vùng) — không
>   sửa lại được như hộp văn bản, ghi chú hay ảnh.

> **Ghi chú dạng chuỗi (thêm bình luận vào ghi chú):** bấm đúp một ghi chú 💬 để mở bảng — phần trên là
> nội dung gốc + các bình luận đã có (chỉ đọc), ô dưới để **Thêm bình luận** (không xoá nội dung cũ). Nút
> **Sửa gốc** để chỉnh nội dung gốc. Marker hiện **số bình luận**. Khi Lưu, cả chuỗi được gộp vào ghi chú
> của PDF (mọi trình xem đọc được).

> **So sánh & Chồng lớp 2 bản vẽ:** nút **So sánh** → chọn 2 file → chế độ:
> - **Bản vẽ**: đặt cạnh nhau, khoanh vùng thêm/xoá/sửa (xuất được bản đánh dấu).
>   Danh sách thay đổi bên trái có **ô tick từng vùng** (mặc định **chọn tất**) — bỏ tick vùng nào thì
>   vùng đó **mờ đi trên cả 2 bản** và **không được khoanh mây** khi xuất bản B. Nút xuất hiện số đã chọn.
> - **Chồng lớp**: xếp 2 bản vẽ lên nhau, tự căn chỉnh + **tô màu khác biệt** (đỏ = chỉ có ở bản A,
>   xanh = chỉ có ở bản B, đen = trùng). Chỉnh **độ mờ** lớp trên, **nudge** (phím mũi tên) để căn tay,
>   PageUp/PageDown đổi cặp trang. Dùng để soi thay đổi giữa 2 phiên bản bản vẽ.

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
| App mở chậm lần đầu | Bình thường — engine OCR tải ngầm ở lần dùng đầu. Lần sau nhanh hơn. |
| Máy yếu, OCR chậm | Engine chạy trên CPU; PDF nhiều trang sẽ lâu. Các thao tác PDF thường (xem/ghép/sửa chữ) vẫn nhanh. |

---

## 8. Yêu cầu máy đích

- Windows 10/11 **64-bit**.
- ~2 GB trống cho app + ~1 GB cho cache model (lần đầu OCR).
- Khuyến nghị ≥ 8 GB RAM để OCR mượt.
- Internet cho **lần đầu** dùng OCR (và mỗi lần dùng "Bóc tách").

---

*Phiên bản: 0.2.51 · Installer (NSIS, tự cập nhật) cho Windows x64.*
