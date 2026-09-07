# Nghiên cứu khả thi — mở dải zoom 40–300% → **20–500%**

_Lập 2026-09-07 · khảo sát trên `2b54535` (v0.2.65); thực hiện trên `0f82144` (v0.2.67) sau khi
`git pull --ff-only` — cây làm việc lúc khảo sát đang chậm 2 commit so với origin. Phát hành **v0.2.68**._

_Trạng thái: **ĐÃ THỰC HIỆN** (2026-09-07, chờ test tay + `/deploy`). Làm đúng phương án §4 với
hai quyết định đã chốt ở §9: hạn mức **32 MP**, bước nút ±/Ctrl± **nhân ×1,25**. Bất biến rút ra:
**BI-78** trong `docs/REGRESSION-GUARD.md`. Số đo sau khi làm thật ở **§10**._

_Mọi con số dưới đây là **đo được** bằng probe chạy thật trong Chromium 148 (cùng họ engine
với Electron đang ship), dùng **đúng** `vendor/pdf.min.js` + `vendor/pdf-lib.min.js` của dự án
— không suy đoán. Cách chạy lại ở §1.2._

---

## 0. Kết luận ngắn

| Câu hỏi | Trả lời |
|---|---|
| Hạ sàn 40% → **20%** có khả thi? | **Có, gần như miễn phí.** Bitmap nhỏ đi; `FIT_MIN_SCALE = 0.08` chứng minh code đã chạy đúng ở tỷ lệ thấp hơn 20% từ lâu. |
| Nâng trần 300% → **500%** có khả thi? | **Có — nhưng KHÔNG được đổi mỗi hai con số.** Đổi trần trần trụi sẽ làm **trang trắng im lặng** trên giấy khổ lớn (chứng minh ở §3.2) và đẩy RAM/trang lên **215–766 MB**. |
| Ảnh hưởng performance? | **Nếu làm kèm hạn mức pixel: gần như không** — mọi ca ≤ 32 MP, 122 MB, 45–134 ms/trang, **thấp hơn hiện trạng** ở giấy khổ lớn. Nếu làm trần trụi: nặng, và có ca **vỡ hẳn**. |
| Cỡ việc | **Nhỏ**: ~60 dòng code trong 1 file + 4 chỗ chữ + ~40 dòng test. |
| Rủi ro | **Thấp** với phương án §4; **Cao** nếu chỉ sửa hai hằng số. |

**Khuyến nghị:** làm, nhưng đi kèm **hạn mức raster** (`MAX_VIEW_MEGAPIXELS` / `MAX_VIEW_SIDE_PX`)
theo đúng khuôn `printScaleFor` mà app **đã có sẵn** cho đường in (§4). Hạn mức này làm app
**an toàn hơn hiện tại**, không chỉ an toàn ở 500%.

---

## 1. Phương pháp luận

### 1.1 Nguyên tắc

Giả định "canvas to thế này Chromium có chịu không / chậm bao nhiêu" **không đọc code ra được** —
phải đo. Nên trước khi thiết kế, mọi câu hỏi định lượng đều chạy qua probe thật: dựng PDF **dày
chữ + 400 nét vector** bằng `pdf-lib` đang ship (A4 / A3 / A0), rồi rasterise bằng `pdf.js` đang
ship, đúng đường code của `renderPageCanvas` (offscreen canvas → `page.render` với
`transform: [dpr,0,0,dpr,0,0]` → blit sang canvas hiển thị).

### 1.2 Ba probe đã chạy (file dùng một lần, ở scratchpad — không commit)

| Probe | Câu hỏi | Kết quả |
|---|---|---|
| `probe.html` §1 | Giới hạn canvas thật của Chromium là bao nhiêu? | side ≈ **65 413 px**, area ≈ **267,96 MP** (= 2^28) — §3.2 |
| `probe.html` §2–3 | Rasterise A4/A3/A0 ở x0.2…x5, dpr 1 và 1,5: bao nhiêu MP / MB / ms? | bảng §3.1 |
| sweep MP | Chỗ nào là **vách** hiệu năng theo diện tích/cạnh? | **cạnh > 16 384 px** → chậm 8–10× — §3.3 |

