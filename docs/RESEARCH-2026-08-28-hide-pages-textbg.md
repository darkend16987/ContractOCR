# Nghiên cứu khả thi — (1) Ẩn trang có khoá · (2) Nền cho hộp văn bản

_Lập 2026-08-28 · trên nhánh `claude/vietnamese-ocr-ai-iSvwV` @ `c0099cb` (app v0.2.63)._

_Trạng thái: **ĐÃ THỰC HIỆN — phát hành ở v0.2.64 (2026-08-28)**. Cả Pha A lẫn Pha B đã ship
theo đúng phương án khuyến nghị dưới đây. Bất biến rút ra: **BI-71 → BI-74** trong
`docs/REGRESSION-GUARD.md`. Tài liệu này giữ lại **lý do** và **số đo** — đừng điều tra lại._

_Mọi con số dưới đây là **đo được** bằng probe chạy thật, không suy đoán — danh sách probe
ở §1.2 để chạy lại._

> **Ba đính chính sau khi làm thật, ghi lại để không hiểu nhầm tài liệu này:**
> 1. §2.5 dự tính thêm ca vào `test:rotate` cho hộp chữ có nền. **Không làm được, và không
>    cần:** lưới đó **cố ý không** dẫn hộp chữ nào (hai rasteriser canvas bị stub cho ném
>    lỗi — xem đầu `annot-rotate.test.js`). Phần xoay của nền được phủ trong `test:managed`,
>    ở khối stub-canvas của `renderTextPng` (ca `rot 30`).
> 2. §3.7 dự tính `looksLikeVaultFile` không có. Hoá ra **cần**: đo được rằng `doc.save()`
>    của pdf-lib gói object thường vào **object stream**, nên `/NabuVault` trên page dict
>    **không** quét được bằng byte. Marker phải nằm trên **dict của stream** (`/NabuVaultBlob`)
>    — pdf-lib không bao giờ gói stream. Nhờ vậy câu hỏi “file này có trang ẩn không?” trả lời
>    bằng một phép so byte thay vì `PDFDocument.load` (~53 ms trên file 200 trang).
> 3. §3.8 đánh số V12 nằm ngoài dãy V1–V11; trong `test/page-vault.test.js` nó nằm cùng
>    nhóm với V4–V7 (cùng là ca “sống sót”).

---

## 0. Kết luận ngắn

| | Khả thi? | Cỡ việc | Rủi ro | Cần sidecar/Python? |
|---|---|---|---|---|
| **(2) Nền phía sau hộp văn bản** | **Có** — thẳng thớm | Nhỏ (~1 phiên, ~120 dòng) | **Thấp**, có đúng **1** chỗ hình học phải làm đúng | Không |
| **(1) Ẩn trang bằng mật khẩu** | **Có**, nhưng chỉ theo **một** phương án | Trung bình (~2–3 phiên, ~500–700 dòng) | **Cao nếu làm sai** — đã tìm ra **4 cạm bẫy mất dữ liệu vĩnh viễn** | Không |

Khuyến nghị làm **(2) trước** (rẻ, người dùng đang kêu), **(1) sau** và làm theo đúng
phương án B2 ở §3.3 — các phương án còn lại đều **mất dữ liệu im lặng** ở những đường code
mà app **đã có sẵn** (chứng minh bằng probe, không phải lo xa).

---

## 1. Phương pháp luận

### 1.1 Nguyên tắc

Bài học đã ghi trong `docs/REGRESSION-GUARD.md`: _lỗi nặng nhất tìm ra bằng cách chạy thật,
không phải đọc code_. Nên trước khi thiết kế, mọi giả định kiểu “cái này có sống sót không /
API này có tồn tại không” đều được **đo bằng probe chạy thật**, dùng đúng thư viện đang ship:
`pdf-lib 1.17.1` trong `node_modules`, `PyMuPDF 1.27.2.3` trong `.venv`, và Electron của dự án
với đúng `webPreferences` mà `tabs.js:81-83` đang dùng.

### 1.2 Bốn probe đã chạy (file dùng một lần, ở scratchpad — không commit)

| Probe | Câu hỏi | Kết quả |
|---|---|---|
| `probe-hidden.js` (node + pdf-lib) | Cất một blob ở đâu trong PDF thì **sống sót các thao tác app đang có**? | bảng §3.2 |
| `probe-fitz.py` (venv + PyMuPDF) | Blob có sống qua vòng sidecar không? | sống, **nhưng bị bọc `/FlateDecode`** |
| `probe-crypto-main.js` (Electron thật) | Renderer `file://` có `crypto.subtle` không? | **có** — §3.5 |
| `probe-textgeom.js` (node + `annot-text.js` thật) | Hộp chữ trên màn hình và PNG bake có **trùng khung** không? | **lệch 2.40pt** — §2.3 |

