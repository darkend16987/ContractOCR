# Chú thích sửa lại được trên trang có `/Rotate` — chẩn đoán & phương án

Trạng thái: **đã thi công PA2 + PB2 — xem §10.** Còn lưới test tay §7 (A6) + P5 (Foxit/Acrobat).
Ngày: 2026-08-12 · Nguồn: 2 report từ người dùng.

---

## 1. Câu hỏi và kết luận

Người dùng báo: với file `NAVY-SGSU-NEM-ID-SD-RFA-0001-00- SG's ceiling finishing-trang-8.pdf`,
thêm hộp văn bản → bấm **Xong** → mở lại chế độ chú thích → **không sửa lại được** hộp văn bản đó
nữa; mũi tên và các thứ khác cũng vậy. Câu hỏi: *hồi quy sau loạt sửa gần đây, hay đặc trưng của
loại file này?*

**Kết luận: không phải hồi quy, và cũng không phải lỗi của file.** Đây là **giới hạn cố ý trong code
của chúng ta**, có từ ngày tính năng ra đời:

> Trang có `/Rotate ≠ 0` thì hộp văn bản / mũi tên / ảnh chèn **không được ghi thành annotation
> sửa-lại-được**; chúng rơi xuống nhánh dán-cứng-thành-pixel. Đã dán cứng thì không còn gì để
> `importManaged()` đọc lại → mở lại chế độ chú thích thì không có vật thể nào để chọn.

Ba dòng `return false` đó nằm ngay trong `addManagedAnnot`:

| kind | chốt | có từ |
|---|---|---|
| text | [editor.js:2352](../desktop/renderer/editor.js:2352) | **v0.2.35** (`4cc6769`) — đúng bản sinh ra tính năng sửa-lại-được |
| arrow | [editor.js:2377](../desktop/renderer/editor.js:2377) | **v0.2.37** (`0d483ad`) — đúng bản sinh ra mũi tên sửa-lại-được |
| image | [editor.js:2307](../desktop/renderer/editor.js:2307) | **v0.2.48** (`0444ecd`) — đúng bản sinh ra ảnh sửa-lại-được |

Không có commit nào gần đây chạm vào chúng. `git log -S` trên cả ba chuỗi comment chỉ ra đúng ba
commit trên. Vậy loạt sửa v0.2.53–v0.2.57 **không liên quan**.

File của người dùng chỉ là file **đầu tiên phơi ra** giới hạn này: nó là bản vẽ A3 có `/Rotate 270`.

---

## 2. Bằng chứng đo được

### 2.1 File của người dùng

Đọc bằng chính `pdf-lib` 1.17.1 mà app dùng:

```
LOAD: ok
pages: 1
page 0: { size: 842x1191, rotate: 270, mediaBox: [0 0 842 1191], cropBox: [0 0 842 1191],
          userUnit: null, annots: 0 }
page keys: /Resources,/MediaBox,/VP,/Type,/Contents,/Rotate,/CropBox,/LastModfied,/Group,/Parent
```

Không mã hoá, không XFA, không AcroForm, MediaBox gốc 0,0, không `/UserUnit`. **Điểm duy nhất khác
thường: `/Rotate 270`.** (`/VP` = viewport đo đạc của bản vẽ CAD, `/LastModfied` là key viết sai
chính tả của phần mềm sinh file — cả hai vô hại, app không đọc.)

Hậu tố `-trang-8` là do **chính app mình** đặt ([page-range.js:139](../desktop/renderer/page-range.js:139)):
người dùng đã tách trang 8 ra khỏi một bộ bản vẽ lớn. Bản tách giữ nguyên `/Rotate 270` của trang
gốc — đúng, không phải lỗi.

### 2.2 Chạy đúng hàm đang ship lên đúng trang đó

Nhấc `addManagedAnnot` ra khỏi `editor.js` đang ship (cùng cách `test/managed-image.test.js` làm),
gọi trên trang thật của file người dùng, rồi gọi lại trên **cùng dãy byte đó** chỉ đổi `/Rotate` về 0
làm đối chứng:

| kind | file thật (`rotate=270`) | đối chứng (`rotate=0`) |
|---|---|---|
| text | `false` → dán cứng | `true` → sửa lại được |
| arrow | `false` → dán cứng | `true` |
| image | `false` → dán cứng | `true` |
| note | **`true`** | `true` |

`rasterised: []` trên file thật: chốt chặn bật **trước** khi gọi bộ raster, tức nguyên nhân là đúng
phép thử `/Rotate`, không phải một lỗi ở dưới. Đối chứng dùng chung y hệt dãy byte (cùng object
stream, cùng mọi thứ) nên **`/Rotate` là nguyên nhân duy nhất**.

Ghi chú dán (`note`) là ngoại lệ: nó là annotation `/Text`, viewer tự vẽ icon tại `/Rect`, không có
`/AP` nào cần xoay. **Hôm nay người dùng vẫn sửa lại được ghi chú dán trên file đó** — đây là cách
đi tạm nếu chưa kịp vá.

### 2.3 Cái gì vẫn đúng

Ảnh dán-cứng **hiện đúng vị trí** trên trang xoay — đã đo lại ở §5 (bốn góc xoay cho cùng một bộ
điểm trong không gian màn hình). Đó là BI-45 / `npm run test:rotate`. Nên report của người dùng là
chính xác và hẹp: **hiển thị đúng, chỉ mất khả năng sửa lại.**

---

## 3. Vùng ảnh hưởng — rộng hơn "một file lạ"

`/Rotate ≠ 0` không phải chuyện hiếm:

1. **Bản vẽ / bộ hồ sơ kỹ thuật** — như file này, gần như luôn có `/Rotate`. Với người dùng đó thì
   tính năng sửa-lại-được coi như **không tồn tại**.
2. **Ảnh scan** đặt ngang.
3. **Chính tính năng "Xoay trang" của app** ([app.js:1647-1648](../desktop/renderer/app.js:1647)) ghi
   `/Rotate`. Nghĩa là: người dùng xoay một trang trong app → từ giây đó hộp văn bản trên trang ấy
   **không còn sửa lại được**. Không có lời cảnh báo nào. Đây là phần đáng lo nhất, vì nó xảy ra
   hoàn toàn bên trong app và người dùng không thể đoán ra.

---

## 4. Phương án

### PA1 — Nói thật, chưa vá (rẻ nhất)
Khi bake trên trang xoay, toast: "Trang đã xoay — chú thích sẽ được dán cố định, không sửa lại được."
Trung thực nhưng để nguyên chỗ hổng.

### PA2 — Cho annotation sửa-lại-được chạy trên trang xoay (**đề xuất**)
Ghi `/AP` form kèm `/Matrix = R(góc xoay)` và tính `/Rect` = bbox của `Matrix × BBox` dịch về đúng
cái mốc mà nhánh dán cứng đang dùng. Đây là cách chuẩn của PDF 32000-1 §12.5.5.

**Đã đo, không phải phỏng đoán** — xem §5. Ba tính chất quan trọng:
- ở cả 4 góc, annotation rơi vào **đúng bộ điểm màn hình** mà nhánh dán cứng hôm nay tạo ra;
- phép `/AP → /Rect` **không có scale** (1.0 ở cả hai trục ở mọi góc) → không méo;
- ở 0° thì `Matrix` là đơn vị và `/Rect` = `[bx, by, bx+w, by+h]` — **trùng khít code hôm nay**, nên
  tài liệu không xoay không đổi một byte.

### PA3 — Bỏ raster xoay sẵn vào PNG (không chọn)
Xoay chính ảnh PNG −góc trên canvas rồi để `/AP` không cần `/Matrix`. Cũng đúng, nhưng phải sửa
`renderTextPng` / `renderArrowPng` (vùng có canvas, không test được từ node) và tốn thêm một lần xoay
canvas. PA2 chỉ chạm phần ghi annotation, rẻ và test được hơn.