Chạy lại: copy `desktop/renderer/vendor/{pdf.min.js,pdf.worker.min.js,pdf-lib.min.js}` + trang
probe vào một thư mục, `python -m http.server` (bắt buộc — `file://` không chạy script trong
preview pane), rồi mở. Đọc `window.RESULT`.

### 1.3 Checkpoint đã tra trong sổ bất biến

- **BI-36** (`docs/REGRESSION-GUARD.md`) — zoom là **hai nửa**: `applyScaleToDom` chỉ đổi CSS box,
  `commitScale` mới rasterise; **không** được dựng lại `.page-wrap`; `m.paintScale` là tỷ lệ **CSS**
  mà bitmap được vẽ ở. Phương án §4 **không đụng** một chữ nào trong các luật đó — nó chỉ đổi
  **độ phân giải thiết bị** của bitmap, không đổi `paintScale`, không đổi hình học.
- **Khối in** — app **đã có** đúng khuôn giải pháp cần dùng: `printScaleFor` +
  `MAX_PRINT_MEGAPIXELS = 12` + `MAX_PRINT_SIDE_PX = 10000` (`app.js:2352-2374`), với lý do ghi
  nguyên văn: _"A0 ở 150 DPI ≈ 35 MP ≈ 140 MB canvas → renderer OOM"_. Đường **xem trang** thì
  **chưa** có hạn mức tương đương — đó chính là lỗ hổng mà trần 500% sẽ chọc vào.

---

## 2. Hiện trạng (đọc từ code, không suy diễn)

| Chỗ | Nội dung |
|---|---|
| `app.js:2735-2736` | `const ZOOM_MIN = 0.4; const ZOOM_MAX = 3;` — chỉ dùng trong `zoomTo` |
| `app.js:2732` | `FIT_MIN_SCALE = 0.08` — sàn **riêng** cho các nút "Vừa…" (đã chạy thấp hơn 20% từ lâu) |
| `app.js:2852-2879` | `zoomTo` — kẹp, làm tròn 3 số thập phân, neo con trỏ, gọi `applyScaleToDom` + `scheduleScaleCommit` |
| `app.js:856-905` | `renderPageCanvas` — `pw = floor(cw * dpr)`, `ph = floor(ch * dpr)`; **không có hạn mức nào** |
| `app.js:769` | `KEEP_MARGIN_PX = 1500` — cửa sổ giữ bitmap, tính theo **CSS px** |
| `app.js:4646-4647`, `5124-5127` | nút ± và Ctrl± dùng bước **cộng** `±0.2` |
| `src/tabs.js:242` | mỗi thẻ tài liệu là **một `WebContentsView` riêng** → RAM cộng dồn theo số thẻ |
| — | **Không** có `webContents.setZoomFactor` ở đâu ⇒ `devicePixelRatio` **chỉ** đến từ tỷ lệ hiển thị Windows (1 / 1,25 / 1,5 / 1,75 / 2 / 2,5) |
| — | `state.scale` **không** được lưu vào session ⇒ không có ca "file cũ mở lại ở 500%" |

Hệ quả quan trọng của `KEEP_MARGIN_PX` tính theo CSS px: **zoom càng cao, số trang giữ bitmap càng
ít** (ở 500% một trang A4 cao 4 210 px ⇒ cửa sổ giữ ~1 trang), nhưng **mỗi** bitmap lớn theo
**bình phương** tỷ lệ. Zoom càng thấp thì ngược lại: bitmap bé tí nhưng **nhiều trang** cùng sống.
Hai đầu dải có hai loại chi phí **khác nhau** — nên §3 đo riêng.

---

## 3. Số đo

### 3.1 Đầu trên — RAM/thời gian mỗi trang theo đường code hiện tại (không hạn mức)

`MP` = triệu pixel thiết bị · `MB` = `px × 4 B` (backing store thật) · `ms` = render + blit.