### 1.3 Checkpoint đã tra trong sổ bất biến

`BI-3` (mọi thay đổi `state.bytes` phải qua `pushUndo` trước) · `BI-4` (không đọc pixel canvas
viewer) · `BI-9` (`GATED_BTNS`) · `BI-10` (i18n `SKIP_IDS`) · `BI-14` (scope chung, tên trần)
· `BI-37`/`BI-38` (stream `/NabuSrc`, giải phóng chuỗi object) · `BI-40` (màn hình ≠ PNG bake
= sai **im lặng**) · `BI-59` (`/AP` trên trang xoay).

---

## 2. Tính năng (2) — nền phía sau chữ trong hộp văn bản

### 2.1 Hiện trạng (đọc từ code)

- Cơ chế “nền + độ mờ” **đã có sẵn** cho `box` / `ellipse` / `cloud` / `cloudpen`: hai trường
  `a.fill` + `a.fillOpacity`, ba control đã dựng trong `index.html:318-320` (`#ed-fill`,
  `#ed-fill-none`, `#ed-fill-opacity`), hiện/ẩn bằng `data-ctl="fill"`.
- Hộp văn bản (`kind: "text"`) **chưa** có `fill`. Nó vẽ:
  - trên màn hình: `editor.js:801-838` — một `<div>` đặt tại `a.x,a.y` cỡ `a.w,a.h`;
  - trong PDF: **cả hai đường bake đều gọi chung một hàm** `renderTextPng()` (`editor.js:2238`)
    — đường dán cứng `drawOneAnnot` (`editor.js:2837`) **và** đường annotation sửa-lại-được
    `addManagedAnnot` (`editor.js:2588`).

👉 **Đây là điểm làm tính năng này rẻ:** thêm nền vào `renderTextPng` là **một chỗ sửa duy
nhất** ăn cho cả bake phẳng lẫn `/AP`, cả trang thẳng lẫn trang `/Rotate`.

### 2.2 Thiết kế đề xuất

**Dùng lại đúng từ vựng đã có:** `a.fill` + `a.fillOpacity`, không đẻ tên mới (`bg`/`bgColor`)
— `serializeManaged`, `deserializeManaged`, `syncControls` đều đã biết đọc hai tên đó.

1. **Tập `FILLABLE_KINDS`.** Danh sách `["box","ellipse","cloud","cloudpen"]` hiện **chép tay
   ở 3 chỗ** (`editor.js:1191` `syncControls`, `editor.js:4015` `applyFillToSel`, và
   `isVectorKind` trong `managed-codec.js`). Chính comment ở `editor.js:76` cảnh báo kiểu chép
   tay này là cách các chỗ đó **trôi ra khỏi nhau**. → Khai một
   `const FILLABLE_KINDS = new Set([...4 kind cũ, "text"])` cạnh `RESIZABLE_KINDS`
   (`editor.js:65`) và dùng ở cả 3 chỗ.
   ⚠️ **Không** thêm `"text"` vào `isVectorKind` — hàm đó lái sang `shapeAppearance()`
   (appearance **vector**), hộp văn bản phải tiếp tục đi đường raster PNG.
2. **Slot ghi nhớ riêng cho chữ.** `ed.fillColor/fillOn/fillOpacity` đang dùng chung cho 4
   hình. Dùng chung luôn cho chữ thì bật “nền trắng 60%” cho hộp văn bản xong vẽ hình chữ nhật
   sẽ **ra hình chữ nhật trắng 60%** — bất ngờ. App **đã có tiền lệ** tách slot:
   `COLOR_SLOTS`/`colorSlotFor()` (`editor.js:98`) tách màu cho `highlight`/`redact`/`check`,
   và `ed.textOpacity` là slot riêng của chữ. → Thêm `ed.textFillColor / textFillOn /
   textFillOpacity` + một `fillSlotFor(tool)` đúng khuôn `colorSlotFor`.
3. **Vẽ trên màn hình** — xem §2.3, đây là chỗ duy nhất phải cẩn thận.
4. **Vẽ vào PDF**: trong `renderTextPng`, **trước** vòng lặp `lay.ops`, thêm
   `cx.globalAlpha = s.opacity; cx.fillStyle = rgba(fill, fillOpacity); cx.fillRect(0,0,cw,chh)`
   — đặt **sau** khối `if (s.rot) { translate/rotate }` để nền quay cùng chữ.
   Nhân `s.opacity` vào là **bắt buộc**: trên màn hình `applyTextCss` đặt `el.style.opacity`
   lên **cả phần tử**, nên nếu raster không nhân thì chữ mờ mà nền đặc → lệch (BI-40).