**Đề xuất: PA2 + câu toast của PA1 giữ lại cho các trường hợp vẫn phải dán cứng** (ảnh sai định dạng,
`/UserUnit` lạ… — xem §6).

---

## 5. Chứng minh hình học (đã đo)

Phép đo mượn nguyên bộ dụng cụ của `test/annot-rotate.test.js`: bake lên 4 trang **chỉ khác nhau ở
`/Rotate`**, đọc content stream, dựng CTM thật từ các toán tử `cm`, đưa điểm về không gian màn hình
bằng `convertToViewportPoint` của pdf.js. Tham chiếu là nhánh **đang ship**.

Annotation đề xuất được đặt theo đúng thuật toán §12.5.5: `T = bbox(Matrix × BBox)`, `A` đưa `T` về
`/Rect`, nội dung vẽ qua `Matrix` rồi `A`.

Ảnh 120×90 neo tại (40, 60) trong không gian overlay, trang 400×620:

| `/Rotate` | `/Matrix` | `/Rect` | bbox màn hình | scale của `/AP` |
|---|---|---|---|---|
| 0 | `[1,0,0,1,0,0]` | `[40, 470, 160, 560]` | `[40, 60, 160, 150]` | `1, 1` |
| 90 | `[0,1,-1,0,0,0]` | `[60, 40, 150, 160]` | `[40, 60, 160, 150]` | `1, 1` |
| 180 | `[-1,0,0,-1,0,0]` | `[240, 60, 360, 150]` | `[40, 60, 160, 150]` | `1, 1` |
| 270 | `[0,-1,1,0,0,0]` | `[250, 460, 340, 580]` | `[40, 60, 160, 150]` | `1, 1` |

**12/12 phép kiểm đạt.** Ba phép mỗi góc: nhánh dán cứng khớp mốc 0°; annotation khớp nhánh dán cứng;
`/AP` không scale. bbox màn hình `[40, 60, 160, 150]` đúng bằng ô người dùng vẽ (x=40, y=60, w=120,
h=90) ở **cả bốn góc**.

Suy dẫn (để người sau không phải đo lại): nội dung `/AP` là `q w 0 0 h 0 0 cm /NabuImg Do Q`, tức ô
đơn vị → `scale(w,h)` trong không gian form. Nhánh dán cứng phát ra
`translate(bx,by) · R(góc) · scale(w,h)`. Cân hai bên: `Matrix = R(góc)`, phần dịch = `(bx, by)` —
**đúng cái mốc `map(a.x, a.y + a.h)` mà code hôm nay đã tính**. Không có hằng số mới nào.

---

## 6. Bẫy và rủi ro

| # | Bẫy | Xử lý |
|---|---|---|
| P1 | `editor.js` là file rủi ro cao nhất (§1 sổ bất biến). Sai ở đây trông không giống bug — nó giống ảnh của người dùng tự biến mất | Chỉ chạm nhánh ghi annotation. 0° phải ra kết quả **y hệt** hôm nay, và đó là một phép kiểm riêng |
| P2 | `stripManagedFromPage` phải xoá đúng annotation vừa ghi ở mọi góc, không thì re-bake ra hai bản | Grid re-bake của `test:managed` chạy lại ở cả 4 góc |
| P3 | Góc xoay không chia hết 90 (`/Rotate 45` — sai chuẩn nhưng có file như vậy) | Giữ nhánh dán cứng cho mọi góc `% 90 !== 0` |
| P4 | `pdf.js` ẩn `/AP` khi ở chế độ chú thích (`AnnotationMode.DISABLE`) — cơ chế đang chạy để overlay sống không bị trùng bóng với bản đã bake | Không đổi; `ed._managedPages` vẫn là nguồn sự thật |
| P5 | Foxit/Acrobat phải hiển thị đúng, không chỉ viewer của mình | Mục test tay: mở file đã bake bằng Foxit + Acrobat + Chrome ở cả 4 góc |
| P6 | `/Rect` của annotation **không** xoay theo trang, nhưng nhiều viewer *tự* xoay icon `/Text` | Chỉ `note` liên quan, và `note` vốn đã chạy đúng ở mọi góc từ trước |

