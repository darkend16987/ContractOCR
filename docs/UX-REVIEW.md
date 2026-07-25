# Rà soát giao diện & thanh công cụ

_Thực hiện 2026-07-25, sau khi thêm tab (Lớp 1). Đối chiếu mã nguồn thật, có trích dẫn._

Nguyên tắc dùng để đánh giá (heuristic đã được kiểm chứng rộng rãi, không phải cảm tính):
**Jakob** (người dùng mong app của bạn hoạt động giống app họ đã quen) ·
**Hick** (thời gian chọn tăng theo số lựa chọn) · **Fitts** (đích to/gần thì bấm nhanh) ·
**Nielsen #4** (nhất quán & theo chuẩn) · **Nielsen #6** (nhận ra thay vì phải nhớ) ·
**progressive disclosure** (chỉ hiện thứ đang cần).

---

## 1. Kết cấu hiện tại (dữ kiện)

Các dải ngang, từ trên xuống:

| Dải | Phần tử | Mặc định |
|---|---|---|
| Thanh tab | `#bar` — **cao đúng 40px** (`shell.html:36`, hằng `TAB_STRIP_H` `tabs.js:25`) | luôn hiện |
| Thanh công cụ 1 | `.tb-row` — Mở/Gộp/Lưu/In · điều hướng trang · zoom · tìm kiếm · cài đặt/badge | luôn hiện |
| Thanh công cụ 2 | `.tb-row.tb-tools` — Hoàn tác/Làm lại · **Trang ▾** · Chú thích · Sửa nội dung · Bóc tách · **Công cụ ▾** · Ghi chú | luôn hiện |
| Thanh chú thích | `#edit-bar` | ẩn, hiện khi vào chế độ chú thích |
| Breadcrumb | `#breadcrumb` | ẩn tới khi mở file |
| Thanh sửa chữ | `#tedit-bar` | ẩn, hiện khi sửa nội dung |
| _(vùng xem tài liệu)_ | `main.workspace` | — |
| Status bar | `#statusbar` — trang · khổ mm · zoom | ẩn tới khi mở file |

Panel bên phải: Bóc tách `420px` · Ghi chú `320px` · Định dạng hộp chữ `236px`.
Sidebar thumbnail trái `180px`.
Dropdown: **Trang ▾** 9 mục · **Công cụ ▾** 11 mục.
Thanh chú thích có 33 control nhưng **được lọc theo công cụ đang chọn**
(`TOOL_CTLS`/`KIND_CTLS`, `editor.js:2738-2780`) → không phải 33 cái cùng hiện. ✔

> Không đo được tổng chiều cao chrome bằng px: khung xem thử render với viewport 0×0
> nên số đo bị sai. Con số chắc chắn duy nhất là thanh tab **40px**. Phần dưới đây
> lập luận trên **số dải xếp chồng**, không dựa vào px ước đoán.

---

## 2. Phát hiện, xếp theo mức ưu tiên

### 🔴 U1 · Ô tìm kiếm mất nền và mất viền — **lỗi thật**
`.find-box` dùng `var(--panel)` và `var(--border)` (`app.css`), nhưng **hai biến này
không được định nghĩa ở bất cứ đâu** trong renderer.
Đã kiểm chứng bằng computed style: `background-color: rgba(0,0,0,0)` (trong suốt),
`border: 0px none`. → Ô tìm kiếm hiện đang “trôi” không khung, khác hẳn các control khác.
**Sửa:** định nghĩa 2 biến trong `:root`, hoặc đổi sang biến màu đang dùng thật.
Chi phí: 1 dòng CSS. Rủi ro: 0.

### 🔴 U2 · Ctrl+W đang đóng **cả cửa sổ** thay vì đóng tab — hồi quy do tab
`main.js:281` khai `{ role: "close" }`; role này của Electron mặc định gắn **Ctrl+W**.
Trước khi có tab thì đúng (1 cửa sổ = 1 tài liệu). Bây giờ Ctrl+W sẽ **đóng mọi tab**.
Vi phạm Jakob rất nặng: trong mọi trình duyệt/IDE, Ctrl+W = đóng **tab**.
Rủi ro thực tế: người dùng quen tay bấm Ctrl+W định đóng 1 tài liệu → bị hỏi lưu hàng loạt.
**Sửa:** Ctrl+W → đóng tab hiện tại; Ctrl+Shift+W → đóng cửa sổ.

### 🟠 U3 · Thiếu phím tắt tab cơ bản
Không có **Ctrl+T** (tab mới), **Ctrl+Tab / Ctrl+Shift+Tab** (chuyển tab),
**Ctrl+1…9** (nhảy tới tab thứ n). Đây là bộ phím phổ quát; thiếu thì thanh tab
chỉ dùng được bằng chuột (Fitts: mỗi lần chuyển tài liệu phải rê chuột lên đỉnh màn hình).

### 🟠 U4 · Menu chưa phản ánh khái niệm “tab”
Menu Tập tin chỉ có “Cửa sổ mới” và “Đóng cửa sổ”. Thiếu “**Tab mới**” và “**Đóng tab**”.
Nielsen #6: người dùng cần *nhìn thấy* chức năng, không phải đoán rằng nút `+` là cách duy nhất.