5. **Round-trip**: thêm `fill`/`fillOpacity` vào nhánh `text` của `serializeManaged`
   (`managed-codec.js:373`) và `deserializeManaged` (`editor.js:2436`), **theo đúng kiểu nhánh
   vector đang làm**: chỉ ghi khoá khi thực sự có nền (`if (a.fill && a.fill !== "none")`)
   ⇒ file cũ (không có khoá) đọc ra vẫn là “nền trong suốt”, y như hôm nay.
6. **Bảng control**: thêm `"fill"` vào `TOOL_CTLS.text` và `KIND_CTLS.text` (`editor.js:3331`,
   `editor.js:3352`).

### 2.3 ⚠️ Điểm phải làm đúng: khung của `<div>` **không** trùng khung của PNG

Đo bằng `probe-textgeom.js`, chạy trên chính `annot-text.js` đang ship (chữ “Hello world”, 16pt):

```
element box (màn hình) : left = a.x + 0.00   w = 93.00  h = 26.00   tâm = a.x + 46.50
raster  box (PNG bake) : left = a.x − 2.40   w = 93.33  h = 26.33   tâm = a.x + 44.27
                                     ↑ cùng KÍCH THƯỚC, lệch đúng pad = fontSize × 0.15
```

Lý do: `measureText` trả `w = layout + 2·pad`, nhưng chữ trên màn hình vẽ từ **góc trên-trái**
của `<div>` (`.an-text` không có padding — `app.css:655`), trong khi trong PNG chữ nằm **thụt
vào `pad` ở cả 4 phía** và bake bù lại bằng cách đặt ảnh ở `a.x − padPt` (`editor.js:2844`).

Hệ quả: **nếu làm cách hiển nhiên nhất — `el.style.background = ...` — thì nền trên màn hình và
nền trong file lệch nhau 2.4pt (~3px ở zoom 100%).** Chữ lệch 2.4pt thì không ai thấy; **mép một
khối nền màu lệch 2.4pt thì thấy ngay**, và đó đúng là kiểu lỗi im lặng BI-40 nói tới.

**Cách làm đúng (phương án 2A — khuyến nghị):** không đụng hình học của `<div>`; vẽ nền bằng
**một `<div>` lót nằm dưới**, là con của phần tử chữ:

```
left: −pad·s    top: −pad·s    width: a.w·s    height: a.h·s    z-index: −1
```

→ trùng **khít** khung PNG khi `rot = 0` (ca chiếm gần như toàn bộ thực tế). Khi `rot ≠ 0`, nền
là con của phần tử đang quay nên **nó lệch đúng bằng lượng chữ đang lệch** — tức là nền **không
bao giờ trôi so với chữ của chính nó**, đó mới là tính chất cần giữ.

> **Ghi nhận phụ (chưa phải lỗi phải sửa ngay):** phép tính trên cho thấy hộp văn bản **đã xoay**
> hiện có sẵn một sai lệch màn-hình-vs-PDF cỡ `pad` (tâm quay lệch 2.23pt) từ **trước** khi có
> tính năng này. Nếu muốn dọn thì đó là **phương án 2B**: dời `<div>` về `(a.x−pad, a.y−pad)` và
> cho nó `padding: pad`, khi đó hai khung trùng tuyệt đối và tâm quay cũng trùng. Nhưng 2B đụng
> `annotBounds` (`annot-geom.js:290`, đang có lưới), đụng viền chọn, đụng căn lề (`alignSel`)
> → **đừng gộp vào đợt này**; đó là refactor riêng, làm sau khi 2A đã ship và test tay xanh
> (đúng luật “kiểm chứng trước, refactor sau” của §1 sổ bất biến).

### 2.4 Danh sách chỗ đụng (ước lượng ~120 dòng)

| File | Việc |
|---|---|
| `desktop/renderer/editor.js` | `FILLABLE_KINDS` · `fillSlotFor` · `ed.textFill*` · nhánh `text` của `renderAnnot` (div lót) · `renderTextPng` (fillRect) · `TOOL_CTLS`/`KIND_CTLS` · `syncControls` · `applyFillToSel` · 3 handler `#ed-fill*` · chỗ tạo hộp chữ (`editor.js:1851`) |
| `desktop/renderer/managed-codec.js` | `serializeManaged` nhánh `text` |
| `desktop/renderer/app.css` | 1 rule cho `.an-text-bg` |
| `desktop/renderer/index.html` | sửa `title=` của 3 control cho đúng cả chữ lẫn hình |
| `desktop/renderer/help.js` | 1 mục hướng dẫn (bắt buộc cặp vi/en — `npm run test:help`) |
| `desktop/renderer/i18n.js` | chuỗi mới nếu có |