---

## 7. Kế hoạch thi công

| Bước | Việc | Test |
|---|---|---|
| A0 | Thêm `apMatrixFor(angle)` + `apRectFor(angle, w, h, bx, by)` vào `managed-codec.js` (thuần số học, không pdf-lib state) | ca đơn vị cho 4 góc + góc lệch chuẩn |
| A1 | `addManagedAnnot`: 3 nhánh text/arrow/image dùng `/Matrix` + `/Rect` mới; chỉ còn `return false` khi `angle % 90 !== 0` | `test:managed` |
| A2 | Mở rộng `test:managed`: ghi → lưu → đọc lại ở **cả 4 góc**, cho cả 3 kind | mới |
| A3 | Mở rộng `test:rotate`: thêm phép so "annotation đặt ở đâu" vs "dán cứng đặt ở đâu" cho 4 góc, kèm **ca canh gác** bỏ `/Matrix` ra và đòi nó lệch (không có ca canh gác thì grid xanh không chứng minh gì — cùng lý lẽ với BI-42) | mới |
| A4 | Grid re-bake 3 vòng ở góc 270: không phình file, không nhân bản ảnh | `test:managed` |
| A5 | Sổ bất biến: **BI-59** (số cao nhất đang dùng là BI-58 — đã kiểm) | — |
| A6 | Lưới test tay: 4 góc × {text, arrow, image, note} × {bake, mở lại sửa, kéo, xoá, re-bake} + P5 (Foxit/Acrobat/Chrome) | tay |

**Hồi quy phải giữ:** tài liệu `/Rotate 0` — tuyệt đại đa số — phải cho ra byte **không đổi**. Đó là
phép kiểm đầu tiên của A2, không phải phép cuối.

---

## 8. Report thứ hai — Ảnh → PDF nên mở ra để chỉnh

Người dùng khác góp ý: `Ảnh → PDF` hiện tạo file rồi **bắt Lưu ngay**, không cho sắp xếp lại thứ tự
trang hay chỉnh gì trước.

Đúng, và app **đã có sẵn tiền lệ**: `Gộp nhiều file` làm chính việc đó —
[app.js:3597](../desktop/renderer/app.js:3597) `await loadBytes(bytes, nm, r.path); // open the result so the user can review it`.

Chỗ cần sửa: [`runImagesToPdf`](../desktop/renderer/app.js:3433) hiện đi thẳng
`savePdf(bytes, "images-to-pdf.pdf")` rồi kết thúc.

### Phương án (đề xuất PB2)

- **PB1** — bắt chước y Gộp file: Lưu As → rồi mở file đã lưu. Rẻ nhất, nhưng **vẫn bắt lưu trước**,
  tức không giải quyết đúng điều người dùng xin.
- **PB2 (đề xuất)** — mở luôn thành tài liệu **chưa từng lưu**: `loadBytes(bytes, tên, null)` rồi
  `markDirty()`. Sau đó người dùng sắp xếp trang / chú thích / xoá trang thoải mái, Ctrl+S mới hỏi
  nơi lưu. Đã kiểm: `state.path = null` → `saveDoc()` tự rơi xuống `saveAsDoc()`
  ([app.js:1947-1956](../desktop/renderer/app.js:1947)), nên không cần thêm gì cho đường lưu.
  `markDirty()` là phần **không được quên**: `loadBytes` đặt `dirty = false`, mà một tài liệu chưa
  từng lưu thì "sạch" nghĩa là đóng app không hỏi gì và mất trắng công. Có `markDirty()` thì được
  luôn dấu ●, autosave và khôi phục sau sự cố.
- **PB3** — thêm lựa chọn "Mở để chỉnh / Lưu ngay" trong hộp thoại. Nhiều UI hơn, để sau nếu có ai xin.

### Bẫy của PB2