| Giấy | dpr | 300% (trần hiện tại) | 400% | 500% (trần đề xuất) |
|---|---|---|---|---|
| A4 | 1,0 | 4,5 MP · 17 MB · 28 ms | 8,0 MP · 31 MB · 36 ms | 12,5 MP · 48 MB · 44 ms |
| A4 | 1,5 | 10,1 MP · 39 MB · 29 ms | 18,0 MP · 69 MB · 47 ms | 28,2 MP · **107 MB** · 48 ms |
| A3 | 1,0 | 9,0 MP · 34 MB · 38 ms | 16,0 MP · 61 MB · 45 ms | 25,1 MP · 96 MB · 53 ms |
| A3 | 1,5 | 20,3 MP · 77 MB · 61 ms | 36,1 MP · 138 MB · 51 ms | 56,4 MP · **215 MB** · 64 ms |
| A0 | 1,0 | 72,3 MP · 276 MB · 135 ms | 128,5 MP · 490 MB · 165 ms | 200,9 MP · **766 MB** · **1 624 ms** |
| A0 | 1,5 | 162,7 MP · **621 MB** · 264 ms | 289,2 MP → **VỠ** (§3.2) | 451,9 MP → **VỠ** (§3.2) |

Đọc bảng này ra ba điều:

1. **A4 và A3 ở 500% chạy được thật** — 48–64 ms/trang, không có vách nào. Người dùng hợp đồng
   (A4) sẽ không thấy gì khác ngoài việc zoom được xa hơn.
2. RAM/trang tăng theo **bình phương** tỷ lệ: A3/dpr1,5 đi từ 77 MB (300%) lên 215 MB (500%) —
   ×2,8. Nhân với **số thẻ đang mở** (mỗi thẻ một renderer riêng) là con số đáng lo.
3. **Giấy khổ lớn đã nguy hiểm từ TRƯỚC khi đổi trần**: A0/dpr1,5 ở **300% hiện tại** đã là
   **621 MB một trang**. Đây là lỗ hổng có sẵn, không phải do đề xuất này sinh ra.

### 3.2 ⚠️ Vách cứng: trên 268 MP canvas **im lặng trả về trang trắng**

Đây là phát hiện quan trọng nhất, và là lý do **không** được chỉ sửa hai hằng số.

Probe: cấp canvas, `fillRect` đỏ toàn bộ, đọc lại 1 pixel ở giữa.

| Kích thước | = ca nào | `canvas.width` nhận đúng? | Có ném lỗi? | Pixel đọc về |
|---|---|---|---|---|
| 10 728 × 15 165 (162,7 MP) | A0 · 300% · dpr 1,5 | có | không | `[255,0,0,255]` ✅ đỏ |
| 14 304 × 20 220 (289,2 MP) | A0 · 400% · dpr 1,5 | **có** | **không** | `[0,0,0,0]` ❌ **trắng** |
| 17 880 × 25 275 (451,9 MP) | A0 · 500% · dpr 1,5 | **có** | **không** | `[0,0,0,0]` ❌ **trắng** |

Vượt `area ≈ 2^28 px` (267,96 MP đo được), Chromium **vẫn nhận** thuộc tính `width`/`height`,
**vẫn** trả về một `2d context`, `page.render` **vẫn resolve** (7–12 ms — dấu hiệu nó không vẽ gì),
và **không** ném exception nào.

Đối chiếu `renderPageCanvas` (`app.js:869-887`): khối `try/catch` ở đó **chỉ** bắt exception. Không
có exception ⇒ code đi tiếp, gán `canvas.width = pw` (**xoá sạch bitmap cũ đang hiển thị**), blit
một offscreen rỗng, gán `m.paintScale = state.scale` (⇒ `commitScale` coi trang này "đã nét", không
bao giờ vẽ lại). Kết quả người dùng thấy: **trang trắng vĩnh viễn, không thông báo, không lỗi
console**, cho tới khi zoom về mức thấp hơn.

Cạnh tối đa đo được là 65 413 px — **không phải** ràng buộc ở đây; diện tích mới là.

### 3.3 Vách mềm: cạnh > 16 384 px chậm 8–10×

Sweep cấp-phát + vẽ theo diện tích (tỷ lệ 1:1,414):