### 2.5 Lưới test

**Tự động:**

- `npm run test:text` — thêm ca: `normTextStyle` **không** nuốt/đổi `fill`; `measureText`
  **không đổi** khi có nền (nền không được ảnh hưởng bố cục chữ — ca canh gác).
- `npm run test:managed` — ca round-trip: hộp chữ có nền → serialize → deserialize → **cùng
  `fill` + `fillOpacity`**; và hộp chữ **không** nền → `/NabuData` **không có khoá `fill`**
  (giữ byte y như trước).
- `npm run test:rotate` — lưới này đi qua **mọi** kind, so `/AP` với đường dán cứng; hộp chữ có
  nền phải qua ở cả `/Rotate` 0/90/180/270.
- `npm run test:defaults` — hộp chữ mới **mặc định không nền** (không đổi hành vi cũ).

**Test tay (lưới check):**

| # | Ca | Kỳ vọng |
|---|---|---|
| T1 | Hộp chữ nền vàng 100% trên nền trắng | Màn hình & PDF cùng một khung, mép trùng |
| T2 | Nền 30% | Nhìn xuyên qua thấy nội dung trang, PDF giống hệt màn hình |
| T3 | Nền + “mờ chữ” (`textOpacity`) 50% | Cả chữ **và** nền cùng mờ 50% ở cả 2 nơi |
| T4 | Nền + xoay 45° | Nền quay cùng chữ, **không** trôi khỏi chữ |
| T5 | Nền + `charScale` 60% | Nền ôm đúng bề ngang đã bóp |
| T6 | Áp dụng → Chỉnh sửa lại → sửa chữ | Nền còn nguyên (round-trip `/NabuData`) |
| T7 | Áp dụng → Đánh số trang (qua sidecar) → mở lại | Nền còn (đường này ép `/FlateDecode`) |
| T8 | Trang `/Rotate 90` | Nền không méo (BI-59) |
| T9 | File cũ có hộp chữ (trước tính năng này) | Vẫn trong suốt, không tự mọc nền |
| T10 | Chọn hình chữ nhật rồi chọn hộp chữ | Control nền hiện đúng giá trị **của từng loại** (slot riêng) |
| T11 | Thanh chú thích khi chọn công cụ Hộp văn bản | Không tràn mất nút “Xong” (thanh có `flex-wrap`, nhưng phải nhìn) |
| T12 | In (Ctrl+P) | Nền in ra, không phải khoảng trắng |

### 2.6 Rủi ro

- **Thấp.** Không đụng `state.bytes`, không đụng cấu trúc trang, không đụng sidecar.
- Rủi ro duy nhất đáng kể là §2.3 — đã có phương án, có ca T1/T4 canh.
- Rủi ro phụ: thanh chú thích của công cụ chữ dài thêm 3 control (~+230px). Thanh là 1 hàng flex
  có `flex-wrap` nên không mất nút, nhưng có thể xuống 2 hàng ở cửa sổ hẹp → T11.

---

## 3. Tính năng (1) — ẩn trang bằng mật khẩu

### 3.1 Sự thật về định dạng PDF (phải nói trước, vì nó quyết định thiết kế)

- **PDF không có khái niệm “trang ẩn”.** Object trang không có cờ hidden nào; cây `/Pages` liệt
  kê trang nào thì viewer hiện trang đó. (Annotation _thì có_ cờ Hidden — bit 2 của `/F`; nội
  dung _thì có_ Optional Content Group. **Trang thì không.**)
- **Mã hoá trong PDF là của cả tài liệu**, một khoá cho cả file. Không có “mật khẩu riêng cho
  trang 5” trong chuẩn.

⇒ Muốn có “trang ẩn mở bằng mật khẩu” thì **phải tự định nghĩa cơ chế**. Có 3 hướng:

| Hướng | Cách làm | Bảo mật thật? | Mở lại được ở phần mềm khác? |
|---|---|---|---|
| **C1 — Optional Content (layer)** | Bọc nội dung trang trong OCG mặc định OFF | ❌ **Không**. Viewer nào có bảng Layers cũng bật lên xem được; chữ vẫn tìm kiếm/copy được | Có (và đó chính là vấn đề) |
| **C2 — Mã hoá cả file** | `/encrypt` (đã có sẵn, `api.py:1137`) | ✅ Có, nhưng **all-or-nothing** — khoá cả tài liệu | Có |
| **C3 — Bóc trang ra, mã hoá, nhét lại vào chính file** | tách trang → AES-256-GCM → cất blob trong file → thay trang | ✅ **Có** | Không — chỉ Nabu mở lại được |

