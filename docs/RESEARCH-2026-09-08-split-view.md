# Nghiên cứu khả thi — **xem song song nhiều tài liệu trong 1 cửa sổ** (split view, không so sánh)

_Lập 2026-09-08 · khảo sát trên `9717b10` (v0.2.68), nhánh `claude/vietnamese-ocr-ai-iSvwV`, cây sạch._

_Trạng thái: **Giai đoạn 0 (đo) XONG** — 5 probe chạy thật, số ở §10.
**Giai đoạn 1 (code) XONG 2026-09-08** — S1.1 → S1.13, nhật ký thực hiện ở §12, probe kết
thúc 42/43 (ca đỏ duy nhất là môi trường, có chạy đối chứng). Bản này là **bản 2**, viết lại
sau khi chốt phạm vi với người dùng (§0.1); bản 1 giả định hai khung đều sửa được — nhật ký
quyết định ở §11._

> **Ranh giới bằng chứng.** Mọi khẳng định về **mã nguồn** đều có trích dẫn file:dòng và đã
> đọc tận nơi. Mọi khẳng định về **hành vi Chromium/Electron lúc chạy** đã được **đo bằng
> probe chạy thật** trên Electron 33.4.11 của chính dự án — số ở §10, cách chạy lại ở §10.7.
> **Hai con số tôi đoán trong bản đầu đã bị chính phép đo bác bỏ** (`MAIN_MIN_W` ở §10.3 và
> cách nói "×cỡ file" ở §10.4); chúng được sửa tại chỗ và ghi lại ở §11.

---

## 0. Kết luận ngắn

| Câu hỏi | Trả lời |
|---|---|
| Có khả thi không? | **Có.** Kiến trúc tab hiện tại (`BaseWindow` + N `WebContentsView`) đã đúng hình dạng cần: hôm nay nó gắn **1** view tài liệu vào cây nội dung; split view chỉ là gắn thêm **1–2** view nữa. |
| Có phải viết lại renderer chính không? | **Không.** `renderer/index.html` + `app.js` giữ nguyên, trừ **1 sửa nhỏ ~5 dòng** (§4.8) vá một papercut đã tồn tại sẵn. |
| Phần code mới nằm ở đâu? | Một **trang xem chỉ-đọc mới, gọn** (`renderer/view.html` + `view.js`) — không phải bản sao của viewer chính, mà là bản **rút gọn có chủ đích** (§4.3). |
| Cùng một file ở nhiều khung được không? | **Được**, và đây chính là lý do khung 2/3 phải **chỉ đọc** (§4.2). Không có chuyện hai renderer cùng lưu đè lên một file. |
| Tốn thêm RAM bao nhiêu? | **ĐÃ ĐO (§10.4):** giữ cùng một tài liệu, khung chỉ-đọc tốn **≤53%** (bộ 300 trang A1) đến **≤81%** (file 120 MB ảnh đặc) so với renderer đầy đủ — tiết kiệm nhiều khi tài liệu nhiều **trang**, ít khi file nặng vì **bytes**. Bật 2 khung xem: **+235 MB** / **+843 MB** cho hai ca đó. Mỗi khung tốn **~80 MB chỉ để tồn tại** (một tiến trình renderer) ⇒ mở theo yêu cầu, đóng là huỷ hẳn. |
| Cỡ việc | **Vừa–lớn**: ~250 dòng ở `src/tabs.js`+`src/main.js`, ~450 dòng cho trang xem mới, ~40 dòng module dùng chung, ~200 dòng test. Không đụng `api.py`/sidecar. |
| Rủi ro | **Thấp.** Quyết định "khung 2/3 chỉ đọc" của người dùng đã **xoá bỏ** rủi ro nặng nhất của bản 1 (lệnh menu bắn nhầm tài liệu) và thu bảng ảnh hưởng từ **14 mục xuống 6** (§5.1). |

### 0.1 Phạm vi đã chốt với người dùng (2026-09-08)

| Hạng mục | Chốt |
|---|---|
| Cùng một file ở hai chỗ khác nhau | **CÓ** — bắt buộc phải làm được |
| Cách xử lý | **Khung 1 = chính (sửa được) · khung 2, 3 = CHỈ ĐỌC** |
| Số khung tối đa | **3** |
| Chiều chia | **Dọc (trái → phải)**, không cần chia ngang |
| Kéo rãnh đổi tỷ lệ | **CÓ** |
| Nhớ bố cục khi mở lại app | **CÓ** |
| Kéo trang giữa hai khung | **KHÔNG** (giữ BI-57 nguyên vẹn) |
| Cuộn đồng bộ hai khung | **KHÔNG** (đó là "so sánh", yêu cầu nói không cần) |
| Ca chỉ có 1 tài liệu | Vẫn chia được: khung 1 sửa + khung 2 (và 3) chỉ đọc **cùng tài liệu đó** |

---

## 1. Phương pháp luận

1. Đọc **toàn bộ** lớp vỏ tab (`src/tabs.js` 1028 dòng, `src/main.js` phần IPC + menu,
   `renderer/shell.{html,js}`, `src/shell-preload.js`, `src/session.js`).
2. Đọc phần **hạ tầng rasterise** của viewer chính (`renderer/app.js` §zoom/render) để biết
   trang xem mới **phải mang theo** những bảo vệ nào (§4.4) — đây là chỗ dễ vô tình làm hỏng
   nhất khi viết một viewer thứ hai.
3. Đối chiếu **sổ bất biến** `docs/REGRESSION-GUARD.md` (78 mục): lọc mọi mục chạm tới tab /
   cửa sổ / focus / thả trang / rasterise / cổng bản quyền → BI-9, BI-15, BI-16, BI-17,
   BI-20, BI-22, BI-26, BI-55, BI-57, BI-72, BI-77, BI-78 (§5.2).
4. Đối chiếu **số đo RAM** `docs/PERF-MEMORY.md` §2–3 (đo 2026-07-25) để trả lời câu hỏi
   hiệu năng bằng số đã đo, **và** ghi rõ chỗ số đó đã cũ so với v0.2.68 (§2.4).
5. Tra **API Electron đang ship** trong `desktop/node_modules/electron/electron.d.ts`
   (33.4.11) thay vì tra tài liệu trên mạng.

---

## 2. Kiến trúc hiện tại (đã đọc, có trích dẫn)

### 2.1 Một cửa sổ = 1 view thanh tab + N view tài liệu, chỉ **1** view được gắn

`src/tabs.js:1-19` nói rõ mô hình:

> "A TabbedWindow is one BaseWindow whose content area holds: a fixed 'tab strip'
> WebContentsView at the top, and N document WebContentsViews below it… **Only the ACTIVE
> document view is attached to the content tree at a time**; inactive views stay alive
> (their renderer keeps running) but detached."

Toàn bộ layout gói trong **12 dòng** — `src/tabs.js:120-132`:

```js
_layout() {
  const { w, h } = this._contentSize();
  const stripH = this._presenting ? 0 : TAB_STRIP_H;
  this.strip.setBounds({ x: 0, y: 0, width: w, height: stripH });
  const tab = this._active();
  if (tab) tab.view.setBounds({ x: 0, y: stripH, width: w, height: Math.max(0, h - stripH) });
}
```

**Đây là toàn bộ chỗ "một khung" được quyết định.** Không có gì khác trong app vẽ vùng tài liệu.

### 2.2 Nạp tài liệu vào một view đã có sẵn đường đi

`src/main.js:148-162` `sendFileToView`: MAIN đọc file, gửi bytes qua structured clone
(**không** base64 — BI-49), renderer nhận `file:open`. Trang xem chỉ-đọc dùng **đúng** đường
này, không cần cơ chế mới.

### 2.3 Viewer chính đã có sẵn hai bảo vệ mà trang xem mới **bắt buộc** phải mang theo

| Bảo vệ | Ở đâu | Vì sao bắt buộc |
|---|---|---|
| **Hạn mức raster** `MAX_VIEW_MEGAPIXELS = 32`, `MAX_VIEW_SIDE_PX = 12000`, `viewRasterDpr()` | `app.js:795-811` | **BI-78**: vượt 268 MP thì Chromium trả **trang trắng, không báo lỗi**. Một viewer thứ hai không có cái này = bản vẽ A0 trắng bệch ở khung xem, đúng lỗi vừa vá ở v0.2.68. |
| **Nhả bitmap trang trôi xa** `keepObserver` + `freePageCanvas` | `app.js:864-871` | Giữ RAM **phẳng theo số trang**. Bộ bản vẽ 300 trang không có cái này sẽ ăn RAM tuyến tính. |

Ngoài ra `app.js:927` dùng `annotationMode: pdfjsLib.AnnotationMode.ENABLE` khi không ở chế
độ sửa → **chú thích đã bake hiện lên**. Trang xem mới phải dùng đúng giá trị đó, nếu không
khung xem sẽ không thấy chú thích người dùng vừa lưu.

### 2.4 Chi phí RAM — số đã đo, và giới hạn của số đó

`docs/PERF-MEMORY.md` §2, đo 2026-07-25, PDF **128 MB**:

| Trạng thái | WorkingSet | Private |
|---|---|---|
| 1 tab trống | 1 336 MB | 1 259 MB |
| + tab 2 (PDF 128 MB) | 1 531 MB | 1 361 MB |
| + tab 3 (PDF 128 MB) | 2 019 MB | 1 780 MB |
| + tab 4 (PDF 128 MB) | 2 383 MB | 2 076 MB |

→ **≈ 270–350 MB/tab ≈ 2,1–2,7× cỡ file**, và §2 kết luận *"tab nền không nhả RAM"*.

**Bốn khoản làm nên cái hệ số 2,1–2,7×** (theo §3 của chính tài liệu đó) và **khung chỉ đọc
không có khoản nào**:

| Khoản | Mã nguồn | Khung chỉ-đọc |
|---|---|---|
| M1 · Lịch sử hoàn tác giữ **bản sao đầy đủ** (`HISTORY_BYTES_BUDGET` 512 MB) | `app.js` `pushUndo`/`snapshot` | **0** — không sửa thì không có gì để hoàn tác |
| M3 · Autosave chép nguyên tài liệu mỗi 120 s | `app.js` `autosaveTick` | **0** — không đăng ký `docId`, không ghi `recovery/` |
| M5 · Thumbnail render xong không bao giờ giải phóng | `app.js:565-597` | **0** ở bản đầu (không có cột trang) |
| Lớp editor / text-edit / find overlay | `editor.js` 4700 dòng, `text-edit.js`, `find-replace.js` | **0** — không nạp |

**Ước tính ban đầu là ~1,2–1,5× cỡ file — ĐO XONG THÌ SAI** (§10.4). "×cỡ file" là cách
diễn đạt hỏng: với `vec300` (1,8 MB / 300 trang) chi phí do **số trang** quyết định, không do
dung lượng. Cách nói đúng, đã đo: **giữ cùng một tài liệu, khung xem tốn ≤53% (nhiều trang)
đến ≤81% (nặng bytes) so với renderer đầy đủ** — và lý lẽ "bốn khoản M1/M3/M5/editor" ở trên
giải thích đúng vì sao khoảng đó rộng: bốn khoản ấy tỷ lệ với **công việc**, còn **bytes thì
bên nào cũng phải giữ**.

⚠️ **Số đo trên có trước v0.2.68.** `keepObserver`/`freePageCanvas` (`app.js:864`) và hạn mức
raster BI-78 (`app.js:795`) đều **mới hơn** ngày đo. Con số hiện thực có thể đã thấp hơn.
P-E phải đo lại nền, không được suy từ bảng cũ.

### 2.5 API Electron 33.4.11 — đã tra trong typings đang ship