| MP | cạnh dài | MB | ms |
|---|---|---|---|
| 24 | 5 827 | 92 | 45 |
| 48 | 8 239 | 183 | 55 |
| 96 | 11 652 | 366 | 20 |
| 160 | 15 043 | 610 | 36 |
| **200** | **16 818** | 763 | **305** |
| 240 | 18 423 | 916 | 374 |

Vách nằm đúng giữa cạnh 15 043 và 16 818 px — tức **giới hạn texture 16 384 px của Skia**: quá
ngưỡng, canvas rơi khỏi đường tăng tốc GPU. Khớp với ca A0/dpr1/500% ở §3.1 (**1 624 ms**, gấp
12× mức 300%).

### 3.4 Đầu dưới — 20% tốn gì

Chi phí ở 20% **không phải pixel** (bitmap A4 ở 20% chỉ 0,08 MB) mà là **số trang cùng sống** trong
cửa sổ giữ, vì mỗi trang được vẽ còn kéo theo một `.text-layer` (DOM).

Đo trên trang A4 dày chữ (55 dòng), khung nhìn 900 px, `KEEP_MARGIN_PX = 1500`:

| Tỷ lệ | canvas ms | text-layer ms | tổng/trang | số trang trong cửa sổ giữ | tổng công một lượt |
|---|---|---|---|---|---|
| **20%** (sàn đề xuất) | 26,8 | 18,2 | ~45 ms | ~24 | **~1,0 s** · ~2 MB bitmap |
| 40% (sàn hiện tại) | 14,6 | 11,4 | ~26 ms | ~12 | ~0,3 s · ~1 MB |
| 100% | 5,0 | 9,6 | ~15 ms | ~5 | ~0,08 s |
| 500% | 4,9 | 9,9 | ~15 ms | ~1 | ~0,015 s |

Nghĩa là: hạ sàn xuống 20% làm công việc của **một lượt làm nét** (`commitScale` sau khi ngừng
lăn chuột) tăng khoảng **3×** so với 40% — từ ~0,3 s lên ~1,0 s, và là công **rải ra từng trang**
(mỗi trang một `await`), không phải một cú đứng máy. RAM không đáng kể. Đây là chi phí **duy nhất**
ở đầu dưới, và nó chấp nhận được: nó chỉ trả sau khi người dùng đã **dừng** cử chỉ.

> Nếu sau này thấy 20% "nhả" hơi lâu, cách rẻ nhất **không phải** hạ sàn lại mà là cho `commitScale`
> nhường main-thread giữa các trang (một `await new Promise(r => requestAnimationFrame(r))`).
> **Không** đưa vào lần này — ngoài phạm vi, và đo được là chưa cần.

### 3.5 Hai giới hạn khác — đã tra, **không** phải vấn đề

- **Chiều cao layout:** Chromium cuộn được ~33,5 M CSS px. Ở 500%, ngưỡng là ~1 990 trang A0
  (hiện tại ở 300% là ~3 315). Với A4 là ~7 970 trang. Không phải ca thật của app.
- **Số học `zoomTo`:** bước lăn nhân 1,1 ⇒ ở 20% một nấc là 0,02, vẫn lớn hơn lượng tử làm tròn
  0,001 (BI-36) ⇒ pinch trackpad không chết ở đầu dưới. Ở 500% một nấc là 0,45 — mượt.
  Ca test `viewer-geom.test.js:187` ("một nấc kẹp không vượt cả dải") vẫn đúng: `1,1³ = 1,331 < 25`.

---

## 4. Phương án đề xuất

### 4.1 Hai hằng số + một hạn mức raster (đúng khuôn `printScaleFor` đã có)

```
ZOOM_MIN: 0.4 → 0.2
ZOOM_MAX: 3   → 5
```

và thêm vào cạnh chúng, **cùng một khuôn với khối in** (`app.js:2352-2374`):