**Khuyến nghị: C3.** C1 là “ẩn” theo nghĩa mỹ thuật, không phải theo nghĩa bảo mật — bán ra mà
gọi là “mật khẩu” là nói dối người dùng. C2 đã có rồi và không giải quyết bài toán.

### 3.2 Chỗ khó thật sự: **cất cái blob ở đâu trong file cho nó sống**

App này đã có sẵn hàng chục thao tác ghi lại `state.bytes`. Câu hỏi sống-chết là: khoá tự chế
của mình có sống sót các thao tác đó không? Bảng **đo được** bằng `probe-hidden.js` (pdf-lib
1.17.1 — đúng bản đang ship):

| Nơi cất blob | save→load | **reorder trang** | xoá trang khác | ghép/chèn file |
|---|---|---|---|---|
| Khoá riêng trên **catalog** (`/Root`) | ✅ | ❌ **MẤT** | ✅ | ✅ |
| Khoá riêng trên **page dict** | ✅ | ✅ | ✅ | ✅ |
| Khoá riêng trên **annotation** | ✅ | ✅ | ✅ | ✅ |

Cột “reorder trang” là `reorderPages()` ở `app.js:1674-1680` — nó dựng lại tài liệu bằng
`PDFDocument.create()` + `copyPages()`, và **catalog cũ bị bỏ lại**. Tức là: _kéo thả sắp xếp
trang một cái là bay sạch trang ẩn._ Không phải giả thuyết — probe in ra `MISSING`.

Probe PyMuPDF (`probe-fitz.py`) cho thấy cả 3 nơi đều sống qua vòng sidecar (`garbage=0/1/3/4`,
`clean=True`, `encrypt→decrypt`) — **nhưng** xem cạm bẫy CB-3.

### 3.3 Phương án đề xuất — **B2: “trang giữ chỗ có khoá”**

Ẩn trang _i_:

1. Bóc trang _i_ ra thành PDF 1 trang (`PDFDocument.create()` + `copyPages`).
2. Mã hoá bằng AES-256-GCM, khoá dẫn xuất từ mật khẩu bằng PBKDF2-SHA256 (§3.5).
3. **Thay** trang _i_ bằng một **trang giữ chỗ** cùng khổ giấy, in dòng
   “🔒 Trang này đã được ẩn — cần mật khẩu (Nabu PDF)”.
4. Ciphertext cất trong **stream thô treo vào chính page dict của trang giữ chỗ**, khoá riêng
   `/NabuVault` (+ header JSON: version, KDF, số vòng, salt, IV, gợi ý mật khẩu).

Bỏ ẩn: nhập mật khẩu → giải mã → `copyPages` trang gốc về đúng vị trí trang giữ chỗ → xoá trang
giữ chỗ.

> Chữ tiếng Việt trên trang giữ chỗ **không cần nhúng font**: dựng bằng canvas → PNG như
> `renderTextPng` đang làm. Đó là khuôn có sẵn trong repo.

**Vì sao B2 chứ không phải “xoá hẳn trang” (B1):**

- Blob **đi cùng trang** ⇒ sắp xếp lại trang, xoá trang khác, ghép file, tách file, chuyển sang
  tab khác… đều không làm mất nó (đã đo — bảng §3.2). Với B1, blob phải bám nhờ vào **một trang
  khác**; người dùng xoá đúng trang đó là mất vĩnh viễn, và không có cách nào cảnh báo.
- **Số trang không đổi.** Với app hợp đồng thì đây là tính năng chứ không phải nhược điểm:
  “trang 7/12” vẫn là trang 7/12, mục lục và tham chiếu chéo không lệch.
- Người mở bằng Acrobat **hiểu chuyện gì đang xảy ra** thay vì tưởng file thiếu trang.
- 1 trang ẩn = 1 trang giữ chỗ ⇒ ẩn/bỏ ẩn từng trang độc lập, undo đơn giản.

**Nhược điểm phải nói thẳng:** vẫn nhìn thấy _có_ trang bị ẩn (chỉ không đọc được nội dung), và
**file không nhỏ đi** (nội dung vẫn nằm trong đó, dạng mã hoá).

### 3.4 Bốn cạm bẫy mất dữ liệu — đã tìm ra, phải chặn ngay từ thiết kế

> Đây là phần đáng giá nhất của nghiên cứu này. Cả bốn đều **im lặng** — không lỗi, không cảnh
> báo, chỉ là trang ẩn biến mất.

