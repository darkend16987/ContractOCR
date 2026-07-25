# RAM & hiệu năng khi mở nhiều tab / nhiều cửa sổ

_Đo ngày 2026-07-25 trên nhánh tab (Lớp 1), Windows 11, Electron 33, chạy `npm start` (dev)._

> **Trạng thái:** P1 (trần dung lượng undo) **đã code, chờ test GUI** — hằng số
> `HISTORY_BYTES_BUDGET = 512 MB` ở `app.js`, cắt bớt trong `trimHistoryToBudget()`.
> Chưa làm: P2 (tab nền nhả bitmap), P3 (autosave co giãn), P4 (chặn mềm số tab), P5 (canvas So sánh).

**Câu hỏi:** mở nhiều tab/cửa sổ có cần tối ưu RAM như đã làm với file nặng không?
**Trả lời ngắn: CÓ.** Chi phí cộng dồn tuyến tính theo số tab, tab nền **không** nhả RAM,
và có một quả bom số học trong lịch sử undo lớn hơn nhiều so với bản thân tài liệu.

---

## 1. Phương pháp đo

- File thử: `LM-CL1-…Phu Gia Khang.pdf` — **128,1 MB**.
- Mở tab bằng cơ chế second-instance (`electron . <file>` lần 2, 3, 4 → mỗi lần thêm 1 tab
  vào cùng cửa sổ), chờ 45 s giữa các lần rồi cộng bộ nhớ **toàn bộ tiến trình `electron`**.
- Hai chỉ số: `WorkingSet64` (RAM vật lý, xấp xỉ Task Manager) và `PrivateMemorySize64`
  (riêng của tiến trình, không tính trang dùng chung).

> Cảnh báo đọc số: tổng `WorkingSet` **cộng trùng** phần bộ nhớ dùng chung giữa các
> tiến trình Electron → hơi cao hơn thực tế. `Private` là mức sàn đáng tin hơn.
> Số của lần thêm tab thứ nhất bị “nhoè” vì 45 s chưa đủ để nạp xong file 128 MB.

## 2. Kết quả đo

| Trạng thái | Số tiến trình | WorkingSet | Private |
|---|---|---|---|
| 1 tab trống (nền) | 6 | 1 336 MB | 1 259 MB |
| + tab 2 (PDF 128 MB) | 7 | 1 531 MB | 1 361 MB |
| + tab 3 (PDF 128 MB) | 8 | 2 019 MB | 1 780 MB |
| + tab 4 (PDF 128 MB) | 9 | **2 383 MB** | **2 076 MB** |

**Đọc ra:**
- **Mỗi tab = một tiến trình renderer riêng** (6→7→8→9). Tốt cho cách ly (một tab chết
  không kéo theo tab khác), nhưng RAM **cộng dồn**.
- 3 tab nặng làm tăng **+1 047 MB WorkingSet / +817 MB Private** so với nền
  → **≈ 270–350 MB mỗi tab** cho tài liệu 128 MB ≈ **2,1–2,7 lần cỡ file**.
  (Hợp lý: `state.bytes` + bản sao nội bộ của pdf.js + canvas + overhead.)
- Lúc đo chỉ **1 tab đang hiển thị**, nhưng danh sách tiến trình vẫn có nhiều renderer
  ~370 MB cùng lúc → **tab nền không nhả RAM**.

## 3. Nguyên nhân gốc (đối chiếu mã nguồn, có trích dẫn)

| # | Vấn đề | Bằng chứng | Mức độ |
|---|---|---|---|
| M1 | **Lịch sử undo giữ bản sao ĐẦY ĐỦ**, chỉ chặn theo *số lượng*, không theo *dung lượng* | `HISTORY_LIMIT = 30` (`app.js:132`); `snapshot()` = `state.bytes.slice()` (`app.js:135-141`); không có bất kỳ trần byte nào | 🔴 **Nặng nhất** |
| M2 | Không có bất kỳ xử lý ẩn/hiện nào → tab nền giữ nguyên mọi canvas | grep `visibilitychange` / `document.hidden` / `requestIdleCallback` trong toàn bộ renderer: **không có kết quả** | 🟠 |
| M3 | Autosave chép nguyên tài liệu mỗi 120 s, mọi tab, kể cả tab nền | `setInterval(autosaveTick, 120000)` (`app.js:275`), thân hàm `state.bytes.slice()` (`app.js:263`) rồi IPC sang main ghi đĩa | 🟠 |
| M4 | Màn So sánh **không** giải phóng canvas trang | `compare.js` chỉ có `unobserve`, không có hàm tương đương `freePageCanvas` | 🟡 (có sẵn từ trước, không liên quan tab) |
| M5 | Thumbnail sidebar render xong không bao giờ giải phóng | `app.js:565-597`, không có hàm free | 🟡 (nhỏ, ~vài chục MB) |