### 🟠 U5 · Thanh ngữ cảnh **cộng thêm** thay vì **thay thế** → chồng dải
Khi đang chú thích, màn hình có 5 dải ngang chồng nhau:
thanh tab + công cụ 1 + công cụ 2 + thanh chú thích + breadcrumb.
Nhưng ngay lúc đó **thanh công cụ 2 gần như vô dụng**: theo bất biến BI-2
(`app.js:3131-3135`), Chú thích/Sửa nội dung loại trừ nhau và các nút bị vô hiệu hoá.
**Sửa:** khi `#edit-bar` hoặc `#tedit-bar` bật thì **ẩn hàng công cụ 2**.
Đây đúng mô hình “contextual ribbon” của Office/Acrobat: vào chế độ thì đổi thanh,
không xếp chồng. Lấy lại 1 dải chiều dọc, đúng bằng phần tab vừa lấy đi.

### 🟡 U6 · “Công cụ ▾” là ngăn kéo tạp — khó đoán nội dung
11 mục thuộc 4 nhóm chẳng liên quan: Văn bản (OCR, dịch) · Tài liệu (Office, nén, so sánh,
copy ảnh) · Ảnh (3 mục) · Bảo mật (ký số, khoá file).
Nhãn “Công cụ” không cho biết bên trong có gì (Hick + Nielsen #6) — người dùng phải mở ra dò.
**Hướng sửa (cần bạn quyết vì ảnh hưởng thói quen):** tách theo động từ người dùng nghĩ tới,
ví dụ **Xuất ▾** (Office/ảnh/nén) và **Bảo mật ▾** (ký số/khoá file), giữ OCR–dịch ở nhóm văn bản.

### 🟡 U7 · Ký số bị chôn 2 lớp
Ký số USB token là tính năng lớn của v0.2.38 nhưng nằm ở `Công cụ ▾ → Bảo mật → Ký số`.
Nếu đây là tính năng bán hàng, nên đưa lên cấp 1 (hoặc ghim vào thanh công cụ khi tài liệu
đã sẵn sàng ký).

### 🟡 U8 · Ba panel phải chưa loại trừ lẫn nhau đủ
`app.js:964` chỉ ẩn Bóc tách khi mở Ghi chú. Panel Định dạng (`#fmt-panel`, tự bật theo
công cụ text, `editor.js:3107-3114`) **không** nằm trong quy tắc đó.
Trường hợp xấu trên màn 1366px: sidebar 180 + Ghi chú 320 + Định dạng 236 = **736px** cho
chrome ngang, vùng xem tài liệu chỉ còn ~630px.
**Cần kiểm chứng bằng thao tác** (mục test 8 bên dưới) rồi mới quyết cách sửa.

---

## 3. Những chỗ đang làm tốt — đừng “tối ưu” hỏng

- **Empty state** có hướng dẫn kéo-thả + nút Gộp — đúng chuẩn onboarding.
- **Tooltip đầy đủ cho mọi nút icon-only, có kèm phím tắt** (`"Trang trước (PageUp)"`) —
  đúng Nielsen #6.
- **Vô hiệu hoá nút khi chưa mở tài liệu** thay vì để bấm rồi báo lỗi — chống lỗi từ gốc.
- **Phím tắt 1 chữ cái cho công cụ chú thích** (v/t/h/d/r/o/c/f/a/n/i/x/m) và có ghi trong tooltip.
- **Lọc control theo công cụ** ở thanh chú thích — đúng progressive disclosure.
- Đợt gom toolbar trước đó (2 dropdown, bỏ hàng thứ 3) đã giải quyết phần lớn vấn đề chật chội.

---

## 4. Đề xuất chia đợt

| Đợt | Nội dung | Rủi ro | Vì sao gộp chung |
|---|---|---|---|
| **A** | U1 (biến CSS) + U2 (Ctrl+W) + U3 (Ctrl+T/Tab/1-9) + U4 (menu tab) | Thấp | Đều là “hoàn thiện tab cho đúng chuẩn”, không đụng logic tài liệu |
| **B** | U5 (ẩn hàng công cụ 2 khi vào chế độ ngữ cảnh) | Thấp–TB | Chỉ bật/tắt hiển thị; phải test kỹ đường thoát chế độ |
| **C** | U6 + U7 (tổ chức lại menu) | TB | **Đổi vị trí lệnh = phá thói quen người dùng** → cần bạn chốt trước |
| **D** | U8 (quy tắc panel phải) | Thấp | Sau khi có kết quả test mục 8 |

---

## 5. Lưới test

| # | Kịch bản | Kỳ vọng |
|---|---|---|
| 1 | Nhìn ô tìm kiếm (U1) | Có nền + viền như các control khác |
| 2 | Ctrl+W khi có 3 tab (U2) | Đóng **1 tab**, hai tab kia còn nguyên |
| 3 | Ctrl+W ở tab cuối cùng | Đóng luôn cửa sổ |
| 4 | Ctrl+Shift+W (U2) | Đóng cả cửa sổ, có hỏi lưu từng tab bẩn |
| 5 | Ctrl+T / Ctrl+Tab / Ctrl+1 (U3) | Tab mới / xoay vòng tab / nhảy tab 1 |
| 6 | Ctrl+W khi con trỏ đang trong ô nhập chữ | **Vẫn đóng tab** (không bị ô input nuốt phím) |
| 7 | Vào chú thích rồi thoát (U5) | Hàng công cụ 2 ẩn khi vào, **hiện lại đủ** khi thoát; không nhảy layout |
| 8 | Mở Ghi chú, rồi chọn công cụ text để bật panel Định dạng (U8) | Ghi rõ hiện tượng: 2 panel cùng hiện, hay đè nhau, hay đẩy vùng xem quá hẹp |
| 9 | Sau mọi thay đổi trên: đổi ngôn ngữ VI↔EN | Không mất chữ, không mất nút (bất biến BI-10) |