**CB-1 · Không được đặt tên khoá là `/NabuKind`.**
`stripManagedFromPage` (`managed-codec.js:533-552`) **xoá mọi annotation có `/NabuKind`** (trừ
ảnh không đọc được). Người dùng chú thích lên trang giữ chỗ rồi bấm “Áp dụng” là annot kho bị
dọn đi cùng. → Dùng **namespace riêng `/NabuVault`**, đặt trên **page dict** (không phải
annotation) ⇒ máy móc managed-annot không bao giờ nhìn thấy nó. Cần **ca canh gác**: chạy
`stripManagedAnnots` trên tài liệu có `/NabuVault` → blob còn nguyên.

**CB-2 · Không được cất blob ở catalog.** Xem bảng §3.2 — reorder trang là mất.

**CB-3 · Phải đọc được stream đã bị nén lại.**
Probe PyMuPDF cho thấy sau bất kỳ vòng sidecar nào (`/add-page-numbers`, `/edit-text`,
`/compress`, Tìm & Thay thế…), stream mình ghi ra **không filter** quay về với `/FlateDecode`:

```
stream obj 8 << /NabuFmt /blob  /Length 17  /Filter /FlateDecode >>
```

Luật hiện hành của app cho ảnh round-trip là _“có `/Filter` ⇒ không tin, bỏ qua”_ (BI-37) — với
ảnh thì hậu quả là “ảnh thành chỉ đọc” (chấp nhận được). Với trang ẩn thì hậu quả là **không
giải mã lại được nữa = mất trang vĩnh viễn** ⇒ **không được dùng luật đó**.
→ Đường đọc blob phải **tự giải nén**: `DecompressionStream("deflate")` — đã đo là **có** trong
renderer (§3.5). Filter lạ (LZW/JBIG2/…) ⇒ **báo lỗi rõ ràng và tuyệt đối không xoá gì**.

**CB-4 · Bản rõ còn nằm trong undo + file autosave khôi phục.**
`pushUndo()` (`app.js:201`) giữ snapshot `state.bytes` **trước khi ẩn** trong RAM, và autosave
(`app.js:322` `autosaveTick`) **ghi snapshot xuống đĩa** trong thư mục recovery. Ẩn trang xong mà
không dọn thì bản rõ của trang “đã ẩn” vẫn nằm trên đĩa.
→ Sau khi ẩn thành công: gọi `resetHistory()` (`app.js:182`) + ghi đè snapshot recovery bằng bản
đã ẩn (`window.desktop.recovery.save`). Đánh đổi: **Ctrl+Z không hoàn tác được thao tác ẩn** —
chấp nhận được vì bỏ ẩn bằng mật khẩu vừa nhập là xong, và phải **nói rõ trong hộp thoại**.

> Ngoài tầm với: file gốc trên đĩa (chưa lưu đè), Windows shadow copy, bản in. Nói thật với người
> dùng, đừng hứa quá.

### 3.5 Mật mã — chạy ở đâu

Đo bằng `probe-crypto-main.js`, chạy Electron thật với đúng `webPreferences` của `tabs.js`
(`sandbox: true, contextIsolation: true, nodeIntegration: false`):

```json
{"isSecureContext": true, "origin": "file://", "hasSubtle": true,
 "aesRoundTrip": "hello", "hasDecompressionStream": true, "inflate": "hello"}
```

⇒ **Không cần IPC, không cần sửa main process, không cần Python.** Toàn bộ tính năng nằm trong
renderer: `pdf-lib` (đã có) + WebCrypto (có sẵn) + `DecompressionStream` (có sẵn). Cũng có nghĩa
là **chạy được cả khi sidecar chưa sẵn sàng**, và không đẻ thêm ràng buộc giấy phép nào.

Tham số đề xuất (ghi vào header để sau này đổi được mà file cũ vẫn đọc): `PBKDF2-SHA256`,
≥ 300.000 vòng, salt 16 byte ngẫu nhiên mỗi trang, `AES-256-GCM`, IV 12 byte ngẫu nhiên. Sai mật
khẩu = GCM tag không khớp ⇒ báo “Sai mật khẩu”, **không** cần lưu hash mật khẩu ở đâu cả.

### 3.6 Luồng người dùng đề xuất

- **Ẩn**: chuột phải thumbnail → “Ẩn trang này…” / “Ẩn N trang đang chọn…” → hộp thoại: mật khẩu
  + nhập lại + gợi ý (tuỳ chọn) + 2 dòng cảnh báo (mất mật khẩu = mất trang; ẩn xong sẽ xoá lịch
  sử hoàn tác).
- **Nhận biết**: trang giữ chỗ có badge 🔒 trên thumbnail + một dòng ở thanh trạng thái
  “🔒 2 trang đang ẩn”.
- **Bỏ ẩn**: chuột phải trang giữ chỗ → “Bỏ ẩn trang…” → nhập mật khẩu (dùng lại
  `promptPassword()` `app.js:585`) → trang về chỗ cũ. Chọn nhiều trang giữ chỗ cùng mật khẩu thì
  bỏ ẩn một lượt.