### M1 — con số đáng sợ

Đây là **số học từ mã nguồn**, không phải đo:

> 30 bước undo × 128 MB = **~3,8 GB cho MỘT tab.**

Chú thích ngay trên đầu hàm (`app.js:130-131`) viết *“capped at HISTORY_LIMIT to bound
memory”* — nhưng cái trần đó là **số bước**, không phải **dung lượng**. Với file nhỏ thì
vô hại; với file 128 MB thì sau khoảng 30 thao tác (xoay/xoá/ghép/bake/sửa chữ) một tab
đơn lẻ đã có thể ăn hết RAM máy. Nhân thêm số tab → hỏng chắc.

Đây cũng chính là rủi ro đã được ghi nhận (chưa xử lý) khi vá lỗi trắng trang ở v0.2.40.
**Tab không tạo ra lỗi này, nhưng tab nhân nó lên.**

---

## 4. Phương án đề xuất (xếp theo giá trị / rủi ro)

### P1 — Trần *dung lượng* cho lịch sử undo 🔴 nên làm trước
- Thêm ngân sách byte (đề xuất **512 MB**/tab). Trong `pushUndo()`, sau khi đẩy, loại bỏ
  bước cũ nhất cho đến khi tổng ≤ ngân sách, **luôn giữ tối thiểu 1–2 bước**.
- Phạm vi: chỉ vùng `app.js:132-158`. Không đụng module khác.
- Đánh đổi: file rất nặng sẽ undo được ít bước hơn (ví dụ 128 MB → ~4 bước thay vì 30).
  Đúng, và tốt hơn nhiều so với treo máy. File thường (<20 MB) **không đổi gì**.
- Kiểm chứng: BI-3 trong `REGRESSION-GUARD.md` (undo/redo còn đúng trên mọi thao tác).

### P2 — Tab nền nhả bitmap trang 🟠
- Main báo tab bị ẩn/hiện → renderer gọi `freePageCanvas` cho mọi trang khi ẩn, render lại
  khi hiện. Tận dụng đúng cơ chế virtualization đã có.
- Lợi: bớt ~phần canvas mỗi tab nền. Rủi ro: chạm vùng BI-4 → **không được** free khi
  đang bake/đang chú thích.

### P3 — Autosave co giãn theo cỡ tài liệu 🟠
- Tài liệu >50 MB thì giãn chu kỳ (ví dụ 120 s → 300 s) và/hoặc chỉ chép khi thực sự đổi.
  Hiện đang so sánh `bytes.length` — hai bản khác nhau vẫn có thể trùng độ dài.
- Lợi: bớt chép 128 MB + ghi đĩa 128 MB mỗi 2 phút mỗi tab bẩn.

### P4 — Chặn mềm số tab 🟢 rẻ
- Cảnh báo khi mở quá nhiều tài liệu nặng cùng lúc (ví dụ tổng > 1 GB), gợi ý đóng bớt.

### P5 — Giải phóng canvas trong màn So sánh 🟡
- Bổ sung cơ chế free giống viewer chính. Độc lập với tab, có thể làm sau.

**Không nên làm:** đổi Electron sang framework khác. Đã kết luận từ trước: chỉ giảm
~15–30%, trong khi P1 giảm hàng GB.

---

## 5. Lưới test cho phần tối ưu này

| # | Kịch bản | Kỳ vọng |
|---|---|---|
| 1 | File nhỏ (~2 MB): 30 thao tác rồi Ctrl+Z nhiều lần | Undo đủ 30 bước như cũ (P1 không đụng file nhỏ) |
| 2 | File 128 MB: làm 10 thao tác, xem RAM | RAM không vượt trần ngân sách; app không treo |
| 3 | File 128 MB: undo sau khi bị cắt lịch sử | Undo vài bước gần nhất vẫn đúng, không lỗi |
| 4 | Mở 4 tab file nặng | Tổng RAM thấp hơn mốc 2 383 MB đo được hôm nay |
| 5 | Chuyển tab qua lại (P2) | Trang hiện lại đúng, không trắng, không lệch chú thích |
| 6 | Chú thích ở tab A rồi chuyển sang tab B và quay lại (P2) | Annotation chưa Áp dụng còn nguyên |
| 7 | Tài liệu bẩn, chờ autosave, kill app, mở lại (P3) | Vẫn có lời mời khôi phục |