| # | Bẫy | Xử lý |
|---|---|---|
| Q1 | `loadBytes` hỏi "bỏ thay đổi chưa lưu?" và nếu người dùng **Ở lại** thì bytes vừa tạo bay mất — mất công chờ convert | Cho `loadBytes` trả `true/false` (thêm giá trị trả về là thuần cộng thêm, mọi chỗ gọi cũ đều bỏ qua). Trả `false` → rơi về `savePdf` như hôm nay, không mất gì |
| Q2 | Mở tab mới thay vì đè tài liệu hiện tại thì đẹp hơn — nhưng renderer **không có** API "mở bytes vào tab mới"; đường mở tab của main nhận **đường dẫn file**. Cần plumbing mới | Ngoài phạm vi v1. Đè tài liệu hiện tại, giống Gộp file, có chốt hỏi của `loadBytes` che |
| Q3 | 500 ảnh → PDF vài trăm MB, mở ra là render hết | Không mới: cùng đường như mở file thường, và trần 500 ảnh của sidecar vẫn giữ ([api.py:1274](../api.py:1274)) |
| Q4 | `i2pImages` đang được xoá sau khi lưu xong để không giữ hàng trăm MB | Giữ nguyên thứ tự đó: chỉ xoá **sau khi** đã mở/lưu thành công |

Không cần đổi gì ở sidecar — `/images-to-pdf` đã trả `data_b64` + `pages`.

---

## 9. Quyết định đã chốt

1. **Giới hạn trang xoay** → **PA2, vá hẳn.**
2. **Ảnh → PDF** → **PB2**, mở ra chưa lưu, Ctrl+S mới hỏi nơi lưu.
3. Chọn PA2 nên chỗ hổng §3.3 (Xoay trang làm mất khả năng sửa) **tự hết**; không thêm cảnh báo nào.

---

## 10. Đã thi công

### 10.1 PA2 — chú thích sửa-lại-được trên trang xoay

| File | Việc |
|---|---|
| `renderer/managed-codec.js` (+66) | `normAngle`, `apRotatable`, `apMatrixFor`, `apRectFor` — thuần số học, không đụng pdf-lib state. Thêm vào `_SURFACE` để `editor.js` gọi được bằng tên trần (BI-14) |
| `renderer/editor.js` (+12/−12) | Ba nhánh `/AP` của `addManagedAnnot`. `const angle` tính **một lần** ở đầu hàm; mỗi nhánh đổi `if (angle % 360 !== 0) return false` → `if (!apRotatable(angle)) return false`, `Rect:` → `apRectFor(...)`, và thêm `/Matrix` **chỉ khi** `normAngle(angle)` khác 0 |
| `test/managed-image.test.js` (50→**75**) | Mục 3 viết lại: vòng qua 90/180/270 kiểm ghi → lưu → **đọc lại được**, `/Matrix` đúng `R(góc)`, `/BBox` giữ `w×h` **chưa xoay**, `/Rect` có đúng tỷ lệ đã xoay, strip vẫn xoá được. Cộng ca `/Rotate 45` vẫn dán cứng, ca `apRotatable(-90)`, và ca **0° không có key `/Matrix` nào** |
| `test/annot-rotate.test.js` (96→**124**) | Mục 5 mới + **ca canh gác**. Thêm hai dụng cụ đo: `xobjectUserQuad` (bắt CTM tại từng `Do` — `inkUserPoints` mù với `drawImage` vì nó không phát toán tử path nào) và `apUserQuad` (thực thi §12.5.5 thay vì tin nó) |
| `docs/REGRESSION-GUARD.md` | BI-59 · 2 hàng bản đồ rủi ro · 2 hàng ma trận test · **sửa một dòng đã thành sai**: hàng ảnh round-trip vẫn ghi "ảnh trên trang đã xoay → vẫn dán chết như trước (đúng)" |

**Đo lại trên chính file người dùng gửi** (`/Rotate 270`), chạy đúng `addManagedAnnot` đang ship:

```
page rotate = 270  size = 842x1191
  text  -> managed annotation: true      (trước khi vá: false)
  arrow -> managed annotation: true      (trước khi vá: false)
  image -> managed annotation: true      (trước khi vá: false)
  note  -> managed annotation: true
read back as editable objects: 4
  text   x=100 y=100 w=200 h=30 "Duyệt bản vẽ"
  arrow  (300,200)->(500,400)
  image  x=40 y=60 w=120 h=90
  note   x=600 y=300 w=18 h=18 "ghi chú"
re-bake strips the previous copies: 4
size: original 560937 -> with 4 annots 563703 -> stripped 560956
```

Bốn kind quay về đúng hình học cũ; re-bake xoá sạch cả 4; sau khi strip file chỉ hơn bản gốc **19
byte** → không có object mồ côi.

**Và giả định cuối cùng cũng đã đo.** Cả §5 lẫn `test:rotate` đều thực thi §12.5.5 *theo cách một
viewer đúng chuẩn sẽ làm* — nhưng đó vẫn là mô hình của mình, không phải viewer thật. Nên: dựng 3
file (annot 0°, annot 270°, dán cứng 270°) với cùng một ảnh **đỏ đặc**, rồi **render bằng chính
pdf.js mà app đang ship** (Electron, `AnnotationMode.ENABLE`, scale 1) và đo bbox của pixel đỏ:

| fixture | canvas | pixel đỏ | bbox màn hình |
|---|---|---|---|
| annot 0° (đang ship) | 400×620 | **10 800** | `[40, 60, 160, 150]` |
| annot 270° (bản vá) | 620×400 | **10 800** | `[40, 60, 160, 150]` |
| dán cứng 270° (người dùng thấy hôm nay) | 620×400 | **10 800** | `[40, 60, 160, 150]` |

`10 800 = 120 × 90` **chính xác** ở cả ba — chặt hơn bbox: một con dấu bị co giãn hay lệch 90° sẽ ra
số khác. Canvas 620×400 xác nhận trang thật sự được render **đã xoay**, tức appearance buộc phải
được đặt bù lại mới ra đúng chỗ.

### 10.2 PB2 — Ảnh → PDF mở ra để chỉnh

| File | Việc |
|---|---|
| `renderer/app.js` `loadBytes` | Trả `true` khi tài liệu **thật sự** được thay; `false` ở cả ba đường bỏ giữa (người dùng chọn "Ở lại", huỷ nhập mật khẩu, render lỗi). Thuần cộng thêm — mọi chỗ gọi cũ bỏ qua giá trị trả về |
| `renderer/app.js` `runImagesToPdf` | Mở kết quả thay vì bắt Lưu As. `state.path = null` nên `saveDoc()` tự rơi xuống `saveAsDoc()`. `markDirty()` ngay sau đó — **không được quên**: `loadBytes` đặt `dirty = false`, mà tài liệu chưa từng lưu mà "sạch" thì đóng app là mất trắng và không có file nào để mở lại. Nhánh `false` rơi về `savePdf` như cũ nên công convert không bao giờ mất. Tên gợi ý đổi `images-to-pdf.pdf` → `anh-N-trang.pdf` (giờ nó là **tên tài liệu hiện trên thanh**, không chỉ tên file trong hộp Lưu) |

Không đụng sidecar — `/images-to-pdf` đã trả `data_b64` + `pages`.

### 10.3 Ba điều chỉnh so với bản thiết kế

1. **Không ghi `/Matrix` đơn vị ở 0°.** Thiết kế nói "Matrix = R(góc)", ở 0° là `[1,0,0,1,0,0]`.
   Ghi luôn thì đúng về hình học nhưng **đổi byte của mọi tài liệu không xoay** — tức là biến một
   bản vá cho trường hợp ngoại lệ thành một thay đổi cho toàn bộ người dùng. Bỏ hẳn key khi 0°.
2. **`% 90` thay vì `% 360`.** Thiết kế nói "vẫn dán cứng khi góc không chia hết 90" nhưng chốt cũ
   là `% 360 !== 0`. Nếu chỉ thay `/Matrix` mà giữ chốt cũ thì `/Rotate 45` sẽ được đặt bằng
   `apMatrixFor(45)` — trả về **đơn vị** — và con dấu lệch 45°. `apRotatable` là cửa duy nhất.