```js
const MAX_VIEW_MEGAPIXELS = 32;    // 32 MP ≈ 122 MB/trang (chốt ở §9; xem §10)
const MAX_VIEW_SIDE_PX = 12000;    // < 16 384 (giới hạn texture Skia — §3.3), còn dư biên

// dpr thực tế để rasterise một trang có CSS box cw×ch. Không bao giờ TĂNG quá dpr thật.
function viewRasterDpr(cw, ch, dpr) {
  return Math.min(dpr,
                  Math.sqrt((MAX_VIEW_MEGAPIXELS * 1e6) / (cw * ch)),
                  MAX_VIEW_SIDE_PX / Math.max(cw, ch));
}
```

Trong `renderPageCanvas`, đổi **đúng ba dòng**: `dpr` → `rd = viewRasterDpr(cw, ch, dpr)` khi tính
`pw`/`ph` và trong `transform`. **Không** đụng `m.paintScale` (nó là tỷ lệ **CSS**, BI-36), không
đụng `applyScaleToDom`, không đụng hình học lớp phủ.

### 4.2 Vì sao phương án này đúng, không phải "vá cho qua"

| | |
|---|---|
| **Chặn được vách cứng §3.2 bằng chứng minh, không bằng may mắn** | 32 MP < 268 MP và 12 000 < 16 384 là **hằng số**, nên bitmap **không thể** vượt giới hạn ở bất kỳ giấy / tỷ lệ / dpr nào. Không cần đọc-lại-pixel để kiểm tra lúc chạy (đọc lại một canvas 32 MP là một cú đồng bộ GPU→CPU trên main thread, đắt hơn nhiều lần cái nó phát hiện). |
| **Giữ đúng chỗ đau ở đầu trên** | Mọi ca ở §3.1 tụt về ≤ 32 MP · 122 MB · **45–134 ms** (đo lại ở §10). Kể cả A0/dpr1,5/500%: 1 724 MB → 122 MB. |
| **Làm app an toàn hơn HIỆN TẠI** | A0/dpr1,5 ở **300%** hôm nay là 621 MB/trang; sau thay đổi là 122 MB. Người dùng A0/A1 được lợi **ngay ở mức zoom họ đang dùng**. |
| **Mất chất lượng gần như không thấy** | Hạn mức chỉ chạm vào ca đã phóng rất to. A4/dpr1,5/500% **không bị kẹp gì** (28,2 MP < 32). A3/dpr1,5/500%: `rd` 1,5 → 1,130, vẫn trên mức "1 pixel thiết bị / 1 CSS px" — trong khi chữ đã to gấp 5. |
| **Là cách các viewer khác làm** | `pdf.js` viewer có `maxCanvasPixels` (mặc định 2^25) và cũng kéo giãn bitmap thấp hơn khi vượt. Ta chọn 32 MP (= 2^25 px, đúng mặc định của pdf.js) — xem §10 vì sao mốc này lại vừa khít với A4 ở 500%. |
| **Không có HiDPI nào chọc lọt** | Ở dpr 2,5 (laptop 4K, Windows 250%) A4/500% trần trụi là 78 MP · **299 MB**; có hạn mức: 32 MP (`rd` 1,598). Ngay cả A4 cũng cần hạn mức này. |

### 4.3 Ba phương án đã cân và **loại**

| Phương án | Vì sao loại |
|---|---|
| Chỉ sửa 2 hằng số | Trang trắng im lặng trên A0/A1 (§3.2) + 215–766 MB/trang. Không chấp nhận được. |
| Trần 500% **chỉ cho** giấy nhỏ (trần động theo cỡ trang) | Đúng về máy nhưng **sai về người dùng**: ô zoom lúc nhận 500 lúc không, không giải thích được, và làm `syncZoomInput`/Trợ giúp nói dối. Hạn mức raster đạt cùng mục tiêu mà dải zoom vẫn là **một** con số cho mọi tài liệu. |
| Trần 400% cho "an toàn" | Không giải quyết gì: A0/dpr1,5 **vỡ ngay ở 400%** (§3.2). Không có trần nào an toàn mà **không** có hạn mức; đã có hạn mức thì 500% cũng an toàn như 400%. |

---

## 5. Chỗ đụng (đầy đủ — đã grep hết)