| Cần gì | Có không | Bằng chứng |
|---|---|---|
| Gắn nhiều view con, đặt bounds tuỳ ý | ✅ | `electron.d.ts:14229` `addChildView(view, index?)`, `:14268` `setBounds`, `:14269` `setVisible` |
| Thứ tự chồng (z-order) | ✅ | `electron.d.ts:14226-14228`: thêm lại một view đã có = **đưa lên trên cùng** |
| Nền trong suốt cho view | ✅ (không cần dùng) | `electron.d.ts:14267` `setBackgroundColor` nhận `#AARRGGBB` |
| Biết view nào đang được gõ | ✅ (không cần dùng nữa — §4.6) | `electron.d.ts:15320-15335`, sự kiện `focus` của `WebContents` |

Không có API nào phải chờ nâng Electron.

---

## 3. Các phương án & lý do chọn

| # | Phương án | Đánh giá |
|---|---|---|
| **A** | Một renderer nạp 2–3 PDF, nhiều pane HTML (kiểu `compare.js`) | ❌ Gộp nhiều tài liệu vào một renderer chính là **Phương án B đã bị loại** ở `TABS-DESIGN` §3.1: *"phải viết lại toàn bộ giả định single-doc"*. Một tiến trình chết kéo theo cả ba khung. |
| **B** | Hai/ba cửa sổ OS kê cạnh nhau | ❌ Đã làm được hôm nay mà người dùng vẫn hỏi. Mất thanh tab chung, không nhớ được bố cục, mỗi lần phải kéo tay. |
| **C1** | Gắn 2–3 `WebContentsView` **đầy đủ** (`index.html`) cạnh nhau | ⚠️ Bản 1 của memo này. Chạy được, nhưng: **không** giải được ca cùng-một-file (hai renderer cùng ghi đè một file, âm thầm), và làm lệnh menu (Ctrl+S/In/Undo) trở nên mơ hồ → rủi ro **mất việc của người dùng**. |
| **C2** | **1 view chính (`index.html`, sửa được) + 1–2 view chỉ-đọc (`view.html`, mới)** ⟵ **CHỌN** | ✅ Giải ca cùng-một-file **bằng thiết kế** (chỉ một renderer được ghi). Lệnh menu **không đổi nghĩa**. Khung xem **rẻ hơn** tab đầy đủ. Renderer chính không đổi. |
| **D** | Như C2 nhưng mỗi khung có thanh tab riêng | ⚠️ Để dành. Với mô hình "khung xem thuộc về cửa sổ, không thuộc về tab" (§4.1) thì không cần. |

**Chọn C2.** Nguyên tắc ràng buộc lấy nguyên văn `docs/TABS-DESIGN.md` §1: *"không được phá
vỡ luồng single-doc của renderer"* — C2 giữ đúng, và còn giữ thêm một luật mới:
**mỗi file trên đĩa chỉ có ĐÚNG MỘT renderer được phép ghi.**

---

## 4. Thiết kế chi tiết

### 4.1 Mô hình: khung xem thuộc về **CỬA SỔ**, không thuộc về **TAB**

Đây là quyết định quan trọng nhất, và nó là thứ làm cho tính năng rẻ:

```
BaseWindow
├── chrome view      (renderer/shell.html — thanh tab + rãnh kéo)   ← đã có, mở rộng vai trò
├── tab view active  (renderer/index.html)                          ← KHÔNG ĐỔI GÌ
├── viewPane[0]      (renderer/view.html — chỉ đọc)                 ← MỚI, tuỳ chọn
└── viewPane[1]      (renderer/view.html — chỉ đọc)                 ← MỚI, tuỳ chọn
```

`TabbedWindow` thêm đúng **hai** trường:

```js
this.viewPanes  = [];   // MỚI — [{ view, path, title }], tối đa 2
this.paneRatios = [];   // MỚI — tỷ lệ bề rộng, [1] hoặc [r1,r2] hoặc [r1,r2,r3]
```

**Hệ quả trực tiếp — và đây là lý do bản 2 rẻ hơn bản 1 rất nhiều:** vì khung xem **không**
nằm trong `this.tabs[]`, toàn bộ vòng đời tab **không đổi một dòng**:

`activateTab` · `destroyTab` · `detachTab` · `moveTabTo` · `tearOutTab` · `adoptTab` ·
`closeTab` · `handleTabKey` (Ctrl+Tab, Ctrl+1..9) · `Ctrl+W` · `activeContents()` ·
`snapshotSession` phần `tabs`.

Bất biến của mô hình:

- **INV-S1:** `viewPanes.length <= 2` (tổng ≤ 3 khung).
- **INV-S2:** khung xem **không bao giờ** ghi ra đĩa, không đăng ký `docId`, không ghi
  `recovery/`, không nhận `menu:cmd`.
- **INV-S3:** khung xem **luôn** xem *bản đã lưu trên đĩa* của một đường dẫn (§4.5).

### 4.2 Vì sao "chỉ đọc" là **lời giải**, không phải là **hạn chế**

Yêu cầu "cùng một file ở hai khung" nếu làm bằng hai renderer đầy đủ sẽ tạo ra:

- **hai `state.bytes` phân kỳ** cho cùng một file;
- **hai lượt lưu đè nhau** — cái lưu sau nuốt trọn việc của cái lưu trước, **âm thầm**;
- **hai `docId` autosave** cùng trỏ một `srcPath` → hộp thoại khôi phục sau sự cố hỏi về
  cùng một file hai lần, không nói được cái nào mới hơn.

App hiện **không có** khoá nào chặn ba việc đó. Đặt khung 2/3 ở chế độ chỉ đọc làm cả ba
**không tồn tại được**, thay vì phải đi vá từng cái. Đây là lý do nên giữ nguyên quyết định
này kể cả khi sau này thấy "giá mà sửa được ở khung phải".

### 4.3 Trang xem chỉ-đọc: **rút gọn có chủ đích**, không phải bản sao

`renderer/view.html` + `renderer/view.js` (**mới**, ước ~450 dòng).

| Có | Không có |
|---|---|
| Cuộn, zoom (±, vừa bề ngang, vừa trang), nhảy trang, hiện tên file + số trang | Mọi công cụ ghi: chú thích, editor, sửa chữ, redact, watermark, ký số |
| Dựng trang **lười** bằng `IntersectionObserver`, **nhả bitmap** khi trôi xa | Undo/redo, autosave, khôi phục sự cố |
| **Hạn mức raster BI-78** (§4.4) | Cột thumbnail (bản đầu), kéo–thả trang |
| `annotationMode: ENABLE` → thấy chú thích đã bake | Mọi tính năng AI / sidecar (OCR, dịch, so sánh, nén, xuất Office) |
| Nút "**Sửa file này**" → đổi chỗ với khung chính (§4.7) | In (bản đầu — in từ khung chính) |