3. **`test:rotate` phải bỏ stub.** Grid đó cố ý cho `dataUrlToBytes`/`sniffImage` **ném lỗi** để
   không kind nào lỡ đi qua mà đo không ra gì. Mục 5 cần nhánh image thật, nên hai hàm đó nhận bản
   thật (chúng thuần byte, không canvas); `renderTextPng`/`renderArrowPng` **vẫn ném** vì đó mới là
   phần cần canvas. Đã ghi lại lý do ngay trong header của grid.

### 10.4 Còn lại — máy không làm được

- **§7 A6, lưới tay:** 4 góc × {hộp chữ, mũi tên, ảnh, ghi chú} × {bake, mở lại sửa, kéo, xoá,
  re-bake}. Cái quan trọng nhất **không** phải trang xoay mà là **hồi quy 0°**: bake trên tài liệu
  bình thường phải cho ra byte y hệt bản trước.
- **P5:** mở file đã bake bằng **Foxit + Acrobat + Chrome** ở cả 4 góc. `test:rotate` đo theo
  §12.5.5 như một viewer *đúng chuẩn* sẽ làm, nhưng không thay được việc mở bằng viewer thật.
- Trang landing của site + README: việc lúc phát hành. (`HUONG-DAN-SU-DUNG.md` + `help.js` đã sửa —
  cả hai đang ghi giới hạn cũ như một sự thật.)

---

## 11. Một chỗ hở CÓ TỪ TRƯỚC mà bản vá này làm dễ gặp hơn — chưa sửa

**Phát hiện lúc tự rà, đã đo, KHÔNG do bản vá gây ra.** `/NabuData` lưu hình học trong **không gian
overlay** (= không gian màn hình ở chiều xoay *lúc bake*). Nếu trang bị xoay **sau khi** đã bake, con
dấu đã bake xoay theo trang (đúng) nhưng số trong `/NabuData` thì không:

```
bake ở 0°       : appearance hiện tại [ 40,  60, 160, 150 ] | overlay vẽ ở [40, 60, 160, 150]  ✓ khớp
sau khi Xoay 270°: appearance hiện tại [ 60, 240, 150, 360 ] | overlay vẽ ở [40, 60, 160, 150]  ✗ lệch
```

Nghĩa là: bake chú thích → **Xoay trang** → mở lại Chú thích thì vật thể sống **nhảy sang chỗ khác**
so với chỗ đang thấy. Kích thước cũng đảo (appearance 90×120, overlay 120×90).

Có từ **v0.2.35**, không phải mới. Nhưng trước bản vá này trang xoay chẳng có vật thể sống nào nên
đường "bake rồi xoay" ít ai đi; giờ trang xoay là công dân bình thường nên nó sẽ gặp nhiều hơn.

**Hướng sửa (chưa làm, chưa được yêu cầu):** lưu thêm `r` = góc xoay lúc bake vào `/NabuData`; lúc
import, nếu `r` khác góc hiện tại thì quay hộp hình học từ không gian màn hình cũ sang không gian màn
hình mới. Tương thích ngược: file cũ không có `r` ⇒ coi như `r` = góc hiện tại, tức đúng hành vi hôm
nay. Nhỏ, nhưng nằm trong `serializeManaged`/`deserializeManaged` — đường đi của **mọi** kind — nên
cần lưới riêng, không nên gộp vào bản này.

**Hai việc liên quan, cũng chưa làm:**
- `src/signing-worker.js` `buildImageAP` là bản sao cùng hình dạng, cũng không có `/Matrix`. Nó
  **từ chối thẳng** trang xoay (`reason: "rotated"` — "Trang xoay chưa hỗ trợ chữ ký nhìn thấy") nên
  không phải bug im lặng. Nhưng `apMatrixFor`/`apRectFor` giờ đã có sẵn, nên chỗ từ chối đó **mở
  được** nếu muốn.
- Watermark trên trang xoay vẫn đi đường dán cứng (`drawWatermark`) — đúng theo thiết kế, watermark
  chưa bao giờ là vật thể sống.
