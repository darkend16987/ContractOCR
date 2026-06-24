# Nabu PDF 0.1.8

## Online activation (license server) — mới
- Kích hoạt key qua máy chủ (Supabase): **giới hạn số máy/key (seat cap)**, **thu hồi** và **gỡ máy từ xa**, hạn dùng tập trung.
- App verify **ngoại tuyến** bằng activation token (Ed25519, hạn 7 ngày), tự gia hạn im lặng khi có mạng, có **grace 14 ngày** khi mất mạng.
- Kích hoạt lần đầu cần internet (để seat cap có hiệu lực); sau đó chạy offline.

## Gộp các bản trước
- **Enforcement**: 8 tính năng pro khóa sau license (bóc tách AI, sửa chữ, chỉnh sửa, ghép, chèn, tách, searchable, nén).
- **HWID**: key có thể khóa theo máy; Settings hiện Mã máy (HWID).
- **About / credit**: Tạ Hoàng Nam — nhà phát triển độc lập; header "developed by Nam Ta".
- Công cụ PDF convert (khóa/mã hóa, trích ảnh, PDF↔ảnh).

## Quản trị
- Dashboard superadmin (Vercel): cấp key, sửa seat/hạn/trạng thái, xem + gỡ máy, audit log, quản lý admin.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
