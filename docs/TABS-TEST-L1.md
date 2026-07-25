# Tab — Lưới test Lớp 1 (kiến trúc lõi)

_Phiên bản: chưa phát hành (nhánh `claude/vietnamese-ocr-ai-iSvwV`). Chạy bằng `cd desktop ; npm start`._

Lớp 1 = mỗi tài liệu là **một tab** trong một cửa sổ (`BaseWindow` + 1 `WebContentsView`/tab).
Renderer tài liệu (`index.html` + `app.js`…) **giữ nguyên**, chỉ tầng cửa sổ đổi.

**Chưa có ở Lớp 1** (để dành lớp sau): kéo sắp xếp tab, kéo tách tab thành cửa sổ,
Ctrl+T / Ctrl+W / Ctrl+Tab, menu chuột phải trên tab, khôi phục phiên.

## Cách chạy

```bash
cd desktop ; npm start
```

## Lưới test

| # | Kịch bản | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1 | Mở app | 1 cửa sổ, thanh tab trên cùng có 1 tab "Trang mới", nút `+` bên phải | ☐ |
| 2 | Mở 1 PDF trong tab đó | Nhãn tab đổi thành tên file; nội dung hiển thị bình thường | ☐ |
| 3 | Bấm `+` | Tab mới trống, tự chuyển sang tab đó; tab cũ vẫn còn | ☐ |
| 4 | Mở PDF thứ 2 ở tab mới, bấm qua lại 2 tab | Mỗi tab giữ đúng tài liệu, đúng vị trí cuộn/zoom của nó | ☐ |
| 5 | Sửa (vd. xoay trang) 1 tab | Tab đó hiện **chấm cam** (chưa lưu); tab kia không đổi | ☐ |
| 6 | Ctrl+S ở tab đang sửa | Lưu xong, chấm cam biến mất, tab kia không ảnh hưởng | ☐ |
| 7 | Bấm ✕ trên tab **sạch** | Tab đóng ngay, không hỏi; tab còn lại được kích hoạt | ☐ |
| 8 | Bấm ✕ trên tab **bẩn** → chọn **Huỷ** | Tab vẫn còn, tài liệu nguyên vẹn | ☐ |
| 9 | Bấm ✕ trên tab **bẩn** → chọn **Không lưu** | Tab đóng, tài liệu khác không ảnh hưởng | ☐ |
| 10 | Bấm ✕ trên tab **bẩn** → chọn **Lưu** | Hỏi/ghi file xong rồi tab mới đóng | ☐ |
| 11 | Đóng tab **cuối cùng** (✕ trên tab) | Cả cửa sổ đóng theo | ☐ |
| 12 | ✕ **cửa sổ** khi có 2 tab, 1 tab bẩn | Tự nhảy sang tab bẩn để hỏi; **Huỷ** → cửa sổ **không** đóng | ☐ |
| 13 | ✕ **cửa sổ**, chọn Không lưu cho mọi tab | Cửa sổ đóng hết; app thoát nếu là cửa sổ cuối | ☐ |
| 14 | Ctrl+N (Cửa sổ mới) | Cửa sổ **thứ 2** với thanh tab riêng; 2 cửa sổ độc lập | ☐ |
| 15 | Menu Tập tin/Trang/Hiển thị khi có 2 tab | Lệnh chạy trên **tab đang xem**, không phải tab khác | ☐ |
| 16 | In (Ctrl+P) ở tab thứ 2 | In đúng nội dung tab thứ 2 | ☐ |
| 17 | Chuột phải trong ô nhập liệu (vd. ô tìm kiếm) | Menu Cắt/Sao chép/Dán hiện đúng | ☐ |
| 18 | Chuột phải trên trang PDF | Menu riêng của app (Sao chép ảnh/vùng) — không bị menu native chen | ☐ |
| 19 | Trạng thái sidecar (huy hiệu OCR) | Cả 2 tab đều thấy "sẵn sàng" (không chỉ tab đầu) | ☐ |
| 20 | "Mở bằng" 1 PDF từ Explorer khi app đang chạy | Mở thành **tab mới** trong cửa sổ đang dùng | ☐ |
| 21 | Đổi ngôn ngữ VI/EN trong Cài đặt | Menu native đổi ngôn ngữ, tab không bị mất | ☐ |
| 22 | Kéo giãn / phóng to cửa sổ | Thanh tab + vùng tài liệu co giãn khít, không hở viền | ☐ |
| 23 | Mở ~5 tab | Thanh tab cuộn ngang được, tab đang xem tự cuộn vào tầm nhìn | ☐ |
| 24 | Tắt app khi 1 tab bẩn → bật lại | Có lời mời khôi phục bản tự lưu như trước | ☐ |

## Ghi chú khi báo lỗi

Với mỗi mục ☐ sai, ghi: số thứ tự + hiện tượng + có log lỗi trong DevTools không
(`Ctrl+Shift+I` mở DevTools của **tab đang xem**; thanh tab là view riêng nên lỗi của
nó không hiện ở đây).
