# Khôi phục phiên — mở lại đúng bộ tab lần trước

_Lập 2026-07-26. Tiếp nối `docs/TABS-2B-DESIGN.md` §7._
_Đọc kèm: `docs/REGRESSION-GUARD.md` (BI-18/19/20)._

---

## 1. Việc này xong khi nào

> Đóng app khi đang mở 5 tài liệu ở 2 cửa sổ → mở lại app thì **đúng 5 tài liệu đó,
> đúng thứ tự, đúng cửa sổ, đúng tab đang xem**, và khởi động **không chậm hơn**
> so với mở app rỗng.

---

## 2. Ranh giới quan trọng nhất: phiên ≠ khôi phục sự cố

App đã có **hai** thứ nghe na ná nhau. Trộn chúng lại là cách nhanh nhất để mất dữ liệu.

| | Khôi phục **sự cố** (đã có từ trước) | Khôi phục **phiên** (mới) |
|---|---|---|
| Nhớ cái gì | **Nội dung thật** (bytes) của tài liệu đang sửa dở | **Đường dẫn** file |
| Lưu ở đâu | `userData/recovery/<docId>/autosave.pdf` | `userData/session.json` |
| Dùng khi | App chết đột ngột, mất điện | Đóng app bình thường |
| Hỏng thì mất gì | Việc đang làm dở | Không mất gì — chỉ là tab không quay lại |

**Nguyên tắc:** module phiên **không bao giờ** đụng tới bytes. Tab nào chưa có file
trên đĩa (tài liệu mới, chưa lưu bao giờ) thì **không nằm trong phiên** — đó là phần
việc của khôi phục sự cố. Nhờ ranh giới này, một lỗi trong `session.js` không thể
làm ai mất tài liệu.

### 2.1 Chỗ hai hệ va nhau — và cách gỡ

Lời nhắc khôi phục sự cố chỉ hiện trong một tab **còn trống** (`checkRecovery` ở
`renderer/app.js`, chạy sau 1,2 giây). Khi khôi phục phiên bật, mọi tab đều được
giao sẵn một tài liệu → **không còn tab trống nào để lời nhắc xuất hiện**, và tệ hơn,
một tab tải chậm có thể "giành" mất danh sách bản nháp rồi bỏ đi (`recovery:scan`
chỉ trả kết quả cho người hỏi **đầu tiên** mỗi lần chạy — BI-7).

Hai chốt chặn:

1. **`tab:reserved`** — main báo cho renderer biết tab này đã được đặt chỗ cho một
   tài liệu; renderer tự rút khỏi việc nhận lời nhắc. Điều này cũng vá luôn một
   cuộc đua vốn đã âm ỉ trong đường "Open with" cũ.
2. Nếu lúc khởi động **có** bản nháp sự cố, main mở thêm **một tab trống** để lời
   nhắc có chỗ hiện. Tab thừa này chỉ xuất hiện đúng lúc cần — đóng app sạch sẽ thì
   không có bản nháp nào, nên cũng không có tab thừa.

---

## 3. Cơ chế

### 3.1 Ai biết tab đang giữ file nào

Renderer là nguồn sự thật (nó xử lý Mở, Lưu thành…, đóng tài liệu). `tab:meta` vốn
đã báo tiêu đề + cờ bẩn; nay báo thêm `path`. Không thêm kênh mới, không thêm vòng đời mới.

### 3.2 Lúc nào ghi ra đĩa

`_emit()` là nút thắt của **mọi** thay đổi tập tab, nên nó là chỗ duy nhất phải nhớ
ghi (gộp trong 1 giây). Cộng thêm `move`/`resize` để nhớ vị trí cửa sổ.

Cái khó không phải "ghi khi nào" mà **"đừng ghi khi nào"**. Lúc đóng cửa sổ, danh sách
tab đang rỗng dần đi — ghi vào đúng lúc đó là ghi lại một cái app đang chết dở:

| Tình huống | Xử lý | Kết quả |
|---|---|---|
| Bấm ✕ đóng cửa sổ còn tab | `_guardAndClose` ghi **trước** khi phá, rồi bật `_closing` | Lần sau mở lại đúng bộ tab đó |
| Đóng lần lượt tới hết tab | `destroyTab` ghi **sau** khi tab cuối đi | Lần sau mở app rỗng — người dùng đã dọn sạch có chủ ý |
| Người dùng bấm Huỷ ở hộp "chưa lưu" | Tắt `_closing`, ghi lại | Cửa sổ sống tiếp, phiên vẫn đúng |
| Menu Thoát / Ctrl+Q | `before-quit` ghi khi các cửa sổ **còn nguyên** | Đúng |
| Đóng 1 trong nhiều cửa sổ | `_onClosed` ghi lại phần còn lại | Cửa sổ đã đóng bị quên — đúng |
| Cửa sổ **cuối** đóng xong | `_onClosed` **huỷ** mọi lần ghi đang chờ | Giữ nguyên ảnh chụp lúc nãy |

### 3.3 Nạp trễ — điều kiện để tính năng không thành tai hoạ

Khôi phục 10 tab × 100MB bằng cách nạp thẳng cả 10 sẽ **treo máy ngay lúc khởi động**
(xem `docs/PERF-MEMORY.md`). Nên: **chỉ tab người dùng đang xem lúc thoát mới đọc file
ngay**; các tab còn lại hiện tên file và **nằm im tới khi được bấm vào lần đầu**
(`createTab({ deferred: true })` → `_wakeDeferred` trong `activateTab`).

Đây là điều kiện cần, không phải tối ưu thêm thắt: thiếu nó thì tính năng tiện lợi
này biến thành cú sập lúc mở app.