| File | Dòng | Việc |
|---|---|---|
| `desktop/renderer/app.js` | 2728-2736 | đổi 2 hằng số + viết lại chú thích (đang ghi "40%", "advertises 40–300%") |
| `desktop/renderer/app.js` | 2838, 3004 | 2 chú thích nhắc "40%" → cập nhật cho khỏi lạc |
| `desktop/renderer/app.js` | ~2737 (mới) | `MAX_VIEW_MEGAPIXELS`, `MAX_VIEW_SIDE_PX`, `viewRasterDpr` + chú thích dẫn §3.2/§3.3 |
| `desktop/renderer/app.js` | 862, 866-867, 883-885 | dùng `rd` thay `dpr` (3 dòng) |
| `desktop/renderer/index.html` | 126 | `title="Gõ tỷ lệ zoom (40–300) rồi Enter"` → `(20–500)` |
| `desktop/renderer/i18n.js` | 54 | ⚠️ **key là chính chuỗi tiếng Việt** — sửa index.html mà quên đây thì tooltip tiếng Anh **âm thầm** tụt về tiếng Việt |
| `desktop/renderer/help.js` | 152 | cả hai ngôn ngữ: "(40–300)" → "(20–500)" |
| `desktop/test/viewer-geom.test.js` | 187-188 | nhãn ca + 2 số `3`/`0.4` đang **hard-code** — chuyển sang **nâng hằng số thật** ra (§6) |
| `docs/REGRESSION-GUARD.md` | BI-36 + bảng test tay | thêm luật hạn mức + bằng chứng §3.2 |
| `HUONG-DAN-SU-DUNG.md` | — | **không cần** — đã kiểm: file này không nói con số dải zoom |

Ước lượng: ~60 dòng code + ~40 dòng test + docs.

---

## 6. Lưới test

### 6.1 Tự động — `desktop/test/viewer-geom.test.js` (`npm run test:geom`)

File này đã có sẵn kỹ thuật **nâng code thật ra khỏi file đang ship** (`extractFn`/`extractConst`)
và cả tiền lệ **so hằng số chéo file** (dòng 325 so JS với source Python). Dùng đúng hai thứ đó:

| # | Ca | Vì sao |
|---|---|---|
| Z1 | nâng `ZOOM_MIN`/`ZOOM_MAX` ra, ca "một nấc kẹp không vượt cả dải" dùng **hằng số nâng** thay vì `3 / 0.4` | ca hiện tại **sẽ lạc** khi đổi trần mà vẫn xanh — đúng loại test tự lừa mình |
| Z2 | `viewRasterDpr` với A4/A3/A0 × dpr {1; 1,5; 2; 2,5} × zoom {3; 4; 5} ⇒ **mọi** ca ≤ 32 MP **và** cạnh ≤ 12 000 **và** < 268 MP | chốt vách cứng §3.2 bằng test, không bằng lòng tin |
| Z3 | `viewRasterDpr(...) <= dpr` luôn đúng | không bao giờ **tăng** phân giải (sẽ vừa mờ vừa tốn) |
| Z4 | A4 ở zoom {0,2; 1; 2} dpr 1,5 ⇒ `rd === dpr` (không kẹp) | chứng minh **không** có hồi quy chất lượng ở ca thường ngày |
| Z5 | `CHROMIUM_MAX_CANVAS_MP = 268` là hằng số **có tên + chú thích dẫn probe** | để người sau biết 32 ở đâu ra |
| Z6 | `index.html` + `i18n.js` (key **và** value) + `help.js` cùng quảng cáo đúng `20–500` suy ra từ `ZOOM_MIN/ZOOM_MAX` | chặn vĩnh viễn bẫy 4-chỗ-lệch ở §5, gồm cả bẫy i18n key |

### 6.2 Test tay (bổ sung vào bảng của `REGRESSION-GUARD.md`)