- **Lối thoát an toàn**: khi đang có trang ẩn, thêm tuỳ chọn **“Xuất bản sao KHÔNG kèm trang ẩn”**
  cho người muốn gửi ra ngoài mà không mang theo ciphertext.

### 3.7 Chỗ đụng (ước lượng ~500–700 dòng)

| File | Việc |
|---|---|
| **mới** `desktop/renderer/page-vault.js` | Toàn bộ phần thuần: KDF/AES, đóng-mở gói `/NabuVault`, đọc stream có/không `/Filter`. Theo **khuôn `managed-codec.js`** (IIFE + `Object.assign(window, …)`) vì có destructure từ pdf-lib → `require()` được từ node ⇒ **có lưới test ngay từ đầu** |
| `desktop/renderer/app.js` | 2 mục menu chuột phải (`openThumbMenu:1593`), badge thumbnail, dòng thanh trạng thái, gọi `resetHistory` sau khi ẩn |
| `desktop/renderer/index.html` + `app.css` | Hộp thoại đặt mật khẩu (mật khẩu + xác nhận + gợi ý), badge 🔒 |
| `desktop/renderer/help.js` | Mục hướng dẫn (bắt buộc cặp vi/en) |
| `desktop/renderer/i18n.js` | Chuỗi mới + `SKIP_IDS` cho phần tử động (BI-10) |
| `desktop/src/main.js` | **Không đụng** |
| `api.py` | **Không đụng** |
| `docs/REGRESSION-GUARD.md` | 3 bất biến mới (§5) |
| `desktop/package.json` | `"test:vault": "node test/page-vault.test.js"` |

### 3.8 Lưới test

**Tự động (`npm run test:vault`, chạy pdf-lib thật trong node — đúng khuôn `test:managed`):**

| # | Ca | Kỳ vọng |
|---|---|---|
| V1 | ẩn → bỏ ẩn | trang gốc khôi phục đúng nội dung, đúng vị trí |
| V2 | sai mật khẩu | ném lỗi rõ ràng, **không** sửa gì trong tài liệu |
| V3 | ẩn 3 trang rời rạc → bỏ ẩn từng trang | thứ tự đúng sau mỗi bước |
| V4 | ẩn → `create()+copyPages` (mô phỏng reorder `app.js:1674`) → bỏ ẩn | **còn** |
| V5 | ẩn → `removePage` trang khác → bỏ ẩn | còn |
| V6 | ẩn → ghép thêm file khác → bỏ ẩn | còn |
| V7 | ẩn → `stripManagedAnnots()` (mô phỏng bake chú thích) → bỏ ẩn | **còn** (CB-1) |
| V8 | blob đã bị bọc `/FlateDecode` | đọc được (CB-3) |
| V9 | blob bị filter lạ | báo lỗi, **không** xoá trang giữ chỗ |
| V10 | `/NabuVault` hỏng/thiếu khoá | không crash, không mất trang giữ chỗ |
| V11 | 2 trang ẩn bằng 2 mật khẩu khác nhau | mở đúng trang tương ứng |
| V12 | ẩn trang có annotation + trang `/Rotate 90` | khôi phục nguyên vẹn cả annot lẫn `/Rotate` |

**Test tay (phải chạy thật, không suy luận):**

| # | Ca | Kỳ vọng |
|---|---|---|
| M1 | ẩn → Lưu → đóng app → mở lại → bỏ ẩn | được |
| M2 | ẩn → Đánh số trang (sidecar) → bỏ ẩn | được (ca ép `/FlateDecode` thật) |
| M3 | ẩn → Tìm & Thay thế → bỏ ẩn | được |
| M4 | ẩn → Nén file (`/compress`) → bỏ ẩn | được |
| M5 | ẩn → khoá cả file bằng mật khẩu (`/encrypt`) → mở khoá → bỏ ẩn | được |
| M6 | ẩn → kéo thả sắp xếp trang → bỏ ẩn | được (ca chết người của phương án catalog) |
| M7 | ẩn → chú thích lên trang giữ chỗ → Áp dụng → bỏ ẩn | được (CB-1) |
| M8 | mở file có trang ẩn bằng Acrobat/Chrome | thấy trang giữ chỗ, **không** đọc được nội dung, file không lỗi |
| M9 | ẩn xong kiểm tra thư mục recovery | không còn bản rõ (CB-4) |
| M10 | ẩn → In | trang giữ chỗ in ra, không phải nội dung gốc |
| M11 | Tách/Trích trang giữ chỗ ra file mới → bỏ ẩn ở file mới | được |
| M12 | Chuyển trang giữ chỗ sang tab khác (`page-move.js`) | blob đi theo |