### 3.4 Khởi động bằng cách bấm đúp một file

**Không khôi phục phiên.** Bấm đúp một PDF thì mở đúng PDF đó. Kéo cả phiên cũ theo
là làm phiền chứ không phải phục vụ. Chỉ khi mở app từ icon/Start mới khôi phục.

### 3.5 Công tắc

Cài đặt → **Mở lại phiên trước** (mặc định **BẬT**). Cờ này nằm trong `session.json`
chứ không phải `localStorage`, vì main phải đọc được nó **trước khi có renderer nào**.

---

## 4. Bẫy đã rà

| # | Bẫy | Xử lý |
|---|---|---|
| S1 | File đã bị xoá/di chuyển từ lần trước | Lặng lẽ bỏ qua. Hộp thoại lỗi cho từng file lúc khởi động còn tệ hơn là mất tab |
| S2 | Màn hình phụ đã rút → cửa sổ khôi phục ra ngoài vùng nhìn thấy | `sanitizeBounds` bỏ toạ độ nếu phần thò vào vùng làm việc < 120×60px |
| S3 | `session.json` hỏng / phiên bản lạ | Coi như chưa có. **Không bao giờ ném lỗi lúc khởi động** |
| S4 | BOM UTF-8 (ai đó sửa file bằng Notepad / PowerShell) | Cắt BOM trước khi `JSON.parse` |
| S5 | Ghi nửa chừng rồi mất điện | Ghi ra `.tmp` rồi `rename` |
| S6 | `createTab` tự kích hoạt từng tab → đánh thức hết các tab nạp trễ | Thêm cờ `background`; khôi phục xong mới kích hoạt đúng một tab |
| S7 | Tab nạp trễ bị đánh thức hai lần → đè lên việc người dùng vừa làm | `pendingPath` xoá **trước** khi gửi file |

---

## 5. Lưới kiểm thử

### 5.1 Tự động (`npm run test:tabs`)

`sanitizeBounds` (8 ca: hợp lệ / rác / ngoài màn hình / thò vào một phần),
`snapshotSession` (7 ca: bỏ tab chưa lưu, bỏ cửa sổ đang đóng, chỉ số tab đang xem,
nhiều cửa sổ), `session.js` (8 ca: mặc định, ghi/đọc, **không ghi khi đang đóng dở**,
công tắc, file hỏng, phiên bản lạ).

### 5.2 Đã chạy thật (vòng đời đầy đủ, tự động)

| Kịch bản | Kết quả |
|---|---|
| Mở 1 PDF → `session.json` ghi đúng đường dẫn + bounds + tab đang xem | ✅ |
| Khởi động lại không tham số → tab quay lại (phiên vẫn còn sau lần chạy thứ 2) | ✅ |
| Khởi động bằng **file khác** → chỉ file đó, không kéo phiên cũ về | ✅ |
| Cờ `restore: false` → không khôi phục, cờ giữ nguyên | ✅ |

### 5.3 Tay (bắt buộc)

| # | Thao tác | Kỳ vọng |
|---|---|---|
| 1 | Mở 3 tài liệu ở 1 cửa sổ, chọn tab giữa, thoát bằng ✕ → mở lại | Đủ 3 tab, đúng thứ tự, **tab giữa** đang xem |
| 2 | Bấm sang một tab chưa mở lần nào | Tài liệu hiện ra bình thường (nạp trễ) |
| 3 | So sánh **thời gian khởi động** khi có 3 tab nặng vs app rỗng | Chênh lệch không đáng kể |
| 4 | 2 cửa sổ, mỗi cửa sổ vài tab, thoát bằng menu **Thoát** | Cả 2 cửa sổ về đúng chỗ, đúng kích thước |
| 5 | Phóng to 1 cửa sổ rồi thoát | Mở lại vẫn phóng to |
| 6 | Đóng **lần lượt hết** các tab rồi mở lại app | App rỗng — không có tab nào quay lại |
| 7 | Tab có tài liệu **chưa lưu bao giờ** (Trang mới) khi thoát | Tab đó **không** quay lại (đúng thiết kế) — nhưng nếu app chết thì khôi phục sự cố vẫn hỏi |
| 8 | **Xoá/đổi tên** một file rồi mở lại app | Các tab còn lại vẫn về, tab của file mất im lặng biến mất |
| 9 | Cài đặt → tắt **Mở lại phiên trước** → thoát → mở lại | App rỗng |
| 10 | Bật lại công tắc → thoát → mở lại | Tab quay lại |
| 11 | **Bấm đúp một file PDF** khi app đang tắt | Chỉ mở file đó |
| 12 | Ép app chết khi có tài liệu bẩn (Task Manager) → mở lại | Tab quay lại **và** vẫn có lời nhắc khôi phục bản nháp (trong một tab trống) |
| 13 | Sửa 1 tab rồi ✕ cửa sổ, chọn **Huỷ** ở hộp hỏi lưu | Cửa sổ ở lại; thoát hẳn sau đó vẫn khôi phục đủ tab |
| 14 | Đổi giao diện VI ↔ EN, mở Cài đặt | Dòng "Mở lại phiên trước" dịch đúng |

---

## 6. Ngoài phạm vi

- Khôi phục **vị trí cuộn / mức zoom** của từng tab.
- Nhớ nhiều phiên (kiểu "khôi phục cửa sổ vừa đóng").
- Gộp phiên với khôi phục sự cố để tab bẩn quay lại kèm nội dung sửa dở — làm được
  (ghép theo `srcPath`), nhưng phải sửa vào đường khôi phục sự cố đang chạy tốt.
  Chưa đáng đánh đổi.