1. A4 nhiều trang: gõ `500` vào ô zoom → Enter → **nét**, chữ không rỗ; gõ `20` → 24 trang hiện ra, cuộn không đứng máy.
2. Gõ `5`, `0`, `999`, `abc` vào ô zoom → kẹp về 20 / 20 / 500 / không đổi, **không** có NaN.
3. **A0 hoặc A1 (bản vẽ CAD)**: zoom 300% → 400% → 500%, mỗi mức chờ nét. **Không** được có trang trắng (đây là ca vỡ ở §3.2). So RAM tiến trình renderer trước/sau — phải **thấp hơn** bản 0.2.65 ở cùng 300%.
4. Ctrl+lăn **nhanh liên tục** từ 20% lên 500% rồi về: không mất nấc, không treo, dừng lại là nét (BI-36).
5. Ở **500%**: mở Chú thích → vẽ chữ nhật + hộp chữ → đúng chỗ; Ctrl+F → vệt tô đúng chữ; "Sửa chữ" → ô span đúng chỗ.
6. Ở **20%**: những việc trên vẫn đúng chỗ (dung sai chạm ở tỷ lệ thấp nới ra là **cố ý**, không phải lỗi).
7. Ba nút "Vừa…" trên A0 → vẫn xuống được **8%** (`FIT_MIN_SCALE` không bị sàn 20% ăn), rồi lăn lên một nấc → nhảy 8% → 20% (**đỡ gắt hơn** 8% → 40% hôm nay).
8. F11 vào/ra ở 500% → về đúng tỷ lệ cũ.
9. Mở **3 thẻ** cùng lúc, mỗi thẻ zoom 500% → xem RAM tổng; đây là ca nhân theo số renderer.
10. Ctrl+P sau khi zoom 500% → bản in **không** đổi (đường in dùng `printScaleFor` riêng, độc lập).

---

## 7. Rủi ro

| Rủi ro | Mức | Chặn bằng |
|---|---|---|
| Trang trắng im lặng ở giấy khổ lớn | **Cao nếu không có hạn mức** | §4.1 + ca Z2 |
| Sửa chữ ở 3 chỗ mà quên **key i18n** ⇒ tooltip tiếng Anh tụt về tiếng Việt | Trung bình | ca Z6 |
| Lăn chuột ở 500% cảm giác nặng vì `applyScaleToDom` là O(số trang)/nấc | Thấp | **không đổi** so với hiện tại — chi phí này độc lập với dải zoom |
| Nút ±/Ctrl± bước **cộng** `±0.2` càng lệch ở hai đầu (từ 20% một cú là **+100% tương đối**; từ 480% chỉ là +4%) | Thấp (chỉ là cảm giác) | **Quyết định cần chốt** — §9 câu 1 |
| `commitScale` ở 20% tốn ~1,0 s một lượt | Thấp | đo rồi (§3.4), có sau khi đã dừng cử chỉ; cách nới ghi ở §3.4 nhưng **chưa làm** |
| Vẽ chú thích ở 20% dung sai chạm nới rộng (12 px CSS = 60 pt) | Rất thấp | hành vi này đã tồn tại ở 40% (30 pt); cùng chiều, không mới |

---

## 8. Kế hoạch theo bước (dừng được ở mỗi checkpoint)

| Bước | Việc | Checkpoint |
|---|---|---|
| **1** | `app.js`: thêm `MAX_VIEW_MEGAPIXELS` / `MAX_VIEW_SIDE_PX` / `viewRasterDpr`, dùng `rd` trong `renderPageCanvas`. **Chưa đổi dải zoom.** | `npm run test:geom` xanh; app ở **300%** trên A0 nhẹ hơn rõ, A4 **không** đổi độ nét |
| **2** | Đổi `ZOOM_MIN`/`ZOOM_MAX` + 3 chú thích | Test tay 1–4 |
| **3** | 3 chỗ chữ người dùng thấy (index.html + i18n key & value + help.js) | Đổi app sang English → tooltip + Trợ giúp nói "20–500" |
| **4** | Thêm Z1–Z6 vào `viewer-geom.test.js` | `npm run test:geom` xanh; thử **cố tình** đổi `ZOOM_MAX` thành 6 → Z6 phải **đỏ** |
| **5** | `REGRESSION-GUARD.md`: BI-36 thêm luật hạn mức + bằng chứng §3.2 + 10 ca test tay | — |
| **6** | Test tay 1–10, rồi `/deploy` | — |

