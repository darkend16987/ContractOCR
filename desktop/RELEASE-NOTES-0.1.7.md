# Nabu PDF 0.1.7 — Bộ công cụ Chuyển đổi

Thêm nhóm tính năng **Chuyển đổi** (gom trong một nút dropdown trên thanh công cụ
+ menu native "Chuyển đổi"). Tất cả là tính năng **Pro** (cần kích hoạt bản quyền)
và chạy hoàn toàn local qua sidecar PyMuPDF — không gửi file ra ngoài.

## Mới

- **Khoá file (đặt mật khẩu)** — mã hoá AES-256, đặt mật khẩu mở file + tuỳ chọn
  quyền (in / sao chép / chỉnh sửa / chú thích). Đối xứng với tính năng mở khoá đã có.
- **Xuất ảnh trong PDF** — trích mọi ảnh nhúng (giữ nguyên định dạng gốc, khử trùng
  lặp theo xref), gói thành một file `.zip`.
- **Trang PDF → ảnh** — render từng trang ra PNG/JPG (96/150/300 DPI), gói `.zip`.
- **Ảnh → PDF** — gộp nhiều ảnh (JPG/PNG/BMP/TIFF/WebP…) thành một PDF, mỗi ảnh một
  trang; chọn khổ "vừa khít ảnh" hoặc "A4 dọc".

## Kỹ thuật

- Backend: 4 endpoint mới trong `api.py` (`/encrypt`, `/extract-images`,
  `/pdf-to-images`, `/images-to-pdf`) + helper dùng chung `_decode_pdf_b64` / `_require_fitz`.
- Không thêm dependency mới: chỉ dùng `pymupdf` + `Pillow` + `zipfile` (đã có sẵn).
- UI: nút "Chuyển đổi" dạng dropdown để thanh công cụ không bị quá tải.
