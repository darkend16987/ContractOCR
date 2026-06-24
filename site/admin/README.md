# Nabu PDF — License Admin (superadmin dashboard)

Static SPA (vanilla JS + supabase-js), served at **`/admin`** of the marketing
site (`site/`). Reads license data via Supabase RLS (`is_admin()`); signed
mutations go through the `admin` Edge Function.

## Đăng nhập (2 cách)

1. **Mật khẩu**: nhập email + mật khẩu → "Đăng nhập bằng mật khẩu"
   (`signInWithPassword`). Đặt mật khẩu cho user trong Supabase → Authentication →
   Users → (tạo user / Reset password). Bật **Email** provider.
2. **Magic link**: bỏ trống mật khẩu → "Gửi magic link qua email" (`signInWithOtp`).

Email phải nằm trong bảng `admins` (đã seed `hoangnam.mng@gmail.com`).
Thêm domain site vào **Authentication → URL Configuration → Redirect URLs**
(vd `https://<your-site>.vercel.app/**`).

## Cấu hình

[`config.js`](config.js) chứa `SUPABASE_URL` + `SUPABASE_ANON_KEY` (đều public).

## Chức năng

Licenses (tìm/cấp/sửa seat·hạn·trạng thái·người nhận), chi tiết key + máy đã kích
hoạt (gỡ/bật lại từng máy), Nhật ký (audit), Admins (thêm/xóa).

## Deploy

Là một phần của `site/` — xem [../README.md](../README.md). Vercel project
**Root Directory = `site`**; admin phục vụ tại `/admin`.