Bước 1 **có giá trị độc lập**: nó sửa một lỗ hổng OOM đang tồn tại ở giấy khổ lớn, kể cả khi
sau đó quyết định **không** đổi dải zoom.

---

## 9. Quyết định cần chốt

1. **Bước của nút ±/Ctrl±**: giữ **cộng `±0.2`** như hiện tại (đơn giản, không hồi quy, nhưng ở
   20% một cú là +100% tương đối), hay đổi sang **nhân** (ví dụ ×1,25 ≈ 2 nấc lăn — đều tay ở cả
   hai đầu dải), hay **bậc thang** kiểu Acrobat/Chrome (20·25·33·50·67·75·100·125·150·200·300·400·500)?
   _Khuyến nghị: **nhân ×1,25**_ — rẻ nhất, cùng triết lý với `wheelZoomFactor` đã có (BI-36),
   và không sinh thêm bảng hằng số phải bảo trì.
2. **Hạn mức**: **24 MP** (92 MB/trang, dư biên cho nhiều thẻ) hay **32 MP** (nét hơn ~15% ở ca bị kẹp,
   122 MB/trang)?

**Đã chốt (2026-09-07):** (1) **nhân ×1,25** · (2) **32 MP**.

---

## 10. Sau khi làm — số đo lại trên đúng hạn mức đã chọn

Chạy lại probe với `MAX_VIEW_MEGAPIXELS = 32` / `MAX_VIEW_SIDE_PX = 12000`, và lần này **đọc lại
một pixel giữa trang** để chứng minh bitmap là thật (giấy trắng ⇒ alpha phải là 255), chứ không
chỉ "không ném lỗi" — đúng cái bẫy ở §3.2.

| Giấy | dpr | zoom | `rd` | bitmap | RAM | ms | vẽ thật? |
|---|---|---|---|---|---|---|---|
| A4 | 1,5 | 300% | 1,5 (không kẹp) | 10,1 MP | 39 MB | 47 | PAINTED |
| A4 | 1,5 | **500%** | **1,5 (không kẹp)** | 28,2 MP | 107 MB | 78 | PAINTED |
| A4 | 2,5 | 500% | 1,598 | 32 MP | 122 MB | 45 | PAINTED |
| A3 | 1,0 | 500% | 1,0 (không kẹp) | 25,1 MP | 96 MB | 66 | PAINTED |
| A3 | 1,5 | 500% | 1,130 | 32 MP | 122 MB | 52 | PAINTED |
| A3 | 2,5 | 500% | 1,130 | 32 MP | 122 MB | 45 | PAINTED |
| A0 | 1,0 | 500% | 0,399 | 32 MP | 122 MB | 134 | PAINTED |
| A0 | 1,5 | **500%** | 0,399 | 32 MP | 122 MB | 116 | PAINTED |
| A0 | 2,5 | 500% | 0,399 | 32 MP | 122 MB | 108 | PAINTED |

Chọn 32 MP thay vì 24 MP hoá ra đúng ở một điểm không thấy trước: **A4 ở 500% trên màn 150%
(28,2 MP) nằm ngay dưới hạn mức**, nên ca thường gặp nhất của HiDPI **không bị kẹp một chút nào**
— 24 MP thì nó đã bị hạ xuống `rd` 1,384. Ranh giới này được chốt bằng test: đổi `ZOOM_MAX` thành
6 thì ca "A4 ở 600% trên màn 150% vẫn full dpr" **đỏ** (`rd` = 1,332), tức 500% là mức cuối còn
giữ trọn độ nét cho A4.

Đối chiếu với §3.1: A0/dpr1,5/500% từ **1 724 MB + trang trắng im lặng** về **122 MB, 116 ms, vẽ
thật**; A0 ở **300%** (mức người dùng đang thật sự dùng hôm nay) từ **621 MB** về **122 MB**.

Toàn bộ 18 lưới `npm run test:*` xanh (`test:geom` 430 ca). Kiểm chứng âm bản: đặt `ZOOM_MAX = 6`
⇒ **đỏ 5 ca**, gồm cả 3 ca chữ ở `index.html` / `i18n.js` / `help.js`.