### 3.9 Giới hạn phải ghi rõ trong Hướng dẫn sử dụng

1. Mất mật khẩu = **mất trang**, không có đường khôi phục.
2. Chỉ **Nabu PDF** mở lại được trang ẩn. Phần mềm khác chỉ thấy trang giữ chỗ.
3. **File không nhỏ đi.**
4. Nếu ai đó mở file bằng công cụ khác rồi lưu đè theo kiểu bỏ hết khoá lạ, trang ẩn có thể mất.
   (Đã đo: PyMuPDF và pdf-lib giữ nguyên; các công cụ khác **chưa đo**.)
5. Không chống được người **đã có** mật khẩu, và không chống được đoán mật khẩu yếu.

---

## 4. Kế hoạch theo bước (có checkpoint dừng được)

**Pha A — Nền hộp văn bản (làm trước, độc lập hoàn toàn)**

- A1. `FILLABLE_KINDS` + `fillSlotFor` + `ed.textFill*` — chạy `test:defaults`, `test:text`.
- A2. Vẽ màn hình (div lót) + `renderTextPng` (fillRect). **Checkpoint:** chụp màn hình so với
  PDF xuất ra ở T1/T2/T4 — _đây là chỗ duy nhất phải nhìn bằng mắt_.
- A3. Round-trip `/NabuData` + ca mới trong `test:managed`, `test:rotate`.
- A4. Help + i18n → `test:help`. Chạy **toàn bộ** lưới. Test tay T1–T12. → phát hành.

**Pha B — Ẩn trang (chỉ bắt đầu sau khi A đã ship)**

- B1. `page-vault.js` thuần + `test:vault` V1–V3, V8–V11. _Chưa có UI._ **Checkpoint:** lưới xanh
  trước khi viết một dòng UI nào.
- B2. Ca sống-sót V4–V7, V12. **Checkpoint:** nếu V7 đỏ thì thiết kế sai, quay lại §3.4.
- B3. UI: menu chuột phải, hộp thoại mật khẩu, badge, thanh trạng thái.
- B4. Dọn bản rõ (CB-4) + hộp thoại cảnh báo.
- B5. Test tay M1–M12. **Checkpoint:** M6, M7, M9 là ba ca không được phép đỏ.
- B6. Help + i18n + ghi 3 bất biến vào `REGRESSION-GUARD.md`. → phát hành.

---

## 5. Bất biến đề xuất bổ sung vào `docs/REGRESSION-GUARD.md`

- **BI-mới-A · Nền hộp văn bản chỉ được vẽ ở `renderTextPng` (PDF) và div lót (màn hình), và hai
  khung lệch nhau đúng `pad`.** Vẽ nền bằng `el.style.background` là sai 2.4pt — im lặng.
  Lưới: `test:rotate` + test tay T1/T4.
- **BI-mới-B · Kho trang ẩn dùng namespace `/NabuVault` trên PAGE DICT — không bao giờ
  `/NabuKind`, không bao giờ catalog.** `/NabuKind` bị `stripManagedFromPage` dọn; catalog bị
  `reorderPages` bỏ lại. Lưới: `test:vault` V4 + V7.
- **BI-mới-C · Đường đọc kho trang ẩn phải chịu được `/Filter /FlateDecode`.** Luật “có filter ⇒
  bỏ qua” của BI-37 **không** áp dụng ở đây: sidecar của chính app nén lại stream, và ở đây “bỏ
  qua” nghĩa là mất trang. Lưới: `test:vault` V8 + test tay M2.

---

## 6. Bốn quyết định đã chốt (2026-08-28)

| # | Câu hỏi | **Đã chốt** | Kéo theo |
|---|---|---|---|
| 1 | Mục tiêu của “ẩn trang” | **Bảo mật thật, đi theo file** | Đi hướng **C3** (§3.1). Không làm chế độ “ẩn tạm trong app”. |
| 2 | Có để lại trang giữ chỗ? | **Có — giữ nguyên số trang** | Đi phương án **B2** (§3.3). Blob nằm trên page dict của trang giữ chỗ. |
| 3 | Phạm vi nền hộp văn bản | **Chỉ màu + độ mờ** | Không làm viền, **không** làm đệm ⇒ `measureText` **không đụng tới** (BI-40 an toàn). |
| 4 | Trí nhớ màu nền của chữ | **Slot riêng** | Thêm `ed.textFillColor/textFillOn/textFillOpacity` + `fillSlotFor(tool)` (§2.2 mục 2). |

⇒ Kế hoạch §4 giữ nguyên, không phải sửa. Bắt đầu từ **Pha A**.