**Không** dựng lại từ đầu: phần "pane cuộn + dựng lười + fit bề ngang" đã có nguyên hình
trong `renderer/compare.js:425-490` (`IntersectionObserver`, `getViewport`, `page.render`).
Hướng làm: **tách phần đó ra một module dùng chung** rồi cho cả `compare.js` lẫn `view.js`
gọi — vừa tránh nhân bản, vừa **trả nợ M4** trong `PERF-MEMORY` (*"màn So sánh không giải
phóng canvas trang"*).

⚠️ Nếu bước tách ra hoá phức tạp hơn dự tính, **không** ép: viết `view.js` độc lập và ghi nợ
lại. Gom một cuộc tái cấu trúc `compare.js` vào chuyến này là cách biến một tính năng thêm
mới thành một chuyến có thể gây regression cho **So sánh** — thứ hoàn toàn không liên quan.

### 4.4 Hạn mức raster **phải có MỘT định nghĩa**, không được chép

`MAX_VIEW_MEGAPIXELS` / `MAX_VIEW_SIDE_PX` / `viewRasterDpr()` hiện sống ở `app.js:795-811`,
là phạm vi toàn cục của **trang `index.html`** — trang `view.html` **không** với tới được.

Chép sang là cách BI-78 lặng lẽ chết một nửa: sửa hằng số ở một chỗ, chỗ kia vẫn cũ, và triệu
chứng là **trang trắng không báo lỗi** trên bản vẽ A0 — đúng triệu chứng vừa vá ở v0.2.68.

**Giải:** tách ra `renderer/raster-cap.js` (~40 dòng, classic script, không module), cho **cả
hai** trang `<script src>` nó. `app.js` xoá 3 khai báo, dùng bản dùng chung. Đây là thay đổi
**thứ hai và cuối cùng** ở renderer chính — thuần di chuyển, không đổi hành vi, và có test
số học riêng.

> Cùng loại bẫy mà **BI-14** đã ghi ("gọi hàm chéo module theo kiểu tên trần là điểm gãy im
> lặng") và **BI-27** đã ghi ("số học khoảng trang sống ở page-range.js, **không** nhân bản
> vào app.js").

### 4.5 Khung xem xem **bản đã lưu trên đĩa** — và vì sao chọn thế

Ba lựa chọn cho "khung xem lấy nội dung ở đâu":

| | Cách | Đánh giá |
|---|---|---|
| a | Ảnh chụp lúc mở, không bao giờ đổi | Đơn giản nhất, nhưng người dùng lưu xong vẫn thấy bản cũ → khó hiểu |
| b | Xin bytes đang sửa từ renderer chính | Phải đẩy 128 MB qua main mỗi lần đồng bộ; và trạng thái "đang sửa dở" không có mốc rõ ràng |
| **c** | **Đọc file trên đĩa; tự nạp lại khi khung chính LƯU** ⟵ **CHỌN** | Ngữ nghĩa nói thành một câu: *"khung xem hiển thị bản đã lưu"*. Dùng lại `sendFileToView` (§2.2). Không có byte nào đi giữa hai renderer (giữ **BI-55** sạch sẽ). |

Bổ sung để không ai bị lừa:

- Đầu khung xem có chip: **"bản đã lưu · HH:MM"** + nút **Làm mới**.
- Khung chính lưu xong → main gửi `view:reload` cho mọi khung xem đang trỏ đúng đường dẫn đó.
- Tài liệu **chưa từng lưu** (tab mới, hoặc bản khôi phục sự cố) **không** đặt vào khung xem
  được: hiện "Hãy lưu tài liệu trước khi mở ở khung xem". Thà nói thẳng còn hơn hiện một
  trang trắng không giải thích.

### 4.6 Lệnh menu **không đổi nghĩa** — rủi ro lớn nhất của bản 1 biến mất

`src/main.js:362` — `send(cmd)` gọi `Tabs.activeContents()`, comment: *"Menu commands target
the active tab of the window the user is using"*. Vì khung xem **không phải tab** và **không
nhận `menu:cmd`** (INV-S2), câu đó vẫn đúng nguyên văn: **Ctrl+S, In, Undo, Ctrl+W luôn về
khung chính, luôn luôn.**

→ Không cần theo dõi "khung nào đang được gõ", không cần `wc.on("focus")`, không cần vòng
báo hiệu focus ở thanh tab. **Ba hạng mục của bản 1 bị xoá khỏi kế hoạch.**

Vẫn cần một dấu hiệu thị giác nhẹ: khung chính có viền trái màu accent 2px, khung xem có
nhãn "CHỈ ĐỌC" ở thanh đầu khung. Để **nói rõ khung nào ghi được**, không phải để chỉ focus.

### 4.7 Đổi chỗ khung — cách "sửa file đang xem ở khung phải"

Nút **"Sửa file này"** trên thanh đầu khung xem:

1. Nếu đường dẫn đó **đang là một tab** → `activateTab(tabId)` cho khung chính, và khung xem
   chuyển sang trỏ vào đường dẫn của tab vừa rời khung chính. Một cú bấm, không nạp lại gì.
2. Nếu **chưa là tab** → mở nó thành tab mới (đi qua `Prefs.getOpenIn()` như mọi đường mở
   file khác — **BI-35**), rồi như trên.
3. Nếu đường dẫn đó **trùng khung chính** (ca cùng-một-file) → nút này **ẩn đi**: không có
   gì để đổi.

Nhờ vậy "khung phải chỉ đọc" không bao giờ thành ngõ cụt.

### 4.8 Layout & rãnh kéo

Trích nguyên tắc `src/tabs.js:437-441`: *"Deliberately the same arithmetic as `_layout` …
Reading it any other way would put the hit test and the pixels on screen out of step."*
→ số học layout nằm ở **một hàm thuần**, cả `_layout` lẫn hit-test cùng gọi.

```js
const SPLIT_GUTTER    = 6;
// ĐÃ ĐO — P-D §10.3. Không đoán: ở 420px thanh công cụ ăn 49% chiều cao khung.
const MAIN_MIN_W      = 620;  // 34% chrome — mức thấp nhất còn dùng được
const MAIN_HARD_MIN_W = 420;  // sàn tuyệt đối (380px đã tràn ngang)
const VIEW_MIN_W      = 260;  // khung xem: thanh đầu 1 dòng
const VIEW_HARD_MIN_W = 180;

// THUẦN — không Electron, không DOM. Test: test/split-layout.test.js
function splitRects(w, h, { stripH, panes, ratios }) { … }
```

Bốn tính chất test phải khoá: các khung **kề khít** rãnh · **phủ hết** bề rộng (không hở /
chồng 1px ở bề rộng lẻ) · không khung nào dưới sàn · `w` nhỏ hơn tổng mức tối thiểu thì
**co đều theo tỷ lệ**, không bao giờ trả bề rộng âm.

**Rãnh kéo, không cần thêm tiến trình:** khi chia khung, cho **chrome view** (đã có,
`this.strip`) cao **hết cửa sổ** thay vì 40px. Các view tài liệu `addChildView` **sau** nên
nằm **trên** nó (`electron.d.ts:14226`), che kín — trừ đúng các dải rãnh 6px. Chuột rơi vào
rãnh → view trên cùng tại điểm đó chính là chrome view.

**Cơ chế kéo — chốt bằng đo (P-B, §10.2): `setPointerCapture`, KHÔNG dùng HTML5 drag.**

```
pointerdown trên tay nắm  →  chrome.setPointerCapture(e.pointerId)
pointermove               →  ratio = clamp(e.clientX / usableWidth)  →  IPC (tiết lưu ~16ms)
pointerup / lostpointercapture →  kết thúc, gửi ratio cuối
```

Ba lý do, đều là **kết quả đo**, không phải sở thích:

1. **HTML5 drag không bắn `drag`** giữa chừng (đo: 0 lần) → chỉ biết lúc bắt đầu và lúc kết
   thúc; muốn kéo mượt thì phải poll con trỏ ở main. `setPointerCapture` bắn **đủ 15/15**
   `pointermove` ngay cả khi con trỏ đã đi sâu vào lãnh thổ view anh em.
2. **`e.clientX` của chrome view = toạ độ nội dung cửa sổ** (vì nó phủ hết cửa sổ khi chia
   khung) → **không** dính cái bẫy *"renderer screen coordinates inside a WebContentsView are
   off by the window frame"* (`TABS-2B-DESIGN` §2.3). Không cần main đọc con trỏ, không cần
   vòng lặp + watchdog (**BI-58 không áp dụng cho đường này**).
3. HTML5 drag còn **rơi một sự kiện `drop` lạc** vào khung tài liệu bên dưới (đo được) —
   rác mà đường pointer-capture không sinh ra.

Chốt an toàn bắt buộc: **`lostpointercapture` phải kết thúc phiên kéo** (mất capture vì tab
Alt, vì cửa sổ mất focus, vì renderer bị treo) — nếu không, một phiên kéo có thể sống lâu hơn
cử chỉ sinh ra nó, đúng loại lỗi mà BI-58 cảnh báo.

### 4.9 Lối vào (UX)

- Menu **Hiển thị** → "**Chia đôi màn hình**" (`Ctrl+\` — đã tra **chưa ai dùng**, toàn bộ
  accelerator ở `src/main.js:372-467`) · "**Thêm khung xem**" (`Ctrl+Shift+\`) ·
  "**Đóng khung xem**".
- Bật chia khung khi cửa sổ chỉ có **1 tài liệu** → khung xem mở **chính tài liệu đó**
  (đúng chốt §0.1) — đây cũng là ca dùng chính: xem trang 5 khi đang sửa trang 40.
- Thanh đầu mỗi khung xem có ô chọn nguồn: **"Cùng tài liệu khung chính"** · danh sách các
  tab đang mở · **"Mở file khác…"**.
- **BI-55:** danh sách tab đến từ **MAIN** (đúng khuôn `pageTargetTabs`, `tabs.js:640-668`:
  trả `{id, title, window}`, giữ `wc` lại trong main). Khung xem chỉ gửi lại một `tabId`
  **do chính main phát ra** — nó không bao giờ biết `webContents` của ai.
- **i18n:** chữ mới vào `MENU_STR` **cả `vi` và `en`** (`src/main.js`). `view.html` là trang
  mới → cho nó đi qua `i18n.js` ngay từ đầu (rẻ lúc này, đắt về sau).

### 4.10 Hai thay đổi ở renderer chính (và chỉ hai)

1. **Tách hạn mức raster** sang `renderer/raster-cap.js` (§4.4) — thuần di chuyển.
2. **Cột trang tự co khi khung hẹp lại.** `app.js:2734` `clampSidebarWidth` chặn cột trang ở
   `min(300, innerWidth * 0.4)` nhưng **chỉ tính lúc được gọi**; grep `"resize"` trong
   `app.js` cho **không kết quả**. Khung chính 450px với cột trang 300px đã lưu = **67%**
   khung.

```js
// Cột trang tự co khi khung hẹp lại (chia khung, kéo nhỏ cửa sổ).
// KHÔNG persist: bề rộng người dùng đã chọn phải quay lại khi khung rộng ra.
window.addEventListener("resize", () => applySidebarWidth(storedSidebarWidth(), false));
```

Cố ý **không** tự chỉnh lại zoom: `fitWidth`/`fitPage` (`app.js:2965-2990`) là **lệnh**, không
phải **chế độ** — app không hề nhớ "đang vừa bề ngang". Biến nó thành chế độ là thay đổi hành
vi riêng, bàn riêng (§7 GĐ3).

---

## 5. Bản đồ ảnh hưởng

### 5.1 Hàm phải sửa — **6 mục** (bản 1 là 14)

| # | Chỗ | Hôm nay | Phải thành | Hỏng gì nếu bỏ sót |
|---|---|---|---|---|
| 1 | `tabs.js:120` `_layout` | 1 khung | gọi `splitRects` cho tab active + `viewPanes` | — |
| 2 | `tabs.js:283` `activateTab` | gắn view vào cả dải | gắn vào **rect khung chính** | Đổi tab khi đang chia khung → tab mới **đè lên khung xem** |
| 3 | `tabs.js:437` `docViewScreenRect` | 1 chữ nhật cả dải | trả rect **khung chính**; thêm `paneAt(point)` | Kéo trang từ cửa sổ khác thả vào khung xem → toạ độ **lệch đúng bằng bề rộng khung chính** |
| 4 | `main.js:1061,1134` | `d.key.activeDocContents()` | dùng `paneAt(point)`; rơi vào khung xem ⇒ **từ chối + toast** | Trang bị chèn vào tài liệu sai, hoặc rơi vào hư không không giải thích |
| 5 | `tabs.js:601` `_emit` | `{id,title,dirty,active}` | thêm `panes` (số khung, tỷ lệ) cho nút `◫` | Nút chia khung không phản ánh trạng thái thật |
| 6 | `tabs.js:794/817` phiên | `{bounds,maximized,active,tabs}` | thêm `panes:[{path}]` + `ratios` | Mở lại app **mất bố cục** |

**Không đụng:** `destroyTab` · `detachTab` · `moveTabTo` · `tearOutTab` · `adoptTab` ·
`closeTab` · `handleTabKey` · `activeContents` · `Ctrl+W` · `planOpen` · `classifyDrop` ·
`classifyPageDrop`.

### 5.2 Đối chiếu sổ bất biến `docs/REGRESSION-GUARD.md`

| BI | Nội dung | Thiết kế này |
|---|---|---|
| **BI-9 / BI-26** | Nút trả phí phải có trong `GATED_BTNS`; cổng bản quyền ở **tầng HÀM** | ✅ Khung xem **không có** một hàm ghi nào để mà cổng — mọi mục trong `GATED_BTNS` (`app.js:4315-4345`) đều là ghi hoặc AI. Xem/zoom vốn miễn phí. **Không mở lỗ nào.** |
| **BI-15 / BI-16** | `detachTab` không đóng `webContents`; tab phải có người nhận | ✅ Không đụng — khung xem không nằm trong `tabs[]`. |
| **BI-17** | Phím tắt tra chủ sở hữu **động** | ✅ Không đụng. Khung xem **không** đăng ký `bindTabKeys` (nó không có tab để chuyển). |
| **BI-20** | Không ghi phiên khi cửa sổ đang đóng dở | ✅ Không đụng `_closing`/`anyClosing`. |
| **BI-22** | Toàn màn hình: **MAIN** là nguồn sự thật | ✅ Cùng khuôn: main sở hữu `viewPanes`, renderer không tự bật. F11 chỉ đặt `stripH = 0`; `splitRects` đã tính. |
| **BI-55** | Renderer **không bao giờ** biết định danh renderer khác | ✅ Khung xem nhận **đường dẫn** + `tabId` **do main phát ra**. Không byte nào đi giữa hai renderer (§4.5c). |
| **BI-57** | Thả trang trong cửa sổ **NGUỒN** ⇒ luôn là sắp xếp cũ | ✅ **Không đụng** (đã chốt loại kéo-trang-giữa-khung khỏi phạm vi). Khung xem từ chối trang thả vào (#4). |
| **BI-72 / BI-73** | Kho trang ẩn `/NabuVault` | ✅ Khung xem **không có** đường giải mã → hiện đúng **trang giữ chỗ**, y như Foxit/Acrobat. Đây là hành vi **đúng**, không phải thiếu sót. Phải có ca test. |
| **BI-77** | Clipboard liên-tab: main chỉ **ĐẨY** vào `clip` | ✅ Không đụng. Khung xem không dán, không copy vật thể. |
| **BI-78** | Bitmap trang phải có **hạn mức pixel** | ⚠️ **Chỗ nguy hiểm nhất của bản 2.** Trang xem mới **phải** dùng chung hằng số, không được chép — §4.4. Triệu chứng nếu sai: **trang trắng, không báo lỗi**. |

---

## 6. Rủi ro, và cách chặn từng cái

### 6.1 ✅ Probe — **ĐÃ CHẠY XONG 2026-09-08** (số đầy đủ ở §10)

| Probe | Kết quả | Ảnh hưởng tới thiết kế |
|---|---|---|
| **P-A** chrome view có nhận chuột ở rãnh 6px? | ✅ **ĐẠT** | Bỏ fallback "view rãnh riêng" — **không tốn tiến trình nào** |
| **P-B** kéo rãnh giữ được chuột qua view anh em? | ✅ **`setPointerCapture` ĐẠT** (15/15 pointermove) · ❌ HTML5 drag không bắn `drag`, còn rơi `drop` lạc | §4.8 **gọn hơn**: bỏ vòng polling con trỏ + watchdog ở main |
| **P-D** thanh công cụ ở khung hẹp | ⚠️ **Bác bỏ con số đã đoán**: `MAIN_MIN_W` 420 → **620** | Đổi ngân sách bề rộng; 3 khung cần **1152px** vùng nội dung |
| **P-E** RAM | ✅ khung xem = **48–59%** renderer đầy đủ; nhả bitmap chạy (1–3 canvas sống / 300 trang) | Bác bỏ cách nói "×cỡ file"; xác nhận kiến trúc C2 |
| **P-F** chú thích đã bake | ✅ `ENABLE` cho đúng màu `/AP`, `DISABLE` cho trắng | Khoá `annotationMode` = `ENABLE` như `app.js:927` |

**Rủi ro còn lại sau probe** (không probe nào phủ được, phải canh bằng test tay):

| # | Rủi ro | Canh bằng |
|---|---|---|
| R1 | Khung xem quên hạn mức raster ⇒ **trang trắng im lặng** trên A0 | S1.1 tách `raster-cap.js` **trước mọi bước khác** + `test/raster-cap.test.js` + test tay 8.2 #13 |
| R2 | Người dùng tưởng khung xem sửa được | §6.2 |
| R3 | PDF **có mật khẩu** ở khung xem (phát hiện ở §10.5b) | Bắt `PasswordException` → báo rõ; test 8.2 #19 |
| R4 | `lostpointercapture` không kết thúc phiên kéo ⇒ rãnh "dính" tay | Chốt an toàn ở §4.8 + test tay 8.2 #7 |

### 6.2 Người dùng tưởng khung xem sửa được

Rủi ro **kỳ vọng**, không phải kỹ thuật. Chặn: nhãn **"CHỈ ĐỌC"** thường trực ở thanh đầu
khung · viền accent ở khung chính · nút **"Sửa file này"** (§4.7) để lối ra luôn hiện diện ·
bấm vào vùng trang ở khung xem mà không có gì xảy ra thì **toast một lần**: *"Khung xem chỉ
để đọc — bấm 'Sửa file này' để mở ở khung chính."*

### 6.3 Khung hẹp làm thanh công cụ nở dọc

`app.css:58-64` `.tb-row` đã có `flex-wrap: wrap` (comment: *"Fix overflow / missing menu by
wrapping items on small screens"*) → **không gãy**, chỉ **cao lên**. `minWidth: 900`
(`tabs.js:56`) cho vùng nội dung ~884px:

| Bố cục | Tổng tối thiểu | Ở cửa sổ 884px | Ở 1360px |
|---|---|---|---|
| 1 chính + 1 xem | 420 + 6 + 260 = **686** | ✅ thoải mái | ✅ |
| 1 chính + 2 xem | 420 + 6 + 260 + 6 + 260 = **952** | ❌ **thiếu 68px** → co đều về `HARD_MIN_W` | ✅ |

→ Khi bật khung xem thứ hai mà cửa sổ hẹp: **thử nới rộng cửa sổ** trong phạm vi `workArea`
trước (đã có khuôn `sanitizeBounds`/`placeTornWindow`, `tabs.js:747-757`), không nới được thì
vẫn cho chia nhưng báo *"cửa sổ hơi hẹp cho 3 khung"*. **Không** chặn cứng — chặn cứng làm
người dùng không hiểu vì sao nút bị mờ. Chốt `MAIN_MIN_W` bằng **P-D**.

### 6.4 Ba khung cùng rasterise một bản vẽ A0

Đây là chỗ BI-78 quyết định sống chết (§4.4). Có hạn mức dùng chung thì mỗi khung **hẹp hơn**
⇒ bitmap **nhỏ hơn** ⇒ đi **xa** vách 268 MP hơn hiện tại. Không có hạn mức thì ngược lại và
triệu chứng là **trang trắng im lặng**. Ca test tay #13 và probe **P-F** cùng canh chỗ này.

### 6.5 Phiên cũ / phiên mới

`session.js:45` từ chối file có `raw.v !== VERSION`. Thêm **trường mới** vào bản ghi window là
**tương thích ngược** (bản cũ thiếu `panes` → coi như không chia), nên **không** bump
`VERSION` — bump sẽ **xoá sạch** phiên của mọi người dùng đang cài.

Khi khôi phục: đường dẫn khung xem đã bị xoá/di chuyển thì **bỏ khung đó**, không báo lỗi —
đúng luật đã có ở `restoreSession` (`tabs.js:825-827`: *"Files the user has since moved or
deleted are dropped without comment"*).

---

## 7. Kế hoạch theo bước

### ✅ Giai đoạn 0 — đo — **XONG 2026-09-08**
`S0.1` chạy P-A, P-B, P-D, P-E, P-F ✅ · `S0.2` số đã ghi ở §10 ✅ ·
`S0.3` chốt: `MAIN_MIN_W = 620` (đo, không đoán) · `VIEW_MIN_W = 260` · **CÓ** rãnh kéo,
bằng `setPointerCapture` ✅. Nguyên mẫu khung xem (~150 dòng) đã chạy thật và là hạt giống
cho bước S1.3.

### Giai đoạn 1 — nền: 1 chính + 1 khung xem (3–4 ngày)

| Bước | Việc | File | Kiểm |
|---|---|---|---|
| S1.1 | Tách `raster-cap.js`, `app.js` dùng bản chung (§4.4) | `renderer/raster-cap.js` (mới), `renderer/app.js`, `index.html` | `test/raster-cap.test.js` (mới) + test tay A0 |
| S1.2 | `splitRects()` **thuần** + hằng số | `src/tabs.js` | `test/split-layout.test.js` (mới) |
| S1.3 | `renderer/view.{html,js}` + `src/view-preload.js` (bề mặt tối thiểu) | mới | test tay |
| S1.4 | `addViewPane()` / `closeViewPane()` / `setPaneSource()`; `_layout` gọi `splitRects` | `src/tabs.js` | `test/tabs-logic.test.js` (mở rộng) |
| S1.5 | Vá §5.1 #2, #3, #5; `paneAt()` | `src/tabs.js` | `test/page-drop.test.js` (mở rộng) |
| S1.6 | #4: khung xem **từ chối** trang thả vào + toast | `src/main.js` | test tay |
| S1.7 | Nạp lại sau khi khung chính lưu; chip "bản đã lưu · HH:MM" (§4.5) | `src/main.js`, `renderer/view.js` | test tay |
| S1.8 | Ô chọn nguồn (danh sách tab do main phát — BI-55) + "Mở file khác…" | `src/main.js`, `renderer/view.js` | test tay |
| S1.9 | Menu + `MENU_STR` vi/en + nút `◫` trên thanh tab | `src/main.js`, `renderer/shell.*` | test tay |
| S1.10 | Rãnh kéo (nếu P-A+P-B đạt) | `renderer/shell.js`, `src/main.js` | test tay |
| S1.11 | Cột trang tự co (§4.10) | `renderer/app.js` | test tay |
| S1.12 | Phiên: `panes` + `ratios` (#6) | `src/tabs.js` | `test/tabs-logic.test.js` |
| S1.13 | Nút "Sửa file này" (§4.7) | `renderer/view.js`, `src/main.js` | test tay |

### Giai đoạn 2 — khung thứ ba + làm mượt (1–2 ngày)
`S2.1` mở khoá khung xem thứ hai (INV-S1 = 2) · `S2.2` nới cửa sổ / cảnh báo khi hẹp (§6.3) ·
`S2.3` khung xem: Ctrl+F tìm chữ, chọn & copy chữ · `S2.4` gộp phần pane cuộn dùng chung với
`compare.js`, trả nợ **M4** trong `PERF-MEMORY` (§4.3).

### Giai đoạn 3 — chỉ khi dùng thật thấy thiếu
`S3.1` in từ khung xem · `S3.2` chia ngang (`splitRects` nhận thêm `axis`) ·
`S3.3` "vừa bề ngang" thành **chế độ** để tự tính lại khi khung đổi cỡ ·
`S3.4` cuộn đồng bộ (**có tắt/bật**) — chỗ split view chạm gần "so sánh" nhất, đúng thứ
yêu cầu nói **không cần**.

---

## 8. Test

### 8.1 Tự động (không cần GUI — đúng khuôn `test/tabs-logic.test.js`)

**`test/split-layout.test.js`** (mới):
- 1 khung → phủ hết, `panes` rỗng;
- 2 khung 0.5 ở 1360×880 → kề khít, tổng + rãnh = bề rộng;
- 3 khung ở 1920 → hai rãnh, ba khung kề khít, không hở/chồng;
- bề rộng **lẻ** (1361, 1921) → **không hở 1px, không chồng 1px**;
- `ratios` = `[0.01,0.98,0.01]` / `NaN` / âm / tổng ≠ 1 → kẹp về mức tối thiểu, **không** khung âm;
- `w` < tổng tối thiểu (884 với 3 khung) → **co đều**, mọi khung ≥ `HARD_MIN_W`;
- `stripH = 0` (toàn màn hình) → khung cao hết cửa sổ;
- `chrome.height === h` khi chia khung, `=== stripH` khi không.

**`test/raster-cap.test.js`** (mới) — khoá BI-78 sau khi tách module:
- `viewRasterDpr` trả **đúng y hệt** giá trị cũ ở một bộ ca lấy từ `app.js` (A4/A3/A0 ×
  scale × dpr) — chứng minh bước tách là **thuần di chuyển**;
- vượt trần diện tích → hạ dpr; vượt trần cạnh → hạ dpr; cả hai → lấy cái nhỏ hơn;
- không bao giờ **nâng** quá dpr thật.

**`test/tabs-logic.test.js`** (mở rộng):
- `addViewPane` không đụng `tabs[]`; `activateTab` vẫn chạy y như trước khi có khung xem;
- INV-S1: khung thứ tư bị từ chối;
- đóng tab cuối / xé tab → khung xem **không** bị bỏ rơi, cửa sổ dọn sạch;
- `snapshotSession` → `restoreSession` round-trip **có** `panes` + `ratios`;
- đường dẫn khung xem không còn tồn tại → bỏ khung đó, **không** ném lỗi;
- tab chưa lưu (không `path`) không vào được `panes`.

**`test/page-drop.test.js`** (mở rộng): `paneAt` trả đúng khung cho điểm ở khung chính /
trong rãnh / ở khung xem / ngoài cửa sổ; **BI-57 vẫn đúng** (nguồn = cửa sổ ⇒ `self`).

### 8.2 Tay (GUI — máy không thay được)

1. 1 tài liệu → `Ctrl+\` → **cùng file** hiện ở hai khung; cuộn khung xem tới trang 40, sửa
   trang 5 ở khung chính → hai khung độc lập. _(ca dùng chính)_
2. Sửa ở khung chính → **Ctrl+S** → khung xem **tự nạp lại**, chip đổi giờ, thấy chú thích vừa lưu.
3. Ctrl+S khi con trỏ vừa ở khung xem → vẫn lưu **khung chính** (§4.6).
4. Khung xem trỏ sang **file khác** → hai file song song, đúng yêu cầu gốc.
5. Nút "Sửa file này" → đổi chỗ đúng, tài liệu **nguyên vẹn**, không nạp lại thừa.
6. Bật khung xem **thứ hai** (3 khung) ở 1920px → đọc được; ở 900px → nới cửa sổ hoặc báo.
7. Kéo rãnh → chạm mức tối thiểu thì **dừng**, không lật, không hở.
8. F11 khi đang chia khung → mọi khung cao hết màn hình, thanh tab biến mất, Esc quay lại (BI-22).
9. Đóng tab đang ở khung chính → tab khác thế chỗ, **khung xem đứng yên**.
10. Xé tab sang cửa sổ mới → tài liệu nguyên vẹn (BI-15), khung xem ở lại cửa sổ cũ.
11. Kéo trang **trong** cột trang khung chính → sắp xếp vẫn chạy y như trước (**BI-57**).
12. Kéo trang từ **cửa sổ khác** thả vào khung xem → **từ chối + toast**, không mất trang (BI-56).
13. **Bản vẽ A0** ở cả 3 khung, zoom 500% → **không trang trắng** (BI-78), RAM khớp P-E.
14. Tài liệu có **trang ẩn bằng mật khẩu** → khung xem hiện **trang giữ chỗ**, không giải mã (BI-72).
15. Tài liệu **chưa lưu bao giờ** → không đặt vào khung xem được, báo rõ lý do.
16. Tắt app đang chia 3 khung → mở lại → **đúng bố cục, đúng file, đúng tỷ lệ**.
17. Cửa sổ nhỏ nhất (900px), 2 khung → cột trang khung chính **tự co** (§4.10).
18. Xoá file đang mở ở khung xem rồi khởi động lại → khung đó **bị bỏ im lặng**, app vẫn chạy.
19. PDF **có mật khẩu** đặt vào khung xem → báo *"Tài liệu có mật khẩu — mở ở khung chính"*, **không** treo, **không** trang trắng (§10.5b).
20. Kéo rãnh rồi Alt+Tab giữa chừng → `lostpointercapture` kết thúc phiên kéo, rãnh **không dính tay** (R4).

---

## 9. Điểm còn để ngỏ (không chặn việc bắt đầu)

| # | Điểm | Đề xuất mặc định |
|---|---|---|
| E1 | Khung xem có cần **Ctrl+F tìm chữ** không? | Giai đoạn 2. Đọc bản vẽ mà không tìm được chữ là khó chịu, nhưng không chặn bản đầu. |
| E2 | Khung xem có cần **chọn & copy chữ** không? | Giai đoạn 2 (cần text layer → thêm RAM; để P-E nói trước). |
| E3 | **In** từ khung xem? | Không ở bản đầu — in từ khung chính. |
| E4 | Khung xem có **cột thumbnail** riêng không? | Không ở bản đầu (tiết kiệm RAM, khoản M5). Thay bằng ô "đi tới trang". |
| E5 | Tỷ lệ mặc định khi mở khung xem | 60/40 (khung chính rộng hơn) thay vì 50/50 — khung chính phải chứa thanh công cụ đầy đủ. |

---

## 10. Số đo sau khi probe (Giai đoạn 0)

_Chạy 2026-09-08 trên chính máy dev: Windows 11 Pro 26200, Electron **33.4.11** (bản dự án
đang ship), `scaleFactor = 1`. Probe ở scratchpad, không commit. Kết quả ghi ra **FILE**
(stdout của Electron mất trên Windows)._

### 10.1 P-A — chrome view phủ hết cửa sổ có nhận chuột ở dải rãnh không? **ĐẠT**

Dựng đúng hình dạng đề xuất: chrome view `{0,0,1000,700}` thêm **trước** → nằm dưới cùng;
hai view tài liệu `{0,40,497,660}` và `{503,40,497,660}` thêm **sau** → nằm trên, chừa rãnh
6px. Điều khiển **chuột thật của OS** (`SetCursorPos` + `mouse_event` qua user32).

| Bấm ở (màn hình) | Rơi vào vùng | View nhận | |
|---|---|---|---|
| 600, 305 | rãnh 6px | **chrome** (`gripCap`, client 500,205) | ✅ |
| 349, 520 | khung trái | `docL` | ✅ |
| 852, 520 | khung phải | `docR` | ✅ |

→ **Không cần thêm tiến trình renderer nào cho rãnh kéo.** Fallback "view rãnh riêng" bỏ.

### 10.2 P-B — kéo rãnh: cơ chế nào giữ được chuột khi con trỏ đi qua view anh em?

| Cơ chế | dragstart/pointerdown | Trong lúc kéo | Kết thúc | Rác |
|---|---|---|---|---|
| **`setPointerCapture`** | ✅ capture đặt được | ✅ **15/15 `pointermove` về chrome**, `clientX` đi từ 521 → **755** (sâu trong lãnh thổ khung phải); khung phải **không nhận gì** | ✅ `pointerup` về chrome tại x=755 | không |
| HTML5 drag | ✅ `dragstart` | ❌ **`drag` bắn 0 lần** — không theo dõi được vị trí | ✅ `dragend` bắn (x=752) | ⚠️ khung phải lãnh một sự kiện **`drop`** lạc |

→ **Chốt: dùng `setPointerCapture`, không dùng HTML5 drag.** Hệ quả làm §4.8 **gọn hơn**
so với bản viết trước:

- **không** cần vòng lặp `screen.getCursorScreenPoint()` trong main, **không** cần watchdog
  (BI-58 không còn áp dụng cho đường này);
- `e.clientX` của chrome view **chính là toạ độ nội dung cửa sổ** vì nó phủ hết cửa sổ →
  né sạch cái bẫy *"renderer screen coordinates inside a WebContentsView are off by the
  window frame"* (`TABS-2B-DESIGN` §2.3);
- không sinh `drop` lạc vào khung tài liệu;
- vẫn giữ một chốt an toàn: `lostpointercapture` **phải** kết thúc phiên kéo.

### 10.3 P-D — thanh công cụ ở khung hẹp: **con số đoán trong §4.8 là SAI**

Nạp **đúng** `renderer/index.html` + **đúng** `src/preload.js` (stub 43 kênh IPC), khung cao
900px, breadcrumb + statusbar được bật (chúng `hidden` khi chưa mở file, nên nếu không bật
thì thiếu 47px).

| Khung | Hàng 1 | Hàng 2 | Thanh công cụ | +crumb+status | **Chrome ăn mất** | Tràn ngang |
|---:|---|---|---:|---:|---:|---|
| 380 | 6 dòng / 251px | 4 dòng / 169px | 421px | 468px | **52%** | **CÓ — vỡ** |
| **420** ← số đã đoán | 5 / 221 | 4 / 169 | 391px | 438px | **49%** | – |
| 470 | 5 / 221 | 3 / 128 | 350px | 397px | 44% | – |
| 520 | 5 / 214 | 3 / 128 | 343px | 390px | 43% | – |
| 560 | 5 / 214 | 3 / 128 | 343px | 390px | 43% | – |
| **620** | 4 / 173 | 2 / 87 | 261px | 308px | **34%** | – |
| **700** | 3 / 139 | 2 / 87 | 227px | 274px | **30%** | – |
| 884 (= minWidth 900) | 3 / 139 | 2 / 87 | 227px | 274px | 30% | – |
| 1000 | 2 / 98 | 2 / 87 | 186px | 233px | 26% | – |
| 1180 · 1360 · 1600 | 2 / 98 | 1 / 46 | 145px | 192px | 21% | – |
| 1920 | 1 / 57 | 1 / 46 | 104px | 151px | 17% | – |

**Đọc ra:**

- `MAIN_MIN_W = 420` như §4.8 viết là **hỏng**: thanh công cụ nuốt **49%** chiều cao khung.
  Con số thật là **620px** (34%), thoải mái ở **700px** (30%).
- **380px là sàn vỡ**: `document.body.scrollWidth > innerWidth` → trang trượt ngang.
  Đó là `MAIN_HARD_MIN_W` **đo được**, thay cho `HARD_MIN_W = 180` đã đoán.
- Hai khoảng "không được gì": 700→884 y hệt nhau, và 1180→1600 y hệt nhau. Nới cửa sổ trong
  hai khoảng đó **không** mua lại được dòng nào.
- Số ở 1360 khớp với chính ghi chú đo cũ trong `app.css:846-851` (*"gave row 1 a whole line
  back at 1600px"* → dưới 1600 hàng 1 vẫn 2 dòng) → probe trung thực.

**Hằng số chốt lại (đã đo, không còn đoán):**

```js
const MAIN_MIN_W      = 620;  // dưới mức này thanh công cụ ăn > 1/3 chiều cao khung
const MAIN_HARD_MIN_W = 420;  // sàn tuyệt đối: 380 đã tràn ngang
const VIEW_MIN_W      = 260;  // khung xem chỉ có thanh đầu 1 dòng
const VIEW_HARD_MIN_W = 180;
```

**Ngân sách bề rộng (vùng nội dung):**

| Bố cục | Cần tối thiểu | Cửa sổ nhỏ nhất (884) | 1360 (mặc định) | 1920 |
|---|---:|---|---|---|
| 1 chính + 1 xem | 620 + 6 + 260 = **886** | ✗ thiếu **2px** | ✓ | ✓ |
| 1 chính + 2 xem | 620+6+260+6+260 = **1152** | ✗ | ✓ | ✓ |

→ **Chính sách:** bật chia khung mà vùng nội dung không đủ thì **nới cửa sổ** trong phạm vi
`workArea` trước (dùng lại khuôn `sanitizeBounds` / `placeTornWindow`, `tabs.js:747-757`);
không nới được thì vẫn cho chia nhưng co đều và **nói ra**, không chặn cứng nút.

**Và đây là bằng chứng thứ hai cho kiến trúc C2:** ở cửa sổ 1360 chia đôi, bản 1 (hai khung
đầy đủ) cho mỗi bên 677px → **cả hai bên** mất ~30% chiều cao cho thanh công cụ. C2 chỉ có
**một** khung phải trả giá đó; khung xem mất ~28px cho thanh đầu một dòng.

### 10.4 P-E — RAM (**bản đã sửa**; bản đo đầu bị bỏ, lý do ở cuối mục)

Đo bằng `app.getAppMetrics()` **bên trong** probe (tổng `workingSetSize` mọi tiến trình) nên
mọi chế độ dùng **cùng một thước**. Ba mốc mỗi lượt:

| Mốc | Là gì |
|---|---|
| **nền** | app đã dựng xong, **chưa** có tài liệu |
| **đã nạp** | 20 s sau khi gửi file, **chưa ép vẽ trang nào** |
| **sau vẽ** | sau khi ép rasterise 6 trang đầu |

`app1` = **đúng** `renderer/index.html` + `src/preload.js` thật. Mọi khung đều bật
`backgroundThrottling: false` (xem cuối mục — thiếu cờ này thì `page.render()` không resolve).

| Bố cục | Tài liệu | Nền | Đã nạp | **GIỮ TÀI LIỆU** | Sau vẽ | Tiến trình |
|---|---|---:|---:|---:|---:|---:|
| `empty` | – | 332,8 | 333,5 | +0,7 | 332,6 | 4 |
| `app1` renderer đầy đủ | vec300 · 300 trang A1 | 334,7 | 401,7 | **+67,0** | 390,7 | 4 |
| `view1` khung xem | vec300 | 311,5 | 346,8 | **+35,3** | 342,8 | 4 |
| `split3` 1 chính + 2 xem | vec300 | 497,3 | 641,8 | **+144,5** | 625,3 | 6 |
| `app1` renderer đầy đủ | big · 120 MB | 334,6 | 975,2 | **+640,6** | 972,4 | 4 |
| `view1` khung xem | big | 312,5 | 829,5 | **+517,0** | 717,7 | 4 |
| `split3` 1 chính + 2 xem | big | 494,9 | 1805,5 | **+1310,6** | 1814,9 | 6 |

**Kết luận 1 — khung xem rẻ hơn, nhưng rẻ bao nhiêu thì TUỲ tài liệu:**

| Tài liệu | Renderer đầy đủ | Khung xem | Tỷ lệ |
|---|---:|---:|---|
| 300 trang A1 (1,8 MB) | +67,0 MB | +35,3 MB | **≤ 53%** |
| 120 MB, 20 trang | +640,6 MB | +517,0 MB | **≤ 81%** |

Chênh lệch giữa hai dòng nói đúng bản chất: bốn khoản mà khung xem bỏ đi (lịch sử hoàn tác,
autosave, thumbnail, lớp editor) tỷ lệ với **công việc trên tài liệu**, còn **bytes thô thì
bên nào cũng phải giữ**. Tài liệu nhiều trang ⇒ tiết kiệm nhiều; file nặng vì ảnh ⇒ tiết
kiệm ít.

"≤" là có chủ ý: ở mốc "đã nạp", `view1` **đã vẽ vài trang** (nguyên mẫu gọi `fitWidth()` ngay
sau khi mở), còn `app1` thì chưa. Nghĩa là con số của khung xem bị tính **dôi** — tỷ lệ thật
**thấp hơn hoặc bằng** những số trên. Sai số nghiêng về phía an toàn.

**Kết luận 2 — giá thật của việc bật 2 khung xem** (chênh tổng `split3` so với `app1`, cùng file):

| Tài liệu | Chỉ khung chính | + 2 khung xem | **Tăng** | Mỗi khung |
|---|---:|---:|---:|---:|
| 300 trang A1 | 390,7 MB | 625,3 MB | **+234,6 MB** | ~117 MB |
| 120 MB ảnh đặc | 972,4 MB | 1814,9 MB | **+842,5 MB** | ~421 MB |

**Kết luận 3 — mỗi khung xem tốn ~80 MB chỉ để TỒN TẠI.** Nền của `split3` (≈495 MB, 6 tiến
trình) so với `app1` (≈334 MB, 4 tiến trình) chênh ~160 MB **khi chưa có tài liệu nào**: đó là
giá cố định của một tiến trình renderer Electron. Vì vậy **không** nên mở sẵn khung xem rồi để
trống — mở theo yêu cầu, đóng thì huỷ hẳn view.

**Kết luận 4 — cột "sau vẽ" KHÔNG dùng để so sánh được, và tôi nói thẳng ra.** Hai renderer
virtualize khác nhau: `app1` ở scale 1 nên trang A1 rộng 1684px và `keepObserver` **nhả ngay**
5/6 trang vừa ép vẽ (đo được: `widths: [1684,0,0,0,0,0]`), còn khung xem fit-to-width (1543px,
hoặc 337px khi hẹp) nên giữ cả 6. Ép hai bên về cùng một trạng thái canvas là **không làm
được**, và một con số ép ra sẽ không mô tả đúng bên nào. Cột đó ở đây chỉ để cho thấy nó dao
động cả hai chiều (GC xen vào), **không** phải để rút tỷ lệ.

**⚠️ Bản đo đầu (cùng ngày) đã bị BỎ.** Nó chạy **không có** `backgroundThrottling: false`,
nên `page.render()` của `app1` **không resolve** và khung đó gần như không rasterise gì, trong
khi `view1` có. Tỷ lệ "48–59%" rút ra từ đó là **so lệch**, không dùng được. Cách phát hiện:
probe S1.1 treo ở `renderPageCanvas` và bị watchdog cắt — xem §12.

**⚠️ Đọc `big.pdf` cho đúng.** Nó là 3 ảnh nhiễu ngẫu nhiên 3739×3739 (42 MB/ảnh khi giải nén)
— **ca xấu nhất** cho cache ảnh của pdf.js, không đại diện cho bản vẽ CAD vector. Nó ở đây để
ép trục **dung lượng**; trục **số trang** là `vec300`. Bản vẽ thật nằm giữa hai ca này.

### 10.5 P-F — chú thích đã bake: **ĐẠT**

`annot.pdf` = 1 trang + `/Square` có `/AP` **vector** (đúng hình dạng `editor.js` bake ra —
BI-64). Hai khung cạnh nhau, đọc pixel **sau khi ép render** (đúng "cách làm đúng" của BI-4,
vì virtualization có thể đã nhả bitmap).

| Chế độ | Giữa ô chú thích (PDF 200,650) | Ngoài ô (PDF 450,300) — đối chứng |
|---|---|---|
| `annotationMode: ENABLE` | **rgb(250, 230, 51)** = đúng `/AP` fill `0.98 0.9 0.2` | trắng |
| `annotationMode: DISABLE` | trắng | trắng |

→ Khung xem **thấy** chú thích người dùng vừa lưu ở khung chính, miễn là dùng đúng
`AnnotationMode.ENABLE` như `app.js:927`. Ca `DISABLE` cho trắng chứng minh phép đo đang đo
đúng chỗ, không phải trùng hợp.

### 10.5b Kiểm bằng mã nguồn (không cần probe)

| Câu hỏi | Kết quả |
|---|---|
| Kho trang ẩn (BI-72/73) có bị khung xem giải mã nhầm không? | **Không.** `grep` cho thấy đường giải mã kho nằm **trọn** trong `renderer/page-vault.js` (`window.PageVault`), mà **chỉ** `index.html:1437` nạp. `view.html` không nạp ⇒ khung xem hiện **trang giữ chỗ**, đúng như Foxit/Acrobat thấy. Đúng theo thiết kế, không phải thiếu sót. |
| Cổng bản quyền (BI-9/BI-26) có bị hở không? | **Không.** Toàn bộ `GATED_BTNS` (`app.js:4315-4345`) là thao tác **ghi** hoặc **AI**; khung xem không có hàm nào trong số đó. Xem/zoom vốn miễn phí. |
| ⚠️ **Phát hiện mới:** PDF **có mật khẩu** | `app.js:539` `unlockEncrypted` mở khoá qua **sidecar `/decrypt`** — khung xem **không** có đường đó (và không nên có). Phải bắt `PasswordException` của pdf.js và nói rõ: *"Tài liệu có mật khẩu — mở ở khung chính."* Bổ sung vào §4.5 và test 8.2 #19. |

### 10.6 Vật liệu thử (dựng bằng `pdf-lib` dự án đang ship)

| File | Nội dung | Ép cái gì |
|---|---|---|
| `vec300.pdf` — 1,8 MB | 300 trang **A1**, mỗi trang 400 nét vector + 40 dòng chữ | **số trang** (bộ bản vẽ vài trăm trang) |
| `big.pdf` — 120,0 MB | 20 trang A1, ảnh nhiễu ngẫu nhiên (không nén được) | **dung lượng** |
| `annot.pdf` — 3 KB | 1 trang + `/Square` có `/AP` **vector** (đúng hình dạng BI-64 bake ra) | P-F |


---

## 11. Nhật ký quyết định

**2026-09-08 · bản 1 → bản 2.** Bản 1 thiết kế **hai khung đều sửa được** (hai
`WebContentsView` cùng nạp `index.html`). Người dùng chốt lại phạm vi: cần **cùng một file ở
nhiều khung**, **tối đa 3 khung**, và khung 2/3 **chỉ đọc**.

Đổi này làm thiết kế **tốt lên**, không phải xấu đi:

| | Bản 1 (2 khung sửa được) | Bản 2 (1 chính + 2 chỉ đọc) |
|---|---|---|
| Cùng một file ở hai khung | ❌ không giải được (hai renderer ghi đè nhau, âm thầm) | ✅ giải **bằng thiết kế** |
| Lệnh menu (Ctrl+S / In / Undo) | ⚠️ mơ hồ — phải theo dõi focus, rủi ro **mất việc** | ✅ **không đổi nghĩa** |
| Hàm phải sửa | 14 | **6** |
| Bất biến bị chạm | BI-57 (phải sửa) | **không mục nào** — BI-78 là phải *mang theo*, không phải *sửa* |
| RAM mỗi khung thêm | ~2,1–2,7× cỡ file | ~1,2–1,5× (ước, chờ P-E) |
| Code mới | ~380–450 dòng vỏ | ~250 dòng vỏ + ~450 dòng trang xem mới |

Cái giá phải trả: **một trang renderer mới** phải tự mang theo BI-78 (§4.4) — đây trở thành
rủi ro số một của bản 2, và là lý do bước **S1.1 (tách `raster-cap.js`) đứng trước mọi bước
khác**.

### 10.7 Chạy lại

Probe nằm ở scratchpad của phiên (không commit). Dựng lại:

1. `gen/gen.js` — dựng `vec300.pdf` / `big.pdf` / `annot.pdf` bằng
   `desktop/node_modules/pdf-lib`. Chữ trong `vec300` phải là **ASCII**: `StandardFonts.Helvetica`
   là WinAnsi, gặp dấu tiếng Việt sẽ ném `WinAnsi cannot encode`.
2. `probe-ab/` — P-A/P-B. Main dựng cửa sổ + 3 view rồi ghi `plan.json` (kèm `scaleFactor`
   để đổi DIP → pixel vật lý); `drive.ps1` điều khiển **chuột thật** bằng `user32!SetCursorPos`
   + `mouse_event`. Chạy main **nền**, `drive.ps1` ở **tiến trình riêng** — nếu HTML5 drag vào
   vòng lặp modal của Windows thì main có thể bị chẹn, không tự bơm input cho mình được.
3. `probe-d/` — nạp thật `index.html` + `preload.js`, stub 43 kênh IPC, đặt `view.setBounds`
   theo từng bề rộng rồi `executeJavaScript` đo. **Nhớ bỏ `hidden`** của `#breadcrumb` và
   `#statusbar`, nếu không thiếu 47px.
4. `probe-e/` — `electron . <empty|app1|view1|split3> <pdf>`; đo bằng `app.getAppMetrics()`.
   Chạy **tuần tự, mỗi lần một tiến trình**, nếu không các lượt đo giẫm lên nhau.
5. `probe-f/` — hai khung `ENABLE`/`DISABLE`, đọc pixel sau khi **ép render** (BI-4).

Mọi probe ghi kết quả ra **FILE** kèm **watchdog** `app.exit()` — stdout của Electron mất
trên Windows, và một probe treo sẽ khoá cả phiên làm việc.

---

## 12. Nhật ký thực hiện (Giai đoạn 1)

### ✅ S1.1 — tách hạn mức raster ra `renderer/raster-cap.js` (2026-09-08)

Bước này đứng **trước mọi bước khác** vì nó là rủi ro **R1**: trang xem mới cũng rasterise
PDF, và một bản sao hằng số ở đó là cách **BI-78 chết một nửa** — sửa một bên, bên kia giữ số
cũ, triệu chứng là **bản vẽ A0 trắng bệch không báo lỗi**.

**Đã làm**

| File | Thay đổi |
|---|---|
| `renderer/raster-cap.js` | **MỚI** — IIFE, publish `window.RasterCap` + `module.exports`. Đúng khuôn `page-range.js`: IIFE để hằng số thành private (BI-14 nửa thứ hai), gọi qua tên có không gian tên (BI-14 nửa thứ nhất). |
| `renderer/app.js` | Xoá 3 khai báo, thay 1 chỗ gọi thành `window.RasterCap.viewRasterDpr(...)`, 2 comment trỏ lại đúng chỗ. **Không đổi một dòng logic nào.** |
| `renderer/index.html` | Thêm `<script src="raster-cap.js">` **trước** `app.js` |
| `test/raster-cap.test.js` | **MỚI** — 24 ca |
| `test/viewer-geom.test.js` | Chuyển từ `extractFn`/`extractConst` sang `require()`; **thêm 3 ca chặn bản sao** |
| `package.json` | `test:raster` |

**Kiểm chứng — bốn tầng, tầng nào cũng cần**

1. **`node test/raster-cap.test.js` — 24/24.** Ca quan trọng nhất là **280 ca lưới**
   khổ giấy (A4…A0 + dải dài) × zoom (0,2–5) × dpr (1–3), so **từng ca** với một **bản chép
   nguyên văn** hàm cũ ở `app.js@9717b10`. Lệch **0/280** ⇒ chứng minh đây là **bê nguyên**,
   không phải "tiện tay dọn dẹp".
2. **`test/viewer-geom.test.js` đã BẮT được việc di chuyển** (`const MAX_VIEW_MEGAPIXELS not
   found in renderer/app.js — renamed or removed?`). Đây là lưới cũ làm đúng việc của nó.
   Sửa theo **đúng tiền lệ file này tự ghi**: khi `resizeRect` rời `editor.js` sang
   `annot-geom.js` ở v0.2.48 nó chuyển sang `require()` và **giữ nguyên mọi ca** — cách
   chứng minh một cú chuyển nhà. Nay thêm 3 ca **chặn bản sao**: `app.js` mà còn khai báo lại
   một trong ba tên đó là **FAIL**.
3. **Cả 20 file lưới xanh** (`for t in test/*.test.js`).
4. **Probe Electron** — bắt buộc, vì BI-14 ghi rõ: *"node không bao giờ thấy lỗi này:
   537/537 ca lưới xanh trong lúc app đang vỡ"*.

| Kiểm trong app THẬT | Kết quả |
|---|---|
| `typeof $ === "function"` (canary của BI-14) | ✅ — `app.js` sống |
| Console error khi nạp `index.html` | ✅ **rỗng** |
| `window.RasterCap` có mặt, hằng số 32 / 12000 | ✅ |
| `PageRange` · `Editor` · `Pan` · Help vẫn nạp | ✅ |
| Vẽ trang A4 thật | canvas **595px** = `floor(595 × dpr 1)` ✅ |
| **Ép** `RasterCap.viewRasterDpr` trả `0.25` rồi vẽ lại | canvas **148px** = `floor(595 × 0,25)` ✅ ⇒ đường render **thật sự đi qua** `RasterCap`, không phải "module có mặt nhưng không ai gọi" |
| Trả lại rồi vẽ lại | về **595px** ✅ |

### ✅ S1.2 — `splitRects()` thuần + hằng số ĐÃ ĐO (2026-09-08)

Thêm vào `src/tabs.js`: `SPLIT_GUTTER` · `MAIN_MIN_W = 620` · `MAIN_HARD_MIN_W = 420` ·
`VIEW_MIN_W = 260` · `VIEW_HARD_MIN_W = 180` · `normalizeRatios` · `largestRemainderRound` ·
`solveWidths` · `splitRects` — **153 dòng thêm, 0 dòng sửa**. Chưa nối vào `_layout` (đó là
S1.4), nên **hành vi app chưa đổi một chút nào**.

Ba quyết định đáng ghi:

1. **Ba bậc sàn, không phải một.** Sàn ưu tiên (620/260) → sàn cứng (420/180) → chia theo tỷ
   lệ. Vì `splitRects` **không được phép từ chối** trả về layout: người gọi đã được lệnh chia
   khung thì phải nhận được thứ vẽ được. Nói "cửa sổ quá hẹp" là việc của UI, không phải của
   hình học.
2. **`largestRemainderRound`, không `Math.round` từng khung.** Làm tròn độc lập là chỗ đẻ ra
   khe 1px giữa hai view **native** — và khe đó là một vệt desktop nhấp nháy, không phải một
   lỗi ai đó ném ra.
3. **Tỷ lệ rác → tỷ lệ mặc định, không bao giờ ra khung rộng 0.** Khung 0px là một renderer
   người dùng không thấy và không đóng được.

**Kiểm chứng:** `test/split-layout.test.js` — **306 ca, 0 fail**, gồm một **quét
300…3840px × {1,2} khung xem × 5 bộ tỷ lệ** kiểm 4 bất biến (kề khít rãnh · phủ hết bề rộng ·
không âm · số rãnh đúng).

Xanh ngay lần đầu là **đáng ngờ**, nên lưới được kiểm bằng **đột biến** — cả ba đều bị bắt:

| Đột biến | Lưới báo |
|---|---|
| bỏ `largestRemainderRound`, làm tròn từng khung | **5 FAIL** — "phủ hết bề rộng" gãy ở 1363 / 1367 / 999 / 1151 px và ở lượt quét |
| bỏ kẹp sàn tối thiểu | **3 FAIL** — kéo hết cỡ thì khung thủng sàn 620 / 260 |
| chrome không phủ hết cửa sổ khi chia khung | **2 FAIL** — mất điều kiện để rãnh nhận chuột (P-A) |

Khôi phục xong: 306 pass, `git diff --stat` = `153 insertions(+)`, **0 deletions** — đúng là
chỉ thêm mới. Toàn bộ **21 lưới xanh**.

### ✅ S1.3 + S1.4 — khung xem chỉ-đọc chạy thật (2026-09-08)

**File mới**

| File | Vai trò |
|---|---|
| `renderer/view.html` | Trang khung xem. Nạp `app.css` (một bảng màu, một chủ đề sáng/tối — không nhân bản) rồi `view.css` cho layout riêng; nạp `raster-cap.js` **trước** `view.js`. |
| `renderer/view.css` | Thanh đầu **một dòng, `flex-wrap: nowrap`** — thanh đầu mà xuống dòng thì trả lại đúng phần chiều cao mà trang này sinh ra để tiết kiệm. Khung hẹp thì **rút gọn nhãn**, không xuống dòng. |
| `renderer/view.js` | Viewer chỉ-đọc: dựng trang lười 2 dải (vẽ / nhả), zoom + fit, nhảy trang, Ctrl+lăn, bắt `PasswordException`. |
| `src/view-preload.js` | **5 hàm**: `ready` · `onOpen` · `onClear` · `onReload` · `close`. So với `src/preload.js` (277 dòng, 43 kênh). Không ghi được gì, không chạm sidecar, không biết tên renderer nào khác (BI-55). |

**Sửa `src/tabs.js`** (+408 dòng, gồm cả S1.2): `viewPanes` / `paneRatios` · `_rects()` dùng
chung cho `_layout` và mọi hit-test · `addViewPane` / `setPaneSource` / `paneReady` /
`reloadPanesForPath` / `closeViewPane` / `setPaneRatios` · `docViewScreenRect` nay trả rect
**khung chính** · `paneAt(point)` phân biệt `main` / `view` / rãnh *(bước S1.5 **thay** hàm này bằng
`viewPaneScreenRects()` — lý do ở mục S1.5 bên dưới)* · `_emit` gửi kèm hình học rãnh · `_onClosed` huỷ pane · `findViewPane` tra theo `e.sender`.

**Sửa `src/main.js`** (+119 dòng): `sendFileToPane` (đọc **từ đĩa**, kèm `savedAt`, file mất →
`view:clear` **kèm lý do**) · `view:ready` / `view:close` · reload pane ngay trong
`file:write-pdf` — **đúng chỗ bytes chạm đĩa**, nên "khung xem hiển thị bản đã lưu" là một
**luật**, không phải một hy vọng · menu **Hiển thị** → Chia đôi (`Ctrl+\`) / Thêm khung xem
(`Ctrl+Shift+\`) / Đóng khung xem, chữ cả `vi` và `en`.

**Ba quyết định đáng ghi**

1. **Pane thuộc CỬA SỔ, không thuộc TAB.** Vì thế `activateTab` · `destroyTab` · `detachTab` ·
   `moveTabTo` · `tearOutTab` · `Ctrl+W` · `Ctrl+Tab` · `activeContents` **không đổi một dòng**
   — đúng như §5.1 dự đoán.
2. **Đóng pane thì HUỶ hẳn webContents** — ngược hẳn BI-15 (tab bị detach **không bao giờ**
   được đóng, vì nó sắp sang cửa sổ khác). Pane không giữ việc chưa lưu, mà một tiến trình
   renderer tốn **~80 MB chỉ để tồn tại** (§10.4) ⇒ để lại là rò rỉ theo số lần người dùng
   từng chia khung.
3. **`samePath()` chuẩn hoá hoa/thường + dấu phân cách** trước khi so, nếu không thì reload
   sau khi lưu sẽ trượt trên Windows đúng những ca hay gặp nhất.

**Kiểm chứng — probe chạy `src/tabs.js` + `view.html` + `view-preload.js` THẬT trong Electron: 30/30**

| Nhóm | Kết quả |
|---|---|
| 0 khung xem | chrome = dải 40px, tab chiếm hết — **y hệt trước khi có tính năng** |
| 1 khung xem | chrome **phủ hết cửa sổ**; bounds THẬT của cả 3 view khớp `splitRects` từng pixel; **kề khít rãnh 6px**; phủ hết bề rộng |
| Tài liệu vào pane | `wraps: 300` · tên file · `· bản lưu 10:03` · `zoom 35%` (fit-width đúng cho A1 trong khung 630px) · **`canvases: 2`, `maxW: 584px`** = bitmap thật |
| Nhãn & cầu nối | badge **CHỈ ĐỌC**; `window.viewPane` đúng **5** hàm, không hơn |
| BI-78 | pane dùng **chung** `window.RasterCap` |
| `paneAt` | giữa khung chính → `main` · giữa khung xem → `view` · **trong rãnh → null** · trên dải tab → null · ngoài cửa sổ → null |
| 2 khung xem | cả ba bounds khớp; **khung thứ ba bị từ chối** (trần 2) |
| Đóng hết | chrome co lại 40px, tab lại chiếm hết, `viewPanes.length === 0` |

Hai chi tiết của phép kiểm này đáng ghi lại:

- **Lượt đầu 26/30**, cả 4 lỗi là *một* nguyên nhân: probe tự đăng ký `view:ready` mà **quên
  gọi `paneReady`**, nên tài liệu nằm mãi ở `pane.pending`. Lỗi của probe, không phải của sản
  phẩm — `main.js` có handler ở dòng 1348. Sửa probe → 29/30.
- **Lỗi cuối cùng là môi trường, không phải mã.** `canvases: 0` vì phiên chạy không có desktop
  được compositor vẽ, và `page.render()` của pdf.js **không resolve** khi đó (cùng bẫy
  `backgroundThrottling` ở dưới). Thêm một `capturePage()` ép một frame → **30/30**.

*(Đã thử đường chụp màn hình để kiểm bằng mắt và **bỏ**: nó chụp cả màn hình nền của người
dùng — nội dung riêng tư không liên quan. Probe cấu trúc vừa chắc hơn vừa không đụng gì.)*

### ⚠️ Bài học probe: `backgroundThrottling`

Lần chạy đầu, probe **treo** ở `renderPageCanvas` và watchdog phải cắt. Nguyên nhân:
**`page.render()` của pdf.js không resolve khi cửa sổ probe không được compositor vẽ.**
Thêm `backgroundThrottling: false` vào `webPreferences` là hết.

Hệ quả **ngược lại phép đo của chính tôi**: bảng P-E lần đầu (§10.4) chạy **không có** cờ đó,
nên khung `app1` nhiều khả năng **chưa rasterise trang nào** trong khi `view1` thì có (nó gọi
thẳng `renderPage` trong `fitWidth`) ⇒ phép so sánh **không công bằng**. §10.4 đã đo lại với:

- `backgroundThrottling: false` ở **cả hai** loại khung;
- **ép render đúng K = 6 trang đầu ở cả hai phía** thay vì cuộn rồi trông chờ
  `IntersectionObserver` — thứ kích **chập chờn** trong cửa sổ probe.

Ghi lại đây vì mọi probe Electron sau này của dự án đều dính bẫy này, cùng họ với ghi chú đã
có: *"capturePage trả frame cũ nên phải dùng offscreen + đếm paint"*.

### ✅ S1.5 → S1.13 — Giai đoạn 1 hoàn tất (2026-09-08)

#### S1.5 + S1.6 — thả trang vào khung xem: **từ chối ra tiếng**, không im lặng

`docViewScreenRect()` đã co về khung chính từ S1.4, nên một trang thả vào khung xem **đã**
không rơi vào tài liệu nào. Nhưng kết quả của nó là `action: "none"` — **giống hệt** thả ra
desktop. Một cử chỉ nhắm vào vùng hình-dạng-tài-liệu mà **không xảy ra gì cả** thì người
dùng đọc là lỗi, nên phải có câu trả lời thứ tư:

```
self      thả trong tài liệu của chính mình  → sắp xếp trong cột (BI-57, không đụng)
send      thả vào tài liệu cửa sổ khác       → chuyển trang
readonly  thả vào KHUNG XEM (của bất kỳ ai)  → từ chối + toast          ← MỚI
none      không trúng gì                     → im lặng
```

**Vì sao `classifyPageDrop` chứ không phải `paneAt`.** Kế hoạch ở §5.1 #4 viết "dùng
`paneAt(point)`". Khi làm thật thì thấy sai chỗ: "điểm này thuộc mặt phẳng nào" là câu hỏi
về **tất cả cửa sổ cùng lúc** — chúng chồng nhau, và cái **ở trên** thắng. Phép giải đó đã
nằm sẵn, thuần và có test, trong `classifyPageDrop` (luật `z`). Một hit-test riêng cho từng
cửa sổ sẽ là **bản sao yếu hơn** của nó, và sai đúng ca chồng lấn:

> khung xem của cửa sổ **A** (đang ở trên) che tài liệu của cửa sổ **B** → gọi `paneAt` lần
> lượt từng cửa sổ sẽ báo "gửi cho B", tức là chèn trang vào tài liệu người dùng **không
> nhìn thấy** ở điểm đó.

Nên `paneAt()` bị **thay** bằng `viewPaneScreenRects()` (trả các chữ nhật, không phán xét),
`pageDropTargets()` mang chúng theo trong `panes`, và `classifyPageDrop` — vẫn thuần, vẫn
không Electron — quyết định. `page-move.js` thêm đúng một nhánh: `readonly` → toast
*"Khung xem chỉ đọc — không nhận trang. Hãy thả vào khung chính."*

**BI-57 không hề bị chạm:** nhánh `self` vẫn đứng **trước** và vẫn ăn trọn mọi điểm trong
**tài liệu** của cửa sổ nguồn. Khung xem là một `WebContentsView` khác, cú kéo trong DOM của
renderer nguồn không bao giờ với tới nó.

`test/page-drop.test.js`: **63 → 82 ca** (thêm 19: bốn hướng thả khi đang chia khung, rãnh, ra
ngoài, hai chiều của luật `z` giữa pane và tài liệu, `panes` thiếu / rác / phần tử rác, và
`viewPaneScreenRects` so với `docViewScreenRect` qua rãnh 6px).

#### S1.7 — nạp lại sau khi lưu **giữ nguyên chỗ đang đọc**

`file:write-pdf` → `reloadPanesForPath` đã có từ S1.4. Chỗ còn thiếu chỉ lộ ra khi dùng thật:
`onReload` gọi `open()`, mà `open()` `teardown()` sạch rồi `fitWidth()` — nên **mỗi lần
`Ctrl+S` ở khung chính là khung xem nhảy về trang 1**. Với người vừa sửa trang 40 vừa đối
chiếu trang 12, đó là tính năng tự huỷ.

`open(payload, keep)` nhận thêm mốc `{ fit, scale, page }` chụp **trước** teardown. Chế độ
`fit` được **áp dụng lại** chứ không khôi phục thành con số — bản lưu mới có thể khác khổ
trang, và "vừa bề ngang" phải vẫn có nghĩa đó. Zoom gõ tay thì khôi phục **đúng số**, vì đó
là lựa chọn của người dùng. `open()` không có `keep` (đổi sang tài liệu **khác**) vẫn
`fitWidth()` như cũ — khôi phục vị trí cuộn của một tài liệu khác là khôi phục chỗ của người lạ.

#### S1.8 — ô chọn nguồn: **menu native, do MAIN dựng**

Tên file trên thanh đầu khung xem **chính là** nút chọn nguồn (một mục tiêu thay vì nhãn +
nút ▾ — ở khung 260px đó là cả một bề rộng nút). Bấm → `view:pick-source` → **main** dựng
`Menu` native: *Cùng tài liệu khung chính* · từng tab đã lưu của cửa sổ · *Mở file khác…*.

Khung xem **không bao giờ nhận danh sách** — nó chỉ đặt câu hỏi; main dựng menu, main hành
động (BI-55). Danh sách được tính **lúc mở menu**, cùng lý do `pages:targets` làm thế (P13):
tab mở/đóng liên tục, một danh sách nhớ sẵn sẽ mời một tab đã biến mất.

#### S1.9 + S1.10 — nút `◫` và **rãnh kéo được**

`renderer/shell.html` thêm nút `◫` (sáng lên khi đang chia khung) và một lớp `#gutters` phủ
toàn cửa sổ nhưng `pointer-events: none` — **bắt buộc**, nếu không thì khi *không* chia khung,
lớp phủ toàn cửa sổ này sẽ nuốt cú bấm đáng lẽ dành cho tài liệu.

Cơ chế kéo đúng như P-B đã đo: `setPointerCapture`, `pointermove` gửi tỷ lệ, và
`lostpointercapture` + `pointercancel` **bắt buộc** kết thúc phiên kéo (mất capture vì Alt-Tab,
vì cửa sổ mất focus) — không có nó thì một phiên kéo sống lâu hơn cử chỉ sinh ra nó, đúng
loại lỗi BI-58 cảnh báo.

**Vòng phản hồi là chỗ dễ sai nhất, và cách chặn nó:**

| Cách làm ngây thơ | Hỏng ở đâu |
|---|---|
| `setPaneRatios` gọi `_emit()` | `_emit` dựng lại **toàn bộ DOM** thanh tab — kể cả chính cái tay nắm đang giữ pointer capture. Phiên kéo **chết ngay frame đầu**. |
| Thanh tab tự đặt lại tay nắm theo con trỏ | Tay nắm sẽ **lệch khỏi biên thật** ngay khi chạm sàn `MAIN_MIN_W`, trừ phi chép các hằng số đã đo sang renderer — tức hai bản sao của cùng một con số. |

Cách đã chọn: main `_layout()` rồi đẩy **`split:geom`** (chỉ hình học) về thanh tab, thanh tab
chỉ *đặt lại vị trí* các tay nắm, **không dựng lại DOM**. Số sàn tối thiểu nằm ở **đúng một
file** (`src/tabs.js`), và tay nắm luôn ở đúng biên mà `solveWidths` thật sự dùng.

#### S1.11 — cột trang tự co

`app.js` `initSidebarWidth()` thêm listener `resize` **áp dụng lại bề rộng ĐÃ LƯU** (không
persist). `clampSidebarWidth` vốn đã kẹp trần `innerWidth * 0.4` nhưng **chỉ khi được gọi** —
mà `grep "resize"` trong `app.js` trước đây cho **không kết quả**. Không persist là phần quan
trọng: bề rộng người dùng chọn phải **quay lại** khi khung rộng ra.

#### S1.12 — phiên nhớ bố cục chia khung

`snapshotSession` thêm `panes: [path|null]` + `ratios` — **chỉ khi có chia khung**. Hai lý do
cho chữ "chỉ khi":

1. `session.json` cũng được đọc bởi các bản đã phát hành trước tính năng này; cửa sổ không
   chia khung (đại đa số) phải cho ra **đúng object cũ**, không thừa khoá nào.
2. **`v` giữ nguyên `1`.** Nâng version sẽ khiến **mọi máy đang cài** vứt bỏ phiên nó đang
   có — đánh đổi tài liệu đang mở thật để lấy một gợi ý bố cục là một vụ đổi chác tồi.

`restoreSession` dựng pane **sau** tab (vì `addViewPane` reset `paneRatios` mỗi lần số khung
đổi), rồi mới đặt `ratios`. Pane trỏ tới file đã bị xoá vẫn **mở** (rỗng): bố cục người dùng
để lại phải quay về nguyên vẹn, chỉ thiếu nội dung. Pane rỗng vẫn **giữ chỗ** (`null`) vì
`ratios` đánh số theo vị trí.

`test/tabs-logic.test.js`: **113 → 120 ca**, trong đó ca quan trọng nhất là *"không chia khung
→ KHÔNG có khoá panes/ratios"* — so khớp **đúng bộ khoá**, không phải chỉ kiểm giá trị.

#### S1.13 — "Sửa file này"

Nút hiện **chỉ khi** khung xem đang mở tài liệu **khác** khung chính — main tính điều đó và
đẩy `view:state { canEdit }`; renderer không tự so đường dẫn với ai. Bấm → nếu file đó đã là
một tab thì `activateTab`, nếu chưa thì `createTab`; **rồi khung xem nhận lấy tài liệu vừa
rời khung chính**. Nhờ cú hoán đổi đó, hai file vẫn nằm cạnh nhau — không file nào biến mất
khỏi màn hình.

#### Kiểm chứng — probe **42/43**, và ca đỏ duy nhất là **môi trường**

Probe mới (`scratchpad/probe-split2`) chạy `src/tabs.js` + `renderer/view.*` +
`renderer/shell.*` **thật** trong Electron 33.4.11:

| Nhóm | Kết quả |
|---|---|
| 0 khung | chrome 40px, tab chiếm hết, `viewPaneScreenRects() === []` |
| 1 khung | bounds THẬT của cả 3 view khớp `splitRects` từng pixel |
| S1.5 | `viewPaneScreenRects` = bounds thật quy về toạ độ màn hình; `pageDropTargets()` mang `panes`; thả giữa khung chính → **self**, giữa khung xem → **readonly**, rãnh → **none**, dải tab → **none** |
| S1.8/S1.13 | tên file là `<button>` có `▾`; **cùng** tài liệu → ẩn *Sửa file này*; đổi nguồn sang `annot.pdf` → tên đổi **và** nút hiện |
| Cầu nối | `window.viewPane` đúng **8** hàm: `close · editThis · onClear · onOpen · onReload · onState · pickSource · ready` |
| S1.9 | `#split` có class `on`; **1** rãnh được vẽ, `left` khớp `splitRects`, rộng đúng `6px` |
| S1.10 | `setPaneRatios([0.75,0.25])` → bounds **thật** của cả hai view đổi theo; `split:geom` đẩy tay nắm về **đúng biên mới**; `[0.02,0.98]` bị kẹp — khung chính **không** thủng `MAIN_HARD_MIN_W` |
| S1.7 | cuộn tới trang 8, `reloadPanesForPath` → vẫn **trang 8** |
| S1.12 | `snapshotSession` có `panes:[vec300.pdf]` + `ratios` 2 phần tử; `restoreSession` dựng lại 1 cửa sổ, 1 khung xem, **đúng file**, **đúng ratios** |
| Đóng hết | chrome co lại 40px, `viewPanes.length === 0`, nút `◫` tắt, **rãnh biến mất** |

**Ca đỏ duy nhất: `canvases: 0`** — khung xem không rasterise trang nào. Đây là **phiên chạy**,
không phải mã, và có ba bằng chứng độc lập:

1. `capturePage` trả `"Current display surface not available for capture"`;
2. đo trong chính renderer đó: `requestAnimationFrame` → **timeout**, `IntersectionObserver`
   → **timeout**, còn `canvas 2D` vẽ rồi đọc lại pixel thì ra **255** (đúng). Không có vòng
   frame thì `IntersectionObserver` không kích, mà nó chính là thứ khởi động bộ dựng trang lười;
3. **chạy đối chứng**: probe cũ (`probe-split`, đường dựng trang **không đổi một dòng** ở các
   bước này) chạy lại **cùng phiên** cũng cho `canvases: 0` với **đúng lỗi đó** — trong khi
   sáng cùng ngày nó cho `canvases: 2, maxW: 584`.

Đã thử `backgroundThrottling: false` (rig của probe, **không phải** sản phẩm) và
`disableHardwareAcceleration()` + `--disable-gpu` — **không** đủ: phiên này không có display
surface nào để mà vẽ. Đường rasterise của khung xem **không bị S1.5–S1.13 chạm tới**, và đã có
bằng chứng dương từ lượt đo trước cùng ngày. Ghi đúng như vậy, không dán nhãn "đạt".

**Toàn bộ 21 lưới node: xanh.**
