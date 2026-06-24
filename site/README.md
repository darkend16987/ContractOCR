# Nabu PDF — Website (`site/`)

Static marketing site + license admin, one Vercel project.

```
site/
  index.html        # landing (hero, tính năng, tải về, bản quyền, liên hệ)
  chinh-sach.html   # chính sách (privacy / bản quyền / điều khoản)
  styles.css        # bổ sung cho Tailwind CDN
  app.js            # feature grid + link tải lấy từ GitHub Releases mới nhất
  assets/           # icon
  vercel.json       # cleanUrls + headers (noindex /admin)
  admin/            # dashboard superadmin → phục vụ tại /admin (login)
```

- **Landing**: `/` — nút tải trỏ tới GitHub Release mới nhất (JS tự lấy đúng asset).
- **Admin**: `/admin` — login (mật khẩu hoặc magic link), `noindex`.
- Thiết kế: Plus Jakarta Sans, teal `#0d9488` + cam CTA `#f97316`, Tailwind CDN, SVG icons.

## Deploy lên Vercel

Vercel project (team của bạn) → **Root Directory = `site`**, Framework = **Other**.

```bash
cd site && npx vercel --prod    # hoặc nối repo, root = site
```

> Nếu trước đây đã tạo project Vercel root=`admin`, đổi **Root Directory** sang `site`
> rồi redeploy. Admin giờ ở `/admin` thay vì root.

Sau khi có domain: Supabase → Authentication → URL Configuration → Redirect URLs
thêm `https://<domain>/**`.
