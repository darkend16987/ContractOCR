# Nabu PDF — License Admin (superadmin dashboard)

Static SPA (vanilla JS + supabase-js). Reads license data via Supabase RLS
(`is_admin()`), performs signed mutations through the `admin` Edge Function.

## Cấu hình

Sửa [`config.js`](config.js):

```js
window.NABU_CFG = {
  SUPABASE_URL: "https://gaqwijsudxpfydruozmd.supabase.co",
  SUPABASE_ANON_KEY: "<anon public key>", // Dashboard → Settings → API → anon public
};
```

Cả hai đều **public** (anon key chỉ làm được gì RLS cho phép).

## Đăng nhập

1. Email của bạn phải nằm trong bảng `admins` (migration đã seed `hoangnam.mng@gmail.com`).
2. Nhập email → "Gửi link đăng nhập" → mở email → bấm magic link.
3. Bật **Email auth** trong Supabase → Authentication → Providers (mặc định bật).
   Thêm domain Vercel vào **Authentication → URL Configuration → Redirect URLs**
   (vd `https://nabu-license-admin.vercel.app/*`).

## Chức năng

- **Licenses**: tìm kiếm, cấp key mới (tên/email/gói/seats/hạn/giao-cho), xem chi tiết.
- **Chi tiết key**: đổi trạng thái (active/suspended/revoked), số máy, gia hạn, người nhận;
  xem máy đã kích hoạt + **gỡ/bật lại từng máy** (free seat / remote-kill).
- **Nhật ký**: audit log mọi thao tác.
- **Admins**: thêm/xóa superadmin.

Thu hồi/gỡ máy có hiệu lực ở lần app đồng bộ kế (token TTL = 7 ngày).

## Deploy lên Vercel

Thư mục tĩnh, không cần build:

```bash
cd admin
npx vercel --prod        # hoặc nối repo này trong Vercel, root = admin/
```

Hoặc trỏ Vercel project vào repo NabuPDF, **Root Directory = `admin`**, framework = "Other".
