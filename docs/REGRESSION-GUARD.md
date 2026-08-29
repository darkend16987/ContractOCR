# Sổ bất biến & chống hồi quy — Nabu PDF

_Lập 2026-07-25. Mục đích: **sửa tính năng mới không được làm hỏng tính năng cũ đang chạy tốt** — nhất là những thứ vừa fix xong ở bản trước._

**Cách dùng:** trước khi sửa, tra mục §5 (“đụng gì → test gì”). Sau khi sửa, chạy đúng
các mục test được chỉ. Khi phát hiện một hợp đồng ngầm mới, **ghi thêm vào §3** —
tài liệu này chỉ có giá trị nếu được cập nhật.

---

## 1. Bản đồ rủi ro: file nào dễ vỡ nhất

| File | Dòng | Vì sao rủi ro cao |
|---|---|---|
| `desktop/renderer/app.js` | ~4440 | State trung tâm + 12 hàm nút thắt. **Gần như mọi bản phát hành đều đụng.** |
| `desktop/renderer/editor.js` | ~3180 | Overlay annotation, bake, form. Diff lớn nhất mỗi lần release. |
| `desktop/renderer/annot-text.js` | ~230 | Bố cục chữ (`layoutTextBox`). Rủi ro **thấp** nhờ lưới `npm run test:text`, nhưng sai ở đây **im lặng**: hộp trên màn hình và PNG đem bake lệch nhau → chữ tràn/xuống dòng khác trong file đã lưu → xem BI-40. |
| `desktop/renderer/managed-codec.js` | ~340 | Lớp object PDF riêng của chú thích sửa-lại-được. **Hậu quả cao nhất trong repo**: sai là **mất ảnh của người dùng** hoặc phình file âm thầm. Từ v0.2.58 chứa thêm số học đặt `/AP` trên trang xoay (`apMatrixFor`/`apRectFor`), từ v0.2.61 thêm `shapeAppearance` — appearance **vector** của chữ nhật/elip — cả hai đều thuần, nằm trong `test:managed` + `test:rotate`. Xem BI-37, BI-38, BI-14, BI-59, BI-64. |
| `desktop/renderer/annot-geom.js` | ~420 | Đường mây revision + nhãn mũi tên + `resizeRect` + (v0.2.50) `strokeExtend` (luật Shift của vẽ tay) + `symbolStrokes` (hình ✓/✗) + (v0.2.52) `snapLineEnd` (kéo một đầu mũi tên) và `annotBounds`/`translateAnnot`/`unionBounds`/`fitShift` (số học của copy–paste vật thể). Rủi ro **thấp** nhờ `npm run test:cloud` + `test:geom`; sai ở đây làm mây/dấu lệch chỗ **trong PDF đã lưu** (trên màn hình vẫn đúng), hoặc dán một mục ra **ngoài mép giấy** nơi không tay nắm nào tóm lại được → xem BI-40, BI-42, BI-46. |
| `desktop/renderer/editor.js` — khối bake (`drawOneAnnot`) | ~200 dòng | Bù xoay trang. Rủi ro **cao và im lặng**: overlay trên màn hình luôn đúng, chỉ **file đã lưu** sai, và **chỉ trên trang có `/Rotate`** — tức đúng loại tài liệu (scan nằm ngang, bản vẽ A3) mà người viết code không mở hằng ngày. Nay có lưới `npm run test:rotate` đi qua **mọi** kind → xem BI-45. |
| `desktop/renderer/editor.js` — ba nhánh `/AP` của `addManagedAnnot` | ~120 dòng | Cùng loại rủi ro im lặng như hàng trên, ở **đường annotation** thay vì đường dán cứng: viewer tự co giãn appearance cho khít `/Rect` (PDF §12.5.5) nên `/Rect` sai không làm con dấu lệch mà làm nó **méo**, và chỉ thấy trên trang xoay. `test:rotate` §5 đo lại đúng cùng một câu hỏi ("rơi vào đâu trên màn hình") bằng cách so với đường dán cứng đang ship, kèm **ca canh gác** → xem BI-59. |
| `desktop/renderer/editor.js` — hộp gõ chữ nội tuyến (`openTextEditor`, `renderLayer`, `PALETTE_KEEP_SEL`) | ~90 dòng | Rủi ro **trung bình**, hậu quả **mất chữ người dùng đang gõ**, và mất **im lặng**: hộp gõ là con của annot layer, `renderLayer` xoá layer bằng `innerHTML = ""`, còn Chromium **không phát `blur`** khi xoá phần tử đang focus ⇒ `commit` không chạy, không annot, không bước undo, không lỗi. Chỉ có **assertion trên source** trong `npm run test:defaults` → xem BI-75. |
| `desktop/src/main.js` + `src/tabs.js` | — | Tầng cửa sổ/tab — **hệ con mới nhất, ít va đập thực tế nhất** (ra mắt v0.2.41). Có lưới tự động `npm run test:tabs` cho phần logic thuần. |
| `desktop/renderer/page-move.js` | ~330 | Chuyển trang giữa hai tài liệu đang mở. Rủi ro **trung bình** nhưng hậu quả **cao nhất về dữ liệu**: nhánh MOVE **xoá trang ở tài liệu nguồn**. Nửa số học có lưới `npm run test:pagedrop`; nửa cử chỉ **máy không test được** (Chromium bỏ qua input tổng hợp trong đường kéo–thả, `TABS-2B-DESIGN.md` §2.2) nên chỉ có test tay + assertion trên source trong cùng lưới đó → xem BI-55, BI-56, BI-57, BI-58. |
| `desktop/renderer/page-vault.js` | ~330 | Trang ẩn có khoá (v0.2.64). Rủi ro **trung bình** (thuần, DOM-free, có lưới `npm run test:vault` từ commit đầu tiên) nhưng **hậu quả cao nhất có thể có**: sai ở đây là **mất hẳn một trang hợp đồng**, không lỗi, không cảnh báo. Bốn cạm bẫy đều đã đo và đều nằm trong lưới → xem BI-72, BI-73, BI-74. |
| `desktop/renderer/page-range.js` | ~170 | Số học khoảng trang. Rủi ro **thấp** vì có lưới `npm run test:pages`, nhưng hậu quả sai là **mất trang tài liệu** → xem BI-27. |
| `desktop/renderer/pan.js` | ~380 | Bàn tay/pan. Rủi ro **trung bình**: nó giành sự kiện chuột **trên cùng phần tử** với `editor.js`/`capture.js`. Nửa logic có lưới `npm run test:pan`; nửa DOM thì không → xem BI-30/31. |
| `desktop/renderer/find-replace.js` | ~700 | Tìm & Thay thế. Rủi ro **trung bình** nhưng hậu quả **cao và im lặng**: nó **ghi vào chữ gốc** của tài liệu hàng loạt. Nửa số học có lưới `npm run test:find`; nửa DOM chỉ có **assertion trên source** trong cùng lưới đó → xem BI-50, BI-51. |
| `desktop/renderer/wire.js` | ~130 | Bộ mã hoá payload nhị phân. Rủi ro **thấp** nhờ lưới `npm run test:wire`, nhưng sai ở đây **im lặng**: request vẫn đúng cú pháp, chỉ là base64 hỏng → xem BI-24. |
| `desktop/renderer/app.js` — khối zoom | ~130 dòng | `applyScaleToDom`/`commitScale` đụng CSS box của **mọi** trang + 4 lớp overlay. Sai là zoom mờ mãi hoặc chú thích lệch. Nửa số học có lưới `npm run test:geom` → xem BI-36. |
| ~~`editor.js` — ảnh round-trip~~ → `managed-codec.js` (v0.2.49) | ~180 dòng | Ghi/đọc/giải phóng object PDF riêng. Sai ở đây **mất ảnh của người dùng** hoặc phình file âm thầm. Có lưới `npm run test:managed` → xem BI-37, BI-38. |
| `desktop/renderer/app.css` — khối `@media print` + `app.js` `buildPrintPages` | ~50 dòng | Bố cục **tờ giấy**. Rủi ro **cao và im lặng**: sai ở đây không có lỗi, không có cảnh báo — chỉ là máy in nhả gấp đôi số tờ, hoặc mất phần dưới trang, và **chỉ trên khổ giấy mà người viết code không dùng** (A3/Letter). Nửa số học có lưới `npm run test:print`; nửa CSS chỉ probe `printToPDF` **đếm tờ** mới thấy → xem BI-43, BI-44. |
| `desktop/src/prefs.js` | ~80 | Tuỳ chọn phía main. Rủi ro thấp; nằm trong lưới `npm run test:tabs`. |
| `desktop/src/shell-combine.js` | ~200 | Verb “Gộp bằng Nabu PDF” của Explorer. Rủi ro **thấp** nhờ lưới `npm run test:combine` (thuần: parse argv, dedupe/sắp thứ tự, chính sách gom). Cái **không** có lưới là hai đầu OS: khoá registry do `build/installer.nsh` ghi, và đường `second-instance` thật — cả hai cần bản **đã cài**. Sai ở đây không mất dữ liệu; nó mất **im lặng** (mục menu chạy app không có cờ ⇒ thành “Open with”) → xem BI-62. |
| `desktop/build/installer.nsh` | ~20 | Khoá registry của verb. Không chạy lúc dev, **chỉ** chạy lúc cài ⇒ sai thì không ai biết cho tới khi có người cài thật. Ba thứ dễ sai: thiếu `MultiSelectModel=Player` (chọn >15 file là mục menu mất), thiếu **BOM UTF-8** (nhãn tiếng Việt thành mojibake), thiếu `customUnInstall` (gỡ app xong còn mục menu chết). Có ca đối chiếu với JS trong `test:combine` → xem BI-62. |
| `api.py` + `src/pdf/*.py` | — | Có lưới test tự động (`run_tests.py`) → rủi ro thấp hơn renderer. |

> Renderer gần như **không có** test tự động. Ngoại lệ là **năm** file được **cố ý tách
> ra cho DOM-free**: `page-range.js`, `pan.js` (nửa trên), `wire.js`, và từ v0.2.48
> `annot-text.js` + `annot-geom.js`. Tiêu chí chọn tách không phải “file to” mà là
> **“sai ở đây có im lặng không”** — mất trang, giành nhầm chuột, payload hỏng, chữ/mây
> lệch chỗ trong file đã lưu. Phần renderer còn lại (`app.js`, `editor.js`,
> `text-edit.js`) đụng DOM/canvas/pdf.js ở mọi dòng nên chỉ có tài liệu này + test tay
> + probe trình duyệt. Đó là lý do sổ bất biến tồn tại.

> **v0.2.48 — đã đo trước khi tách, và đây là con số:** `editor.js` (3641 dòng, 115 hàm,
> trung bình 24,5 dòng/hàm) có **33 hàm / 429 dòng thuần** (không DOM, không `ed`/`state`),
> **24 hàm / 315 dòng** chỉ đụng `ed`/`state`, và **58 hàm / 2075 dòng (57%) bám
> DOM/canvas**. Vì thế **module hoá toàn bộ file đã bị bác bỏ có chủ ý**: 57% kia tách ra
> chỉ *di chuyển* code chứ không làm nó test được, mà lại đụng file có diff lớn nhất repo.
> Bốn rào cản đo được, ghi lại để không phải điều tra lại:
> 1. **ESM bị chặn ở tầng nạp** — `tabs.js` dùng `loadFile` ⇒ origin `file://`; Chromium
>    fetch module script theo CORS nên `import` chết. Muốn ESM phải chuyển sang custom
>    protocol cho **cả 3 HTML**, viết lại CSP tay ở `main.js`, dưới `sandbox: true`.
>    Rủi ro dồn đúng chỗ mong manh nhất (đa tab/đa cửa sổ, BI-35) để đổi lấy tổ chức file.
> 2. **Bundler sẽ phá lưới hiện có** — `test:geom`/`test:managed` cắt source hàm ra khỏi
>    file *đang ship*; minify/bundle là mất tính chất “cái được test chính là cái chạy”.
> 3. **`ed` là điểm dính** — 345 chỗ đọc/ghi một object 43 thuộc tính. Tách file thì hoặc
>    phơi `ed` thành global (nhân BI-14 lên) hoặc viết lại để truyền state tường minh
>    (rewrite ngữ nghĩa trên file nguy hiểm nhất).
> 4. **Không có áp lực cộng tác** — 20 commit cả đời file, một người viết, gần như chỉ
>    thêm. Lập luận “file to đau vì nhiều người sửa” không áp dụng ở đây.
>
> ⚠️ **Thứ tự thao tác, luật rút ra ở v0.2.48:** chỉ tách code **đã ship và đã test tay**.
> Cả `annot-text.js` lẫn phần mây/mũi tên của `annot-geom.js` đã được chứng minh
> **byte-identical với editor.js của v0.2.47** trước khi move (script so từng dòng), nên
> bản chất là đổi chỗ ở. Ngược lại khối **managed-codec** (`managedSrcBytes`,
> `managedSrcDataUrl`, `collectManagedChain`, `freeManagedTrash`) **cố ý CHƯA tách**: lúc
> đó nó là code mới của chính v0.2.48, **chưa từng ship, chưa test tay GUI**. Tách nó
> cùng lúc sẽ làm đợt test tay không phân biệt được lỗi là của tính năng mới hay của phép
> move — trên đúng đường code mà sai là **mất ảnh của người dùng** (BI-37/38). Sau khi
> v0.2.48 ship và test tay xanh thì điều kiện đã thoả ⇒ tách được ở phiên sau.
>
> **Luật chung:** code vừa viết xong thì **kiểm chứng nó trước, refactor sau** — đừng gộp
> "tính năng mới" và "đổi chỗ ở" vào cùng một đợt test tay, vì lúc đó không có cách nào
> quy lỗi. Ngược lại, code đã ship thì refactor **rẻ**, vì đã có bản gốc để so byte.

> **Cách thứ hai để có lưới mà KHÔNG tách file** (v0.2.48, mở rộng cách đã dùng để kiểm
> chứng bản hợp nhất `page-range` ở v0.2.47): test **cắt thẳng hàm ra khỏi file đang
> ship lúc chạy** (khớp ngoặc từ `function <tên>(`) rồi `eval`, và cấp cho nó đúng
> những tên nó khép kín (`ed` giả, class của pdf-lib, `pushB64Chunks` thật). Cái được
> test **chính là** cái chạy trong app — không có bản copy nào để lệch — và `app.js` /
> `editor.js` **không phải** tách ra làm gì. Đổi tên hàm ⇒ test **đổ ngay** (đúng ý muốn).
> - `npm run test:geom` → `test/viewer-geom.test.js`: `resizeRect` (editor.js),
>   `nearestScrollDelta` + `wheelZoomFactor` (app.js) — 39 ca.
> - `npm run test:managed` → `test/managed-image.test.js`: cả vòng ghi→đọc→bake lại của
>   ảnh round-trip, chạy trên chính pdf-lib trong `node_modules` (đã đối chiếu sha256 với
>   `renderer/vendor/pdf-lib.min.js`) — 42 ca.
>
> **Nửa DOM thì vẫn phải probe trình duyệt.** v0.2.48 dựng probe bằng cách cho node cắt
> `applyScaleToDom` / `syncThumbFocus` / `currentPageIndex` ra, nhúng cùng `app.css` thật
> vào một trang HTML, rồi chạy bằng **chính Electron của dự án**
> (`./node_modules/.bin/electron`, `BrowserWindow({show:false})` → đọc `#out`): 30/30 —
> box canvas theo tỷ lệ, `--scale-factor` của pdf.js kéo span đi đúng, `.page-wrap`
> **được dùng lại** chứ không dựng lại, cột trang trượt đúng, và 4 tay nắm có đúng CSS.
> Probe là **file dùng một lần, không commit** (như các probe trước). Đừng dùng preview
> pane của IDE: nó render snapshot, **script không chạy**.

---

## 2. Kiến trúc phải nhớ trước khi sửa

- 14 file JS của renderer (`i18n, page-range, wire, annot-text, annot-geom, managed-codec,
  page-vault, app, pan, editor, text-edit, compare, capture, sign`) nạp bằng `<script>` **classic**, dùng
  chung **một scope**. `state`,
  `toast`, `sidecarFetch`, `showOverlay`… là biến toàn cục dùng chéo, **không phải
  module** → đổi tên một hàm trong `app.js` có thể làm `editor.js` chết mà không hề có
  cảnh báo lúc build. Năm file đã tách ra để test được, theo **ba mức** khác nhau — đọc
  kỹ trước khi tách file thứ bảy:
  - `page-range.js` — **sạch nhất**: chỉ phơi `window.PageRange`, không thả tên trần
    nào vào scope chung, nên `require()` được từ node. Dùng cho code **mới**.
  - `pan.js` — **nửa vời có chủ ý**: nửa trên logic thuần `require()` được, nửa dưới
    đụng DOM nằm sau cửa `typeof document === "undefined"` → node nạp nửa trên,
    trình duyệt chạy cả hai.
  - `wire.js` — **cố tình giữ tên trần**: `pdfJsonBody` / `b64ToU8` có sẵn **16 chỗ
    gọi** trong `app.js`/`text-edit.js`/`compare.js` từ trước khi tách. Khai ở top-level
    một classic script thì chúng vẫn nằm đúng scope chung như cũ ⇒ **không phải sửa
    chỗ gọi nào**. Đổi sang `window.Wire.*` là tự chuốc lấy đúng rủi ro BI-14. Đánh đổi:
    `wire.js` **phải nạp trước** `app.js`/`text-edit.js`/`compare.js` trong `index.html`.
    Đã kiểm chứng bằng probe rằng tên trần nhìn thấy được từ script khác.
  - `annot-text.js` + `annot-geom.js` (v0.2.48) — **cùng mức `wire.js`, cùng lý do**:
    ~25 và ~11 chỗ gọi có sẵn trong `editor.js`. Giữ tên trần ⇒ phía `editor.js` của
    lần tách này là **thuần xoá**, không một call site nào đổi, nên hành vi không thể
    lệch. `module.exports` cho node, `window.AnnotText` / `window.AnnotGeom` là **cùng
    bộ đó** dưới cái tên probe/test khẳng định được. Đánh đổi: **phải nạp trước
    `editor.js`**. Cả hai đều DOM-free trừ `measureCtx` — nó nằm sau cửa
    `typeof document === "undefined"` kiểu `pan.js`, và `measureText` nhận thêm tham số
    `ctx` **tuỳ chọn** để lưới node bơm ctx giả (chỗ gọi cũ truyền 3 tham số, không đổi).
  - `managed-codec.js` (v0.2.49) — **mức thứ tư: IIFE + `Object.assign(window, …)`**. Cần
    thiết vì nó destructure `PDFName`/`PDFRawStream`/`PDFDict`/`degrees` từ pdf-lib, và
    khai ở top level thì `degrees` **đụng `app.js:17`** ⇒ SyntaxError giết `app.js` ⇒ app
    trắng. Bọc IIFE cho binding thành private, publish bề mặt bằng `Object.assign` — bare
    name vẫn phân giải khi *đọc*, mà không thể trùng khai báo. **Đây là khuôn phải dùng cho
    mọi file mới có destructure từ thư viện.** Xem BI-14 (nửa sau).
  - `page-vault.js` (v0.2.64) — **IIFE bắt buộc** (destructure pdf-lib, đúng bẫy BI-14) nhưng
    phơi ra ở **mức `page-range.js`**: chỉ `window.PageVault`, **không** `Object.assign(window, …)`,
    không một tên trần nào. Làm được vì đây là code **mới**, không có call site cũ để giữ —
    và đó chính là tiêu chí: giữ tên trần chỉ đáng khi nó **xoá được** hàng chục chỗ sửa tay
    trong file diff lớn nhất repo. Đây là **khuôn cho mọi file mới** kể từ nay.
- **Mỗi tab = một renderer riêng** (`WebContentsView`, process riêng). `state` **không**
  chia sẻ giữa các tab. Cái chia sẻ là: main process, sidecar Python, thư mục recovery.
  → Mọi singleton ở main process là nguy cơ xung đột đa tab.

---

## 3. Sổ bất biến (đừng phá)

Mỗi mục: **bất biến → ở đâu → vì sao → dấu hiệu vỡ.**

### BI-1 · Undo khi đang mở overlay phải là undo *annotation*, không phải undo tài liệu
- `app.js:3446-3455` (nhánh `window.Editor.active`).
- Undo bytes tài liệu khi overlay đang sống sẽ lệch toàn bộ annotation đang chờ.
- **Vỡ khi:** Ctrl+Z lúc đang chú thích làm nhảy trang / mất hình vẽ.

### BI-2 · Overlay edit và Text edit loại trừ nhau
- `app.js:3131-3135` (`be.disabled = !has || textEditing`, `bt.disabled = … || overlayEditing`).
- Hai chế độ cùng ghi `state.bytes` → xung đột bake.
- **Vỡ khi:** bật được cả hai nút cùng lúc.

### BI-3 · Mọi thay đổi `state.bytes` phải đi qua `pushUndo()` TRƯỚC
- `app.js:148-158`. Gói chung: snapshot + xoá redo + `updateUndoRedo` + `markDirty`.
- Bỏ qua → mất undo **và** mất cờ dirty (→ đóng file không hỏi, mất dữ liệu).
- **Vỡ khi:** sửa xong mà tiêu đề không có chấm ●, hoặc Ctrl+Z không quay lại được.

### BI-4 · Không tính năng nào được đọc **pixel** canvas của viewer
- Virtualization (`freePageCanvas` `app.js:739-745`) xoá bitmap trang trôi xa, chỉ giữ
  `canvas.style.*`. Print/compare/export/bake đều tạo canvas riêng từ `state.bytes.slice()`.
- **Vỡ khi:** thêm tính năng đọc pixel trang → ra ảnh trắng ngẫu nhiên tuỳ vị trí cuộn.
- **Cách làm đúng:** ép render trước bằng `renderPageCanvas(i)`, hoặc mở doc riêng.

### BI-5 · `rerenderChanged()` giả định bake **không đổi số trang**
- `app.js:1134-1149`; có kiểm tra số trang rồi mới fallback `renderAll()`.
- Đường nào bỏ qua kiểm tra đó sẽ lệch ánh xạ DOM ↔ trang.

### BI-6 · Guard đóng cửa sổ phải SKIP khi `appQuitting`
- `tabs.js:_onClose` + `main.js` (`appQuitting` đặt ở `before-quit`).
- Nút X **không** bắn `before-quit` (được hỏi); menu Thoát/Ctrl+Q **có** bắn (đã
  `stopSidecar`) → nếu guard chặn rồi user bấm Huỷ thì sidecar đã chết + có thể treo quit.
- **Đừng bỏ điều kiện `appQuitting`.** Mạng lưới an toàn cho đường này là autosave.

### BI-7 · `recovery:scan` chỉ trả kết quả cho **người hỏi đầu tiên mỗi lần chạy app**
- `main.js` (`recoveryScanDone`), ghi chú ở `preload.js:59-60`.
- Chống hỏi khôi phục nhiều lần khi mở nhiều cửa sổ/tab.
- **Hệ quả cần nhớ:** tab thứ 2 gọi sẽ nhận mảng rỗng — đó là **đúng thiết kế**, không phải lỗi.

### BI-8 · Mở tài liệu mới **không bao giờ** được đè lên tab đang có dữ liệu
- `app.js` `openDialog()` + nhánh drop; `main.js` `tabs:open-paths`; **quyết định thật
  nằm ở `tabs.js` `planOpen()`** — nó chỉ trả `fill` khác `null` khi người gọi khai
  `fillCurrent`, và lưới `npm run test:tabs` có ca canh gác cho đúng điều đó.
- Đây chính là lỗi đã phải hotfix ngay sau khi ra tab (`624fd7f` vá `7bd02d3`).
- **Vỡ khi:** bấm Mở → tài liệu đang xem biến mất.

### BI-9 · Nút tính năng trả phí phải có trong `GATED_BTNS`
- `app.js:2924-2936`, dùng bởi `installLicenseGuard()` + `updateToolbar()`.
- Danh sách **id nút** cứng; nút mới khai báo ở `editor.js`/`text-edit.js`/`index.html`
  mà quên thêm vào đây thì **thoát cổng bản quyền trong im lặng**.

### BI-10 · Phần tử có nội dung động phải nằm trong `SKIP_IDS` của i18n
- `i18n.js:463-469`.
- Không thì đổi ngôn ngữ sẽ ghi đè giá trị đang chạy bằng text tĩnh cũ.

### BI-11 · Ký số là thao tác **cuối cùng**
- `sign.js:13-14, 341`. Sửa rồi lưu đè file đã ký = mất hiệu lực chữ ký.

### BI-12 · Cache CTM của capture khoá theo *danh tính đối tượng* `state.pdf`
- `capture.js:26, 66-70` (`docToken`).
- Nếu sau này có đường thay tài liệu mà **giữ nguyên** đối tượng `state.pdf`, cache
  sẽ cũ trong im lặng → copy vùng ra sai toạ độ.

### BI-13 · `state.pageMetas` là trường **ẩn**, không khai trong `state = {}`
- Tạo động ở `app.js:648`; `capture.js` và `sign.js` phụ thuộc vào nó.
- Đọc khai báo `state` ở đầu file sẽ **không** thấy trường này tồn tại.

### BI-15 · `detachTab` **không bao giờ** được đóng `webContents`
- `tabs.js` — `detachTab` (chuyển nhà) vs `destroyTab` (khai tử). Hai đường tách bạch.
- Tab tách ra vẫn là **đúng renderer đó**, giữ nguyên tài liệu + lịch sử hoàn tác +
  phiên chú thích đang dở. Đóng `webContents` ở đường tách = người dùng mất việc đang làm
  chỉ vì kéo một cái tab.
- **Vỡ khi:** kéo tab ra → cửa sổ mới trắng trơn, hoặc tài liệu nạp lại từ đầu.

### BI-16 · Sau `detachTab`, tab **bắt buộc** phải có người nhận
- `moveTabTo` / `tearOutTab` luôn `adoptTab` ngay sau khi gỡ.
- Tab không ai nhận = một tiến trình renderer mồ côi, giữ nguyên RAM của cả tài liệu,
  không cửa sổ nào đóng được nó.

### BI-17 · Phím tắt của tab phải tra chủ sở hữu **động**
- `tabs.js` `ownerOf()` + `bindTabKeys()`.
- Listener `before-input-event` gắn vào `webContents`, mà `webContents` **đổi cửa sổ** khi
  tách tab. Đóng gói `this` vào listener → sau khi tách, Ctrl+Tab / Ctrl+1–9 điều khiển
  cửa sổ **cũ** (có thể đã bị huỷ).
- **Cũng đừng gắn lại listener lúc `adoptTab`** — sẽ thành hai listener, mỗi phím nhảy hai tab.

### BI-18 · Phiên nhớ **đường dẫn**, khôi phục sự cố nhớ **nội dung** — không trộn
- `src/session.js` (đầu file) + `docs/SESSION-RESTORE.md` §2.
- Tab chưa có file trên đĩa **không** nằm trong phiên; nội dung sửa dở là việc của
  `recovery:*`. Nhờ ranh giới này, một lỗi trong `session.js` **không thể** làm mất tài liệu.
- **Vỡ khi:** ai đó nhét bytes vào `session.json` cho tiện.

### BI-19 · Tab đã được main “đặt chỗ” không được nhận lời nhắc khôi phục sự cố
- `tabs.js` `createTab` gửi `tab:reserved` → `renderer/app.js` `checkRecovery` rút lui.
- `recovery:scan` chỉ trả kết quả cho người hỏi **đầu tiên** (BI-7). Một tab sắp nhận
  tài liệu mà giành mất danh sách rồi bỏ đi = **nuốt luôn lời nhắc của cả lần chạy đó**.
- Đi kèm: khi khởi động **có** bản nháp sự cố, main phải mở một tab trống để lời nhắc có chỗ hiện.

### BI-20 · Không ghi phiên khi một cửa sổ đang đóng dở
- Cờ `_closing` + `Session.anyClosing()`; bảng đầy đủ ở `docs/SESSION-RESTORE.md` §3.2.
- Lúc teardown danh sách tab rỗng dần → ghi vào đúng lúc đó là lưu lại một cái app
  đang chết dở làm thứ để khôi phục.
- **Vỡ khi:** đóng cửa sổ đang có 5 tab, mở lại chỉ còn 1 tab (hoặc không tab nào).

### BI-21 · “Giữ nguyên font” là một THANG BA BẬC — bậc nào cũng phải qua cửa kiểm tra glyph
- `api.py` `/edit-text` (khối chọn font) + `src/pdf/fonts.py`.
- Thứ tự **bắt buộc**: (1) font hệ thống theo họ (`_resolve_local_font`, thử lần lượt
  `_family_candidates`) → (2) chính font **nhúng trong PDF nguồn**
  (`_page_font_buffers` + `embed_page_font`) → (3) DejaVu bó sẵn.
- Bậc 1 hỏng ở tên kiểu **“TimesNewRomanBold”** (kiểu chữ dính liền, không dấu gạch)
  → rơi thẳng xuống DejaVu, người dùng thấy **đổi font trong im lặng** dù đã chọn
  “Giữ nguyên”. Đó là lỗi đã sửa 2026-07-26.
- Bậc 2 dùng **font con (subset)** — chỉ chứa glyph tài liệu từng vẽ. Cửa kiểm tra
  `_font_covers` ở bậc này phải chạy **KHÔNG điều kiện**, không được gắn vào
  `needs_unicode`: chữ ASCII thuần cũng có thể thiếu glyph → ra ô vuông (□) đúng
  kiểu hồi quy v0.2.34.
- `_page_font_buffers` phải gọi **TRƯỚC `apply_redactions()`**.
- **Vỡ khi:** sửa chữ xong đổi sang font khác hẳn · hoặc ra □.
- Lưới: `.venv\Scripts\python test_edit_text_font.py` (8 ca) + `test_edit_text_rounds.py`.

### BI-22 · Toàn màn hình: MAIN là nguồn sự thật, renderer chỉ phản ứng
- `src/tabs.js` (`setPresentation` / `_applyPresentation` / `_layout`) + `main.js`
  (`window:set-presentation`) + `renderer/app.js` (`togglePresentation` /
  `applyPresentation`).
- Renderer **không bao giờ** tự bật cờ `.presenting`; nó xin main, main đổi cửa sổ
  rồi phát `window:presentation` ngược lại cho **mọi tab** của cửa sổ đó. Vì cửa sổ
  có thể rời toàn màn hình bằng đường khác (nút cửa sổ, cử chỉ OS) — sự kiện
  `leave-full-screen` là cái kéo UI về đúng chỗ.
- **Vỡ khi:** thoát toàn màn hình bằng nút cửa sổ → app mất luôn thanh công cụ,
  không có đường quay lại; hoặc chuyển tab trong lúc trình chiếu thì tab kia vẫn
  còn nguyên thanh công cụ.
- Chế độ này **loại trừ** Chú thích/Sửa nội dung (hai chế độ đó cần thanh công cụ
  mà nó ẩn) — xem `updateToolbar()`.

### BI-23 · Redaction của `/edit-text` chỉ được lấy đi **chữ**, không lấy gì khác
- `api.py` `/edit-text` bước 1: `add_redact_annot(..., fill=False)` +
  `apply_redactions(images=PDF_REDACT_IMAGE_NONE, graphics=PDF_REDACT_LINE_ART_NONE)`.
- Hộp redaction là **bbox của chữ**, nên mọi thứ nó chồng lên (nền ô bảng, đường kẻ
  dưới tiêu đề, ảnh scan letterhead) là do **tài liệu** vẽ, không phải do chữ:
  - còn `fill` mặc định (1,1,1) → tô một hình chữ nhật đục lên trang: **vô hình trên
    giấy trắng, thành vệt trắng trên ô có nền**;
  - `images` mặc định `PDF_REDACT_IMAGE_PIXELS` → **xoá pixel** của ảnh dưới hộp;
  - `graphics` mặc định → **xoá nét vector bị hộp phủ trọn**, đúng kiểu Word vẽ gạch chân.
- `fill` **vẫn còn trong API** cho ai cố ý muốn tô đè — chỉ đổi giá trị mặc định.
- **Vỡ khi:** sửa 1 chữ trong ô bảng có nền → hiện vệt trắng; hoặc mất đường kẻ.
- Lưới: `.venv\Scripts\python test_edit_text_layout.py` (5 ca, **kiểm theo PIXEL** —
  nét vector vẫn “tồn tại” dưới lớp fill nên đếm object sẽ pass trong khi trang hỏng).
- `/translate` đã theo đúng luật này từ trước (`test_translate_layout.py`) — hai đường
  phải giữ giống nhau.

### BI-25 · Vẽ lại chữ phải bám **hình học** của face bị thay, không chỉ tên font
- `api.py` `/edit-text` (khối “match the geometry”), `TextEdit.orig_text` + `orig_size`,
  `text-edit.js` `apply()`.
- Font gốc thường **không dùng lại được**: PDF nhúng nó dạng subset mất cmap nên cửa
  kiểm tra glyph từ chối (BI-21) → buộc phải thay bằng font hệ thống. **Cùng tên
  không có nghĩa cùng thiết kế**: đo trên hoá đơn VNPT, “TimesNewRomanBold” nhúng
  chỉ bằng **0.83 bề rộng** và **0.91 chiều cao** của Times New Roman Bold của
  Windows, advance từng chữ lệch **ngược chiều nhau** (T hẹp hơn, o rộng hơn) → **không
  một cỡ chữ nào chỉnh được cả hai**, phải hai phép hiệu chỉnh độc lập:
  1. **Cao**: nhân cỡ chữ sao cho line box (ascender..descender) của font thay khớp
     line box PDF khai cho font gốc — `(bbox_h / orig_size) / (asc − desc)`.
  2. **Rộng**: đo **nguyên chuỗi gốc** trong font sắp vẽ rồi ép scale x bằng
     `bbox_w / text_length`. Áp bằng `morph` quanh gốc baseline, **sau** bước cao
     (text_length tỉ lệ với cỡ chữ nên hai phép độc lập và ghép chính xác).
- ⚠️ **Đo nguyên chuỗi, KHÔNG `strip()`**: bbox đang chia là bbox của **cả chuỗi**, dấu
  cách cuối có advance thật. Cắt chuỗi mà giữ nguyên bbox là lệch cặp → vẫn rộng
  (đo được: median 1.03, tệ nhất 1.08). Đúng cặp thì ra **0.9994 / 0.9996**.
- Cả hai đều có **vùng chết ±2%** và kẹp biên độ tin cậy → tài liệu bình thường
  (font thay = font gốc) **không bị đụng vào**.
- **Vỡ khi:** sửa 1 dòng thì dòng đó dài ra đè sang chữ bên cạnh, hoặc chữ cao hơn
  hẳn các dòng chưa sửa.
- Lưới: `.venv\Scripts\python test_edit_text_metrics.py` (7 ca; có ca **canh gác**
  chứng minh không sửa thì thật sự tràn).
- Ghi nhớ khi đọc số: PyMuPDF trả `size` của span là **trung bình nhân** của ma trận
  chữ, nên một cú nén ngang 0.84 hiện ra thành `size × sqrt(0.84)` — nửa cú nén đã
  nằm sẵn trong cỡ chữ.

### BI-24 · Không bao giờ dựng payload PDF thành **một chuỗi JS**
- **Nhà của luật này: `renderer/wire.js`** (tách khỏi `app.js` 2026-07-28) — có lưới
  `npm run test:wire` (51 ca). Trước đó nó nằm giữa `app.js` và **không** test được;
  đó là vấn đề, vì mọi cách vi phạm luật này đều hỏng **im lặng**.
- `pdfJsonBody()` — dùng ở **16 chỗ gọi** trong `app.js`/`text-edit.js`/`compare.js`,
  **bằng tên trần** (xem §2 để biết vì sao cố tình giữ vậy).
- `JSON.stringify({pdf_b64: u8ToB64(bytes), …})` tốn **ba bản sao cỡ đầy đủ** trên heap
  renderer (chuỗi nhị phân trong `u8ToB64`, base64 nó trả về, và bản sao của
  `stringify`) ⇒ ~500MB rác tạm cho file 134MB, chồng lên `state.bytes` + lịch sử undo.
  Đúng loại hết-heap mà v0.2.40 đã vá cho chiều **tải về** và bỏ sót chiều **gửi lên**.
- `pdfJsonBody` ghép `Blob` theo mảnh → byte nằm trong blob store của Blink (tràn ra đĩa
  được), mỗi lúc chỉ có **một mảnh 48KB** là chuỗi JS. **Định dạng trên dây không đổi.**
- **Kích thước mảnh phải là bội của 3** — base64 chỉ chèn `=` ở cuối luồng, chia đúng
  mốc 3 byte thì các mảnh nối thẳng được. Đổi thành số khác là hỏng payload **im lặng**.
- Nhận cả `Uint8Array` (→ `pdf_b64`) lẫn object `{tên: bytes}` cho `/compare` (2 tài liệu).
- **Không còn hàm `u8ToB64`** (xoá 2026-07-27). Nó là công cụ duy nhất dựng được payload
  thành một chuỗi JS, tức là chính cái bẫy điều luật này sinh ra để chặn — để nó nằm đó thì
  người viết lời gọi sidecar mới sẽ tìm thấy và tái lập đúng lỗi cũ. Cần đưa binary lên dây
  thì **chỉ** có `pdfJsonBody` (một/nhiều trường) hoặc `binArrayJsonBody` (mảng trong 1 trường).
- Chỗ cuối cùng còn sót đã vá cùng ngày: **Ảnh → PDF** (`pickI2pImages` / `runImagesToPdf`).
  Nó phình bộ nhớ **hai lần**: giữ base64 của **mọi** ảnh đã chọn suốt lúc hộp thoại mở
  (base64 = 4/3 dung lượng gốc), rồi `JSON.stringify` cả mảng đó thành một chuỗi nữa.
  100 ảnh điện thoại 5MB ⇒ ~670MB chuỗi tạm chồng lên ~670MB đang giữ. Nay giữ **byte thô**
  và chỉ mã hoá lúc gửi; xoá danh sách sau khi tạo xong (giữ lại khi lỗi để còn thử lại).

### BI-26 · Menu chuột phải là lối vào **không có id nút** → cổng bản quyền phải ở tầng HÀM
- `app.js` `openThumbMenu()` + `GATED_BTNS` / `installLicenseGuard()`.
- Cổng bản quyền có **hai** tầng và chúng không thay thế nhau:
  1. `installLicenseGuard()` bắt click theo **id của `<button>`** — chỉ chặn được nút thật
     khai trong `index.html`;
  2. `gateProFeature()` gọi **bên trong từng hàm** (`addBlankPageAt`, `insertBuffersAt`,
     `extractSelected`, `openSplit`→`convertReady`).
- Mục menu chuột phải là `<div>` sinh động, **không có id** → tầng 1 **không nhìn thấy nó**.
  Cùng tình huống với kéo–thả PDF vào dải thumbnail (đã đi qua `insertBuffersAt`).
- **Luật:** mọi lệnh trả phí thêm vào menu ngữ cảnh **phải** gọi một hàm đã tự gọi
  `gateProFeature()`. Đừng viết logic mới thẳng trong `onClick` của mục menu.
- Ngược lại: nút mới trên **thanh công cụ** thì phải thêm id vào `GATED_BTNS` (BI-9) —
  `btn-tb-blank` / `btn-tb-extract` / `btn-tb-split` là ví dụ.
- **Vỡ khi:** máy chưa kích hoạt bản quyền mà chuột phải vào thumbnail vẫn chèn/tách được.

### BI-27 · Số học khoảng trang sống ở `page-range.js`, **không** nhân bản vào `app.js`
- `desktop/renderer/page-range.js` (`parseSpec` / `computeRange` / `formatList`) —
  file renderer **duy nhất** không đụng DOM, nên là file renderer **duy nhất** có lưới
  tự động: `npm run test:pages` (36 ca).
- Ba luật đã có ca test canh gác, đừng “đơn giản hoá” mất:
  - `"-3"` và `"3-"` là **rác**, không phải số âm — số âm sẽ kẹp về trang 1 rồi xoá nhầm;
  - bỏ **toàn bộ** khoảng trắng trước khi tách token, nếu không `"1 - 3"` thành 3 token rác;
  - `computeRange` trả `error: "all"` khi kết quả ăn hết tài liệu — PDF phải còn ≥1 trang.
- `extractFileName` cũng ở đây: tên file gợi ý khi tách trang **phải có trần độ dài**.
  Liệt kê mọi số trang là không giới hạn — **~80 trang đã vượt 255 ký tự**, giới hạn của
  Windows cho một thành phần tên file, mà chuỗi đó đi thẳng vào `defaultPath` của hộp
  thoại Lưu. Trần tính trên **chuỗi cuối cùng**, không tính theo số trang: `baseName`
  là dữ liệu người dùng, dài bao nhiêu không biết trước. Thứ tự cắt: thu gọn phần
  trang trước (rẻ hơn), cắt phần tên gốc sau cùng.
- **Bản sao duy nhất còn sót đã hợp nhất 2026-07-28**: `editor.js` từng có
  `parsePageRanges()` riêng cho hộp thoại “Áp ảnh / chữ ký cho nhiều trang”, viết
  **trước** khi có luật này. Nó khác `parseSpec` theo hướng chỉ gây hại: gạch en
  (`1–3` — thứ Word/Excel sinh ra) và dấu chấm phẩy bị coi là **rác**, và **một**
  token hỏng làm **hỏng cả chuỗi**. Nay dùng chung `window.PageRange.parseSpec`.
  Đi kèm **hai thay đổi hành vi có chủ ý**, không được coi là hồi quy:
  1. token rác bị **bỏ qua** thay vì từ chối cả chuỗi;
  2. số vượt trang cuối bị **kẹp** về trang cuối thay vì biến mất.
  Điều kiện để hai thay đổi đó chấp nhận được là **người dùng nhìn thấy kết quả
  trước khi bấm**: `syncImgPages()` viết bản xem trước vào `#imgpages-hint` mỗi lần
  gõ và **khoá nút Áp dụng** khi không còn trang nào — đúng khuôn `syncDeleteRange()`
  của hộp thoại xoá. **Bỏ bản xem trước đi là làm hai thay đổi trên thành lỗi im lặng**
  (gõ `99` trên tài liệu 10 trang sẽ đóng dấu chữ ký lên trang 10 mà không ai biết).
  Ba tình huống hỏng có **ba câu thông báo riêng** — “chưa nhận ra trang nào” khác
  hẳn “chỉ gõ đúng trang ảnh đang nằm”; trước đây hai cái dùng chung một câu sai.
  `#imgpages-hint` vì thế phải nằm trong `SKIP_IDS` (BI-10).
- `app.js` gọi qua `window.PageRange.*` (có tên gọi rõ ràng), **không** gọi tên trần — xem BI-14.
- **Vỡ khi:** gõ “từ 5 đến 12, trừ 7” mà trang 7 vẫn biến mất · hoặc “Chọn tất cả” rồi
  Tách ra file mới thì hộp thoại Lưu hiện tên file rác/dài lê thê.

### BI-29 · “Sẵn sàng” là HAI điều kiện độc lập — engine và API key, hai badge riêng
- `app.js` `renderSidecarBadge()` / `setApiBadge()` / `refreshApiBadge()`;
  `index.html` `#sidecar-badge` + `#api-badge`.
- Engine cục bộ (sidecar) lo OCR/nén/tách/so sánh/sửa chữ. **Bóc tách và Dịch cần
  THÊM một API key Gemini.** Một badge “OCR: sẵn sàng” duy nhất bị đọc thành “mọi thứ
  chạy được” — đó là lý do tách đôi (yêu cầu người dùng 2026-07-26).
- `apiKey.configured` là **ba trạng thái**: `true` / `false` / **`null` = chưa biết**.
  `null` **không được** vẽ thành “chưa có key” — engine chưa lên hoặc `/config` không
  gọi được thì ta *không biết*, và mắng người dùng về một cái key họ đang có là sai.
  `refreshApiBadge()` nuốt mọi lỗi về `null` đúng vì vậy.
- Nguồn sự thật là `GET /config` → `gemini_configured` (sidecar không bao giờ trả key
  đầy đủ, chỉ mask). Ba chỗ cập nhật: sidecar vừa ready · mở hộp thoại Cài đặt ·
  lưu key xong (dùng luôn phản hồi POST, không gọi lại).
- Tín hiệu **không được chỉ dựa vào màu**: `.badge.dot::before` vẽ chấm **đặc = sẵn
  sàng**, **rỗng (vòng tròn viền) = chưa**. Bỏ phần hình dạng đi là mất tín hiệu với
  người mù màu và trên theme sáng (warn/ok gần nhau).
- Cả hai badge nằm trong `SKIP_IDS` (BI-10) ⇒ registry i18n **không** vẽ lại chúng khi
  đổi ngôn ngữ ⇒ phải tự vẽ lại qua listener `i18n:changed`. Bỏ listener đó thì thanh
  công cụ thành nửa Việt nửa Anh.
- **Vỡ khi:** chưa nhập key mà badge API vẫn xanh · hoặc engine chưa lên mà đã báo
  “chưa có key” · hoặc đổi VI↔EN thì hai badge đứng nguyên tiếng cũ.

### BI-28 · `Editor.active` / `TextEdit.active` là **thuộc tính**, không phải hàm
- `editor.js:3324-3327` và `text-edit.js:595-598` đều khai `get active() { … }` trả về
  **boolean**. Gọi `window.Editor.active()` ném `TypeError` — và vì các chỗ dùng nằm
  trong listener `keydown`, ngoại lệ **nuốt luôn phần còn lại của handler**.
- Bẫy nằm ở chỗ `x && x()` **im lặng khi cờ tắt**: `false && …` không gọi gì cả, nên lỗi
  chỉ hiện khi tính năng **đang bật** — đúng lúc ít ai test. Đã có thật ở `app.js` nhánh
  ↑/↓/PageUp/PageDown và nhánh Delete (sửa 2026-07-26); hành vi lúc đó *tình cờ* vẫn đúng
  vì ngoại lệ cũng làm handler không chạy tiếp, nên lỗi sống rất lâu mà không ai thấy.
- Mẫu đúng, dùng ở `updateToolbar()`: `!!(window.Editor && window.Editor.active)`.
- Mở rộng: **chế độ Sửa nội dung không cần kiểm riêng trong `keydown`** — `isTyping()` đã
  bao nó qua class `body.text-editing`. Thêm kiểm tra thứ hai là thừa và dễ lệch nhau.
- **Vỡ khi:** console đầy `TypeError: … is not a function` lúc đang chú thích · hoặc code
  mới thêm vào cuối handler đó không bao giờ chạy khi đang chú thích.

### BI-30 · Bàn tay giành chuột bằng `stopImmediatePropagation`, KHÔNG phải `stopPropagation`
- `pan.js` `onPointerDown` + cửa `mousedown`/`click`.
- `editor.js` (`viewer.addEventListener("mousedown", onDown)`) và `capture.js`
  (`v.addEventListener("mousedown", onDown, true)`) nghe trên **CÙNG phần tử
  `#viewer`** với pan. `stopPropagation()` chỉ chặn sự kiện **đi sang nút tiếp
  theo**, **không** chặn các listener khác **trên chính nút đang đứng** → cửa của
  capture.js vẫn chạy. Đã đo được bằng probe: `stopPropagation` cho lọt, đổi sang
  `stopImmediatePropagation` mới sạch.
- Đừng đổi ngược lại “cho nhẹ”. Cũng đừng dựa vào việc `preventDefault()` trên
  `pointerdown` tự dập `mousedown` (đúng theo spec, nhưng **không kiểm chứng được
  bằng sự kiện tổng hợp** — sự kiện dispatch tay không sinh mouse event tương thích).
  Vì vậy cửa `mousedown` tường minh là **lớp bảo đảm chính**, không phải dự phòng.
- **Vỡ khi:** kéo bàn tay lúc đang Chú thích lại vẽ ra một hình · hoặc kéo chuột
  giữa trong chế độ Copy ảnh lại kéo ra khung marquee.

### BI-31 · Nút chuột GIỮA là tài nguyên chưa ai chiếm — đó là lý do pan chạy được mọi lúc
- `pan.js` `shouldPan` nhánh `button === MIDDLE`.
- `editor.js` `onDown`, `capture.js` `onDown` đều mở đầu bằng `e.button !== 0` →
  nút giữa **không thuộc về ai**. Chính điều đó cho phép “pan cả khi đang chú thích”
  mà không phải giành giật gì.
- **Luật:** đừng gắn hành vi mới vào nút giữa trong `#viewer`. Nếu buộc phải, phải
  sửa `shouldPan` **cùng lúc**, không thì hai tính năng chạy chồng nhau im lặng.

### BI-32 · Toàn màn hình: dải thumbnail **không được chiếm chiều rộng layout**
- `app.css` khối `body.presenting .sidebar` (`position:absolute` + `transform`) +
  `app.js` `applyPresentation`.
- Chế độ này gọi `fitPage()` **một lần** lúc vào, đo trên `#viewer` rộng nguyên
  màn hình. Nếu dải thumbnail chiếm chiều rộng thật thì “trọn trang” sai âm thầm,
  và mỗi lần rê chuột mở dải là cả trang nhảy layout.
- Vì vậy dải trượt bằng `transform`, **không** bằng `width`. Lưới đo trực tiếp
  bất biến này (`viewer.clientWidth` trước/sau khi mở dải phải **bằng nhau**).
- `applyPresentation` **không còn** ép `toggleSidebar(true)` như trước: CSS lo việc
  ẩn. Ai thêm lại lệnh ép đó sẽ giết luôn dải thumbnail.
- Sidebar mà người dùng **đã tự thu** trước khi vào F11 thì vẫn thu (`.sidebar-collapsed`
  thắng) — F4 trong F11 vì thế phải **vừa mở lại vừa ghim**, không thì nó là phím bấm
  không ra gì.
- **Vỡ khi:** F11 xong trang không còn vừa màn hình · hoặc rê chuột mép trái thì
  trang co lại/nhảy.

### BI-33 · Dải thumbnail phải ở **MỘT CỘT** ở mọi bề rộng
- `app.css` `.thumbs` (flex column) + `app.js` `wireThumb` nhánh `dragover`.
- Kéo rộng sidebar được rồi thì phản xạ tiếp theo là “cho nó dàn thành lưới như
  Acrobat”. **Đừng.** Gợi ý chèn khi kéo–thả PDF từ ngoài vào chọn *trên hay dưới*
  bằng `e.clientY` so với **đường giữa dọc** của thumbnail. Xếp thành lưới thì
  “trên/dưới” thành câu hỏi sai ⇒ chèn nhầm vị trí trang, im lặng.
- Muốn làm lưới thật thì phải sửa **cả** gợi ý chèn sang trục ngang **trước**.
- **v0.2.52 — cùng số học đó nay lo CẢ hai loại kéo, và số hiệu “khe” là hợp đồng:**
  `thumbGapAt` trả về **khe** (`gap`), nghĩa là “giữa trang `gap-1` và trang `gap`”, nên
  0 là trên trang đầu và `numPages` là dưới trang cuối. Đó **đúng** là con số
  `insertBuffersAt` đã nhận từ trước ⇒ kéo–thả file dùng thẳng. Nhưng `reorderPage`
  **cắt trang ra trước rồi mới chèn lại**, nên chỉ số đo trên danh sách **gốc** bị lệch
  1 khi trang đang di chuyển nằm **trước** khe đó — đó là `gapToReorderIndex`, và sai nó
  là trang **rơi cách chỗ đã hứa một ô**, im lặng.
- Gợi ý phải nằm ở **hai** thumbnail cùng lúc (`insert-after` trên trang trên +
  `insert-before` trên trang dưới): tô một mép của một trang mới chỉ trả lời “tôi đang ở
  trên trang nào”, chứ không trả lời “nó sẽ nằm đâu” — mà trang đang trỏ có **một khe ở
  mỗi bên**. Đó là lý do `showThumbGapCue` xoá cue **toàn dải** rồi vẽ lại: `dragover`
  của thumbnail vừa vào và `dragleave` của thumbnail vừa rời **không** có thứ tự bảo
  đảm với nhau.
- Hai khe hai bên trang đang kéo là **no-op** (`gapIsNoOp`) và bị **từ chối**
  (không `preventDefault` ⇒ con trỏ hiện “không cho phép”): một cú thả đứng yên vẫn tốn
  một lần ghi lại cả tài liệu + một bước undo.
- **Vỡ khi:** kéo trang 1 xuống giữa trang 3–4 mà nó rơi vào giữa 2–3 · thả đúng chỗ cũ
  mà tài liệu vẫn “bẩn” (có dấu ●) · kéo ra ngoài dải rồi quay lại thì cue vẫn còn dính.
- Lưới: `npm run test:geom` (`gapToReorderIndex`/`gapIsNoOp`, **cắt thẳng từ `app.js`**,
  đối chiếu với một phép splice thật chứ không với một công thức viết lại).

### BI-34 · Trần bề rộng sidebar bị quy định bởi **raster thumbnail**, không phải thẩm mỹ
- `app.js` `SIDEBAR_W_MAX` + `renderThumbCanvas` (`150 / base.width`).
- Thumbnail luôn rasterise ở **150px ngang**; panel rộng hơn chỉ là **phóng to**
  đúng bitmap đó. 300px ⇒ vẽ ~252px (1,7× — mềm nhưng vẫn nhận ra trang);
  vượt xa nữa thì nhoè.
- Nâng raster lên cho nét **không miễn phí**: thumbnail render lười nhưng **không
  bao giờ được giải phóng**, nên tài liệu vài trăm trang trả tiền cho mọi trang đã
  cuộn qua. Raster hợp với panel 420px sẽ **gấp ~4 lần** hoá đơn đó.
- **Luật:** đổi `SIDEBAR_W_MAX` thì phải trả lời câu hỏi raster + bộ nhớ, không
  chỉ nhìn cho đẹp.

### BI-35 · “Mở file mới trong” sống ở MAIN, và **cả ba** đường mở file phải hỏi cùng một chỗ
- `src/prefs.js` (lưu) + `src/tabs.js` `planOpen()` (quyết định, thuần, có lưới) +
  `main.js` (`tabs:open-paths`, `openPathInApp`) + `renderer/app.js` (`#set-open-in`).
- **Vì sao ở main, không phải localStorage:** file từ Explorer (“Open with”) có thể tới
  lúc **chưa có cửa sổ nào** — không có renderer để hỏi. Đúng lý do `session.js` giữ cờ
  `restore` trên đĩa. (Cũng là lý do **không** nhét vào `session.json`: giá trị của file
  đó nằm ở phạm vi hẹp — chỉ đường dẫn — xem BI-18.)
- Có **ba** đường mở tài liệu; bỏ sót một đường là người dùng thấy “lúc tab lúc cửa sổ”:
  1. nút Mở / Ctrl+O / menu Mở → `openDialog` → `tabs:open-paths`;
  2. kéo–thả PDF vào viewer khi tab **đã có** tài liệu → `tabs:open-paths`;
  3. Explorer “Open with” / mở file thứ hai / macOS `open-file` → `openPathInApp`.
- **Tab đang trống thắng tuỳ chọn** (`fillCurrent`). Không thế thì chọn 3 file trong một
  cửa sổ trắng sẽ **để nguyên cửa sổ trắng đó** và mở thêm cửa sổ thứ hai.
- Chọn **nhiều file** + “Cửa sổ mới” = **MỘT** cửa sổ mới chứa cả loạt. Mỗi file một cửa
  sổ nghĩa là mỗi file một **tiến trình renderer** — chọn 30 file thành sự cố tài nguyên.
- Giá trị đi qua IPC là **đầu vào không tin cậy**: `setOpenIn` chỉ nhận `"tab"`/`"window"`,
  còn lại về mặc định; đọc từ đĩa cũng qua đúng cửa đó (file có thể bị sửa tay).
- Mặc định **bắt buộc** là `"tab"` — đúng hành vi có từ trước khi có tuỳ chọn. Pref hỏng
  hay không đọc được **không bao giờ** được suy thành “rải tài liệu ra nhiều cửa sổ”.
- **Vỡ khi:** đổi sang “Cửa sổ mới” mà double-click file trong Explorer vẫn ra tab · chọn
  10 file thì mở 10 cửa sổ · tab trắng vẫn trắng còn file chui sang cửa sổ khác.
- Lưới: `npm run test:tabs` (mục `prefs.js` + `planOpen`, gồm 2 ca canh gác BI-8).

### BI-14 · Gọi hàm chéo module theo kiểu “tên trần” là điểm gãy im lặng
- `rerenderChanged` (gọi từ `editor.js:2521`, `text-edit.js:519`) và
  `showOverlay`/`hideOverlay` (gọi từ 4 module) **không** có `window.` và **không** có guard.
- Đổi tên/xoá chúng trong `app.js` → `ReferenceError` lúc chạy, không lỗi lúc build.
- Ngược lại `repaintRenderedPages` có guard `if (window.…)` — mẫu này an toàn hơn, nên theo.

**Mặt thứ hai của cùng vấn đề, mất một lần vỡ app mới thấy (v0.2.49):** khi **hoist code
vào một classic script mới**, phải kiểm trùng tên cho cả **binding destructure**, không
chỉ tên hàm.
- `managed-codec.js` khai `const { PDFName, PDFRawStream, PDFDict, degrees } = PDFLib`
  ở **top level**. `app.js:17` cũng khai `const { PDFDocument, degrees } = window.PDFLib`
  ở top level. Hai `const degrees` trong **cùng** global scope = **SyntaxError**, và nó
  không giết file mới — nó giết **`app.js`**, file nạp sau. `$` biến mất ⇒ `pan.js`,
  `editor.js`, `capture.js`, `sign.js` đổ theo. **App trắng.**
- **`node` không bao giờ thấy lỗi này**: `require()` cho mỗi module một scope riêng, nên
  **537/537 ca lưới xanh trong lúc app đang vỡ**. Chỉ probe Electron bắt được. Đây là ca
  cụ thể chứng minh vì sao §1 nói "nửa DOM thì vẫn phải probe" — nó không chỉ đúng cho DOM,
  mà cho **mọi** thứ phụ thuộc scope dùng chung.
- **Cách làm đúng, xem `managed-codec.js`:** bọc **IIFE** để mọi binding riêng (nhất là
  destructure từ thư viện) thành private, rồi publish bề mặt công khai bằng
  `Object.assign(window, SURFACE)`. Một **property** của global object vẫn được phân giải
  y như tên trần khi *đọc*, mà **không thể** SyntaxError với khai báo của script khác.
  (`annot-text.js`/`annot-geom.js` không cần IIFE vì chúng không destructure gì từ thư viện
  — nhưng nếu sau này có thêm, phải đổi sang khuôn IIFE.)
- **Vỡ khi:** mở app thấy trắng · console có `Identifier 'X' has already been declared` ·
  hoặc `$ is not defined` hàng loạt (dấu hiệu `app.js` chết, **không** phải `$` bị đổi tên).
- Kiểm nhanh trước khi thêm file: `grep -nE "^\s*const \{.*\} = " renderer/*.js` rồi đối
  chiếu từng tên trong ngoặc.

### BI-36 · Zoom là HAI nửa: đổi hình học ngay, rasterise sau — và **không** dựng lại `.page-wrap`
- `app.js` `applyScaleToDom()` + `commitScale()` + `scheduleScaleCommit()`; `zoomTo` gọi cả ba.
- Trước v0.2.48 `zoomTo` gọi thẳng `renderViewer()`: **mỗi nấc lăn chuột** xoá sạch mọi
  `.page-wrap`, dựng lại canvas + hai IntersectionObserver rồi rasterise. Đó là nguyên nhân
  “zoom bị khựng/giật”. Cờ `zooming` còn **âm thầm bỏ** những nấc tới trong lúc nó chạy.
- Luật: **nửa đồng bộ chỉ được đổi CSS box** (`canvas.style.*`, `--scale-factor` của
  `.text-layer`, `transform` của `.note-layer`/`.search-layer`). Không `page.render`,
  không tạo/xoá phần tử. Nét lại là việc của `commitScale` sau `SCALE_COMMIT_MS`.
- **Không được dựng lại `.page-wrap` khi zoom.** Overlay chú thích, ô nhập chữ đang mở,
  highlight Ctrl+F và cả hình học cuộn đều bám vào đúng phần tử đó — `renderViewer` phá
  hết (đó là lý do nó chỉ dùng cho **đổi tài liệu**, không dùng cho **đổi tỷ lệ**).
- `m.paintScale` = tỷ lệ mà bitmap hiện tại được vẽ ở. `commitScale` so nó với
  `state.scale` để biết trang nào còn đang bị kéo giãn; **quên gán** nó trong
  `renderPageCanvas` thì trang mờ mãi không bao giờ nét lại.
- `.note-layer`/`.search-layer` mang `data-pscale` **riêng của nó**, không dùng
  `m.paintScale`: `gotoMatch` dựng lại lớp tìm kiếm giữa hai nấc zoom, dùng tỷ lệ của
  trang sẽ scale **hai lần**.
- Bước lăn chuột là **phép nhân** (`wheelZoomFactor`, cơ số 1.1/nấc, kẹp ±3 nấc), và
  `zoomTo` làm tròn **3 chữ số thập phân**, không phải 2: cộng cố định 0.1 là nhảy 25% ở
  mức 40% và chỉ 3% ở mức 300%; còn làm tròn 2 chữ số thì các delta nhỏ của pinch
  trackpad bị vo về đúng tỷ lệ cũ ⇒ cử chỉ **chết**.
- **Vỡ khi:** zoom xong trang mờ mãi · chú thích/ô nhập chữ biến mất khi zoom · highlight
  tìm kiếm lệch sau khi zoom · Ctrl+lăn nhanh mất nấc · pinch trackpad không ăn.
- Lưới: `npm run test:geom` (`wheelZoomFactor`) + probe Chromium (nửa DOM — xem §1).

### BI-37 · Byte ảnh gốc của ảnh round-trip nằm trong stream `/NabuSrc` **không có `/Filter`**
- `editor.js` `addManagedAnnot` (nhánh `image`) ghi; `managedSrcBytes` đọc.
- **Vì sao không nhét vào `/NabuData` như mọi kind khác** (đo trên pdf-lib 1.17.1 đang ship):
  chuỗi hex tốn ~1.46× cỡ ảnh và >1 s để ghi 1 MB; **và cả** `PDFHexString.decodeText`
  **lẫn** `PDFString.decodeText` **ném `RangeError`** khi payload > ~150 KB (chúng spread cả
  buffer qua `String.fromCharCode`) ⇒ một PNG chữ ký đã không đọc lại được. Stream thô =
  1.00×, ~5 ms cho 2 MB, đọc ra đã là byte.
- **Không** khôi phục được từ ảnh trong `/AP`: pdf-lib giải mã PNG thành mẫu thô + `/SMask`,
  bỏ luôn container.
- **`/Filter` là cái khoá an toàn**: ta ghi không filter, nên có filter = tool khác đã nén
  lại ⇒ `managedSrcBytes` trả `null`, và khi đó `stripManagedFromPage` **từ chối xoá** annot
  đó. Mất byte gốc phải thành “ảnh chỉ đọc”, **không bao giờ** thành “ảnh bị xoá lúc bake”.
- **Vỡ khi:** mở lại file thấy ảnh nhưng bấm Chỉnh sửa thì ảnh biến mất sau khi Áp dụng.
- Lưới: `npm run test:managed`.

### BI-38 · Bỏ liên kết annot round-trip là **chưa đủ** — phải giải phóng chuỗi object của nó
- `editor.js` `stripManagedFromPage` → `collectManagedChain` → `freeManagedTrash`.
- pdf-lib giữ **mọi** object nó đọc được và ghi lại tất cả khi save. Chỉ `arr.remove(i)` thì
  ảnh/PNG appearance của bản cũ **nằm lại trong file mãi mãi** — một hộp văn bản bake 10 lần
  là 10 bản PNG. Với ảnh (megabyte) thì file phình đến mức không thể bỏ qua.
- An toàn được vì chuỗi đó là **của riêng** annot: `embedPng`/`embedJpg` của pdf-lib trả
  **ref mới mỗi lần gọi** (không bao giờ dedupe theo nội dung), và `/NabuImg` là tên resource
  không chỗ nào khác ghi. Cái gì **không** giống hệt output của ta thì **bỏ qua** — xấu nhất
  là phình như cũ, tuyệt đối không được để lại ref treo.
- **Thứ tự bắt buộc: bỏ liên kết cả tài liệu TRƯỚC, giải phóng SAU.** Một `/NabuSrc` được
  **chia sẻ** cho mọi trang mà “Áp ảnh/chữ ký cho nhiều trang” đặt lên; xoá bản của trang 1
  giữa vòng lặp làm `managedSrcBytes` của trang 2 trả `null` ⇒ annot đó **được giữ lại rồi
  ghi thêm bản mới** = một ảnh hai lần. Vì thế `stripManagedFromPage` nhận `trash` và
  `bakeWithRedaction` chỉ gọi `freeManagedTrash` **sau** vòng lặp.
- **Vỡ khi:** lưu vài lần thì file to dần dù nội dung không đổi · áp 1 chữ ký cho 20 trang
  ra file gấp 20 lần cỡ ảnh · sau khi áp dụng thấy ảnh nhân đôi trên một trang.
- Lưới: `npm run test:managed` (3 vòng re-bake + ca 5 trang dùng chung + ca `/Filter`).

### BI-39 · “Trang đang xem” trong cột trang **không phải** “trang đang chọn”
- `app.js` `syncThumbFocus()` + `.thumb.current` trong `app.css`.
- `state.selected` là tập trang cho Xoá/Tách/Trích/Xoay. Nếu cuộn tài liệu cũng đổi nó thì
  cuộn qua trang khác rồi bấm Xoá sẽ **xoá trang vừa cuộn tới** — đúng loại hậu quả BI-26.
  Vì thế `syncThumbFocus` chỉ gắn/bỏ class, **không chạm** `state.selected`.
- Cue hình phải **khác** `.selected` (viền accent) — hiện dùng nền `--bg-3` + số trang đổi màu.
- Đang kéo–thả sắp xếp trang (`state.dragSrc != null`) thì **không được cuộn** cột trang:
  `wireThumb` chọn khe chèn theo `e.clientY` so với đường giữa thumbnail (BI-33).
- Dùng số học `nearestScrollDelta` chứ **không** `el.scrollIntoView()` — cái đó cuộn cả
  **phần tử cha** và có animation, đánh nhau với smooth-scroll của viewer.
- Thứ tự khởi tạo: `renderAll` chạy `renderThumbs` **trước** `renderViewer`, nên
  `renderThumbs` chỉ **reset** `thumbFocusIdx`; đánh dấu là việc của cuối `renderViewer`
  (lúc đó `#viewer` mới chứa trang của tài liệu mới).
- **Vỡ khi:** cuộn tài liệu rồi bấm Xoá trang thì mất trang không mong muốn · thumbnail sáng
  sai trang sau khi mở file khác · cột trang nhảy khi đang kéo sắp xếp trang.
- Lưới: `npm run test:geom` (`nearestScrollDelta`) + probe Chromium.

---

### BI-40 · Chữ và mây có **một** bộ số học, dùng cho **hai** đích — màn hình và PDF đã bake
- `annot-text.js` `layoutTextBox()` là nguồn duy nhất cho **cả hai**: `measureText()` (hộp
  trên màn hình người dùng gõ vào) và `renderTextPng()` (PNG thật sự đem bake vào PDF).
  Hai đường lệch nhau là **lỗi im lặng**: màn hình trông đúng, file đã lưu bị tràn chữ /
  xuống dòng khác / khác số dòng. Không ai thấy tới khi khách mở hợp đồng.
- Cùng khuôn: `annot-geom.js` `cloudPath()` / `cloudPathPoly()` trả **một** chuỗi SVG path
  cho **cả** overlay `<svg>` (viewBox gốc 0) **và** `drawSvgPath` của pdf-lib. Hai luật
  bất khả xâm phạm: (1) **mọi toạ độ ≥ 0** — đó là việc của `pad`; âm là bị cắt trên
  overlay và đặt sai chỗ trong PDF; (2) `cloudPathPoly` **phải** trả `minX`/`minY` — bỏ
  đi là mọi mây freehand nhảy về góc trên-trái trang.
- Ba luật đã có ca canh gác, đừng “đơn giản hoá” mất:
  - `letterSpacing` nằm **GIỮA** các glyph ⇒ dòng n ký tự có **n-1** khoảng. Đếm n khoảng
    là âm thầm nới rộng **mọi** hộp (vô hình ở mặc định 0, sai với mọi ai chỉnh spacing).
  - `align: justify` **không** áp cho dòng cuối đoạn (`lastOfPara`), kể cả dòng ngay
    trước một dòng trống — nếu không thì đoạn nào cũng kết bằng một dòng bị kéo giãn.
  - `bumpOf({bump: 0})` phải trả về mặc định: `0` là falsy **có chủ ý**, vì `bump = 0`
    làm `Math.round(len / 0)` ra `Infinity` và treo lúc dựng path.
- Cột chữ của danh sách bullet/số lấy theo marker **rộng nhất** trong khối, không theo
  marker của từng dòng — nếu không thì “9.” và “10.” làm chữ bị bậc thang.
- **Đã sửa ở v0.2.49 — `fontFamily(falsy)` trả về stack `sans`.** Trước đó nó trả
  `'"sans", sans-serif'`, tức đi tìm font tên **literal** `sans` (không tồn tại) rồi rơi về
  `sans-serif` chung ⇒ **Arial** trên Windows. Hộp văn bản **không** đi vào nhánh này
  (`normTextStyle` luôn cấp `font: "sans"`), nhưng `textFont(fpx)` gọi **không có** `opts`
  thì có — và đó **đúng là** hai rasteriser `renderArrowPng` / `renderWatermarkPng`. Kết
  quả: **nhãn mũi tên + watermark render bằng Arial** còn mọi hộp văn bản dùng Segoe UI,
  suốt nhiều phiên bản, mà **không ai phát hiện được** vì cả hai **không có** tuỳ chọn font
  (`TOOL_CTLS.arrow` = `["color","penwidth","arrowlabel"]`; modal watermark chỉ có
  size/angle/opacity/color). `labelSize` cũng hardcode `14`.
- **Phạm vi ảnh hưởng của bản sửa, đã đo bằng probe (không suy luận):** `layoutTextBox`
  **0/1248** lệch · `measureText` **0/1248** lệch · hình học mây/mũi tên **0/178** lệch ·
  `textFont` **1104/1248** lệch — đúng những ca **không** có `font` tường minh (144 ca còn
  lại có `serif`/`mono`/tên font hệ thống nên không đổi). Tức hộp văn bản và hình học
  **không** đổi gì; chỉ nhãn mũi tên + watermark **bake mới** đổi font. Cái đã bake là
  pixel nên file cũ không đổi.
- **Nếu muốn cho người dùng chọn font cho nhãn mũi tên / watermark** thì đó là **tính năng
  khác**: phải thêm field `font` vào annot mũi tên + object watermark, thêm `"font"` vào
  `TOOL_CTLS.arrow`, và truyền style vào `textFont` ở hai rasteriser. Bản sửa v0.2.49
  **không** làm việc đó — nó chỉ làm mặc định nhất quán.
- **Vỡ khi:** gõ chữ Việt có dấu vào hộp rồi Xong mà chữ tràn khỏi khung · đổi
  letter/word spacing xong hộp rộng hơn chữ · khoanh mây freehand rồi Lưu mà mây nhảy chỗ.
- Lưới: `npm run test:text` (annot-text.js) + `npm run test:cloud` (annot-geom.js) +
  `npm run test:geom` (`resizeRect`). Nửa DOM vẫn phải probe — xem §1.

### BI-41 · `.edit-bar` phải `flex-wrap: wrap` — thanh tràn thì mất nút **Xong**
- `app.css` khối `.edit-bar` (dùng chung cho `#edit-bar` **và** `#tedit-bar`).
- Thanh này là **một hàng flex**, và nội dung của nó **phụ thuộc công cụ đang chọn**
  (`syncCtlVisibility`). Công cụ có palette rộng làm nó rộng hơn cửa sổ. Hai thứ bị đẩy
  ra ngoài đầu tiên lại đúng là `#ed-exit` và `#ed-apply` — tức người dùng chú thích được
  mà **không có đường nào ghi lại hay huỷ bỏ**. Kèm theo: `#ed-hint` có `min-width: 0`
  nên bị bóp về 0 rồi **chữ xuống dòng dựng đứng**, đẩy thanh cao **381px** và nuốt mất
  vùng xem trang.
- **Đo bằng probe Electron trên chính `app.css`** (không suy luận) — width nhỏ nhất còn
  bấm được "Xong", 13 nút công cụ / 15 nút:

  | Công cụ | 13 nút | 15 nút |
  |---|---|---|
  | select · image | 959px | 1035px |
  | highlight · note · redact | 1026px | 1102px |
  | draw · check · cross | 1110px | 1186px |
  | measure | 1225px | 1301px |
  | arrow | 1290px | 1366px |
  | box · ellipse | 1451px | 1527px |
  | **cloud · cloudpen** | **1667px** | **1743px** |

  Nghĩa là **trước khi thêm gì cả**, laptop 1366px đã mất nút Xong ở 3 công cụ. Mỗi nút
  công cụ thêm vào tốn **+76px** trên **mọi** dòng của bảng.
- Có `wrap` thì ở mọi width 900–1920px nút Xong luôn bấm được, thanh cao **46–127px**.
- **Luật:** thêm nút vào `#ed-tools` (hay control vào palette) thì phải trả lời câu hỏi
  bề rộng, không chỉ nhìn cho vừa mắt trên màn hình của mình. Và **đừng gỡ `flex-wrap`**
  "cho gọn một hàng" — nó là thứ duy nhất đang giữ nút commit trên màn hình.
- **Vỡ khi:** thu nhỏ cửa sổ khi đang Chú thích → không thấy "Xong"/"Hủy bỏ" · hoặc chọn
  công cụ Khoanh mây thì thanh công cụ phình cao che mất trang.
- **Cập nhật v0.2.53 — `#ed-hint` không còn là chỗ để chữ hướng dẫn.** Câu hướng dẫn theo
  từng công cụ (15 câu) + `SELECT_HINT` / `ARROW_HINT` / hint nhóm đã bị **bỏ**, chuyển sang
  **Trợ giúp → Hướng dẫn sử dụng** (`renderer/help.js`). Ô `#ed-hint` giữ lại nhưng **chỉ**
  cho **trạng thái tạm**: dòng "đang vẽ mây từng điểm" và tỷ lệ của công cụ Đo — cả hai đều
  ngắn và phụ thuộc trạng thái. Ghi qua **một** hàm duy nhất `setEdStatus()` trong
  `editor.js`.
  - **Luật:** **đừng để chữ có thể dài trở lại ô này.** Đó chính là cái đẩy thanh lên
    381px. Muốn thêm hướng dẫn thì thêm vào `SECTIONS` của `help.js`, ở đó nó được dịch
    (VI/EN) và không ảnh hưởng bố cục thanh công cụ. `#ed-hint` nằm trong `SKIP_IDS` của
    `i18n.js`, nên mọi chữ đặt vào đây vĩnh viễn **không có bản tiếng Anh**.
  - Đã đo lại bằng probe Electron sau khi bỏ: công cụ *Khoanh mây*, thanh cao **86px** ở
    1366px và 1024px, **127px** ở 900px, nút **Xong** bấm được ở cả ba.
  - Lưới: `npm run test:help` (chặn lệch bản dịch VI/EN, markup `**`/`` ` `` không cân,
    và thiếu bất kỳ cử chỉ nào từng chỉ sống trong hint cũ).

### BI-42 · ✓ / ✗ và đoạn thẳng Shift dùng **một** bộ số học ở `annot-geom.js`
- `annot-geom.js` `symbolStrokes()` + `strokeExtend()`; chỗ gọi ở `editor.js`
  (`renderAnnot` nhánh `SYMBOL_KINDS`, `drawOneAnnot`, nhánh `drag.type === "draw"`).
- **`symbolStrokes` là cùng khuôn BI-40**: một hàm, **hai** người đọc — `<svg>` overlay và
  `page.drawLine` lúc bake. Viết riêng hình ✓ cho phần bake là tái lập đúng lớp lỗi im
  lặng của BI-40: màn hình đúng, file giao cho khách sai.
- **`strokeExtend` có đúng một cái bẫy, và nó im lặng hoàn toàn:** điểm neo của đoạn
  thẳng phải được **chốt một lần** lúc Shift vừa nhấn rồi mang theo qua các lần
  `mousemove` (`drag.lineFrom`). Suy lại neo = "điểm cuối" ở mỗi lần move sẽ ghim nó vào
  chính điểm vừa ghi ⇒ đoạn thẳng luôn dài 0 ⇒ **Shift trông như không làm gì**, không
  lỗi, không cảnh báo. `npm run test:cloud` có ca canh gác dựng lại đúng lỗi đó.
- `e.shiftKey` đọc **live từ event** (đúng khuôn `resizeRect` ở `onMove`), nên nhấn/thả
  Shift giữa chừng ăn ngay — đó là thứ cho phép một nét trộn cả gấp khúc lẫn vẽ tay. Nếu
  đổi sang đọc từ một cờ `keydown` toàn cục thì cờ sẽ **kẹt** khi Shift được thả lúc cửa
  sổ mất focus.
- ✓/✗ nằm trong `RESIZABLE_KINDS` ⇒ được 4 tay nắm + Shift-giữ-tỷ-lệ **miễn phí**; đổi lại
  chúng **bắt buộc** phải có `x/y/w/h` thật (`resizeRect` chỉ biết hộp).
- Bấm-một-cái ra cỡ mặc định là việc của **`onUp`**, không phải `onDown`: `onDown` không
  biết cử chỉ sẽ là bấm hay kéo. Hộp bị **kẹp vào trong trang** ở bước đó — dấu treo nửa
  ngoài mép giấy thì 4 tay nắm không tóm lại được.
- Màu: ✓ và ✗ có **màu nhớ riêng** (`ed.checkColor`/`ed.crossColor`, khuôn `redactColor`)
  nhưng **dùng chung ô "Màu"**. `colorSlotFor()` là chỗ duy nhất quyết định ghi vào đâu, và
  nó ưu tiên **kind của mục đang chọn** hơn công cụ hiện tại — nếu không, dưới công cụ Chọn
  việc đổi màu một dấu ✗ sẽ âm thầm ghi đè màu chung của bút tô sáng/vẽ tay.
- Hai loại này **flatten** khi bake (như vẽ tay / tô sáng), **không** round-trip — chúng
  không nằm trong `MANAGED_KINDS`. Muốn sửa lại sau khi Lưu là **tính năng khác** (xem
  BI-37/38 để biết cái giá; chữ nhật, elip và **khoanh mây** đã đi con đường đó ở BI-64).
- **Vỡ khi:** giữ Shift mà nét vẫn ngoằn ngoèo (hoặc đứng im) · dấu ✓ trên màn hình một
  nơi, trong PDF đã lưu một nẻo · đổi màu ✗ xong bút tô sáng cũng đổi màu theo · đóng dấu
  sát mép trang rồi không kéo tay nắm được nữa.
- Lưới: `npm run test:cloud`. Nửa DOM + nửa bake vẫn phải probe — xem §1.

### BI-43 · Ảnh trang in phải **vừa TRONG** tờ giấy, không phải vừa **bề ngang** — và khoảng trang của hộp thoại hệ thống đếm **TỜ**
- `app.css` khối `@media print` (`.print-sheet` / `.print-page`) + `app.js`
  `buildPrintPages()` (bọc mỗi ảnh trong `.print-sheet`) + `main.js` `print:page`.
- **Lỗi gốc, đã có thật (báo 2026-07-31, sửa ở v0.2.51):** ảnh trang nằm thẳng dưới
  `#print-root` với `width:100%; height:auto` — tức **vừa bề NGANG**, chiều cao thả tự do.
  Tỷ lệ giấy lệch tỷ lệ trang **một chút** là ảnh cao hơn tờ giấy ⇒ Chromium ngắt phần
  dưới sang **tờ thứ hai**. Đo bằng probe Electron trên chính stylesheet này, trang nguồn
  595.2×841.92pt (tỷ lệ 1,414516):

  | Giấy | fit-to-width (cũ) | contain (nay) |
  |---|---|---|
  | A4 | 1 tờ/trang | 1 tờ/trang |
  | **A3** | **2 tờ** — tràn 0,11 mm | 1 tờ/trang |
  | **Letter** | **2 tờ** — tràn 26 mm | 1 tờ/trang |
  | Legal / Tabloid | 1 tờ/trang | 1 tờ/trang |

- **Vì sao lỗi chỉ hiện khi "Mở hộp thoại máy in của hệ thống":** `pageSize` ta truyền chỉ
  có hiệu lực ở nhánh `silent: true`. Mở hộp thoại hệ thống thì **giấy do driver quyết**
  — máy đầu tiên gặp lỗi này là driver **HP Color LaserJet A3/11x17**, tức A3. Nhưng đây
  **không** phải lỗi của hộp thoại: chọn **A3 trong hộp thoại của Nabu** (không mở hộp
  thoại hệ thống) tái hiện y hệt. Đừng đi vá tầng IPC.
- **Hậu quả tổ hợp — chỗ làm người dùng hiểu sai hoàn toàn:** khoảng trang trong hộp thoại
  hệ thống đếm **TỜ IN**, không đếm trang tài liệu. Khi 1 trang = 2 tờ, gõ `1-2` in ra
  **trang 1 hai lần** (nửa trên + dải dưới). Vì vậy bất biến "1 trang = 1 tờ" **là điều
  kiện để mọi khoảng trang có nghĩa**, không chỉ là chuyện thẩm mỹ.
- **`html, body { height: 100% }` trong khối print KHÔNG phải trang trí.** Không có nó,
  `height:100%` của `.print-sheet` rơi về `auto`, clamp thành vô hiệu và lỗi tràn quay lại
  y như cũ — đã đo đúng cái sai đó trước khi chốt hình dạng này.
- `<img class="print-page">` **không được** là con trực tiếp của `#print-root`: cái clamp
  cần hộp `.print-sheet` cỡ cố định để clamp vào. Ai "đơn giản hoá" bỏ wrapper là dựng lại
  nguyên lỗi.
- Giữ **đúng tỷ lệ**: giấy rộng/cao hơn trang thì để dải trắng, **không** kéo méo, **không**
  cắt. Lấp chỗ trắng đó (tự xoay trang ngang) là **tính năng khác**, cố ý chưa làm.
- **Vỡ khi:** in 4 trang ra 8 tờ, tờ chẵn chỉ có một dải mỏng · chọn `1-2` ở hộp thoại hệ
  thống ra hai bản của trang 1 · đổi Khổ giấy sang A3/Letter thì số tờ nhân đôi.
- Lưới: `npm run test:print` (số học khoảng trang, **cắt thẳng từ `app.js`**). Nửa CSS
  **phải** probe: dựng `.print-sheet` với `app.css` thật rồi `printToPDF` từng khổ giấy và
  **đếm tờ** — v0.2.51 chạy 40 ca (5 dạng tài liệu × 8 khổ giấy) + một probe boot
  `index.html` thật lái hộp thoại bằng sự kiện `input` thật. Đọc lại content stream là
  **vô giá trị** ở đây, phải đếm tờ và đếm pixel (cùng bài học của v0.2.50).

### BI-44 · Ô "Trang cần in" để trống = in tất cả, và bản xem trước là bắt buộc
- `app.js` `printPageIndices()` + `syncPrintPages()`; `index.html` `#print-pages` +
  `#print-pages-hint`; lưới `npm run test:print`.
- Ô trống **phải** ra đúng hành vi có từ trước khi có ô này (in cả tài liệu). Hộp thoại
  cũng **reset ô về trống mỗi lần mở** — khoảng trang còn sót của lần in trước sẽ âm thầm
  bỏ trang ở lần này.
- Dùng `window.PageRange.parseSpec`, **không** viết bộ parse thứ hai (BI-27). Kèm theo là
  **nghĩa vụ** hiển thị bản xem trước + khoá nút "In": `parseSpec` cố ý **bỏ qua token rác**
  và **kẹp số vượt trang cuối** thay vì từ chối, nên gõ `99` trên tài liệu 4 trang sẽ in
  trang 4. Có bản xem trước thì đó là tiện; bỏ nó đi thì đó là **in sai trang trong im lặng**.
- `#print-pages-hint` phải nằm trong `SKIP_IDS` (BI-10) — nó bị ghi lại mỗi lần gõ.
- **Chỉ raster những trang được chọn.** Mọi ảnh trang được giữ trong DOM cùng lúc, nên in
  2 trang của tài liệu 400 trang phải tốn 2 trang bộ nhớ, không phải 400. Đây cũng là lý do
  `buildPrintPages` **nhận tham số** và `printDoc` **không** raster trước khi mở hộp thoại.
- **Vỡ khi:** mở hộp thoại In lần thứ hai thì tự nhiên chỉ in vài trang · gõ rác mà vẫn
  bấm In được · đổi VI↔EN thì dòng gợi ý nhảy về text tĩnh.

### BI-45 · Bù xoay trang là chuyện của **primitive**, không phải của “ảnh”
- `editor.js` `drawOneAnnot` + `drawWatermark` (khối chú thích ở đầu `drawAnnots`);
  lưới `npm run test:rotate`.
- `map` = `vp1.convertToPdfPoint`, và viewport scale-1 của pdf.js **đã mang sẵn** góc
  xoay. Nên chia làm hai loại, và ranh giới **không** phải “ảnh / không phải ảnh”:
  1. **Hình học dựng từ các điểm ĐÃ MAP RIÊNG LẺ thì đúng miễn phí** — `drawLine` từng
     đoạn (vẽ tay · thân + đầu mũi tên · thân + gạch đầu dim · nét ✓/✗),
     `drawRectangle` lấy min/max của hai góc đã map (box · tô sáng), `drawEllipse` lấy
     tâm + bán trục từ khoảng đã map (hai bán trục **tự đổi chỗ** theo trang — đúng).
  2. **Thứ nào đưa cho pdf-lib một HỆ TOẠ ĐỘ CỤC BỘ rồi để pdf-lib đặt hệ đó** thì
     **bắt buộc** `rotate: pageRotate(page)`, vì trục cục bộ đang ở không gian **màn
     hình** mà pdf-lib đọc như không gian user. Hôm nay gồm `drawImage` (chữ · ảnh ·
     watermark · PNG nhãn mũi tên/dim) **và `drawSvgPath` (mây · mây tự do)**.
- **Lỗi thật, do người dùng báo 2026-08-04:** v0.2.11 vá đúng ba chỗ `drawImage` và kết
  luận “hình axis-aligned không bị ảnh hưởng” — **đúng lúc đó**. Khoanh mây ra đời
  **sau**, đi qua `drawSvgPath`, và `drawSvgPath` có **option `rotate` riêng** mà không
  ai truyền ⇒ mây bake bị xoay 90/180/270° trên mọi trang có `/Rotate` (tức mọi trang
  “landscape” do xoay), suốt từ khi có mây tới v0.2.52.
- **Đã đo, không suy luận** (pdf.js 3.11.174 + pdf-lib 1.17.1 đang ship): `drawSvgPath`
  áp `translate(x,y)·R(rotate)·scale(1,-1)`, và `R(gócTrang)·scale(1,-1)` **chính là**
  phép biến đổi màn-hình→user mà `convertToPdfPoint` hàm ý, ở **cả bốn** góc. Ở 0° nó là
  ma trận đơn vị ⇒ tài liệu không xoay **không đổi một byte**.
- **Luật:** thêm một primitive vẽ mới vào `drawOneAnnot` thì phải trả lời nó thuộc loại
  1 hay loại 2, **và** thêm kind đó vào `KINDS` của `test/annot-rotate.test.js`. Lớp lỗi
  ở đây là “primitive mới âm thầm không tham gia bù xoay”, nên phòng tuyến duy nhất là
  một lưới đi qua **mọi** kind.
- **Vỡ khi:** khoanh mây / đóng dấu / khoanh vùng trên trang scan nằm ngang → Áp dụng
  xong hình nhảy sang chỗ khác hoặc quay 90°. Trên màn hình **vẫn đúng** (overlay vẽ ở
  không gian màn hình) — chỉ file đã lưu sai, đúng khuôn im lặng của BI-40.
- Lưới: `npm run test:rotate` (96 ca — mỗi kind × 4 góc, so **điểm mực trong content
  stream** quy về không gian màn hình; có **ca canh gác** dựng lại đúng lỗi cũ bằng một
  `drawSvgPath` thiếu `rotate` và đòi nó **phải khác** 0°, nên một lưới xanh mới có
  nghĩa là bù xoay đang thật sự hoạt động).

### BI-46 · Clipboard vật thể sống **ngoài** `ed` — đó chính là tính năng
- `editor.js` `let clip` + `copySelected` / `pasteClip`; lưới `npm run test:cloud`
  (mục `annotBounds` / `translateAnnot` / `unionBounds` / `fitShift` + ca chốt vị trí
  khai báo).
- `reset()` **và** `bakePending()` đều xoá `ed.annots`. Nhét clipboard vào `ed` là
  **bấm “Áp dụng” sẽ xoá clipboard** — đúng cái mà yêu cầu “copy … paste ở trang khác,
  **ngay cả khi đã áp dụng xong**” đòi phải sống sót. Vì thế nó là binding cấp module.
  Không lưu ra đĩa, **không** chia sẻ giữa các tab (mỗi tab một renderer — §2).
- **Giới hạn phải nói ra, đừng đi tìm bug:** chỉ `MANAGED_KINDS` (chữ · ghi chú · mũi
  tên · ảnh · **chữ nhật · elip · mây · mây-vẽ-tay** từ v0.2.61, BI-64) quay lại thành đối
  tượng sống sau khi Lưu. Vẽ tay, tô sáng, che thông tin, đo, ✓/✗ **flatten thành pixel**
  (BI-42) ⇒ đã áp dụng rồi thì **không còn đối tượng để chọn**.
  Cách dùng đúng: copy **trước** khi Áp dụng — clip sống qua bake, đó là điều làm cho
  trình tự đó chạy được. Cho các kind kia round-trip là **tính năng khác** (giá: BI-37/38).
- **Nhóm bị kẹp theo HỘP HỢP (`unionBounds`), không kẹp từng mục**: kẹp riêng lẻ sẽ
  **xé nhóm** — mục sát mép trượt còn mục bên cạnh đứng yên ⇒ dán một bản vẽ sang trang
  nhỏ hơn là nó rời ra. Một `fitShift` cho cả nhóm, cùng một delta cho mọi thành viên.
- Chọn nhiều là **trong MỘT trang** (`toggleSelect`). Không phải hạn chế tạm: chính nó
  giữ cho một cú kéo nhóm chỉ cần **một** `renderLayer` mỗi mousemove, và cho
  copy/delete được phép giả định một trang.
- `ed.selMore` là **tập phụ**, `ed.sel` vẫn là “mục chính” với nghĩa cũ — có ~30 chỗ đọc
  `ed.sel` và tất cả đều muốn **đúng một** đối tượng. Tay nắm đổi cỡ (`gripsFor`) chỉ vẽ
  khi chọn **một** mục: `resizeRect`/`snapLineEnd` mỗi hàm chỉ biết một annot.
- Ctrl+C đi bằng **sự kiện DOM `copy`** + đường dự phòng `keydown`, Ctrl+V **chỉ** bằng
  sự kiện DOM `paste`: menu Edit của `main.js` dùng `role: "copy"`/`role: "paste"` (và
  **không** đặt `registerAccelerator: false` như các mục lân cận), nên phím tắt do menu
  chiếm và cái nó gây ra là `webContents.copy()/paste()` → sinh **sự kiện DOM**. Đó cũng
  là đường `capture.js` đã dùng để dán ảnh từ clipboard hệ điều hành nhiều bản nay.
  **Paste không có đường dự phòng keydown** — bắn hai lần là dán ra hai vật thể.
- **Bàn giao gesture:** clipboard hệ điều hành **có ảnh** thì Ctrl+V vẫn thuộc
  `capture.js` (handler của editor rút lui, không `preventDefault`). Bấm phải mà **không
  chọn gì và clipboard vật thể rỗng** thì cũng rút lui ⇒ menu ảnh cũ hiện y như trước.
  Hai tính năng không che nhau, ở cả hai thứ tự.
- **Vỡ khi:** copy xong bấm Áp dụng rồi Ctrl+V không ra gì · dán nhóm sang trang khác
  thì các mục rời rạc ra · Ctrl+V dán ảnh hệ điều hành không còn chạy · chọn 3 mục rồi
  đổi màu chỉ 1 mục đổi · Esc giữa lúc kéo nhóm chỉ 1 mục về chỗ cũ.

### BI-47 · Phím tắt phải nhường cho modal — `isTyping()` **không** đủ
- `app.js` `modalOpen()` + hai chỗ gọi trong `window keydown`; `editor.js` chốt ngay đầu
  `window keydown`.
- `isTyping()` chỉ đúng khi focus nằm trên **INPUT / TEXTAREA / SELECT**. Focus nằm trên
  **nút** của hộp thoại, hay trên một khung cuộn được (`#help-doc` có `tabindex="0"`), thì
  `isTyping()` = **false** và phím rơi xuống tài liệu phía sau:
  - `Delete` → `deleteSelected()` của `app.js` **xoá thật các trang đang tick**, hoặc
    `deleteSelected()` của editor **xoá annotation đang chọn** — không dấu vết, không hỏi.
  - chữ cái đơn → đổi công cụ chú thích sau lưng hộp thoại (`TOOL_KEYS`).
  - `↑`/`↓`/`PageUp`/`PageDown` → `preventDefault()` chặn cuộn của **chính hộp thoại** rồi
    **nhảy trang tài liệu** thay vì cuộn nội dung đang đọc.
  - `Esc` → huỷ polygon đang vẽ dở thay vì đóng hộp thoại.
- Lỗ này **có sẵn từ trước** cho Watermark / Điền form / Áp nhiều trang / Hiệu chuẩn; nó chỉ
  lộ ra khi trang **Hướng dẫn sử dụng** (v0.2.53) mở được **ngay trong lúc đang Chú thích**
  và mang theo cả một vùng văn bản dài phải cuộn được.
- **Bỏ hết phím ở cấp window khi có modal là an toàn — đã kiểm:** cả 4 modal của editor
  (`wm-modal`, `dim-modal`, `imgpages-modal`, `form-modal`) đều có nút **Hủy** riêng, và các
  ô nhập của chúng gắn `keydown` **thẳng lên input**, nên không cái nào phụ thuộc handler
  cấp window.
- **Luật:** thêm phím tắt toàn cục nào thì kiểm **cả** `isTyping()` **và** `modalOpen()`.
  Thêm hộp thoại mới thì nó **phải** dùng đúng class `.modal` — `modalOpen()`, chốt
  Esc-thoát-toàn-màn-hình và mọi chốt trên đều nhận diện qua class đó, không qua id.
- **Vỡ khi:** mở một hộp thoại, bấm một **nút** trong đó (không phải ô nhập), rồi bấm
  `Delete` → trang/annotation phía sau biến mất · hoặc `↓` trong trang Hướng dẫn làm nhảy
  trang tài liệu thay vì cuộn hướng dẫn.

### BI-48 · Đóng hộp thoại phải **BẤM HỘ nút Hủy**, không được set `hidden` thẳng
- `app.js` `dismissModal()` / `topOpenModal()` (ngay dưới `modalOpen()`), ba chỗ gọi:
  `Esc` (window, bubble), bấm nền (`document mousedown`), nút `.modal-x` (uỷ quyền click).
- Nhiều hộp thoại **hình dạng Promise**: `promptPassword()` và `askInsertPos()` chỉ
  `resolve()` **trong hàm `done()` của nút Hủy**; `closePrintModal()` và `closeDialog()`
  của `sign.js` còn dọn state riêng. Ẩn phần tử sau lưng chúng thì hộp thoại **biến mất
  khỏi màn hình nhưng `await` treo vĩnh viễn** — không lỗi, không dấu vết, và người dùng
  chỉ thấy "app đơ" ở lần thao tác tiếp theo. Vì thế `dismissModal` gọi `btn.click()`.
- **Hợp đồng markup:** mỗi `.modal` (trừ `data-modal-manual`) phải có **đúng một**
  `[data-modal-close]` **và một** `.modal-x`. Thêm hộp thoại mới mà quên → `Esc` im lặng
  không làm gì. Probe boot đếm cả hai (`dialogs_without_close` / `dialogs_without_x` phải
  rỗng), đó là lưới duy nhất bắt được thiếu sót này.
- **`stopImmediatePropagation`, không phải `stopPropagation`:** handler `Esc` này và
  handler phím tắt lớn **nằm cùng trên `window`**, mà `stopPropagation` không chặn listener
  anh em trên **cùng một node**. Thiếu nó thì `Esc` đóng hộp thoại **rồi thoát luôn toàn
  màn hình**, vì chốt `!modalOpen()` của handler kia lúc đó đã thành true. Kéo theo: khối
  này **phải khai TRƯỚC** `window keydown` lớn trong `app.js` — đổi chỗ là hỏng.
- `#help-modal` là **ngoại lệ duy nhất**, đánh dấu `data-modal-manual`: `help.js` tự giữ
  `Esc` (bấm lần đầu xoá từ khoá tìm, lần hai mới đóng) và tự giữ bấm-nền.
- **Vỡ khi:** mở PDF có mật khẩu → bấm nền để đóng ô nhập mật khẩu → mở file khác:
  không có gì xảy ra (promise cũ còn treo) · hoặc `Esc` trong lúc F11 làm mất cả hộp
  thoại lẫn chế độ toàn màn hình.

### BI-49 · Payload PDF **lớn** phải đi đường nhị phân, không phải base64-trong-JSON
- `api.py` `/compress-bin` + `_compress_pdf_bytes()`; `app.js` `runCompress()`.
- Đường JSON tốn ~5 lần cỡ file ở đỉnh (base64 trên dây → `str` lúc parse JSON → bytes
  giải mã → bản sao của fitz → base64 trả về). Đó là lý do có `_MAX_PDF_B64` (~200MB), và
  cũng là lý do **"nén" từ chối đúng những file đáng nén nhất**. Đường nhị phân chở
  **chính bytes** cả hai chiều nên có trần riêng `_MAX_PDF_BIN` (1GB).
- **Hợp đồng nhận biết:** thành công = `Content-Type: application/pdf` (body là PDF);
  thất bại = JSON. Client phân biệt bằng content-type, **không** bằng mã HTTP. Giống hệt
  `/edit-text?raw=1`. Đổi bên nào cũng phải đổi bên kia.
- **Header X-\* phải nằm trong `expose_headers` của CORS.** Origin của renderer là
  `file://` ⇒ mọi lệnh gọi là cross-origin ⇒ JS chỉ đọc được header nào được liệt kê. Thiếu
  thì `res.headers.get("X-Original-Size")` trả `null` **không kèm lỗi ở đâu cả**.
  `runCompress` cố ý **không** đọc chúng (tự tính từ `state.bytes.length` và
  `buf.byteLength`) — nhưng danh sách vẫn phải đúng cho người viết code sau.
- **Hai route dùng CHUNG `_compress_pdf_bytes`** để không bao giờ lệch nhau về "nén là
  làm gì"; `test_compress_bin_matches_json_route` là lưới canh đúng chỗ đó.
- **Vỡ khi:** nén file 300MB báo "PDF quá lớn" · hoặc nén xong hiện "Đã nén: 0 B → 0 B".

### BI-54 · Nén file lớn phải chạy ở TIẾN TRÌNH RIÊNG — thread không cứu được
_Ghi 2026-08-12, từ `docs/REVIEW-caps-2026-08-12.md`. Sửa ở `api.py`
(`_compress_worker_cmd`, `_compress_via_worker_blocking`, `_COMPRESS_WORKER_MIN_BYTES`)
+ `sidecar.py` (`--compress-worker`, `_err`)._

- **Vấn đề, đo được:** mọi route trong `api.py` là `async def`, nên một lệnh PyMuPDF đồng
  bộ chiếm trọn **một** event loop — mà app dùng **một** sidecar cho **mọi tab và cửa sổ**.
  Nén 30 trang làm `/health` **không trả lời 13.088 ms**; ở trần 3000 trang (0,377 s/trang)
  là **~19 phút** mọi tab khác treo theo.
- **Ba lý do khiến thread KHÔNG phải lời giải** — ghi lại để không ai mất buổi chiều tìm
  lại: (1) `doc.rewrite_images()` chiếm **98,9%** thời gian và **giữ GIL suốt** — thread
  quan sát chạy được **0,1%** thời gian và không xong nổi một vòng lặp cho tới khi nén
  xong; (2) nó là **một** lệnh mức document, **không có tham số khoảng trang**, nên không
  cắt nhỏ để chèn `await` được; (3) PyMuPDF gọi `mupdf.reinit_singlethreaded()` **lúc
  import**, bỏ khoá nội bộ của MuPDF — chạy hai thread cùng lúc không chỉ vô ích mà **không
  an toàn**. Tiến trình con có GIL riêng và context MuPDF riêng; cha chờ bằng `subprocess`
  trong thread, mà **chờ tiến trình thì nhả GIL**. Kết quả đo lại: **32 ms**, bằng lúc rảnh.
- **Worker là CHÍNH chương trình này chạy lại** với `--compress-worker` (`sidecar.py`), nên
  không có nhị phân thứ hai phải build/ký/ship. `sys.executable` là `sidecar.exe` khi
  frozen, là python của venv khi dev ⇒ **hai dạng argv khác nhau**, có lưới canh
  (`test_compress_worker_command_shape`).
- **Hợp đồng mã thoát: 0 = xong · 3 = lỗi của người gọi (stderr là câu tiếng Việt cho người
  dùng, map thành HTTP 400) · 1 = hỏng bên trong.** Đổi một đầu phải đổi đầu kia.
- **stderr của worker phải ghi UTF-8 tường minh** (`_err`). Đây là **lỗi thật đã bắt được
  lúc làm**: `sys.stderr.write` trong tiến trình con mã hoá theo **codepage console**
  (cp1258/cp1252 trên Windows) còn cha giải mã UTF-8 ⇒ "preset phải là…" đến tay người dùng
  thành rác. `test_compress_worker_reports_caller_errors_as_400` so **đúng từng ký tự**.
- **Có ngưỡng, và ngưỡng là cố ý.** Khởi động worker tốn một lần `import api` (đo 2,1 s ở
  dev, hơn nữa khi frozen). Dưới `_COMPRESS_WORKER_MIN_BYTES` (25 MB) thì nén tại chỗ —
  đo được **0,00 s** cho file nhỏ; bật worker ở đó chỉ là phí thuần.
- **Không được để mất TÍNH NĂNG vì worker.** Nếu không khởi chạy được (thiếu script, hết
  chỗ temp, máy bị khoá), route bắt `OSError` và **quay về nén tại chỗ** — tức đúng hành vi
  trước khi có worker, chậm nhưng không hỏng.
- **Đường JSON `/compress` KHÔNG đổi** — nó chỉ phục vụ lưới test; hai đường vẫn dùng chung
  `_compress_pdf_bytes` (BI-49).
- **Chỉ Nén được chuyển ra ngoài, không phải mọi thứ.** Dựng index của Tìm nhả GIL ~45% và
  chỉ mất ~1,8 s cho 600 trang, không đáng đổi rủi ro. Và vì `reinit_singlethreaded`, đưa
  **bất kỳ** việc PyMuPDF nào sang thread sẽ khiến nó chạy song song với việc PyMuPDF đang
  chạy trên event loop ⇒ **không được làm** nếu chưa đặt toàn bộ sau cùng một khoá.
- **Ước tính thời gian tính theo BYTE, không theo TRANG** (`compressEta`, `app.js`). Đo
  trên ba loại tài liệu — scan toàn ảnh, 600 trang chữ, bản vẽ vector kiểu CAD khổ A0 —
  **giây/MB** trải 0,098–0,189 (**2 lần**) còn **giây/trang** trải 0,001–0,439 (**439
  lần**). Ước tính theo trang sẽ sai **hai bậc độ lớn** với loại tài liệu nó không được
  hiệu chuẩn. Và phải **theo preset**: `lossless` bỏ hẳn `rewrite_images` (98,9% công
  việc) nên nhanh hơn ~50 lần — đo trên một file 57,8 MB: screen 0,047 · ebook 0,155 ·
  printer 0,179 · lossless 0,003 s/MB. Ngưỡng worker là một **bậc thang** cộng thêm
  (~3 s), không phải độ dốc. Lưới `npm run test:geom` so lại với chính các số đo này, và
  so **xuyên ngôn ngữ** `COMPRESS_WORKER_MIN_BYTES` (JS) với `_COMPRESS_WORKER_MIN_BYTES`
  (api.py) — lệch nhau thì ước tính sai âm thầm.
- **Hỏi lại trước khi nén tài liệu rất lớn, và hỏi TRƯỚC `bakePending()`.** Đỉnh bộ nhớ cả
  chuỗi ≈ **4 lần cỡ file** (bytes ở renderer + bản sao Blob + body ở sidecar + bản của
  worker), nên 300 MB là ~1,2 GB rải trên ba tiến trình — chỗ máy 8 GB bắt đầu đuối. Đây là
  **cảnh báo, không phải từ chối**: trần cứng `_MAX_PDF_BIN` = 1 GB vẫn giữ làm chốt chặn
  đầu vào vô lý, còn giới hạn thật là **máy**, không phải định dạng. Thứ tự bắt buộc: hỏi
  **trước** `Editor.bakePending()`, vì bake ghi chú thích vào tài liệu — bake trước rồi
  người dùng bấm Hủy là để lại một file đã bị sửa và bẩn.
- **`#cmp-eta` phải nằm trong `SKIP_IDS`** — nó là số liệu sống, đổi ngôn ngữ mà quét trúng
  thì đè mất (BI-10). Sáu chuỗi `t()` của khối này **không** nằm trong markup tĩnh nên
  không được i18n quét tự động; lưới `test:geom` liệt kê đích danh cả sáu.
- **Vỡ khi:** nén file lớn mà tab khác vẫn treo · hoặc preset sai báo lỗi bằng ký tự rác ·
  hoặc nén file nhỏ bỗng mất 3 giây · hoặc bản **đóng gói** nén xong không ra file (argv
  frozen sai) · hoặc nháy cửa sổ console đen mỗi lần nén (thiếu `CREATE_NO_WINDOW`) · hoặc
  đổi mức nén mà dòng ước tính đứng im · hoặc bấm Hủy ở hộp cảnh báo mà tài liệu đã bị bẩn.

### BI-50 · Tìm & Thay thế: mọi hit là offset của MỘT phiên bản bytes — bytes đổi thì list là hư cấu
- `renderer/find-replace.js` (`invalidate`, `applyEdits`, `indexAtOrAfter`, `groupEdits`);
  hai chỗ móc trong `app.js`: cuối `renderAll()` và cuối `rerenderChanged()`.
- Mỗi hit mang `page` + `start/end` **đo trên đúng một bản** tài liệu. Bất cứ thứ gì đổi
  bytes — chính thao tác Thay, `Ctrl+Z`, xoay trang, **xoá trang**, bake watermark — làm
  cả list sai: offset dịch, và sau khi xoá trang thì `page` trỏ sang **trang khác hẳn**,
  nên vệt tô nằm trên chữ vô can và bấm **Thay** sẽ **ghi đè đúng chữ vô can đó**.
- **Vì thế `invalidate()` móc vào hai HÀM PHỄU** (`renderAll` / `rerenderChanged`) chứ
  không vào từng chỗ gọi — thêm một thao tác sửa tài liệu mới thì nó tự được che.
  `applyEdits` bật cờ `fr.suppress` để phễu không quét chồng lên lần quét có neo của nó.
- **Sau mỗi lần ghi là QUÉT LẠI, không sửa list tại chỗ.** Một lần ghi làm hỏng ba thứ
  cùng lúc: các hit khác **trong cùng span** dịch offset, hit cross-span **đè lên span
  đó** thành rác, và **chính chữ vừa thay có thể chứa từ khoá**. Quét lại giết cả ba;
  neo (`indexAtOrAfter`) đặt **ngay sau** chữ vừa chèn nên "hợp đồng → phụ lục hợp đồng"
  không mời lại vô hạn.
- **Nhiều hit trong CÙNG một span phải gộp thành MỘT edit** (`groupEdits`). `/edit-text`
  redact hộp span rồi vẽ lại từ `new_text`; hai edit rời trên cùng span thì cái sau dựng
  lại từ **text gốc** và **xoá kết quả của cái trước** — mà toast vẫn báo "đã thay 2".
- **Không có endpoint ghi riêng.** Thay thế đi qua `/edit-text` với **đúng payload
  text-edit.js gửi** (kể cả `orig_text`/`orig_size` — BI-25, và `font` là tên font gốc —
  BI-21). Sidecar chỉ thêm endpoint **đọc** `/text-find`.
- **Cố ý KHÔNG fold dấu**, khác `Ctrl+F`: gõ "hop dong" **không** ra "hợp đồng". Fold
  đúng cho việc đọc, sai cho việc ghi — thay một kết quả fold là **xoá dấu** trong hợp
  đồng của người dùng. Hệ quả chấp nhận: hai ô tìm cho số khác nhau.
- **Khớp cắt qua 2 span thì ĐẾM và TÔ, không thay** (`replaceable: false`, vàng nét đứt).
  Bỏ im lặng sẽ bị đọc là "app tìm sót".
- **Panel không phải `.modal`** — cố ý, vì phải đọc trang phía sau khi duyệt. Nên nó
  **nằm ngoài** mọi thứ `modalOpen()` quản, và ô nhập tự giữ `Esc` của mình.
  `placePanel()` đặt `top` theo mép trên của `main`: hàng 1 thanh công cụ **rewrap**
  (đo được 57px ở 1920 → 98px ở 1366) nên mọi hằng số CSS đều sai ở một bề rộng nào đó.
- **Vỡ khi:** tìm xong → xoá một trang → vệt tô vẫn còn và bấm Thay ghi nhầm chỗ · hoặc
  "Thay tất cả" báo N nhưng mở lại file thấy vài chỗ chưa đổi (lỗi gộp span) · hoặc bấm
  Thay mãi không hết vì chữ thay chứa từ khoá.

### BI-51 · Tìm & Thay thế: quét là hành động NGƯỜI DÙNG YÊU CẦU, và thông báo lỗi không được bị đè
- `renderer/find-replace.js` (`runFind`, `refreshStatus`, `setSticky`, `markStale`,
  `setBusy`, `syncButtons`); nút `#fr-go` trong `index.html`. Lưới `npm run test:find`.
- **Một lần quét = một lượt đi hết tài liệu.** base64 cả PDF → sidecar mở lại →
  `get_text("dict")` **mọi trang**. Vài mili-giây với hợp đồng 3 trang, **vài chục giây**
  với bộ bản vẽ A1 480 trang. Vì thế **KHÔNG quét theo từng ký tự gõ** (v0.2.55 có
  debounce 350ms — gõ "2026" là **bốn** lượt đi hết tài liệu, và chúng **đua nhau**).
  Gõ chỉ đặt cờ `stale`; **Enter / nút Tìm** mới là lệnh quét.
- **`stale` khoá GHI, không khoá ĐỌC.** Vệt tô cũ vẫn đúng với bytes hiện tại (BI-50) nên
  cứ để, ↑↓ vẫn duyệt được — nhưng hai nút **Thay** phải tắt, vì thay theo hit của **từ
  khoá cũ** bằng **chữ thay mới** là ghi nhầm chỗ trong im lặng.
- **`fr.sticky` phải thắng số đếm trong `refreshStatus()`.** Đây là lỗi thật của v0.2.55:
  `runFind` ghi câu lỗi rồi `finally { setBusy(false) }` → `refreshStatus()` → **đè ngay
  lập tức** bằng "Không tìm thấy kết quả nào.". Hệ quả: **mọi** thất bại — 400 "PDF quá
  lớn", PDF là bản scan, mất kết nối sidecar, chạm trần `max_hits` — đều đến tay người
  dùng dưới dạng "không tìm thấy", tức là **báo sai nguyên nhân**. Bốn câu bắt buộc đi
  qua `setSticky()`, không phải `setStatus()`.
- **Ô `#fr-find` khi bận: `readOnly`, KHÔNG `disabled`.** `disabled` làm rơi phím và mất
  focus → ký tự gõ trong lúc quét biến mất. Ngược lại `#fr-case`/`#fr-word` **phải** nằm
  trong danh sách `setBusy` — thiếu chúng thì tick giữa lúc quét đẻ ra lượt quét thứ hai.
- **Mỗi lượt quét mang số thế hệ (`fr.runSeq`) + `AbortController`.** Lượt bị thay thế
  không được vẽ, không được gỡ cờ bận. Đóng panel cũng huỷ lượt đang chạy.
- **Trần payload phải khớp hai phía.** `MAX_B64` trong renderer = `_MAX_PDF_B64` trong
  `src/pdf/util.py`; lưới so **xuyên ngôn ngữ** hai hằng số này. Chặn ở renderer để khỏi
  mất vài giây dựng chuỗi base64 ~280MB cho một request chắc chắn bị từ chối.
- **Vỡ khi:** gõ vào ô Tìm mà app đứng hình vài chục giây · hoặc file >200MB báo "không
  tìm thấy" thay vì "PDF quá lớn" · hoặc file scan báo "không tìm thấy" thay vì nhắc OCR ·
  hoặc đổi từ khoá rồi bấm Thay và nó thay theo từ khoá cũ.

### BI-52 · /text-find: khớp MỘT lần trên DÒNG, hai trần khác nhau, cache khoá bằng toàn bộ bytes
- `api.py` (`_find_build_index`, `_find_index_for`, `_find_scan_index`, `_text_find_core`,
  `/text-find`, `/text-find-bin`); `renderer/find-replace.js` (`MAX_FIND_BIN`,
  `MAX_EDIT_B64`, `overWriteLimit`). Lưới `.venv\Scripts\python test_text_find.py` +
  `npm run test:find`.
- **Biên "Đúng nguyên từ" tính trên DÒNG ghép, không trên span.** Bản cũ khớp hai lượt
  (trong span + trên dòng) nên dòng vẽ thành `["AB","2026"]` báo `2026` là nguyên từ
  (đúng là nó đứng đầu *span* của nó) **và cho thay** ⇒ **hỏng chữ `AB2026`**. Ghi sai
  trong im lặng. Khớp một lượt trên `joined` rồi ánh xạ ngược ra span cho biên đúng, và
  ít code hơn hẳn dạng hai lượt.
- **Span toàn khoảng trắng GIỮ text trong `joined`, nhưng không bao giờ nhận lệnh ghi.**
  PyMuPDF đẻ ra span `' '` thật mỗi khi một dòng được vẽ làm nhiều mẩu (bước nhảy Td/TJ —
  rất hay gặp ở văn bản canh đều/xuất từ CAD). Vứt nó đi làm dòng ghép thành `"Hợpđồng"`
  nên **không tìm ra "Hợp đồng"**. Cờ `host=False` giữ chữ mà chặn ghi.
- **ĐO ĐƯỢC, đừng đoán:** PyMuPDF **tự gộp** span cùng style vẽ liền nhau, nên "202"+"6"
  cùng style **không** tách. Tách span nghĩa là style **thật sự** khác — lệch cỡ chữ
  **0.0001pt cũng đủ**. Vì vậy "gộp lại span cùng style" là việc **không có gì để làm**;
  mọi chỗ tách đều đi nhánh `replaceable=False` (BI-50).
- **HAI trần, khác nhau, và renderer phải soi gương cả hai.** Đọc đi `/text-find-bin`
  (body **là** file PDF) → trần `_MAX_PDF_BIN` = 1GB. Ghi vẫn đi `/edit-text` (request là
  base64 JSON) → trần `_MAX_PDF_B64` ≈ 200MB. Nên tài liệu 300MB **tìm được nhưng chưa
  thay được**, và UI phải **nói thẳng** (mờ hai nút Thay + ghi lý do trên dòng đếm) chứ
  không để người dùng bấm Thay rồi nhận lỗi. Lưới so **xuyên ngôn ngữ** cả hai hằng số.
- **Cache index span khoá bằng blake2b của TOÀN BỘ bytes.** Khoá bằng độ dài + vài mẩu
  lấy mẫu là sai chết người: sửa ở giữa file vẫn trùng khoá ⇒ dùng lại index ôi thiu ⇒
  **mọi offset trỏ sai chỗ** — đúng kiểu vỡ của BI-50 nhìn từ phía kia. Cache giữ **một**
  tài liệu, đổi bằng **một tuple** `(key, pages)` để đọc song song không bao giờ ghép
  khoá mới với index cũ. Có trần `_FIND_CACHE_MAX_PARTS` để file bệnh hoạn không ghim
  hàng trăm MB trong sidecar.
- **Bộ cứu font legacy phải giống hệt `/text-spans`.** Thiếu nó thì "Sửa nội dung" hiện
  đúng chữ TCVN3 còn Tìm bảo không có — hai tính năng bất đồng về việc trang giấy ghi gì.
- **Trần cache là con số ĐO ĐƯỢC, không phải số cho đẹp** (sửa 2026-08-12). Một span
  phẳng tốn **~1.5 KB** khi tính đủ hai tuple hộp, origin, text và tên font — đo trên PDF
  600 trang chữ thật: **27.000 span → +41 MB RSS**. Giá trị đầu tiên là `300_000`, tức
  cho phép **~450 MB** — đúng cái "hàng trăm MB" mà trần này sinh ra để ngăn. Nay
  `_FIND_CACHE_MAX_PARTS = 80_000` (≈100 MB). Không tài liệu nào bị **từ chối**: vượt trần
  thì chỉ là lần tìm sau parse lại. Cache **không** được thả khi đóng panel/tài liệu/tab —
  nó chỉ bị thay khi index một tài liệu khác, nên trần là thứ duy nhất chặn nó.
- **Hit cắt-qua-span phải mang HAI hộp khác nhau** (sửa 2026-08-12). `bbox` theo hợp đồng
  là hộp **chưa xoay** (chính là hình chữ nhật `/edit-text` sẽ redact), `bbox_view` là hộp
  **hiển thị**. Bản đầu dựng **một** union từ `parts[i][3]` (đã xoay) rồi chép vào cả hai
  ⇒ `bbox` nói dối trên trang có `/Rotate`. Vô hại **chỉ chừng nào** loại hit này còn
  `replaceable=False`; ngày ai đó gỡ hạn chế đó thì `/edit-text` redact **sai hình chữ
  nhật**, im lặng, và chỉ trên trang xoay. Nay hai union riêng (`parts[i][2]` và
  `parts[i][3]`); trên trang **không** xoay `rotation_matrix` là đơn vị nên hai hộp trùng
  nhau — đó là lý do phép sửa này không đổi gì với tài liệu thường. Lưới: `R10c`/`R10d`.
- **Vỡ khi:** tìm "Hợp đồng" trong văn bản canh đều ra 0 kết quả · hoặc tick "Đúng nguyên
  từ" rồi Thay làm hỏng chữ dính liền · hoặc sửa tài liệu xong tìm lại vẫn ra kết quả cũ
  (cache ôi thiu) · hoặc file 300MB tìm được nhưng bấm Thay ra lỗi khó hiểu.

### BI-53 · Câu xác nhận không được HỨA nhiều hơn thứ đã quét; sidecar chết phải nói ra
_Ghi 2026-08-12, từ đợt rà soát hệ quả của việc nâng trần (`docs/REVIEW-caps-2026-08-12.md`)._

- **"Thay tất cả" chỉ được nói "toàn bộ tài liệu" khi lượt quét đã đi hết.**
  `renderer/find-replace.js` (`fr.truncated`, `fr.truncatedPage`, `replaceAll`).
  `/text-find` dừng ở `max_hits` = 5000 — **đo được**: một từ khoá phổ biến trên file 600
  trang dừng ở **trang 28**, tức 5% tài liệu. Hộp xác nhận là **chỗ duy nhất** nói cho
  người dùng biết thao tác này bao trùm cái gì, nên câu "trong toàn bộ tài liệu" ở đó biến
  đúng hộp thoại sinh ra để chặn bất ngờ thành thứ **gây** bất ngờ: thay 5000 trong số
  nhiều hơn thế, được báo "đã xong", phần còn lại nằm im. Cờ **phải nằm trên `fr`** —
  `replaceAll` không đọc được chuỗi trong `fr.sticky`. Đặt lại **ở đầu** `runFind`, trước
  request: mọi nhánh return sớm (rỗng, quá lớn, lỗi mạng) nếu không sẽ để cờ của lượt
  trước đứng lại sau lưng lần "Thay tất cả" kế tiếp.
- **Sidecar chết đột ngột phải đẩy `state: "error"` ra renderer.**
  `desktop/src/sidecar.js` (`startSidecar(token, onExit)`, cờ `handle.stopping`) +
  `main.js` (`bootSidecar`). Trước đây `child.on("exit")` chỉ `console.log`, còn
  `sidecarState` chỉ được ghi **một lần** từ promise lúc khởi động ⇒ sau khi sidecar chết,
  badge vẫn "OCR: sẵn sàng", mọi nút engine vẫn sáng, mỗi lần bấm là một lỗi `fetch` trần,
  và cách chữa duy nhất là khởi động lại app — **không có gì trên màn hình gợi ý điều đó**.
  Renderer **đã** xử lý sẵn `state:"error"` (badge đỏ + `updateToolbar` làm mờ); nó chỉ
  chưa bao giờ được báo. Trần mới (1 GB, 3000 trang, index cả tài liệu) làm ca OOM-kill
  thành chuyện có thật chứ không còn lý thuyết.
- **Nửa khó là nửa thứ hai: tắt CÓ CHỦ Ý phải im lặng.** `stopSidecar` chạy lúc thoát app
  và lúc "khởi động lại engine", mà sự kiện `exit` của đứa cũ đến **không đồng bộ** — có
  thể sau khi đứa thay thế đã chạy. Bắn callback ở đó là vẽ "Engine đã dừng đột ngột" đè
  lên một sidecar hoàn toàn khoẻ mạnh. Vì thế có cờ `handle.stopping` (đặt **trước** khi
  kill), **và** thêm một lớp chốt ở `main.js`: `if (sidecar !== handle) return`.
- **Vỡ khi:** bấm "Thay tất cả" trên tài liệu lớn, được báo "đã thay xong" mà mở ra vẫn còn
  hàng nghìn chỗ chưa đổi · hoặc kill `sidecar.exe` mà badge vẫn xanh và nút vẫn bấm được ·
  hoặc "khởi động lại engine" xong badge lại đỏ dù engine mới đang chạy.

---

### BI-55 · Một renderer không bao giờ được biết định danh của renderer khác
_Ghi 2026-08-12, cùng đợt "kéo trang sang tài liệu khác" (`docs/SPEC-page-drag.md`)._

- **Main là router duy nhất.** `desktop/src/main.js` (`routePages`, `askRenderer`) +
  `src/tabs.js` (`pageTargetTabs`). Đường đi của một cú chuyển trang là
  `nguồn → main → đích → main → nguồn`, và `webContents` của đích **không bao giờ** rời khỏi
  `main.js`. Renderer chỉ được phép nói hai thứ: "có trang ở toạ độ này" (main tự tra cửa sổ
  nào đang ở đó) hoặc một `tabId` **do chính main phát ra** trong `pages:targets`.
- **Vì sao là bất biến, không phải sở thích:** mỗi tab là một renderer chạy PDF của người
  dùng. Cho tab A gọi tên tab B là mở đường cho A **đọc tài liệu của B** — và một PDF độc
  hại chỉ cần thắng đúng một renderer là đủ. Trả lời của renderer cũng chỉ được nhận từ
  **đúng webContents đã được hỏi** (`pageReqs` giữ `wc`, `pages:reply` so trước khi resolve).
- **Vỡ khi:** thêm một channel nhận `docId`/`tabId` do renderer tự khai rồi lấy bytes theo
  đó · hoặc gửi `wc`/`webContentsId` xuống renderer cho "tiện".

### BI-56 · Chuyển trang = CHÈN, XÁC NHẬN, rồi mới XOÁ — không bao giờ đổi thứ tự
_Ghi 2026-08-12._

- `desktop/renderer/page-move.js` (`dragEnd` → `const moved = !!shift && res.ok && unchanged(fp)`
  → `if (moved) await deletePages(indices)`), `answerReceive` (`inserted = state.numPages - before`).
  Đích chỉ trả `ok: true` khi tài liệu **thật sự dài ra** — không phải khi `insertBuffersAt`
  trả về, vì hàm đó **return im lặng** khi bị cổng bản quyền chặn hoặc khi không có bytes.
- **Kịch bản hỏng phải là "trang nhân đôi", không phải "trang biến mất".** Nhân đôi thì thấy
  được và `Ctrl+Z` được; biến mất là mất việc của người dùng. Mọi timeout, mọi renderer chết
  giữa đường đều rơi về phía nhân đôi vì nguồn **chưa xoá gì**.
- **Nửa dễ bỏ sót:** `unchanged(fp)`. Chỉ số trang được đo lúc bắt đầu kéo; nếu tài liệu
  nguồn đổi trong lúc chuyển (người dùng bấm Ctrl+Z, xoá trang khác…) thì những chỉ số đó
  **trỏ sang trang khác** — xoá theo là xoá đúng thứ người dùng không hề nhắm tới. Dấu vân
  tay là `docId + numPages + bytes.length`.
- **Vỡ khi:** kéo Shift một trang sang cửa sổ khác rồi đóng cửa sổ đích ngay giữa lúc chèn,
  mà trang ở nguồn vẫn mất · hoặc nút "Xoá khỏi bản gốc" xoá sai trang sau khi đã Ctrl+Z.

### BI-57 · Điểm thả nằm trong cửa sổ NGUỒN ⇒ luôn là đường sắp xếp cũ
_Ghi 2026-08-12._

- `desktop/src/tabs.js` (`classifyPageDrop`: `if (src && inside(src.rect)) return { action: "self" }`
  — **trước** vòng quét mọi cửa sổ khác, và **bất chấp** `z`). Đường liên tài liệu chỉ được
  chen vào khi cú thả **không** rơi vào cửa sổ đã bắt đầu nó.
- Kéo–thả sắp xếp trang trong cùng tài liệu đã phát hành từ v0.2.41 và là thao tác dùng hằng
  ngày; tính năng mới **thêm việc** ở `dragstart`/`dragend` chứ không sửa việc cũ. Với cú kéo
  nội bộ, main trả về `self` và **không có một byte IPC nào** được gửi đi, không cue nào được
  vẽ ở đâu.
- Chú ý ca "cửa sổ nguồn bị cửa sổ khác che": vẫn là `self`. Nhường cho `z` ở đây là biến một
  cú sắp xếp bình thường thành gửi trang sang tài liệu khác. Có test: `npm run test:pagedrop`.
- **Vỡ khi:** kéo sắp xếp trang trong một cửa sổ đang bị cửa sổ khác chồng lên, mà trang lại
  bay sang tài liệu kia.

### BI-58 · Vòng đọc con trỏ phải có watchdog, và cue không được sống lâu hơn phiên kéo
_Ghi 2026-08-12._

- `desktop/src/main.js` (`pageDrag`, `PAGE_DRAG_MAX_MS`, `stopPageDrag`, `endPageHover`).
  Main **bám con trỏ bằng `setInterval`** trong lúc kéo, vì `event.screenX/screenY` từ trong
  một `WebContentsView` lệch theo khung cửa sổ (`docs/TABS-2B-DESIGN.md` §2.3) nên toạ độ của
  renderer không dùng được. Cái giá là một timer — và một timer thì phải có đường chết chắc
  chắn: `dragend` (đường thường) **và** watchdog 30s (đường `dragend` không bao giờ tới).
- **`hover-end` bắn SAU khi chèn xong, không phải trước.** Ở `pages:drag-end`, timer bị dừng
  ngay nhưng cue **để nguyên**, và `stopPageDrag()` nằm trong `finally`. Hạ cue trước khi chèn
  làm cửa sổ đích nháy — và nếu cột trang của nó vừa được **tự bung** ra để nhận thì nó sập
  lại rồi mở ra lần nữa.
- Tự bung cột trang phải **trả lại trạng thái cũ** khi phiên kéo không thả vào đó
  (`renderer/page-move.js`: `springOpened`, `settleSpring`). Người dùng cố ý thu gọn cột thì
  một cú kéo đi ngang **không được** đổi bố cục của họ.
- **Vỡ khi:** kéo trang rồi nhả ngoài màn hình mà CPU vẫn quay (timer sống) · hoặc vạch chèn
  đứng chết ở cửa sổ đích sau khi phiên kéo đã xong · hoặc cột trang tự bung rồi ở lại dù
  người dùng chỉ lướt qua.

---

### BI-59 · Trang 0° phải ra **byte y hệt** — `/Matrix` chỉ được ghi khi trang thật sự xoay
_Ghi 2026-08-12._

- `desktop/renderer/managed-codec.js` (`normAngle`, `apRotatable`, `apMatrixFor`, `apRectFor`) +
  ba nhánh `/AP` của `addManagedAnnot` (text / arrow / image).
- Bối cảnh: trước v0.2.58 ba nhánh đó **từ chối** trang có `/Rotate` và rơi xuống dán cứng thành
  pixel. Dán cứng là **không thể đảo lại** — `importManaged()` không còn gì để đọc, nên hộp văn
  bản trên mọi bản vẽ (và trên mọi trang người dùng vừa **Xoay trang** trong app) là vĩnh viễn
  không sửa lại được. Xem `docs/SPEC-annot-rotated.md`.
- **Luật:** `if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);` — trang 0° **không có key
  `/Matrix`** nào cả, và `apRectFor(0, w, h, bx, by)` trả đúng `[bx, by, bx+w, by+h]` mà code cũ
  viết thẳng. Tài liệu không xoay là tuyệt đại đa số; chúng phải lưu ra **cùng dãy byte** như
  trước khi BI-59 tồn tại. Đừng "gọn hoá" bằng cách ghi luôn matrix đơn vị.
- **`/Rect` phải đúng bbox của `Matrix × BBox`**, không phải `[bx, by, bx+w, by+h]`. Theo
  PDF 32000-1 §12.5.5 viewer *co giãn* appearance cho khít `/Rect` — sai một chỗ này thì con dấu
  không lệch, nó **méo**, và một test chỉ nhìn `/Matrix` sẽ không thấy gì.
- Góc **không chia hết 90** (`/Rotate 45` — sai chuẩn nhưng có file thật) vẫn phải dán cứng.
  `apRotatable` là cửa duy nhất; đừng thay bằng `% 360 !== 0`.
- **Vỡ khi:** tài liệu bình thường (0°) lưu ra khác byte so với bản trước · hoặc con dấu/hộp chữ
  trên trang xoay bị **méo** (dấu hiệu `/Rect` sai) hoặc **lệch 90°** (dấu hiệu `/Matrix` sai) ·
  hoặc re-bake trên trang xoay để lại **hai** con dấu.

---

### BI-60 · Cổng bake phải hỏi “có gì THAY ĐỔI”, không phải “có gì để THÊM”
_Ghi 2026-08-12._

- `desktop/renderer/editor.js`: `exit()`, `bakePending()`, `hasUnsaved`, `openTextEditor`,
  và trường `ed._importedManaged`.
- Bối cảnh — report thật ở v0.2.58: tạo một hộp văn bản → Lưu → vào Chú thích → xoá → **hộp
  quay lại**. Cơ chế xoá (`stripManagedAnnots`) chưa bao giờ sai; **hai cái cổng** chặn không
  cho nó chạy, cả hai đều gác bằng `hasAny()`:
  - `exit()`: `if (ed._dirty && hasAny())` — xoá hết thì `ed.annots` rỗng ⇒ `hasAny()` **false**
    ⇒ **không bake** ⇒ annotation vẫn nằm trong `state.bytes` ⇒ `repaintRenderedPages()` vẽ nó
    lại. Có từ **v0.2.35**, đúng bản sinh ra chú thích sửa-lại-được.
  - `bakePending()`: `if (!hasAny()) return false` — nên **Ctrl+S cũng không cứu được**.
- **Luật:** cổng phải là `hasAny() || ed._importedManaged`. `_importedManaged` = số annot
  round-trip mà `importManaged()` **nhận quyền sở hữu** từ file trong phiên này; nó là **cách
  duy nhất** biết rằng bake vẫn còn việc (xoá) khi không còn gì để thêm. Phải gán ở **cả hai**
  chỗ gọi `importManaged()` (`enter()` và nhánh lưu-giữa-phiên của `bakePending()` — chỗ thứ
  hai đọc lại file nên số phải cập nhật theo) và **xoá trong `reset()`**.
- `hasUnsaved` cũng vậy: “tôi đã xoá hết hộp văn bản” **là** một thay đổi chưa lưu. Gác bằng
  `hasAny()` thì đóng app không hỏi gì và mất luôn.
- **Xoá trắng nội dung hộp văn bản = XOÁ hộp**, không phải “không có gì thay đổi”. Chốt cũ
  `if (text && text !== existing.text)` (có từ **v0.2.20**) làm việc xoá nội dung thành no-op
  im lặng. Không giữ được hộp rỗng: `deserializeManaged` từ chối payload không có `text`
  (`if (!data.text) return null`) nên nó sẽ biến mất ở lần mở sau, và `renderTextPng` sẽ bị
  đòi một PNG cỡ 0. Nhánh `editOrig` của ghi chú vốn đã làm đúng — dùng nó làm mẫu.
- **Vỡ khi:** xoá hộp văn bản cuối cùng rồi bấm Xong → nó quay lại · hoặc xoá trắng nội dung
  rồi bấm ra ngoài → chữ cũ hiện lại · hoặc xoá hết rồi đóng app → **không** có cảnh báo.
- Lưới: `npm run test:managed` §3b (cơ chế, đo thật) + §3c (hai cổng, assertion trên source —
  `exit()`/`bakePending()` cần DOM nên không đo trực tiếp được).

### BI-61 · Màu chú thích: `colorSlotFor` là nguồn sự thật DUY NHẤT, và bốn màu có NGHĨA không được gộp
_Ghi 2026-08-13._

- `desktop/renderer/editor.js`: `DEFAULT_ANNOT_COLOR`, `savedAnnotColor()`, `COLOR_SLOTS`,
  `colorSlotFor()`, `setDefaultColor()`, khối `ed`; `renderer/app.js` `#set-annot-color`;
  `index.html` `#ed-color` + `#set-annot-color`.
- Mặc định dùng chung đổi **vàng `#ffd54a` → đỏ `#d32f2f`** ở v0.2.60 vì hộp văn bản / mũi
  tên màu vàng trên giấy trắng gần như vô hình.
- **BỐN kind giữ ô màu riêng vì màu của chúng là NGHĨA, không phải sở thích:**
  `check` xanh (= đúng), `cross` đỏ (= sai), `highlight` vàng highlighter
  (`mix-blend-mode: multiply` 0.4 ⇒ đỏ thành vệt hồng), `redact` đen. Gộp chúng vào một
  màu “cho đơn giản” là làm dấu ✓ mang nghĩa **sai** và ô che thôi không còn đen.
- **Luật:** `COLOR_SLOTS` là một **Map** khai ở đầu IIFE cùng `SYMBOL_KINDS`. Mọi nhánh phục
  vụ **nhiều kind** (màu phụ thuộc `ed.tool`) **phải** đi qua `ed[colorSlotFor(ed.tool)]` —
  đừng viết lại một ternary `ed.tool === "redact" ? ed.redactColor : ed.color` tại chỗ gọi,
  đó đúng là cái đã bị xoá và đúng cách các chỗ gọi lệch nhau.
  - Nhánh chỉ tạo **một** kind mà kind đó **không** có slot riêng (arrow, dim, draw,
    cloudpen, text, note) đọc `ed.color` trực tiếp là **đúng** và đang làm vậy — 7 chỗ.
    ⚠️ Nhưng nếu sau này cấp slot riêng cho một trong số đó (ví dụ `note`), **phải** đổi
    chỗ tạo nó sang `colorSlotFor`, nếu không nó sẽ im lặng vẽ bằng màu chung.
  - Map **không phải** object literal: `COLOR_SLOTS["constructor"]` trên object literal trả
    về hàm của prototype (truthy) ⇒ `ed[hàm]` = `undefined` ⇒ vật thể màu đen im lặng.
  - Khai ở **đầu** file, không cạnh `colorSlotFor`: `colorSlotFor` là function declaration
    (hoisted) nhưng Map là `const`; một lời gọi lúc IIFE-init sẽ đụng **TDZ** ⇒ app trắng.
- **`|| "#ffd54a"` trong `deserializeManaged()` (2 chỗ: arrow + note) là hằng số của ĐỊNH
  DẠNG FILE, không phải preference.** Trỏ chúng sang mặc định mới = mọi file đã lưu đổi màu
  khi mở lại. Có ca canh gác trong lưới.
- Preference nằm ở **localStorage phía renderer** (`nabu-annot-color`), **không** phải
  `prefs.js`: `prefs.js` tồn tại cho quyết định main phải ra khi **chưa có cửa sổ nào**
  (BI-35); màu chú thích thì chỉ renderer đọc. Đọc/ghi **chỉ** ở `editor.js` và phơi qua
  `window.Editor.getDefaultColor/setDefaultColor` — `app.js` không được giữ bản sao thứ hai
  của key hay của regex kiểm hex.
- **Ba literal phải bằng nhau:** `DEFAULT_ANNOT_COLOR`, `value=` của `#ed-color`, `value=`
  của `#set-annot-color`.
- Đổi màu ở Cài đặt **không** sơn lại vật thể đã vẽ (đó là mặc định cho vật thể **mới**, y
  như `ed.fontSize`), còn ô **Màu** trên thanh **không** ghi vào preference.
- **Vỡ khi:** dấu ✓ ra đỏ · bút tô sáng ra hồng · ô che ra đỏ · vật thể mới ra **đen** (slot
  sai tên) · đổi màu ở Cài đặt rồi khởi động lại thì mất · mở file cũ thấy mũi tên đổi màu.
- Lưới: `npm run test:defaults` (45 ca — 3 literal, validate storage, 4 slot có nghĩa,
  ca canh gác `constructor`/`__proto__`, và 2 fallback `#ffd54a` của import).

### BI-62 · Verb “Gộp bằng Nabu PDF”: Explorer gọi app MỘT LẦN MỖI FILE — nhánh combine phải hỏi TRƯỚC, và batch phải mở tab RIÊNG
_Ghi 2026-08-13._

- `desktop/src/shell-combine.js` (thuần, có lưới) + `main.js` (`combineBucket`,
  `openCombineBatch`, `sendCombineToView`, `combineReady`) + `tabs.js` (`createTab`
  `combinePaths`) + `preload.js` (`onCombinePrefill`) + `renderer/app.js`
  (`combineFromShell`, `addCombineEntries`) + `build/installer.nsh`.
- **Sự thật của shell, phải nhớ trước khi sửa:** verb kiểu command-line được gọi **một lần
  cho mỗi file** được chọn, `%1` chỉ có một đường dẫn. `MultiSelectModel` **không** gộp lại;
  nó chỉ quyết định mục menu có hiện hay không:

  | Kiểu verb | `Document` | `Player` |
  |---|---|---|
  | legacy (command line) | 15 mục | **100 mục** |
  | COM (DropTarget) | 15 mục | không trần |

  ⇒ `Player` là **bắt buộc** (thiếu nó thì chọn 16 file là mục menu **biến mất**), và 100 là
  trần của OS. Nhận cả loạt trong **một** tiến trình cần COM `IDropTarget` — Electron không
  làm được mà không có helper native, **đã cố ý không làm**.
- **Bộ gom mà shell buộc phải có thì repo đã có sẵn:** `requestSingleInstanceLock` +
  `second-instance`. Tiến trình 2..N chuyển argv về tiến trình đầu rồi thoát. Không cần thêm
  binary nào (app khác phải ship hẳn một exe phụ cho việc này).
- **Luật 1 — THỨ TỰ HỎI.** `pdfPathFromArgv()` **cũng** tìm thấy đường dẫn trong argv của
  một lần gọi combine (cờ bị bỏ qua vì bắt đầu bằng `-`, đường dẫn thì không). Nên
  `ShellCombine.combinePathFromArgv()` phải được hỏi **TRƯỚC** ở **cả hai** lối vào argv
  (`second-instance` và đường khởi động). Sai thứ tự = chuột phải Gộp lại thành **mở file**.
- **Luật 2 — TAB RIÊNG.** `runCombine()` kết thúc bằng `loadBytes()`, tức là **thay tài
  liệu của tab nó chạy trong đó**. Dùng lại tab đang có tài liệu sẽ dựng lên câu hỏi “bỏ
  thay đổi chưa lưu?” mà người dùng không gây ra. Batch luôn mở **tab của riêng nó**, và vẫn
  hỏi `Prefs.getOpenIn()` cho tab-hay-cửa-sổ — đây là **đường mở tài liệu thứ tư**, bỏ sót
  nó là phá BI-35.
- **Luật 3 — KHÔNG GỘP IM LẶNG.** `%1` không mang chỉ số và N tiến trình tới theo thứ tự OS
  xếp lịch, nên **thứ tự click không sống sót**. Sắp theo tên **tự nhiên** (2 trước 10) rồi
  **luôn** mở hộp thoại để người dùng xác nhận/sắp lại. Gộp thẳng theo thứ tự tuỳ ý tạo ra
  tài liệu sai mà không ai phát hiện.
- **Luật 4 — CỜ VÀ KHOÁ REGISTRY SỐNG Ở HAI FILE.** `--nabu-combine` + subkey có trong cả
  `shell-combine.js` lẫn `build/installer.nsh`, và **không có gì lúc build đối chiếu**. Lệch
  = mục menu chạy app **không có cờ** ⇒ app coi là “Open with” ⇒ tính năng mất im lặng. Lưới
  đối chiếu hai file; đừng xoá ca đó.
- **Luật 5 — `SHCTX`, không hard-code HKCU/HKLM.** NSIS phân giải `SHCTX` theo chế độ cài mà
  electron-builder đã đặt, nên bản per-user ghi HKCU còn bản per-machine (đã nâng quyền) ghi
  HKLM. Hard-code HKCU = đăng ký verb cho **tài khoản admin** khi người khác nâng quyền hộ.
- `installer.nsh` phải là **UTF-8 CÓ BOM** (nhãn verb là tiếng Việt; NSIS 3 cần BOM). Thiếu
  BOM = mục menu ra mojibake. Có ca test đọc 3 byte đầu.
- `customUnInstall` **phải** `DeleteRegKey`, không thì gỡ app xong còn mục menu trỏ vào exe
  đã bị xoá.
- Trần một lượt là **60 file** (`MAX_BATCH`) vì mỗi file được đọc thành bytes rồi đẩy qua
  IPC. Phần bị cắt **phải được nói ra** (`dropped` → toast), không bao giờ cắt im lặng.
- **Windows 11:** đây là verb registry legacy nên nó nằm trong **“Hiện thêm tùy chọn”**
  (Shift+F10), **không** ở menu ngắn. Menu ngắn chỉ nhận `IExplorerCommand` đăng ký qua sparse
  MSIX **đã ký**, mà bản build đang **không ký** (`SIGNING.md`). Đã ghi trong Hướng dẫn để
  không bị báo là “thiếu tính năng”.
- **Vỡ khi:** double-click **một** file PDF lại mở hộp thoại Gộp · chuột phải Gộp lại **mở
  từng file** · chọn 5 file ra **hai** hộp thoại (cửa sổ gom quá ngắn) · batch **đè** lên tài
  liệu đang đọc · chọn 16 file thì mục menu mất (thiếu `Player`) · gỡ app xong menu vẫn còn.
- Lưới: `npm run test:combine` (77 ca — parse argv gồm ca canh gác “Open with phải ra
  null”, dedupe/sắp thứ tự/trần, chính sách gom của `createCombineBucket` gồm cửa
  chờ-app-sẵn-sàng, đối chiếu `.nsh` ↔ JS, và assertion thứ tự hỏi trên source `main.js`).
  ⚠️ **Chưa có lưới cho:** verb thật trong registry và đường `second-instance` thật — cả hai
  cần bản **đã đóng gói + đã cài**. Xem §5 để biết phải test tay những gì.

### BI-63 · `File.path` ĐÃ CHẾT ở Electron 33 — đường dẫn file kéo–thả phải qua `webUtils.getPathForFile`
_Ghi 2026-08-13. **Đo được, không suy luận.**_

- `desktop/src/preload.js` `pathForFile` + `renderer/app.js` `droppedPath()`.
- **Số đo:** trong renderer của Electron 33.4.11, `typeof f.path` của một `File` là
  **`"undefined"`**. Nghĩa là chốt `if (f.path && state.bytes)` trong handler `drop` (có từ
  trước, viết cho Electron ≤31) **là code chết** — mọi lần kéo–thả đều rơi xuống nhánh
  `loadBytes`, tức là **nạp vào chính tab đang mở** thay vì mở tab mới như BI-8/BI-35 quy
  định. Không lỗi, không cảnh báo; chỉ là tài liệu đang đọc bị thay.
- Typings của Electron 33 **vẫn còn** khai `interface File { path: string }`, nên đọc
  `.d.ts` sẽ tưởng nó còn sống. Đừng tin typings ở điểm này — đo bằng probe.
- **Luật:** đường dẫn của file kéo vào lấy qua `webUtils.getPathForFile(file)` (gọi trong
  **preload**, phơi ra thành `window.desktop.pathForFile`), giữ `f.path` làm fallback để
  không phụ thuộc vào một API duy nhất.
  - **Đã đo:** `webUtils` **dùng được** trong preload có `sandbox: true` +
    `contextIsolation: true` (đúng cấu hình `src/tabs.js`): `typeof webUtils === "object"`,
    `getPathForFile` là `function`.
  - Với `File` dựng bằng JS (không có file thật trên đĩa) nó trả **chuỗi rỗng** `""` —
    đúng như tài liệu. Nên `droppedPath()` phải nhận **chuỗi không rỗng**, chứ không phải
    "bất kỳ giá trị truthy": `""` là falsy nên lọt, nhưng một giá trị sai hình dạng khác
    sẽ được chuyển thẳng sang main làm tên file.
- **Vỡ khi:** kéo một PDF vào tab **đã có** tài liệu mà nó **thay** tài liệu đó thay vì mở
  tab mới · kéo nhiều file rồi chọn “Mở từng file” mà chỉ mở được một file kèm toast
  “không lấy được đường dẫn”.
- Lưới: `npm run test:confirm` §3b (assertion trên source). Đường OS thật (kéo từ Explorer
  vào để lấy đường dẫn **thật**) **không** probe được — phải test tay.

---

### BI-64 · Chữ nhật · elip · **khoanh mây** round-trip bằng `/AP` **VECTOR** — cái bẫy là `pad`, không phải ma trận

- `managed-codec.js` `shapeAppearance()` + `MANAGED_KINDS` + `VECTOR_KINDS`/`isVectorKind`
  + nhánh vector của `serializeManaged`; `editor.js` nhánh vector của `addManagedAnnot` +
  `deserializeManaged`. Lưới: `npm run test:managed` §6 + `npm run test:rotate` §6/§7.
- **Bốn kind, MỘT nhánh mỗi nơi.** `VECTOR_KINDS = {box, ellipse, cloud, cloudpen}` có tên
  riêng vì câu hỏi “kind này có vector không” bị hỏi ở **ba** file; viết chuỗi `||` ở mỗi
  chỗ là đúng cách để ba chỗ đó trôi khỏi nhau (lý lẽ y hệt `RESIZABLE_KINDS`).
- **Tại sao vector chứ không phải PNG như chữ/mũi tên.** Chữ và mũi tên rasterise vì mực
  của chúng là **glyph tiếng Việt** — nhúng font để vẽ được "Nghiệm thu" là bài toán ta cố
  ý không có. Hình chữ nhật và elip không có cái cớ đó: pdf-lib **export sẵn** đúng những
  hàm sinh operator mà `page.drawRectangle`/`page.drawEllipse` gọi bên trong, nên `/AP` có
  thể dùng **chính đường vẽ** mà nhánh flatten của `drawOneAnnot` đang dùng — chỉ khác chỗ
  chứa (Form XObject thay vì content stream của trang). Được ba thứ: nét **không mờ** ở mọi
  mức zoom và khi in, tốn vài chục byte thay vì một bitmap supersample, và — vì hình học đến
  từ **cùng một hàm** — bản sửa-lại-được **không thể** trôi khỏi bản flatten.
- **`pad` là thứ chịu lực, và nó là chỗ dễ sai nhất.** Form `/AP` **cắt** theo `/BBox`, mà
  **một nửa nét vẽ nằm NGOÀI** đường path nó bám theo — ở góc vuông bo mí (miter) còn với ra
  xa hơn (√2 nửa nét). Lấy BBox đúng bằng w×h là **gọt mất viền** của người dùng ở cả bốn
  cạnh. `shapeAppearance` đệm **trọn một bề rộng nét** mỗi bên, vẽ hình ở `(pad, pad)` bên
  trong form, và neo form tại `map(a.x - pad, a.y + a.h + pad)` — **ba chỗ phải cùng nói về
  một số `pad`**, sai lệch một chỗ là hình lệch đúng một bề rộng nét (2–8pt): **không thấy
  trên ảnh chụp màn hình, sai trong file**, và **không** bị bắt bởi bất kỳ test nào chỉ so
  `/Rect` với công thức dựng từ chính `pad` đó.
- **Mây chồng HAI lớp đệm, và đó là bẫy riêng của nó.** `annot-geom` đã dịch path đi trọn
  một `bump` (để bướu không âm) — đó là **đệm hình học**, dùng chung với `<svg>` của lớp phủ.
  `/BBox` còn phải cộng thêm **đệm NÉT** nữa. Nhầm hai thứ này là viền mây bị gọt (chỉ
  `test:managed` bắt được) hoặc hình lệch (chỉ `test:rotate` bắt được).
- **`drawSvgPath` LẬT trục y** (`translate · R · scale(1,-1)`), nên điểm neo của nó là góc
  **TRÊN**-trái của hộp path, không phải dưới-trái như `drawRectangle`. Trong form, điểm đó
  là `(lw, hPt - lw)`. Viết nhầm thành `(lw, lw)` là mây lộn ngược **và** lệch.
- **Bên trong form LUÔN vẽ ở `degrees(0)`.** Đường flatten **bắt buộc** truyền
  `rotate: pageRotate(page)` cho `drawSvgPath` (BI-45 — quên nó chính là lỗi mây bị quay trên
  mọi trang xoay tới tận v0.2.52); trong Form XObject thì hệ toạ độ local **chính là** không
  gian form, đã dựng đứng theo màn hình, và `/Matrix = R(angle)` mới là thứ quay. Truyền góc
  trang vào `shapeAppearance` là **quay HAI lần**.
- **`shapeAppearance` trả về `ox`/`oy`** — toạ độ lớp phủ của góc dưới-trái form — nên chỗ
  gọi map **đúng một điểm** và không cần biết luật đệm của từng kind. Cố ý: `pad` của hộp
  (nửa nét bo mí) và của mây (trọn một bướu **cộng** nét) là hai thứ khác nhau, và để chỗ gọi
  tự suy ra là **bốn** cơ hội lệch một bề rộng nét.
- **Đa giác suy biến (<3 điểm phân biệt) phải bị TỪ CHỐI ở cả hai đầu:** `shapeAppearance`
  trả `null` ⇒ `addManagedAnnot` trả `false` ⇒ rơi về `drawOneAnnot`, chỗ `cloudPathPoly`
  cũng trả `null` và vẽ **không gì cả** — hai bên đồng ý. `deserializeManaged` cũng từ chối,
  nếu không sẽ có một vật **vô hình, không chọn được** nằm trong `ed.annots` mà lần bake sau
  âm thầm đánh rơi. Điểm `NaN` cũng bị lọc: nó đầu độc `Math.hypot` và cả chu vi.
- **Vì thế `test:rotate` §6 đọc content stream BÊN TRONG form**, không phải hộp bao của nó:
  với ảnh round-trip thì `/AP` chỉ là một `Do` của hình vuông đơn vị nên bao form **chính là**
  bao mực; với hình vector thì bao form là bao **phần đệm**. Đo xong đẩy từng điểm qua
  `/Matrix` rồi qua phép ánh xạ §12.5.5 lên `/Rect`, đúng như một trình đọc thật làm, và so
  với **đường flatten đã phát hành** ở 0° — thứ mà §1 đã ghim vào đúng chỗ người dùng vẽ.
- **Hai ca guard, và chúng không phải trang trí:** (i) `/AP` **thiếu `/Matrix`** — đúng ở 0°,
  sai ở cả ba góc phần tư (lỗi tiền-BI-59 dựng lại bằng tay); (ii) **quên `pad` ở khâu neo** —
  sai ở **cả 0°**, đó là lý do (i) một mình không đủ. Không có hai ca này, §6 xanh mà không
  chứng minh được gì. Đã mutation-test: `pad = 0` làm đỏ 8 ca ở `test:managed` + 4 ở
  `test:rotate`; bỏ `/Matrix` làm đỏ 12 ca; neo thiếu `pad` làm đỏ 24 ca. Riêng phần mây:
  neo `drawSvgPath` ở `(lw, lw)` → **49** ca đỏ ở `test:rotate`; quên `- g.pad` → **49**;
  `rotate: degrees(90)` trong form (đúng lỗi BI-45) → **98**. Còn `/BBox` không cộng nét thì
  `test:rotate` **KHÔNG** thấy (mực không dời, chỉ bị cắt) — **2** ca của `test:managed` là
  thứ duy nhất bắt được. **Hai lưới bù nhau: đừng bỏ lưới nào.**
- **Độ mờ nền đi bằng ExtGState ghi TRỰC TIẾP (inline) trong `/Resources`, tuyệt đối không
  đăng ký thành object gián tiếp.** Đây không phải chuyện thẩm mỹ: `collectManagedChain` giải
  phóng `/NabuSrc`, `/NabuImg` và bản thân form — một ExtGState gián tiếp là **object thứ tư
  không ai giải phóng**, rò rỉ đều đặn sau **mỗi** lần bake. Đúng lớp lỗi mà BI-38 tồn tại để
  chặn. Dict trực tiếp chết cùng form giữ nó. Nền **đục hoàn toàn thì không ghi ExtGState** —
  không có gì để đặt thì đừng trả giá.
- **Chỉ `ca` (alpha nền), không `CA` (alpha nét):** đường flatten truyền cho pdf-lib đúng một
  `opacity`, mà pdf-lib hiểu là alpha **nền**. Bịa thêm alpha nét ở đây là làm bản bake **lệch
  khỏi lớp phủ trên màn hình**.
- **`deserializeManaged` phải rơi về một LITERAL, không bao giờ về màu mặc định đang nhớ.**
  Màu mặc định là một **tuỳ chọn sống**; đọc nó ở đây là ngày người dùng đổi màu thì **mọi
  hình trong file cũ đổi màu theo**. `test:defaults` chặn bằng cách so **chuỗi con trên toàn
  bộ source của hàm — kể cả trong comment**, nên đừng nhắc tên hằng đó ở đây.
- **Còn cố ý flatten:** vẽ tay, tô sáng, che thông tin, đo, ✓/✗. Không phải bỏ sót — mỗi
  loại cần nhánh appearance riêng, và ra từng lớp một là điều giữ cho các ca guard của
  `test:rotate` còn có nghĩa.
- **Vỡ khi:** vẽ chữ nhật **hoặc khoanh mây** → Áp dụng → Lưu → mở lại → **không chọn được**
  (rơi về flatten) · mây mở lại **lộn ngược** hoặc lệch trọn một bướu ·
  chọn được nhưng **lệch đúng một bề rộng nét** lên trên-trái · viền **bị gọt** một sợi ở cả
  bốn cạnh (BBox thiếu đệm) · hình trên trang **đã xoay** ra **méo hoặc lệch 90°** · lưu 3–4
  lần liên tiếp mà **file phình** (ExtGState rò) · elip nền mờ mở lại thành **đục**.
- Lưới: `npm run test:managed` (§6) · `npm run test:rotate` (§6 + §7, xem BI-65) ·
  `npm run test:defaults`.
  Nửa GUI vẫn phải thử tay — xem hàng tương ứng ở §5.

---

### BI-65 · “Landscape” là **HAI** thứ khác nhau, và mỗi trang phải dùng **viewport của CHÍNH NÓ**

- `editor.js` `bakeInPlace()` / `bakeWithRedaction()` — dòng
  `const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });` **nằm TRONG**
  vòng lặp trang. Lưới: `npm run test:rotate` §7.
- **Hai nghĩa của “trang ngang”, và chúng đi hai đường số học khác nhau:**
  · `/MediaBox` **rộng** (bản vẽ CAD, `/Rotate 0`) → `vp1.width/height` đổi thẳng;
  · `/MediaBox` **cao** + `/Rotate 90` (ảnh scan dựng đứng bị xoay) → `convertToPdfPoint`
  **hoán vị** hai chiều bên trong.
  Trước v0.2.61 lưới chỉ phủ nghĩa thứ hai. Bộ hồ sơ thật có **cả hai**, và rất thường
  **trong cùng một file** — tờ bản vẽ ngang đóng chung với thuyết minh dọc.
- **Lớp lỗi mà §7 tồn tại để chặn không phải “xoay sai”** (§1/§5/§6 đã giữ việc đó) mà là
  **“bake dùng viewport của trang này cho trang khác”**. Trong tài liệu **một hướng** lỗi đó
  **tàng hình hoàn toàn**; trong tài liệu trộn hướng nó ném mực **ra ngoài mặt giấy**. Vì thế
  §7(b) dựng **một** tài liệu 4 trang {dọc 0°, ngang 0°, dọc 90°, ngang 270°}, bake trong
  **một lượt** đúng như `bakeInPlace`, rồi so **từng trang** với đáp án một-trang của chính nó.
- **Ca guard là thứ làm §7(b) có nghĩa:** nó nhấc `vp1` ra ngoài vòng lặp (dùng map của
  **trang 0** cho mọi trang) và **đòi** kết quả phải SAI ở trang 1–3, đồng thời vẫn ĐÚNG ở
  trang 0 — nếu không thì ca guard chỉ đang đo nhiễu.
- **“Áp dụng xong trang tự quay” có HAI đường gây ra, §7 chốt cả hai:** mực xoay (so bộ điểm
  hiển thị) **và** bản thân trang xoay — nên §7(b) kiểm luôn `page.getRotation().angle` và
  `getWidth()/getHeight()` **không đổi** sau khi bake.
- **Đường redact là đường nguy hiểm nhất và nó CỐ Ý phẳng hoá xoay:** `bakeWithRedaction`
  **không** copy trang bị che, nó rasterise rồi dựng trang **MỚI**
  `out.addPage([vp1.width, vp1.height])` **không `/Rotate`**, và map mực qua
  `makeMap(vp1, "image")`. Ảnh PNG **đã ở hướng hiển thị** — cộng thêm góc xoay của trang lên
  nữa là tờ ngang ra **quay 90°** sau khi Áp dụng. §7(c) đo đúng phép tính đó ở 90° và 270°
  (bản thân `rasterRedacted` cần canvas nên không chạy được ở node).
- **Vỡ khi:** file có cả trang dọc lẫn trang ngang → chú thích trên trang **thứ hai trở đi**
  lệch hoặc biến mất · tờ ngang **quay 90°** sau khi Áp dụng · che thông tin trên trang đã
  xoay làm trang đó **nằm ngang ra** · bản vẽ A3 ngang `/Rotate 0` đúng nhưng A4 dọc trong
  cùng file thì sai (dấu hiệu kinh điển của `vp1` bị nhấc khỏi vòng lặp).
- Lưới: `npm run test:rotate` §7 (a: mọi kind vector trên `/MediaBox` rộng × 4 góc ·
  b: tài liệu trộn hướng + guard · c: trang redact).

### BI-66 · Vẽ lại chữ phải theo **CHIỀU VIẾT CỦA CHÍNH ĐOẠN CHỮ**, không theo `/Rotate` của trang

- `_text_frame()` + khối vẽ lại của `/edit-text` ([api.py](../api.py)); trường `dir` của
  `/text-spans`, `/text-find` và `TextEdit`; `ed.dir` ở
  [text-edit.js](../desktop/renderer/text-edit.js) `apply()`, `dir` ở
  [find-replace.js](../desktop/renderer/find-replace.js) `editForSpan()`.
  Lưới: `.venv\Scripts\python test_edit_text_rotate.py`. Chẩn đoán đầy đủ + số đo:
  [SPEC-text-edit-rotated.md](SPEC-text-edit-rotated.md).
- **Đã đo, không suy luận** (PyMuPDF 1.27.2 đang ship): `page.insert_text` — như **mọi**
  hàm ghi nội dung của PyMuPDF — vẽ ở không gian trang **CHƯA XOAY** và **bỏ qua hoàn
  toàn** `/Rotate`: gọi y hệt trên trang 0°/90°/180°/270° cho ra **cùng một** bbox.
  `get_text` cũng báo ở đúng không gian đó. Nên bản thân endpoint **không có cách nào
  biết** chữ nó đang thay chạy theo chiều nào — trước bản vá nó vẽ **mọi** đoạn từ trái
  sang phải.
- **Lỗi thật, do người dùng báo 2026-08-20:** trên bộ hồ sơ thầu/CAD (`/Rotate 90`), chữ
  gốc chạy **DỌC** trong không gian chưa xoay để đọc **xuôi** sau khi viewer xoay lại ⇒
  “Sửa nội dung” và **chữ thay thế của Tìm & Thay thế** ra **quay 90°**. Đây là **lớp lỗi
  BI-45 ở một tầng khác**: BI-45/BI-65 vá đường bake chú thích (pdf-lib, phía renderer);
  đường này là chữ **thật** của trang (PyMuPDF, phía sidecar) và **không** dùng chung một
  dòng số học nào với nó.
- **`page.rotation` là câu trả lời SAI, và đây là con số:** file tham chiếu
  (`260521_CLD_NAVY_SGSU`, 30 trang, **trang nào cũng** `/Rotate 90`) có **5799** đoạn đọc
  xuôi — `dir (0,-1)` — **và 902** nhãn dựng dọc — `dir (-1,0)`. Một góc trang **không thể**
  mô tả cả hai; lấy góc trang mà vá thì 902 đoạn kia sai theo kiểu mới. Nguồn sự thật duy
  nhất là `line["dir"]` của **chính đoạn chữ**, nên nó được chuyển suốt từ
  `/text-spans`/`/text-find` → renderer → `/edit-text`.
- **Ba phép tính, không phải một.** Sửa chiều mà bỏ hai chỗ còn lại là đổi lỗi lộ thành
  lỗi im:
  1. **Chiều vẽ** — một ma trận `morph` mang cả xén-nghiêng, nén ngang **và** góc chữ:
     `Matrix(hscale, 0, shear, 1, 0, 0) * Matrix(theta)`. **Thứ tự bắt buộc** như vậy: nén
     ngang thuộc hệ **của chữ**, phép xoay mới đưa hệ đó ra trang; đảo lại thì trên đoạn đã
     xoay cái nén rơi vào **chiều cao glyph** thay vì bước tiến (đã đo).
  2. **`hscale` / `vscale` (BI-25)** chia cho bề ngang / bề cao của bbox. bbox là
     **axis-aligned**, nên trên đoạn xoay 90° bề ngang chính là **chiều cao dòng** và bề cao
     chính là **độ dài chữ** — hai số **đổi chỗ**. Với đoạn dài thì tỷ số rơi ra ngoài dải tin
     cậy và bị loại (may), nhưng với đoạn **ngắn** nó rơi **vào trong** dải ⇒ chữ bị nén còn
     một nửa mà **không báo gì**. Vì thế `adv`/`thick` được chọn theo `quadrant`.
  3. **Gạch chân** vẽ theo `u_dir`/`n_dir` (dọc theo chữ / xuống dưới đường chân), không
     phải theo trục x/y của trang.
- **Không phải góc vuông thì KHÔNG suy diễn.** Nhãn dẫn của bản vẽ được viết ở 15°, 22.7°,
  30°, 49°… — `insert_text(rotate=…)` chỉ nhận bội số 90 nên đường vá dùng **ma trận**, tái
  tạo **đúng** góc đó. Nhưng bbox axis-aligned của một đoạn chữ chéo **không** tách được
  thành “dọc theo chữ” và “ngang qua chữ”, nên ở đó `quadrant = None` và **cả hai** phép
  chỉnh hình học bị **tắt** — thà không chỉnh còn hơn chỉnh theo một số đo đã biết là sai.
  Dưới `_DIR_SNAP_DEG = 2°` thì **bắt vào** góc vuông: file thật có đoạn lệch 0.11°, và bắt
  đúng góc giữ cho `u`/`n` không nhiễm bụi float (`cos 90° = 6e-17`).
- **Dải chết là hợp đồng, không phải may mắn:** không có `dir` (renderer cũ, caller khác,
  test cũ) ⇒ `theta = 0` ⇒ `Matrix(0)` là ma trận đơn vị và `morph` về đúng biểu thức cũ ⇒
  tài liệu Word/Excel bình thường ra **y hệt từng pixel**. Lưới có ca `D3` đo đúng điều đó.
- **Luật:** thêm bất kỳ phép vẽ nào vào vòng lặp `for e in edits` của `/edit-text` (viền,
  gạch giữa, chỉ số trên/dưới…) thì phải trả lời nó đi theo **hệ của chữ** (`u_dir`/`n_dir`,
  hoặc nằm trong `morph`) hay hệ của **trang**, **và** thêm ca vào `test_edit_text_rotate.py`.
  Lớp lỗi ở đây là “phép vẽ mới âm thầm không tham gia bù xoay” — hệt BI-45.
- **Vỡ khi:** sửa một dòng trên bản vẽ A1 nằm ngang → chữ mới **quay 90°** · Thay tất cả
  trên hồ sơ CAD → chữ thay thế nằm **vắt ngang** bản vẽ · nhãn kích thước dựng dọc sau khi
  sửa thì **nằm ngang ra** · đoạn **ngắn** trên trang xoay bị **nén còn ~50%** · gạch chân
  **cắt ngang** chữ thay vì nằm dưới. Trên trang **không** xoay thì mọi thứ vẫn đúng — đúng
  khuôn im lặng của BI-40/BI-45.
- Lưới: `test_edit_text_rotate.py` (107 ca — helper thuần · dải chết · 4×4 tổ hợp
  {góc trang} × {chiều chữ} · gốc đường chân · `/Rotate` không tự đổi · trục hình học ·
  gạch chân · góc chéo 30° · **đường Tìm & Thay thế đi hết vòng**). **Mỗi** nhóm có **ca
  canh gác** gửi `dir=None` để dựng lại đúng lỗi cũ và **đòi** kết quả phải SAI — bỏ ma
  trận `morph` ra thì lưới đỏ 26 ca, nên một lưới xanh mới có nghĩa.
- Trường `dir` **cũng là trường thứ 9 của tuple span dẹt** trong `_find_build_index`. Tuple
  đó là **hợp đồng theo vị trí**: fixture `part()` của `test_text_find.py` phải đi theo, nếu
  không nó đang test một hình dạng tài liệu mà sidecar không bao giờ sinh ra.
---

### BI-67 · Chữ **thành nét vẽ** + lớp text vô hình: redact xoá lớp vô hình, **mực vẫn còn**

- `_fix_span_box` / `_fix_text_dict` / `_page_text_dict` và bộ dò mực
  `_probe_pixmap` / `_px_box` / `_ink_survived` / `_ring_color`
  ([src/pdf/layout.py](../src/pdf/layout.py)); bước **1** + **1b** của `/translate-pdf`
  ([api.py](../api.py)). Lưới: `test_helpers.py` (10 ca thuần) + `test_translate_layout.py`
  (4 ca dựng file).
- **Lỗi thật, người dùng báo:** bấm **Dịch**, file ra vẫn đọc được **nguyên** tiếng Việt và
  bản tiếng Anh **nằm đè lên** — không đọc được cái nào. Thiết kế nói rõ bản gốc phải biến
  mất.
- **Hai lỗi ĐỘC LẬP chồng lên nhau, và vá một cái không đủ.** Đã đo trực tiếp trên file
  người dùng gửi:
  1. **Chữ nhìn thấy KHÔNG phải chữ.** Content stream 775 KB toàn `m/l/c/f` — 33 đường
     **tô đặc** vẽ ra toàn bộ chữ của trang, kèm một lớp font **Type3 rỗng** chỉ để
     `get_text` đọc được. `apply_redactions` xoá đúng lớp vô hình đó (`get_text` về **0**
     ký tự) nhưng render **y hệt trước** — vì `graphics=PDF_REDACT_LINE_ART_NONE` (thêm ở
     v0.2.43 để cứu gạch chân và ô bảng có nền) nói **đừng đụng vào nét vẽ**, mà mực CHÍNH
     LÀ nét vẽ.
  2. **bbox của span lệch xuống đúng một dòng.** MuPDF báo
     `bbox=(56, 43, 71.6, 57) origin=(56, 43)` — **đường chân nằm trên cạnh TRÊN** của
     hộp, trong khi mực thật ở `y 32.94..43.17`. Nên ô redact **và** ô `insert_textbox`
     đều thấp hơn chữ một dòng.
- **Bật lại xoá nét vẽ KHÔNG phải câu trả lời — đã thử cả ba chế độ.** `REMOVE_IF_COVERED`
  và `REMOVE_IF_TOUCHED` chỉ xoá những sub-path heuristic của MuPDF cho là bị phủ: tiêu đề
  quay lại **mất dấu** (“PHAM VI CÔNG VIEC”), gạch ngang trang biến mất. Vá theo hướng đó
  là đổi một lỗi lộ lấy một lỗi bẩn.
- **Nguồn sự thật là ĐO, không phải đoán:** render trang 72 dpi **trước** và **sau**
  `apply_redactions`, so **đúng ô của block đó**. Không đổi **một** pixel ⇒ redact chứng
  minh là **không xoá được gì** ⇒ chữ nhìn thấy không phải chữ ⇒ che nền. Phép thử này
  **không** hỏi “vùng này có tối không”, nên chú thích nằm **trên ảnh** (redact xoá được
  glyph ⇒ pixel ĐỔI) không bao giờ bị nhận nhầm.
- **Che nền lấy màu từ dải ngay TRÊN và DƯỚI block**, không phải viền quanh: với một dòng
  chữ, hai dải đó là khoảng cách dòng ⇒ chính là màu nền trang, còn hai bên có thể chạm cột
  bên cạnh. Dải **không** đồng màu (ảnh, gradient) ⇒ **không vẽ gì**, đếm vào
  `blocks_uncleaned` và báo cho người dùng: một mảng đặc đè lên ảnh phối cảnh là hỏng nặng
  hơn một trang nói thẳng là không dọn được.
- **Bản vá bbox nằm ở TẦNG CHUNG (`_page_text_dict`), cố ý.** `/text-spans`, `/text-find`
  và `_page_text_blocks` là ba cửa duy nhất đọc span; đi chung một cửa thì Dịch, Sửa nội
  dung và Tìm & Thay thế **không thể** bất đồng về chỗ của một chữ. Thêm cửa thứ tư = gọi
  `_page_text_dict`, **không** gọi `page.get_text("dict")`.
- **Tài liệu bình thường không thể chạm vào luật này:** với font thật MuPDF dựng
  `y0 = origin.y - ascender*size`, nên `origin.y - y0 ≈ 0.9*size` — cách xa ngưỡng
  `0.25*size`; ca lỗi cho đúng **0**. Ngưỡng là **phân số của cỡ chữ**, không phải số điểm
  tuyệt đối, nên chú thích 4pt và tiêu đề 40pt cùng một luật. Chỉ áp cho **dòng ngang**
  (`dir ≈ (1,0)`) — trên dòng dọc `origin.y - y0` mang nghĩa khác hẳn (BI-66).
- **Số thay thế là ĐO được:** `asc = 0.9`, `desc = -0.25`. Trên file thật, dòng cao nhất cần
  `0.89*size` trên đường chân và đuôi chữ sâu nhất xuống `0.21*size`.
- **Vỡ khi:** dịch một brochure/catalogue xuất từ InDesign/Canva (“giữ chữ tìm được” =
  outline + lớp vô hình) → bản dịch **đè** lên bản gốc · “Sửa nội dung” trên cùng file đó
  tô sáng **khoảng trắng dưới** chữ · Tìm & Thay thế ghi chữ mới thấp hơn một dòng · và
  ngược lại, nếu ngưỡng bị nới thì tài liệu Word **bình thường** bị dịch ô hộp lên trên.
- **Luật:** đừng bao giờ đổi `graphics=` của `apply_redactions` để “cho chắc”. Câu hỏi đúng
  là “redact có xoá được gì không”, và câu đó phải **đo**, không suy luận.
---

### BI-68 · `blocks_covered` / `pages_failed` là **kết quả**, không phải log — `success` không có nghĩa là xong

- `TranslateResponse` ([api.py](../api.py)) và toast của `runTranslate`
  ([app.js](../desktop/renderer/app.js)). Lưới:
  `test_translate_layout.py::test_pages_the_model_gave_nothing_for_are_reported`.
- **Lỗi thật, trong cùng một lượt báo lỗi:** file 3 trang, Gemini chỉ trả kết quả cho trang
  1. Hai trang kia ra file **nguyên tiếng Việt** và app báo **thành công**. Code cũ:
  `if not translations: continue` — bỏ qua **im lặng**.
- Người dùng sắp **gửi file này cho người khác**. Một trang không dịch mà không ai nói là
  lỗi tệ hơn một trang dịch xấu.
- **Luật:** trong `/translate-pdf`, mọi nhánh `continue` bỏ qua công việc phải **cộng vào
  một bộ đếm có trong response**, và toast phải đổi sang `warn` khi bộ đếm khác 0. `success`
  chỉ có nghĩa “đã tạo được file”.
---

### BI-69 · `draw` round-trip: điểm phải **thưa hoá**, và nét phải **cùng một hình** ở cả hai đường ghi

- `strokePath` / `simplifyStroke` ([annot-geom.js](../desktop/renderer/annot-geom.js));
  nhánh `draw` của `shapeAppearance` + `serializeManaged`
  ([managed-codec.js](../desktop/renderer/managed-codec.js)); nhánh `draw` của
  `deserializeManaged` + `drawOneAnnot` ([editor.js](../desktop/renderer/editor.js)).
  Lưới: `test:cloud` (14 ca hình học), `test:managed` (round-trip + thưa hoá),
  `test:rotate` §6/§7 (`draw` + `draw flat`).
- **Điều `draw` khác MỌI kind managed khác:** nó là kind duy nhất mà điểm **lưu vào file
  không phải** điểm trên object. `cloudpen` là dăm góc **bấm chuột** nên ghi nguyên; `draw`
  thêm một điểm **mỗi lần chuột di chuyển**, nên một nét chéo qua trang A4 là vài trăm điểm
  và một chữ ký là vài nghìn — tất cả phải nằm trong chuỗi hex `/NabuData`, trên **mỗi**
  trang, ở **mỗi** lần lưu.
- **Thưa hoá phải LŨY ĐẲNG, và đó mới là điểm mấu chốt** — không phải tỷ lệ nén. RDP giữ
  lại đúng những điểm cách dây cung **hơn** `tol`, nên chạy lại trên chính kết quả của nó
  trả về y nguyên. Không có tính chất đó thì **lưu → mở lại → lưu** bào mòn đường cong thêm
  một chút mỗi vòng và chữ ký từ từ thành đa giác — đúng lớp lỗi “dịch lại file đã dịch”.
- **`tol = 0.3 pt ≈ 0.1 mm`**: một phần mười bề rộng nét mảnh nhất thanh công cụ cho, và
  dưới cả độ phân giải in 600 dpi (0.042 mm/px ⇒ 2.5 px).
- **Trần `maxPts` NỚI DUNG SAI, không cắt cụt.** Quá hạn thì `tol` nhân đôi rồi chạy lại;
  mất **đuôi** chữ ký là hỏng nặng hơn một đường cong thô hơn.
- **Hai đường ghi vẽ CÙNG một hình, bằng hai primitive khác nhau — và đó là chủ ý.**
  Đường flatten vẫn là `drawLine` **từng đoạn** vì mỗi đầu mút được `map` **riêng**, thứ
  giữ cho nét đúng trên trang `/Rotate` mà không cần `rotate:` (chính cái bẫy BI-45); `/AP`
  là **một** `drawSvgPath`. Chúng bằng nhau **chỉ khi** cả hai bo tròn: `lineCap: Round`
  bên flatten, `1 J` + `1 j` bên `/AP` — **một đầu bo tròn ở mỗi mối nối chính là một mối
  nối bo tròn**. Bỏ `1 j` thì mối gấp Shift mọc **gai mitre** dài tới 10 lần bề rộng nét;
  bỏ `lineCap` thì nét flatten có **khấc** giữa các đoạn.
- **`1 j` phải nằm TRONG `q/Q` của form**, chèn vào sau `ops[0]` (`pushGraphicsState`) chứ
  không đặt trước — trạng thái đồ hoạ rò ra ngoài form là lỗi không thấy được cho tới khi có
  operator thứ hai.
- **Nét thẳng tuyệt đối có một cạnh bằng 0** (`strokePath` trả `H = 0` cho nét ngang, đúng
  như vậy — không fudge). `/BBox` cạnh 0 **cắt sạch** đường vẽ; thứ cứu nó là phần đệm bề
  rộng nét của `shapeAppearance`. Ca `draw flat` trong `test:rotate` tồn tại đúng để giữ
  phần đệm đó.
- **`redact` sẽ KHÔNG BAO GIỜ vào `MANAGED_KINDS`.** Nó tồn tại để **phá huỷ** nội dung bên
  dưới; một ô che sửa lại được thì không còn là ô che.
- **Vỡ khi:** vẽ tay rồi Lưu → mở lại **không chọn được** (quên `MANAGED_KINDS`) · file
  phình vài MB vì một chữ ký (quên thưa hoá) · nét mờ dần sau vài vòng lưu (thưa hoá không
  lũy đẳng) · nét ngang **biến mất** sau khi lưu (`/BBox` cạnh 0) · nét bake ra **khác**
  nét round-trip ở mối nối (thiếu `1 j` hoặc `lineCap`).
---

### BI-70 · Xoay hộp văn bản nướng vào **RASTER**, không vào `/AP` — và tâm không được dịch

- `normRot` / `rotatedBox` ([annot-text.js](../desktop/renderer/annot-text.js)); nhánh xoay
  của `renderTextPng`, `ox`/`oy` ở `drawOneAnnot` + `addManagedAnnot`, transform của
  `renderAnnot` và `openTextEditor` ([editor.js](../desktop/renderer/editor.js)).
  Lưới: `test:text` (13 ca thuần), `test:managed` (round-trip + toán raster trên canvas giả).
- **Vì sao nướng vào raster.** Appearance của hộp văn bản **vốn đã** là PNG (glyph tiếng
  Việt, không nhúng font — xem đầu file editor.js), nên xoay glyph trên canvas **không tốn
  gì thêm** và annot vẫn là stamp **thẳng trục**. Nhờ vậy `apMatrixFor`/`apRectFor` giữ
  nguyên **một** nghĩa duy nhất — “trang bị xoay” — tức là toàn bộ lưới BI-59 / `test:rotate`
  không phải đụng tới. Đi đường `/Matrix` sẽ mua thêm độ nét mà hộp văn bản **không có**
  (nó là ảnh) và trả bằng việc mở lại đúng chỗ nguy hiểm nhất của codebase.
- **Bất biến duy nhất phải giữ: xoay KHÔNG được làm dịch TÂM raster.** Canvas phình ra để
  chứa glyph đã xoay, và `ox`/`oy` trả lại **đúng một nửa** phần phình đó, nên tâm rơi
  đúng chỗ tâm hộp thẳng đã ở. Chia không đều thì raster vẫn **đúng cỡ** mà chữ vẫn **sai
  chỗ** — đo được, nhìn không ra.
- **`ox`/`oy` KHÔNG cùng dấu.** Quay 1/4 thì hộp **phình theo một trục và co theo trục
  kia**, nên đừng khẳng định “luôn âm”. Thứ cố định là chia đều.
- **Ở 0° phải ra byte y hệt:** `rotatedBox(w, h, 0)` trả **đúng** `(w, h)` — không epsilon,
  không ceil — và `ox = oy = 0`, nên mọi call site cũ không đổi một chữ. Cùng lời hứa
  BI-59.
- **Dấu góc:** dương = **ngược chiều kim đồng hồ** trên màn hình, cùng quy ước watermark
  (`rotate(${-angle}deg)` trong CSS, `-angle` radian trên canvas). Hai thứ chữ xoay được
  của app mà cãi nhau về chiều “45” là một báo lỗi riêng.
- **Chuẩn hoá vào `(-180, 180]`:** ô nhập là số độ, người dùng gõ 350 nghĩa là “10 chiều
  kia”, và con số này **đi vào `/NabuData`** — lưu 350 và -10 thành hai giá trị khác nhau
  thì hai hộp trông y hệt lại so sánh không bằng nhau.
- **KHÔNG đo lại hộp khi xoay.** `a.w`/`a.h` vẫn là cỡ hộp **thẳng**; góc chồng lên trên.
  Đo lại thành hộp bao đã xoay thì lần xoay sau áp lên hộp **đã xoay rồi** ⇒ hộp phình
  không giới hạn.
- **Chọn và kéo không cần thêm phép tính nào:** hit-test ở đây là
  `e.target.closest(".an")`, nên trình duyệt tự thử hình **đã xoay**; còn kéo là phép tịnh
  tiến, bất biến với góc. Đây là lý do tính năng này rẻ, và nó chỉ đúng chừng nào hit-test
  còn dựa vào DOM — chuyển sang hit-test hình học thì **phải** xoay ngược con trỏ trước.
- **Transform của overlay là MỘT chuỗi.** `charScale` từng là writer duy nhất của
  `el.style.transform`; thuộc tính này **không cộng dồn**, nên gán hai lần là mất cái đầu.
  Và tâm được viết thẳng ra bằng `translate·rotate·translate` chứ **không** đổi
  `transform-origin` sang `50% 50%`: phần tử đã bị **nới rộng** `1/charScale`, nên 50% của
  nó không phải tâm người dùng nhìn thấy.
- **Vỡ khi:** xoay hộp rồi Lưu → mở lại **thẳng lại** (quên `rot` trong payload) · chữ
  xoay xong **trôi** khỏi chỗ cũ (chia `ox`/`oy` không đều) · xoay 45° rồi xoay tiếp thì hộp
  **to dần** (đo lại hộp) · gõ lại nội dung thì ô nhập **thẳng** trong khi chữ nghiêng ·
  hộp có `charScale` khác 1 thì xoay xong **lệch ngang**.
### BI-71 · Nền hộp văn bản: khung `<div>` và khung PNG **lệch nhau đúng `pad`** — đừng dùng `el.style.background`
- `editor.js` `renderAnnot` (nhánh `text`, khối `.an-text-bg`) ghi phía màn hình;
  `renderTextPng` ghi phía PDF. `app.css` `.an-text { z-index: 0 }` + `.an-text-bg`.
- **Số đo, đừng suy luận lại** (chạy trên chính `annot-text.js`, chữ 16pt):
  ```
  element box (màn hình) : left = a.x + 0.00   w = 93.00   tâm = a.x + 46.50
  raster  box (PNG bake) : left = a.x − 2.40   w = 93.33   tâm = a.x + 44.27
  ```
  Cùng **kích thước**, lệch đúng `pad = fontSize × 0.15`. Lý do: chữ trên màn hình vẽ từ
  **góc trên-trái** của `<div>` (`.an-text` không có padding), còn trong PNG chữ thụt vào
  `pad` cả 4 phía và bake bù bằng cách đặt ảnh ở `a.x − padPt`.
- **Vì thế nền là một `<div>` LÓT đặt ở `(−pad, −pad)` cỡ `a.w × a.h`**, không phải
  `el.style.background`. Đo lại toàn bộ trên Chromium thật: sai lệch **tệ nhất 0.333pt**
  (đúng bằng 1/RS — hạt của phép `ceil`), tức mắt thường không thấy.
- **Ba chi tiết không được bỏ:**
  · `z-index: -1` chỉ nằm yên trong hộp chữ vì `.an-text` có `z-index: 0` → nó **tự tạo
  stacking context**; bỏ dòng đó thì nền chui xuống dưới canvas trang và **biến mất**.
  · Dưới `charScale`, cả `left` lẫn `width` của lớp lót phải **chia trước** cho charScale
  (phần tử cha đang bị `scaleX`).
  · Trong raster, `globalAlpha = s.opacity` phải đặt **trước** `fillRect`, và độ mờ của
  nền đi trong chuỗi `rgba()` — hai cái **nhân nhau**, vì trên màn hình `el.style.opacity`
  làm mờ **cả** chữ lẫn nền.
- **`text` vào `FILLABLE_KINDS`, TUYỆT ĐỐI KHÔNG vào `isVectorKind`** — cái sau lái sang
  `shapeAppearance()` (appearance vector); nền hộp chữ nằm trong PNG.
- **Bố cục chữ không được biết đến cái nền.** `normTextStyle` dựng object từ danh sách
  trường cố định nên nó **rơi** `fill`/`fillOpacity` — đó là thứ bảo đảm một mảng nền
  không bao giờ đẩy được một glyph (BI-40). Có ca canh gác trong `test:text`.
- **Vỡ khi:** mép nền trên màn hình lệch ~3px so với file PDF · nền biến mất hẳn (mất
  `z-index: 0`) · nền đặc trong khi chữ mờ · hộp có `charScale` thì nền thừa/thiếu bề ngang
  · file cũ mở ra tự mọc nền đen (ghi `fill: "none"` vào `/NabuData` thay vì bỏ khoá).
- Lưới: `npm run test:managed` (rect nền trong raster + round-trip `/NabuData`) ·
  `npm run test:text` (nền không đụng layout) · `npm run test:defaults` (hộp mới **không**
  nền, và ba handler đi qua `fillSlotFor`).

### BI-72 · Kho trang ẩn: `/NabuVault` trên **PAGE DICT** — không bao giờ `/NabuKind`, không bao giờ catalog
- `renderer/page-vault.js`; UI ở `app.js` (`scanVaultPages`, `hidePagesWithPassword`,
  `unhidePagesWithPassword`, `exportWithoutHiddenPages`).
- **Đo được trên pdf-lib 1.17.1 — bảng này là lý do tồn tại của thiết kế:**

  | Nơi cất blob | save→load | **reorder trang** | xoá trang khác | ghép/chèn |
  |---|---|---|---|---|
  | catalog (`/Root`) | ✅ | ❌ **MẤT** | ✅ | ✅ |
  | page dict | ✅ | ✅ | ✅ | ✅ |

  Cột giữa là `reorderPages()` (`app.js`) — nó dựng lại tài liệu bằng
  `PDFDocument.create()` + `copyPages()` và **bỏ lại catalog cũ**. Tức là kéo-thả sắp xếp
  một cái là bay sạch trang ẩn, không một dòng lỗi nào.
- **Không được đặt tên khoá là `/NabuKind`:** `stripManagedFromPage` xoá **mọi** annotation
  mang khoá đó, và nó chạy ở **mỗi lần bấm Áp dụng**. Chú thích lên trang giữ chỗ là mất
  kho. Vì thế kho nằm trên **page dict** (không phải annotation) với **namespace riêng**.
- **1 trang ẩn = 1 trang giữ chỗ.** Số trang **không đổi** — đó là thứ giữ cho blob **đi
  theo trang của nó** qua reorder/ghép/tách/chuyển tab, và giữ cho “trang 7/12” vẫn là 7/12.
- **Vỡ khi:** kéo sắp xếp trang xong thì không bỏ ẩn được nữa · chú thích lên trang giữ chỗ
  rồi Áp dụng thì trang ẩn biến mất · badge 🔒 hiện sai thumbnail sau khi xoá/ghép trang.
- Lưới: `npm run test:vault` (V4 = reorder, V5 = removePage, V6 = merge, V7 =
  `stripManagedAnnots`).

### BI-73 · Đường đọc kho trang ẩn **phải chịu được `/Filter /FlateDecode`** — luật BI-37 không áp dụng ở đây
- `page-vault.js` `readVaultBytes`.
- **Đo được:** ta ghi stream **không filter**; sau **bất kỳ** vòng sidecar nào
  (`/add-page-numbers`, `/edit-text`, `/compress`, Tìm & Thay thế — tất cả đều
  `doc.tobytes(deflate=True)`) nó quay về là
  `<< /NabuFmt /vault /Length n /Filter /FlateDecode >>`.
- BI-37 dạy “có `/Filter` ⇒ không tin, bỏ qua”. Ở **ảnh** thì hậu quả là “ảnh thành chỉ
  đọc” — chấp nhận được. Ở **trang ẩn** thì hậu quả là **mất trang vĩnh viễn**. Nên ở đây
  phải **tự giải nén** bằng `DecompressionStream("deflate")` (đã đo là có trong renderer
  `file://` lẫn node). Filter **lạ** thì báo lỗi rõ và **không xoá gì**.
- **Luật chung rút ra:** “không đọc được ⇒ để nguyên”, không bao giờ “không đọc được ⇒ dọn đi”.
- **Vỡ khi:** ẩn trang → Đánh số trang → không bỏ ẩn được nữa.
- Lưới: `npm run test:vault` V8 (Flate) + V9 (filter lạ, phải giữ nguyên trang giữ chỗ).

### BI-74 · Ẩn trang phải **xoá lịch sử hoàn tác và ghi đè bản phục hồi** — nếu không, bản rõ vẫn nằm trên đĩa
- `app.js` `hidePagesWithPassword` → `resetHistory()` + `scrubRecoverySnapshot()`.
- `pushUndo()` giữ snapshot bytes **trước khi ẩn** trong RAM, và `autosaveTick` đã có thể
  **ghi nó xuống thư mục recovery**. Ẩn xong mà không dọn thì trang “đã ẩn” vẫn còn nguyên
  bản rõ ở hai chỗ — với một tính năng bán ra dưới chữ “mật khẩu” thì đó là lỗi, không phải
  chi tiết.
- **Đây là ngoại lệ có chủ ý của BI-3.** Mọi thay đổi `state.bytes` khác đều phải qua
  `pushUndo()` trước; đường này **cố ý không**, và bù lại bằng `markDirty` thủ công
  (`state.dirty = true` + `updateDirtyIndicator()`) để chấm ●, guard đóng và autosave vẫn
  biết file đã đổi. Hộp thoại **nói trước** rằng Ctrl+Z sẽ không hoàn tác được.
- **Bỏ ẩn thì ngược lại**: nó đưa bản rõ trở lại **có chủ đích**, nên `pushUndo()` chạy
  bình thường, đúng BI-3.
- **Ngoài tầm với, phải nói thật với người dùng:** file gốc trên đĩa (chưa lưu đè), Windows
  shadow copy, bản in.
- **Vỡ khi:** ẩn trang xong, mở file recovery trong `userData` vẫn thấy trang gốc · ẩn xong
  bấm Ctrl+Z ra lại trang gốc.
- Lưới: máy không kiểm được — probe renderer (`vault-drive.js` mẫu ở phiên v0.2.64) khẳng
  định `#btn-undo` bị vô hiệu và `recovery.save` đã chạy lại sau khi ẩn.

### BI-75 · Ô kiểu chữ **không được chốt** hộp gõ chữ — và vì thế `renderLayer` phải **cõng** hộp gõ qua lần dựng lại
- `editor.js`: `PALETTE_KEEP_SEL` / `inPalette` · `renderLayer` (khối `keep`) ·
  `openTextEditor` (`paint`, `ta.addEventListener("blur", …)`, `clearTaHooks`) ·
  `fillTargetAnnot` / `applyFillToSel` · listener uỷ quyền trên `#edit-bar, #fmt-panel`.
- **Vấn đề gốc (v0.2.64):** ba ô Nền là `<input>` thường. `mousedown` vào chúng làm
  textarea `blur` → `commit()` chạy → hộp được tạo bằng **nền CŨ**, giá trị vừa chọn chỉ
  ăn vào hộp **kế tiếp**. Kéo thanh `%` sau đó không thấy gì vì `applyFillToSel` thoát
  ngay khi `ed.sel == null`, mà đường tạo hộp văn bản **không** set `ed.sel`.
- **Đừng “khôi phục” mẹo `mousedown → preventDefault()`** của các nút B/I/U ở đây: trên
  `input type=range` nó **giết luôn cú kéo**, trên `input type=color` nó có thể **chặn hộp
  chọn màu mở ra**. Chỗ đúng là **handler `blur`**, lọc theo `e.relatedTarget`.
- **Hệ quả bắt buộc, và đây là phần dễ mất dữ liệu:** `renderLayer` làm
  `layer.innerHTML = ""`, còn hộp gõ chữ là **con của layer đó**. Xoá một phần tử đang
  focus **không phát `blur`** trong Chromium ⇒ `commit` không bao giờ chạy ⇒ **mất chữ
  đang gõ, không annot, không bước undo, không một dòng lỗi**. Trước v0.2.65 không ai
  chạm vào vì mọi đường ra khỏi textarea đều chốt trước. Nay focus có thể sang palette mà
  **không** chốt, nên bất kỳ `syncOverlays()` phát từ một ô kiểu chữ đều rơi vào đây giữa
  lúc gõ. `innerHTML = ""` chỉ **tháo rời**: node, `value`, vùng chọn và listener đều còn
  sống nhờ tham chiếu `keep` — nhưng **focus thì không**, nên phải `focus()` +
  `setSelectionRange()` lại, không thì con trỏ nhảy về `<body>` (hoặc về cuối chuỗi).
- **`#edit-bar [data-ctl]`, KHÔNG phải `#edit-bar`:** `#ed-tools` nằm **bên trong**
  `#edit-bar`, Copy / Dán / Áp dụng cũng vậy. Nới thành `#edit-bar` là mất chữ ở **mỗi
  lần đổi công cụ** và ở **mỗi lần bấm Áp dụng**.
- **Mục tiêu của ba ô Nền khi hộp gõ đang mở là `ed._taAnnot`, không bao giờ là `ed.sel`:**
  `setTool` không deselect, nên lựa chọn cũ sống qua lần đổi công cụ và **bản thân nó có
  thể cũng là một hộp văn bản** — không phép kiểm `kind` nào phân biệt được. Hộp gõ đang
  mở thì nó **sở hữu** ba ô đó; hộp mới chưa tồn tại thì mục tiêu là **không có gì**.
- **Vỡ khi:** gõ chữ → bỏ tick “Không nền” → hộp đóng lại và vẫn trong suốt · gõ chữ →
  đổi cỡ chữ → **chữ đang gõ biến mất** · gõ giữa từ → kéo thanh Mờ nền → phần gõ tiếp
  nhảy xuống cuối · đổi công cụ giữa lúc gõ → mất chữ.
- Lưới: `npm run test:defaults` nhóm “the Nền controls survive an open text editor”
  (16 ca, đều là canh-gác: ba ca then chốt đã được kiểm là **đỏ** khi hoàn nguyên bản sửa).

### BI-76 · Ba ô nền: **control là sự thật của vật thể ĐANG SỬA, `ed[slot]` là sự thật của vật thể SAU** — và 0% với ô tick là **một** trạng thái
- `editor.js`: `clampFillPct` · `FILL_ON_FROM_ZERO_PCT` · `setFillPctCtl` · `setFillOn` ·
  `fillFromCtls` · `applyFillToSel` · `onFillColorInput` / `onFillNoneToggle` /
  `onFillOpacityInput`; cộng nhánh `FILLABLE_KINDS` trong `syncControls` (chiều ngược:
  vật thể → control). Nối tiếp BI-75 (mục tiêu là ai) và BI-71 (hình học của lớp lót).
- **Hai nửa của sự thật, đừng trộn:**
  · `syncControls()` khi chọn một vật thể chỉ ghi **DOM** — cố ý: `ed[slot.*]` là **mặc
  định cho vật thể tiếp theo**, đúng cùng lằn ranh mà `#ed-color` giữ.
  · Vì thế `applyFillToSel()` phải đọc **`fillFromCtls()`** (ba control), **không** đọc
  `ed[slot]`/`effFill()`. Đọc `ed[slot]` là lỗi đã ship ở v0.2.64 **và còn nguyên ở
  v0.2.65**: chọn một chữ nhật nền **vàng 40%**, tick rồi bỏ tick ô nền → vật thể quay lại
  **TRẮNG 100%** trong khi ô màu vẫn hiện vàng và slider vẫn hiện 40%. Mất dữ liệu, và
  thanh công cụ nói dối về việc đó.
  · Ngược lại, `effFill()`/`effFillOpacity()` **vẫn phải sống** — chúng là đường **tạo
  mới** (4 chỗ: `text`, nhánh shape, `cloudpen`, và `taFillPreview` cho hộp chưa tồn tại).
  Xoá chúng “vì handler không dùng nữa” là làm mọi vật thể mới ra **không có nền**.
  · Đây cũng là luật `refreshFillSwatch` đã theo từ v0.2.65 (“đọc control, không đọc
  `ed.*`”) — nay ba handler theo cùng một luật, nên chip, con số và vật thể không thể
  nói ba chuyện khác nhau.
- **0% và ô “Không nền” là MỘT trạng thái, không phải hai.** Không có trạng thái thứ ba
  “có nền, alpha 0”: nó vô hình mà ô tick lại báo “đang có nền” — đúng cái làm ô tick
  trông như bản sao vô dụng của slider (khiếu nại thật của người dùng, 2026-08-29).
  · kéo slider về 0 ⇒ **tự tick** + `ed[slot.on] = false` + vật thể nhận `fill: "none"`;
  · bỏ tick khi slider đang ở 0 ⇒ nâng lên `FILL_ON_FROM_ZERO_PCT` (100%) — “bật nền” thì
  phải **thấy** nền;
  · `syncControls` cũng tick khi `pct === 0`. **Nhưng biến `none` phải giữ nghĩa hẹp**
  (“không có `fill` nào”), vì dòng ngay dưới nó — `$("ed-fill").value = none ? … : a.fill`
  của v0.2.65 (F3) — phụ thuộc vào nghĩa hẹp đó.
- **HAI số 0 khác nhau, phải dọn riêng.** Slider là thứ **vật thể đang sửa** sắp nhận;
  `ed[slot.opacity]` là thứ **vật thể sau** sắp nhận. Cửa hông: kéo về 0% (nhớ 0), chọn
  vật thể khác đang 70%, bỏ tick → slider không ở 0 nên không nâng, nhưng **số 0 đã nhớ**
  còn đó ⇒ chữ nhật vẽ tiếp theo ra vô hình mà ô tick lại trống. `setFillOn` nâng **từng
  số 0 một**, nên dọn cái đã nhớ không bao giờ âm thầm sơn lại vật thể trên màn hình.
- **Ô tick là nút MUTE, không phải slider thứ hai.** Đó là toàn bộ lý do nó tồn tại: tick
  là tắt hẳn, bỏ tick là bật lại **đúng màu và đúng độ mờ đang hiện** — thử có/không nền
  mà không mất giá trị đã chọn. Nhãn là **“Không nền”**, không phải “Trong suốt”: cái tên
  cũ đọc như một **mức** của **Mờ nền**, và đó chính là chỗ hiểu nhầm.
- **Ba handler phải là hàm CÓ TÊN.** Tới v0.2.65 chúng là thân arrow inline, nên
  `test:defaults` không gọi được và cả hai lỗi trên nằm ngoài mọi lưới. Bọc lại thành
  arrow inline là làm mù lưới lần nữa.
- **Handler không tự vẽ lại chip hay nền hộp gõ.** Listener uỷ quyền trên `#edit-bar`
  (BI-75) làm việc đó sau **bất kỳ** thao tác palette, và nó **nổi bọt SAU** handler của
  chính phần tử — nên nó thấy vật thể đã cập nhật. Thêm `refreshFillSwatch()` vào từng
  handler là đúng cái drift mà listener uỷ quyền sinh ra để tránh.
- **Vỡ khi:** tick rồi bỏ tick trên vật thể đang chọn → nền ra **màu khác** với màu ô
  swatch đang hiện · slider ở 0% mà ô “Không nền” vẫn trống · vẽ vật thể mới ra **vô hình**
  · chip caro và con số % nói khác nhau.
- Lưới: `npm run test:defaults` §4c (chạy **thật** ba handler trên DOM giả + mục tiêu giả,
  gồm ca canh gác quét **36 tổ hợp** trạng thái×hành động) và §4d (nhãn + tooltip khớp
  từ điển i18n). Đã kiểm bằng cách **hoàn nguyên cả ba nửa của bản sửa** → 11 ca đỏ, kể cả
  đúng con số `#ffffff` của vụ mất dữ liệu.

### BI-77 · Clipboard liên-tab: main chỉ được **ĐẨY** vào `clip`, **không bao giờ được hỏi** lúc dán — và clip nhận từ tab khác mang `page: -1`
- `main.js`: `objClip` · `annots:clip-write` / `annots:clip-read`; `preload.js`:
  `writeAnnotClip` / `readAnnotClip` / `onAnnotClipChanged`; `editor.js`: `SHARE_EXCLUDED` ·
  `isShareableKind` · `shareClip` · `adoptSharedClip` · `requestPaste`. Lưới `npm run test:clip`.
- **Quyết định phải ĐỒNG BỘ, việc thì được async.** `editor.js` giành cử chỉ `Ctrl+V`
  bằng `preventDefault()` **ngay trong** sự kiện `paste`, đọc `clip` ở module scope. Luật
  bàn giao với đường dán-ảnh của `capture.js` (“có ảnh trên clipboard OS thì bỏ qua, không
  `preventDefault`”) **dựa hoàn toàn** vào chỗ này chạy đồng bộ.
  · Đổi thành `await window.desktop.readAnnotClip()` là hỏng: câu trả lời về **sau** khi
  sự kiện đã bubble sang `capture.js` → `Ctrl+V` khi thì dán hai lần, khi thì không dán gì,
  **tuỳ thời điểm**. Không có exception nào ném ra.
  · Vì thế main **chỉ broadcast** (`annots:clip-changed`) và `adoptSharedClip` ghi thẳng
  vào chính biến `clip`. Nhờ vậy **mọi** chỗ đọc cũ — guard của listener `paste`, nút
  “Dán”, bản thân `pasteClip` — **không phải sửa một dòng nào**. Đó là lý do bản vá này
  không đụng vào logic dán sẵn có.
  · `readAnnotClip` **chỉ** được gọi một lần lúc renderer khởi động (cho tab mở **sau**
  khi copy, vốn không nhận được broadcast). Gọi nó trong `pasteClip`/`requestPaste` là tái
  phạm — lưới §3 của `test:clip` canh đúng chuyện đó, kể cả `paste` listener bị đổi thành
  `async`.
  · `requestPaste` là chỗ **duy nhất** được `await`, và chỉ để **làm việc** (bật Chỉnh sửa),
  không bao giờ để **quyết định** — lúc nó chạy thì `preventDefault()` đã gọi xong. Sau
  `await enter()` phải **kiểm lại** `ed.active` + `clip`: người dùng có thể đã bấm Escape,
  hoặc tab khác đã xoá clip, trong lúc `importManaged()` còn đang chạy.
- **`page: -1` là số học, không phải giá trị canh gác cho vui.** `pasteClip` lệch
  `PASTE_STEP` khi dán **đúng trang nguồn** (`i === clip.page`) để bản sao không nấp hoàn
  toàn dưới bản gốc. Clip đến từ **tài liệu khác** không có bản gốc nào trên trang này, nên
  giữ `srcPage` sẽ khiến trang 0 của file B bị nhầm là trang nguồn của file A → **mọi** lần
  dán liên-tài-liệu lệch 12pt khỏi chỗ người dùng đã copy. `-1` không bao giờ là chỉ số
  trang, nên nhánh đó chết hẳn và bản dán rơi đúng toạ độ gốc.
- **Ảnh cố ý không qua IPC** (`SHARE_EXCLUDED`). Ảnh mở lại là chuỗi base64 **nhiều MB**
  (xem `edSnapshot`); đẩy nó qua IPC mỗi lần `Ctrl+C` đúng là cái giá mà ghi chú
  “clipboard riêng từng tab” đã từ chối trả. Ảnh vẫn copy **trong cùng tab** y như cũ.
  Một lần copy **không có** mục nào chia sẻ được thì **XOÁ** clip chung, không để clip cũ
  đứng lại — nếu không, tab khác sẽ lặng lẽ dán thứ người dùng đã copy từ hai thao tác trước.
- **Toạ độ vốn đã liên-tài-liệu**, đó là lý do việc này rẻ: annot nằm trong không gian
  **điểm PDF scale-1** (`editor.js` §đầu file, đo lại ở `layer.dataset.w = cw / state.scale`),
  nên trang đích chỉ tham gia qua khổ giấy `pw/ph` — và `fitShift(unionBounds(...))` đã kẹp
  biên đúng từ v0.2.52. “Dán sang tài liệu khác” **bằng đúng** “dán sang trang khác”.
- Đã kiểm bằng **mutation test**: đổi `page: -1` → `srcPage` ⇒ 2 ca đỏ; đổi guard của
  `paste` thành `await readAnnotClip()` ⇒ 2 ca đỏ. Ca định vị listener cũng khẳng định thân
  hàm **khác rỗng**, vì bản đầu tiên của lưới này *pass giả* khi regex trượt CRLF.

---

## 4. Hàm nút thắt (đổi chữ ký = ảnh hưởng diện rộng)

| Hàm | Định nghĩa | Ai gọi |
|---|---|---|
| `toast()` | `app.js:58` | cả 6 module, ~172 chỗ |
| `sidecarFetch()` | `app.js:49` | 4 module (~28 chỗ) — điểm duy nhất gắn token `X-Sidecar-Token` |
| `pushUndo()` | `app.js:148` | 3 module, 10 chỗ — xem BI-3. Phơi ra ngoài bằng **`window.DocHistory`**, **không** phải `window.History` (tên đó là constructor của DOM → guard `if (window.History)` không bao giờ sai được) |
| `pdfJsonBody()` | **`wire.js`** | 3 module, 16 chỗ, **gọi bằng tên trần** — xem BI-24 + §2 |
| `renderAll()` | `app.js:486` | 13 chỗ |
| `rerenderChanged()` | `app.js:1138` | **chỉ** module khác gọi — xem BI-14 |
| `updateToolbar()` | `app.js:3084` | 3 module, 11 chỗ — chứa BI-2 và BI-9 |
| `showOverlay/hideOverlay` | `app.js:66/70` | 4 module — xem BI-14 |
| `binArrayJsonBody()` | **`wire.js`** | 1 chỗ — Ảnh→PDF. Cùng luật BI-24, dạng **mảng** binary trong một trường |
| `b64ToU8` | **`wire.js`** | 13 chỗ — chiều **giải mã** cho mọi vòng gọi sidecar. Chiều **mã hoá** cố ý **không còn helper** — xem BI-24 |
| `pushB64Chunks` | **`wire.js`** | 3 chỗ trong `wire.js` + **`editor.js` `managedSrcDataUrl`** (dựng `data:` URL cho MỘT ảnh round-trip). Là bộ mã hoá byte→base64 **duy nhất** được phép dùng; đừng gói lại thành helper tổng quát — BI-24 |
| `stripManagedFromPage(doc, page, trash)` | `editor.js` | 2 chỗ (`stripManagedAnnots`, `bakeWithRedaction`). Tham số `trash` **không phải tuỳ chọn cho vui**: bỏ nó là giải phóng ngay giữa vòng lặp — xem BI-38 |
| `planOpen()` | `tabs.js` | 1 chỗ (`tabs:open-paths`) — quyết định tab hay cửa sổ. Thuần + có lưới, xem BI-35 |

---

## 5. Ma trận “đụng gì → phải test gì”

| Nếu bạn sửa… | Bắt buộc test lại |
|---|---|
| `pushUndo` / `snapshot` / history | Ctrl+Z–Ctrl+Y sau: xoay, xoá trang, ghép, chèn, bake chú thích, sửa nội dung · chấm ● xuất hiện · đóng file bẩn có hỏi |
| `state.bytes` ở bất kỳ đâu | Lưu ra file mở lại được · in · undo · autosave (BI-3) |
| Virtualization / `renderPageCanvas` / `freePageCanvas` | Cuộn nhanh lên-xuống PDF nhiều trang · in · so sánh · copy vùng ảnh (BI-4) · **`m.paintScale` còn được gán sau khi vẽ** (BI-36) |
| Zoom (`zoomTo`, `applyScaleToDom`, `commitScale`, `wheelZoomFactor`, `renderViewer`) | `cd desktop ; npm run test:geom` · Ctrl+lăn **nhanh liên tục** → trang bám tay, dừng lại ~0.2s là **nét**, không nấc nào bị bỏ · Ctrl+lăn trên A0 nhiều trang → không treo · zoom rồi bôi đen chữ → **vệt chọn đúng chỗ** · Ctrl+F có kết quả rồi zoom → highlight đúng chỗ · zoom **khi đang Chú thích** → hình vẽ/hộp chữ theo đúng tỷ lệ, ô nhập chữ đang mở **không mất** · zoom khi đang “Sửa chữ” → ô span đúng chỗ · Vừa bề ngang / Vừa cả trang / Ctrl+0 · F11 vào/ra (BI-36, BI-22) |
| Cột trang theo trang đang đọc (`syncThumbFocus`, `nearestScrollDelta`, `.thumb.current`) | `npm run test:geom` · cuộn tài liệu → thumbnail sáng đúng trang & tự trượt vào khung nhìn · **tick chọn vài trang rồi cuộn đi đâu đó → Xoá trang vẫn xoá đúng các trang đã tick** (BI-39, BI-26) · đang kéo sắp xếp trang thì cột **không nhảy** (BI-33) · thu sidebar (F4) rồi cuộn → không lỗi console · F11 → dải trang vẫn sáng đúng trang |
| Ảnh round-trip (`addManagedAnnot` nhánh image, `managedSrcBytes`, `collectManagedChain`, `freeManagedTrash`, `MANAGED_KINDS`) | `cd desktop ; npm run test:managed` · chèn 1 ảnh → Áp dụng → Lưu → **mở lại** → Chỉnh sửa → ảnh **kéo/đổi cỡ/xoá được**, “Áp nhiều trang” vẫn dùng được · lưu 3–4 lần liên tiếp → **cỡ file không phình** · áp 1 chữ ký cho 20 trang → file ~1 lần cỡ ảnh, không 20 · ảnh trên trang **đã xoay** → **cũng sửa lại được** kể từ v0.2.58, xem hàng dưới (BI-59) · xoá ảnh round-trip rồi **thêm ô redact trên chính trang đó** → Áp dụng: ảnh **không** quay lại thành pixel, và ảnh còn lại **không nhân đôi** (BI-37, BI-38) |
| Chữ nhật / elip / **khoanh mây** round-trip (`shapeAppearance`, `VECTOR_KINDS`, nhánh vector của `addManagedAnnot` · `serializeManaged` · `deserializeManaged`, `MANAGED_KINDS`) | `cd desktop ; npm run test:managed ; npm run test:rotate ; npm run test:defaults` · vẽ 1 chữ nhật **viền không nền** + 1 elip **có nền mờ** + 1 **khoanh mây hộp** + 1 **khoanh mây vẽ tay** → Áp dụng → Lưu → **mở lại** → Chú thích → cả hai **chọn/kéo/đổi cỡ/đổi màu/đổi nét/xoá được**, elip vẫn **mờ đúng độ mờ đã lưu** · zoom 400% → viền **nét, không rỗ** (vector, không phải PNG) · so **viền có bị gọt** không ở cả 4 cạnh với nét dày 8pt · lặp trên trang **đã xoay 90/180/270** → không méo, không lệch · Lưu 3–4 lần liên tiếp → **cỡ file không phình** · mở file đã bake bằng **Foxit + Acrobat + Chrome** → thấy đúng chỗ, đúng màu (BI-64) |
| Nền hộp văn bản (`FILLABLE_KINDS`, `fillSlotFor`/`FILL_SLOTS`, `ed.textFill*`, khối `.an-text-bg` trong `renderAnnot`, `fillRect` trong `renderTextPng`, `.an-text { z-index: 0 }`) | `cd desktop ; npm run test:text ; npm run test:managed ; npm run test:defaults` · hộp chữ **nền vàng 100%** trên nền trắng → Áp dụng → Lưu → mở file bằng viewer khác: **mép nền trùng** đúng chỗ trên màn hình · nền **30%** → xuyên thấy nội dung trang, PDF **giống hệt** màn hình · nền + **Mờ chữ 50%** → cả chữ **và** nền cùng mờ ở cả hai nơi · nền + **xoay 45°** → nền quay theo, **không trôi** khỏi chữ · nền + `charScale 60%` → nền ôm đúng bề ngang · Áp dụng → Chỉnh sửa lại → sửa chữ → **nền còn** · Áp dụng → **Đánh số trang** (qua sidecar) → mở lại → nền còn · trang `/Rotate 90` → nền **không méo** · file **cũ** (trước v0.2.64) → hộp chữ vẫn trong suốt, **không tự mọc nền** · chọn hình chữ nhật rồi chọn hộp chữ → ô **Nền** hiện đúng giá trị **của từng loại** (slot riêng) · in (Ctrl+P) → nền in ra (BI-71) · **lượt đầu, đây là ca vỡ của v0.2.64 (BI-75)**: chọn công cụ Hộp văn bản → bấm lên trang → **gõ chữ trước** → rồi mới bỏ tick **Trong suốt** và kéo **Mờ nền** → khung gõ **đổi nền ngay trước mắt**, hộp **không** bị đóng, bấm ra ngoài thì hộp ra **đúng** màu và **đúng** % vừa kéo · đang gõ mà **đổi cỡ chữ / phông / B-I-U / canh lề** → khung gõ đổi theo, **chữ đang gõ còn nguyên** · gõ **giữa từ** rồi kéo Mờ nền → thả chuột là **con trỏ về đúng chỗ đang gõ**, không nhảy xuống cuối · đang gõ mà **đổi công cụ** hoặc bấm **Áp dụng** → hộp **được chốt** như cũ (không được im lặng mất chữ) · mở lại hộp cũ bằng công cụ Hộp văn bản (gõ sửa chữ) → kéo Mờ nền → **chính hộp đó** đổi nền, không phải hộp khác · chọn một hình chữ nhật, đổi sang công cụ Hộp văn bản, kéo Mờ nền → **hình chữ nhật không đổi gì** và **không sinh bước undo rỗng** · chọn hộp chữ **không có nền** → ô màu hiện đúng màu mà bỏ tick sẽ nhận (không phải màu của hình vừa chọn trước đó) · **ô xem trước** cạnh thanh Mờ nền: trắng 30% và trắng 100% **trông khác nhau rõ**, Không nền thì thấy ô caro |
| Ba ô nền (`onFillColorInput`/`onFillNoneToggle`/`onFillOpacityInput`, `setFillOn`, `fillFromCtls`, `clampFillPct`, nhánh `FILLABLE_KINDS` của `syncControls`) | `cd desktop ; npm run test:defaults` · chọn 1 chữ nhật nền **vàng 40%** → tick **Không nền** → bỏ tick → phải ra **lại vàng 40%**, không phải trắng 100% · kéo **Mờ nền** về **0%** → ô **Không nền** phải **tự tick**, chip thành ô caro · bỏ tick khi slider ở 0% → slider nhảy lên **100%** và thấy nền · kéo về 0%, chọn vật thể khác đang 70%, tick rồi bỏ tick, rồi **vẽ hình mới** → hình mới phải **thấy được** · để 1 chữ nhật đang chọn rồi đổi sang công cụ **Hộp văn bản**, kéo Mờ nền → chữ nhật **không đổi** và **không** ăn bước hoàn tác (BI-75) · gõ chữ trong hộp mới, kéo Mờ nền → khung gõ đổi màu, **không mất chữ** · đổi tool Hộp văn bản ↔ Chữ nhật → ba ô hiện đúng bộ **của từng loại** · đổi VI↔EN → nhãn **Không nền** dịch đúng (BI-76) |
| Trang ẩn có khoá (`renderer/page-vault.js`, `scanVaultPages`, `hidePagesWithPassword`, `unhidePagesWithPassword`, `exportWithoutHiddenPages`, `#vault-modal`) | `cd desktop ; npm run test:vault` · **ba ca không được phép đỏ**: ẩn → **kéo thả sắp xếp trang** → bỏ ẩn được (BI-72) · ẩn → **chú thích lên trang giữ chỗ → Áp dụng** → bỏ ẩn được (BI-72) · ẩn xong mở thư mục recovery trong `userData` → **không còn bản rõ** (BI-74) · ẩn → Lưu → đóng app → mở lại → bỏ ẩn được · ẩn → **Đánh số trang** → bỏ ẩn được (BI-73) · ẩn → **Nén file** → bỏ ẩn được · ẩn → khoá cả file bằng mật khẩu (`/encrypt`) → mở khoá → bỏ ẩn được · ẩn → **In** → in ra trang giữ chỗ, không phải nội dung gốc · mở file có trang ẩn bằng **Acrobat/Chrome** → thấy trang giữ chỗ, **không đọc được** nội dung, file không lỗi · tách/trích trang giữ chỗ ra file mới → bỏ ẩn được ở file mới · chuyển trang giữ chỗ **sang tab khác** → blob đi theo · sai mật khẩu → hỏi lại, **tài liệu không đổi** · badge 🔒 và dòng “N trang đang ẩn” đúng sau mỗi lần xoá/ghép/sắp xếp trang |
| Tay nắm đổi cỡ (`resizeRect`, `RESIZABLE_KINDS`, `.handle.h-*`) | `npm run test:geom` · kéo **cả 4 góc** của ảnh/tô sáng/redact/chữ nhật/elip → góc đối diện **đứng yên** · **giữ Shift** → không méo · Esc giữa lúc kéo → về đúng vị trí+cỡ cũ · Ctrl+Z sau khi đổi cỡ · bấm vào tay nắm rồi **không kéo** → không tạo bước undo rỗng |
| `editor.js` bake | Chú thích → Xong → sửa lại được · số trang không đổi · comment panel còn đúng (BI-5) |
| Cổng bake (`exit()`, `bakePending()`, `hasUnsaved`, `ed._importedManaged`) hay `openTextEditor` | `cd desktop ; npm run test:managed` · **đường xoá, làm trên tài liệu chỉ có ĐÚNG MỘT chú thích** (đó là ca vỡ): tạo hộp văn bản → Xong → Lưu → vào Chú thích → `Delete` → Xong → hộp **mất thật**, mở lại file vẫn mất · lặp lại nhưng thay `Delete` bằng **xoá trắng nội dung rồi bấm ra ngoài** → hộp mất, chữ cũ **không** hiện lại · lặp lại nhưng bấm **Ctrl+S** thay vì Xong → cũng mất · xoá hết rồi **đóng app** → **có** hỏi lưu · xoá 1 trong 2 hộp → hộp còn lại **nguyên vẹn**, không nhân đôi (BI-60) |
| Đặt `/AP` trên trang xoay (`apMatrixFor`, `apRectFor`, `apRotatable`, `normAngle`, ba nhánh `/AP` của `addManagedAnnot`) | `cd desktop ; npm run test:rotate ; npm run test:managed` · `docs/SPEC-annot-rotated.md` §7 lưới tay: với **cả 4 góc** `/Rotate` × {hộp chữ, mũi tên, ảnh, ghi chú} → bake → **Xong** → mở lại Chú thích → **sửa/kéo/xoá được**, không méo, không lệch 90° · re-bake 3 lần → **không** thành hai con dấu, file không phình · mở file đã bake bằng **Foxit + Acrobat + Chrome** → thấy đúng chỗ · và **hồi quy quan trọng nhất**: một tài liệu 0° bake rồi lưu phải ra **byte y hệt** bản trước (BI-59) |
| Ảnh → PDF (`runImagesToPdf`) và **giá trị trả về của `loadBytes`** | Ảnh→PDF → kết quả **mở ra trong app** (không bắt Lưu trước), có chấm ● · sắp xếp lại trang / xoay / chú thích được · Ctrl+S → hiện hộp thoại **Lưu thành** · đang có tài liệu **bẩn** rồi chạy Ảnh→PDF → chọn **"Ở lại"** thì **vẫn được hỏi nơi lưu** file vừa tạo (không mất công convert) · đóng app khi chưa lưu → **có** cảnh báo |
| Hướng trang trong bake (`vp1` trong vòng lặp của `bakeInPlace`/`bakeWithRedaction`, `makeMap`, `pageRotate`) | `cd desktop ; npm run test:rotate` §7 · **ca vỡ là tài liệu TRỘN HƯỚNG**: ghép 1 file có trang **A4 dọc** + trang **A3 ngang** (`/MediaBox` rộng, `/Rotate 0`) + trang **dọc đã Xoay 90°** → khoanh mây / chữ nhật trên **từng** trang → Áp dụng → mọi hình **đứng yên đúng chỗ**, **không trang nào tự quay**, khổ giấy không đổi · lặp lại kèm **che thông tin** trên trang ngang (đường raster dựng trang mới) → tờ ngang **vẫn nằm ngang** · in thử: số tờ không tăng (BI-65, BI-45) |
| Tầng tab/cửa sổ (`main.js`, `tabs.js`) | Toàn bộ `docs/TABS-TEST-L1.md` (24 mục) |
| Tách tab / kéo tab (`detachTab`, `adoptTab`, `classifyDrop`, `shell.js` dragend) | `docs/TABS-2B-DESIGN.md` §6.2 (18 mục) · BI-15/16/17 · **mục #1 là hồi quy của tính năng sắp xếp tab** |
| Chuyển trang giữa 2 tài liệu (`renderer/page-move.js`, `classifyPageDrop`, `docViewScreenRect`, `routePages`, `pages:*`) | `cd desktop ; npm run test:pagedrop` · `docs/SPEC-page-drag.md` §7.1 (22 mục) · BI-55/56/57/58 · **mục #1 và #2 là hồi quy của kéo-sắp-xếp trang và kéo file PDF vào cột trang** — hai thứ đã chạy tốt từ v0.2.41 mà tính năng này gắn thêm việc lên đúng cùng một cử chỉ |
| Clipboard vật thể **liên-tab/liên-tài-liệu** (`objClip` + `annots:clip-*` ở `main.js`, `writeAnnotClip`/`readAnnotClip`/`onAnnotClipChanged` ở `preload.js`, `SHARE_EXCLUDED`/`isShareableKind`/`shareClip`/`adoptSharedClip`/`requestPaste` ở `editor.js`) | `cd desktop ; npm run test:clip ; npm run test:managed ; npm run test:text` · **ca vỡ nguy hiểm nhất là hồi quy của dán-ảnh**: để một **ảnh** trên clipboard hệ điều hành (copy từ app khác) rồi `Ctrl+V` ở tab đang có clip vật thể → phải dán **ảnh**, **không** dán vật thể (luật bàn giao với `capture.js` — BI-77) · copy 1 hộp văn bản ở tab A → `Ctrl+V` ở tab B → **đúng vị trí, đúng cỡ chữ, đúng màu, đúng nền** · copy ở A → **Áp dụng** ở A → dán ở B (clip sống sót bake) · copy ở A → **xé tab B ra cửa sổ riêng** → dán được · copy ở A → **mở tab C mới** → dán được (đường `readAnnotClip` lúc khởi động) · dán vào tab **chưa bật Chỉnh sửa** → tự bật rồi dán, có toast · chọn nhóm Ctrl+click 3 mục → dán sang B **giữ nguyên cự ly tương đối** · dán sang trang **nhỏ hơn** ở B → cả nhóm lùi vào trong tờ, **không rời ra** · dán **hai lần liên tiếp** ở B → bản thứ hai lệch 12pt (không nấp lên nhau), bản **thứ nhất không lệch** · dán sang trang **đã xoay 90/180/270** ở B → Áp dụng → Lưu → mở lại: đúng chiều, đúng chỗ · copy **ảnh** ở A → nút “Dán” ở B **tối đi** (ảnh không qua tab) và toast nói rõ · copy nhóm **ảnh + hộp chữ** ở A → B chỉ nhận hộp chữ, toast báo số mục ở lại · đóng hết tab trừ một → clip cũ **không** làm app lỗi |
| Khôi phục phiên (`src/session.js`, `snapshotSession`, `_closing`, `tab:reserved`) | `docs/SESSION-RESTORE.md` §5.3 (14 mục) · BI-18/19/20 · **mục #12 là hồi quy của khôi phục sự cố** |
| Guard đóng | BI-6: nút X vs menu Thoát vs Ctrl+Q — cả 3 đường |
| Recovery/autosave | BI-7: mở 2 tab, chỉ tab đầu được hỏi khôi phục |
| `uiConfirm` (nhất là `thirdText`) hay lời mời khôi phục (`checkRecovery`) | `cd desktop ; npm run test:confirm` · chọn **Để sau** → lần mở sau **vẫn hỏi** (đúng) · chọn **Xoá, không hỏi lại** → lần mở sau **im hẳn** · nhãn nút phải ghi đúng **số bản** sẽ xoá · ngay sau đó mở một hộp thoại yes/no khác (vd đóng file bẩn) → **không** được thấy nút thứ ba sót lại · `Esc` / bấm nền / ✕ trên hộp có 3 nút → vẫn là **Hủy**, không phải nút xoá |
| Thêm nút tính năng mới | BI-9: khoá bản quyền có ăn không · BI-10: đổi VI/EN không mất chữ · **và ghi cử chỉ / phím tắt của nó vào `SECTIONS` của `help.js`** — thanh công cụ không còn chỗ để chữ hướng dẫn (BI-41) |
| Trang Hướng dẫn (`renderer/help.js`, `#help-modal`, khối `.help-*` trong `app.css`) | `cd desktop ; npm run test:help` · mở bằng **cả 3** đường: menu **Trợ giúp**, **F1**, nút **?** · bấm từng mục lục · ô tìm gõ **không dấu** ("mui ten") vẫn ra đúng phần · đóng bằng **Đóng / Esc / bấm nền** · đổi **VI↔EN** (cả nhãn menu native) · đổi theme **Sáng** · mở **trong lúc đang Chú thích** có 1 mục đang chọn rồi bấm `Delete` → mục **không** bị xoá (BI-47) |
| `#ed-hint` / `setEdStatus` / `#te-hint` | BI-41: **không** đặt câu hướng dẫn vào đây · thu cửa sổ về 1024px ở công cụ *Khoanh mây* → thanh **không** phình, nút **Xong** còn bấm được · vẽ mây từng điểm → có dòng nhắc cách đóng; đổi công cụ → ô **trắng** · công cụ Đo → thấy `Tỷ lệ: chưa/đã hiệu chuẩn` đúng trạng thái |
| Menu chuột phải trên thumbnail (`openThumbMenu`) | BI-26 · chuột phải **ngoài** vùng đang chọn → chỉ chọn trang đó · chuột phải **trong** vùng đang chọn → giữ nguyên nhiều trang · đang Chú thích/Sửa nội dung → **không** ra menu · chọn hết trang → mục Xoá phải mờ |
| `page-range.js` hay hộp thoại xoá theo khoảng | `cd desktop ; npm run test:pages` · gõ “từ 5 đến 12, trừ 7” trên tài liệu thật → trang 7 **còn nguyên** · Ctrl+Z quay lại đủ trang (BI-27, BI-3) |
| Hộp thoại “Áp ảnh / chữ ký cho nhiều trang” (`imgPagesSpec`, `syncImgPages`) | `npm run test:pages` · chèn 1 ảnh rồi Áp nhiều trang: gõ `1-3` → dòng gợi ý ghi đúng “Sẽ áp sang N trang: …” và nút Áp dụng **mở** · dán `1–3` (gạch en, copy từ Word) → **vẫn nhận** · gõ `abc` → “Chưa nhận ra trang nào”, nút Áp dụng **khoá** · gõ đúng số trang ảnh đang nằm → “Chỉ có đúng trang ảnh đang nằm”, nút **khoá** · gõ số lớn hơn số trang → gợi ý cho thấy nó **kẹp về trang cuối** trước khi bấm · Ctrl+Z hoàn tác được (BI-27, BI-10) |
| Tên file gợi ý khi Tách trang (`extractFileName`) | `npm run test:pages` · mở PDF ≥200 trang → Chọn tất cả bỏ 1 trang → Tách → tên trong hộp thoại Lưu **ngắn, đọc được**, lưu thành công (BI-27) |
| Khối `@media print` của `app.css`, `.print-sheet`, `buildPrintPages`, `printScaleFor` | `cd desktop ; npm run test:print` · **đếm TỜ, không tin mắt**: in ra "Microsoft Print to PDF" tài liệu 4 trang với Khổ giấy **A4, rồi A3, rồi Letter** → mỗi lần đúng **4 tờ**, tờ nào cũng thấy đủ 4 mép trang · lặp lại với **tick "Mở hộp thoại máy in của hệ thống"** → vẫn 4 tờ · gõ `1-2` ở hộp thoại hệ thống → ra **trang 1 và trang 2**, không phải trang 1 hai lần · PDF **A0** nhiều trang → không treo, không hết bộ nhớ (BI-43) |
| Hộp thoại In — ô "Trang cần in" (`printPageIndices`, `syncPrintPages`, `#print-pages`) | `npm run test:print` · để trống → gợi ý "Sẽ in tất cả N trang", nút In **mở**, in đủ cả tài liệu · gõ `1-2` → chỉ 2 tờ · dán `1–2` (gạch en) → **vẫn nhận** · gõ `abc` → nút In **khoá** · gõ `99` trên tài liệu 4 trang → gợi ý cho thấy nó **kẹp về trang 4** trước khi bấm · in xong mở lại hộp thoại → ô **trống lại** · đổi VI↔EN lúc đang gõ → dòng gợi ý **không** bị ghi đè (BI-44, BI-27, BI-10) |
| Badge trạng thái (`renderSidecarBadge`, `setApiBadge`, `/config`) | Mở app lúc engine chưa lên → OCR chấm rỗng, API “…” · engine lên & chưa có key → API chấm rỗng vàng · nhập key → chuyển xanh **ngay**, không cần khởi động lại · bấm badge API → mở Cài đặt đúng ô nhập · đổi VI↔EN → cả hai badge đổi theo (BI-29) |
| Bất kỳ điều kiện nào đọc `Editor.active` / `TextEdit.active` | Vào Chú thích rồi bấm ↑/↓/PageUp/PageDown/Delete → **không** có lỗi trong console, trang không bị xoá · thoát Chú thích → Delete xoá lại được (BI-28) |
| Menu ngữ cảnh dùng chung (`showPageMenu` trong `capture.js`) | Chuột phải lên **trang PDF** (Sao chép ảnh/vùng/Dán) vẫn đúng · mở menu này rồi mở menu kia → menu cũ đóng · cuộn dải thumbnail → menu đóng |
| Chiều vẽ lại chữ (`_text_frame`, `theta`/`u_dir`/`n_dir`, `morph`, trường `dir` của `/text-spans`·`/text-find`·`TextEdit`, `ed.dir` ở `text-edit.js`, `dir` ở `editForSpan`) | BI-66 · `.venv\Scripts\python test_edit_text_rotate.py` · rồi **test tay trên bản vẽ `/Rotate 90` thật** (bộ hồ sơ thầu/CAD): **Sửa nội dung** một dòng đọc xuôi → chữ mới **đọc xuôi**, thẳng hàng với dòng bên cạnh · sửa một **nhãn kích thước dựng dọc** → vẫn **dựng dọc**, cùng chiều với nhãn kế bên · **Ctrl+H → Thay tất cả** → mọi chữ thay thế đúng chiều của chỗ nó thay · sửa một đoạn **rất ngắn** (2–3 ký tự) trên trang xoay → **không** bị nén lại · bật **gạch chân** → gạch nằm **dưới** chữ, cùng chiều · lặp lại trên trang **không** xoay để chắc không có gì dịch đi (BI-66, BI-25, BI-45) |
| Cỡ/hình học chữ vẽ lại (`hscale`, `vscale`, `orig_text`, `orig_size`) | `test_edit_text_metrics.py` · sửa 1 dòng trên hoá đơn thật → **không** dài ra đè chữ bên cạnh, **không** cao hơn dòng chưa sửa (BI-25) |
| Redaction / `add_redact_annot` / `apply_redactions` | `test_edit_text_layout.py` **và** `test_translate_layout.py` · sửa 1 chữ trong ô bảng **có nền** → không vệt trắng, không mất đường kẻ (BI-23) |
| `wire.js` (`pdfJsonBody` / `binArrayJsonBody` / `pushB64Chunks` / `b64ToU8` / `B64_CHUNK`) hay bất kỳ chỗ gọi sidecar nào có PDF | `cd desktop ; npm run test:wire` (51 ca) · mở file **lớn** (≥100MB) rồi: Sửa nội dung · Nén · So sánh 2 file · Tách — không tab nào chết vì hết bộ nhớ · **Ảnh → PDF với ~50 ảnh máy ảnh**: tạo được file, PDF mở lại đúng số trang và đúng thứ tự (BI-24) |
| Thứ tự `<script>` trong `index.html` | `find-replace.js` **sau** `app.js` (dùng tên trần `state`/`sidecarFetch`/`pdfJsonBody`/`rerenderChanged` và gắn nút lúc nạp); `wire.js` **trước** `app.js`/`text-edit.js`/`compare.js`/`editor.js`/`sign.js`; `annot-text.js` + `annot-geom.js` + `managed-codec.js` **trước** `editor.js` (và `managed-codec.js` sau `vendor/pdf-lib.min.js` + `wire.js` + `annot-text.js`); `pan.js` sau `app.js` và trước `editor.js`/`capture.js`. Mở app → console **không** có `ReferenceError` · thử một lệnh gọi sidecar bất kỳ (Nén) (§2, BI-14, BI-40) |
| `annot-text.js` / `annot-geom.js` | `npm run test:text` + `test:cloud` + `test:geom` · rồi **test tay**: gõ chữ Việt vào hộp → Xong → mở lại file, chữ **không** tràn khung · khoanh mây (hộp + freehand) → Lưu → mây đúng chỗ · mũi tên có nhãn ở cả hai đầu (BI-40) |
| Bất kỳ lệnh vẽ nào trong `drawOneAnnot` / `drawWatermark` (thêm kind, đổi anchor, đổi primitive) | `cd desktop ; npm run test:rotate` **và thêm kind mới vào `KINDS` của lưới đó** · rồi test tay trên **trang đã xoay**: mở PDF scan nằm ngang (hoặc Xoay phải 90° một trang bất kỳ) → khoanh mây · khoanh vùng · mũi tên · dấu ✓ · hộp chữ → **Áp dụng** → mở lại file: mọi thứ **đúng chỗ, đúng chiều** như lúc vẽ · lặp lại trên trang **không** xoay để chắc không có gì dịch đi (BI-45, BI-40) |
| Sắp xếp trang bằng kéo–thả trong cột trang (`thumbGapAt`, `showThumbGapCue`, `gapToReorderIndex`, `gapIsNoOp`, `.thumb.insert-*`) | `npm run test:geom` · kéo trang 1 xuống **giữa trang 3 và 4** → thấy **hai vạch** ở đúng khe đó, thả ra thì trang nằm đúng giữa 3 và 4 · kéo rồi thả **đúng chỗ cũ** → con trỏ báo “không cho phép”, tài liệu **không** bẩn (không có ●) · kéo–thả **1 PDF từ ngoài** vào giữa dải → vẫn chèn đúng khe (BI-33) · Ctrl+Z sau khi sắp xếp · đang kéo thì cột **không** tự cuộn (BI-39) |
| Chọn nhiều mục / clipboard vật thể (`ed.selMore`, `selIds`, `toggleSelect`, `gripsFor`, `clip`, `copySelected`, `pasteClip`, menu bấm phải trong Chú thích) | `npm run test:cloud` · **giữ Ctrl bấm 3 mục** → cả 3 có viền chọn, **không** hiện tay nắm · kéo một mục trong nhóm → **cả nhóm** đi cùng, Esc giữa lúc kéo → **cả nhóm** về chỗ cũ · đổi Màu / Nét → **cả nhóm** đổi · Delete → mất cả nhóm, **một** Ctrl+Z lấy lại hết · Ctrl+C rồi sang trang khác Ctrl+V → dán đúng vị trí cũ, còn nguyên khoảng cách giữa các mục · dán **lại** trên cùng trang → lệch dần chứ không đè lên nhau · dán vào trang **nhỏ hơn** → cả nhóm bị kéo vào trong trang mà **không rời ra** · **copy → Áp dụng → Ctrl+V** vẫn dán được (BI-46) · bấm phải lên một mục → menu Sao chép/Dán/Xoá · bấm phải lên **giấy trắng** khi chưa copy gì → vẫn ra menu **ảnh** cũ · copy một ảnh từ app khác rồi Ctrl+V → vẫn là đường dán ảnh của `capture.js` (BI-30) |
| Sửa mũi tên (`drag.type === "point"`, `snapLineEnd`, `.handle.h-pt`, `reverseSelectedArrow`) | `npm run test:cloud` · chọn mũi tên → thấy **2 nút tròn** ở hai đầu · kéo một đầu → mũi tên xoay/dài ra, đầu kia **đứng yên** · giữ Shift → khoá góc 15°, **độ dài không đổi** · Esc giữa lúc kéo → về đúng cũ, không để lại bước undo rỗng · "Đảo chiều" → mũi nhọn **và nhãn** sang đầu kia · **Áp dụng → mở lại → Chỉnh sửa** → vẫn kéo/đảo/sửa nhãn được (arrow round-trip qua `/NabuData`) |
| Vẽ tay + Shift (`strokeExtend`, nhánh `drag.type === "draw"`, `drag.lineFrom`) | `npm run test:cloud` · vẽ tay **không** giữ Shift → vẫn ngoằn ngoèo đủ điểm · giữ Shift giữa nét → ra đoạn **thẳng**, rê chuột thì đoạn đó **xoay theo** chứ không dài thêm điểm · **thả** Shift → vẽ tay tiếp từ đúng đầu mút đó · Esc giữa chừng → mất cả nét, không để lại bước undo rỗng · Xong → mở lại file, nét **đúng hình** (BI-42) |
| Dấu ✓ / ✗ (`SYMBOL_KINDS`, `symbolStrokes`, `colorSlotFor`, `drag.type === "symbol"`) | `npm run test:cloud` · **bấm** một cái → ra dấu cỡ mặc định, **kéo** → ra đúng cỡ đã kéo · bấm sát mép phải-dưới trang → dấu vẫn **nằm trọn trong trang** · chọn rồi kéo 4 góc, giữ Shift giữ tỷ lệ · đổi "Nét" → dấu đậm/mảnh theo · đổi màu ✗ rồi chuyển sang bút Tô sáng → **màu tô sáng không bị đổi theo** · phím K/J đổi công cụ, nhưng đang gõ trong ô số thì **không** · Xong → mở lại file: dấu **đúng chỗ, đúng màu**, kể cả trên trang **đã xoay** (BI-42) |
| Thêm nút vào `#ed-tools` hay control vào palette | BI-41: thu cửa sổ về 1366px rồi 1024px, lần lượt chọn **mọi** công cụ → nút "Xong"/"Hủy bỏ" luôn thấy được, thanh **không** phình cao che trang · và BI-9 + BI-10 |
| Tuỳ chọn “Mở file mới trong” (`prefs.js`, `planOpen`, `tabs:open-paths`, `openPathInApp`) | `cd desktop ; npm run test:tabs` · với **cả hai** giá trị, thử **cả ba** đường: nút Mở · kéo–thả PDF vào tab đang có tài liệu · double-click file trong Explorer — kết quả phải **giống nhau** · chọn 3 file cùng lúc + “Cửa sổ mới” → **một** cửa sổ 3 tab · tab trắng + “Cửa sổ mới” → nạp vào chính tab trắng đó · đổi tuỳ chọn rồi khởi động lại app → vẫn nhớ · xoá `%APPDATA%/Nabu PDF/prefs.json` → về “Tab mới” (BI-35, BI-8) |
| Màu chú thích mặc định (`DEFAULT_ANNOT_COLOR`, `savedAnnotColor`, `COLOR_SLOTS`, `colorSlotFor`, `setDefaultColor`, `#set-annot-color`) | `cd desktop ; npm run test:defaults` · xoá key `nabu-annot-color` → vẽ **cả 10** loại dùng màu chung (hộp văn bản, mũi tên, mây, mây vẽ tay, chữ nhật, tròn, bút vẽ, ghi chú, đo) → **tất cả đỏ** · **✓ vẫn xanh, ✗ vẫn đỏ, Tô sáng vẫn vàng, Màu che vẫn đen, Nền vẫn trắng** · Cài đặt đổi màu **khi hộp thoại còn mở** → vật thể mới theo màu mới, **vật thể cũ không đổi** · ô **Màu** trên thanh đổi màu vật thể đang chọn nhưng **không** ghi vào Cài đặt · Ctrl+click 3 mục rồi đổi màu → **cả 3** đổi · khởi động lại app → vẫn nhớ · Áp dụng + Lưu + mở lại → màu trong file đúng · mở file **đã lưu từ bản ≤0.2.59** có mũi tên/ghi chú round-trip → màu **giữ nguyên** · đổi VI↔EN → hàng Cài đặt dịch đúng, ô màu không bị reset (BI-61, BI-10) |
| Kéo–thả nhiều PDF vào cửa sổ (`drop` ở `app.js`, `openDroppedPdfs`, `combineDroppedPdfs`, `droppedPath`, `pathForFile`) | `cd desktop ; npm run test:confirm` · kéo **1** file → mở luôn, **không** hỏi gì · kéo **3** file → hộp thoại 3 lựa chọn; **Enter** = Mở từng file, nút **Gộp thành một file**, **Esc = không làm gì cả** (tài liệu đang đọc phải còn y nguyên) · chọn Gộp → danh sách đúng **thứ tự đã kéo** (không phải thứ tự tên) · chọn Mở từng file khi tab **đã có** tài liệu → ra **tab mới**, tài liệu cũ không bị thay (đây là ca canh gác BI-63: `File.path` đã chết, nếu `webUtils` không chạy thì nó sẽ **đè** tài liệu đang mở) · tab **trắng** + kéo 3 file → file đầu vào chính tab trắng đó · kéo file **không phải PDF** → không hỏi, không làm gì · kéo PDF vào **dải thumbnail** → vẫn là đường **chèn trang** cũ, **không** ra hộp thoại này (BI-63, BI-8, BI-35, BI-26) |
| Verb Explorer “Gộp bằng Nabu PDF” (`shell-combine.js`, `combineBucket`, `openCombineBatch`, `sendCombineToView`, `createTab combinePaths`, `combineFromShell`, `installer.nsh`) | `cd desktop ; npm run test:combine` · **phần còn lại CHỈ test được trên bản ĐÃ ĐÓNG GÓI + ĐÃ CÀI** (dev không đăng ký verb, và `electron .` không dựng được verb): `reg query "HKCU\Software\Classes\SystemFileAssociations\.pdf\shell\NabuCombine" /s` thấy đủ `MUIVerb` (tiếng Việt đúng, không mojibake) + `MultiSelectModel=Player` + `command` · **app đang mở với tài liệu BẨN** → chọn 3 PDF → Gộp → tab **mới**, tài liệu cũ **còn nguyên, vẫn bẩn, không bị hỏi câu nào** · **app CHƯA chạy** → chọn 5 PDF → Gộp → **một** hộp thoại **đủ 5 mục**, lặp **≥10 lần** (đây là ca đua khoá single-instance, xem BI-62) · 20 file · tên tiếng Việt có dấu · đường dẫn có dấu cách · ổ mạng UNC · file có mật khẩu lẫn trong loạt → bị bỏ kèm toast, loạt còn lại vẫn gộp · chọn **1** file → hộp thoại 1 mục, “Gộp & lưu” mờ, “Thêm file PDF…” dùng được · sắp lại thứ tự → Gộp & lưu → mở kết quả kiểm **đúng thứ tự + đủ trang** · huỷ hộp thoại Lưu → kết quả vẫn mở, Ctrl+S lưu được · **double-click MỘT file PDF vẫn mở tài liệu, KHÔNG ra hộp thoại Gộp** (ca canh gác thứ tự hỏi) · gỡ app → khoá registry mất hẳn · Win11: mục nằm trong **“Hiện thêm tùy chọn”** (BI-62, BI-35, BI-8) |
| Chọn font ở `/edit-text` hay `src/pdf/fonts.py` | `test_edit_text_font.py` **và** `test_edit_text_rounds.py` · mở 1 hoá đơn Times New Roman thật, sửa 1 dòng với “Giữ nguyên” → **không** đổi sang DejaVu, **không** ra □ (BI-21) |
| Toàn màn hình (`setPresentation`, `_layout`, `.presenting`) | `npm run test:tabs` (10 ca cuối) · F11 vào/ra · Esc ra · thoát bằng nút cửa sổ → thanh công cụ phải quay lại · chuyển tab khi đang toàn màn hình · thử bật lúc đang Chú thích (phải từ chối) — BI-22 |
| `pan.js` hay bất kỳ listener chuột nào trên `#viewer` | `cd desktop ; npm run test:pan` (57 ca) · bật Bàn tay → kéo trang chạy, **không** bôi đen chữ · tắt Bàn tay → bôi đen chữ lại được · giữ Space kéo rồi thả → về đúng công cụ cũ · kéo chuột giữa lúc **đang Chú thích** → trang chạy, **không** vẽ ra hình · lúc **đang Copy ảnh** → trang chạy, **không** ra khung marquee · bấm vào ghi chú (note marker) khi Bàn tay bật → popup vẫn mở (BI-30, BI-31) |
| Toàn màn hình / dải thumbnail (`applyPresentation`, `body.presenting .sidebar`, `#present-rail`) | F11 → trang vẫn vừa trọn màn hình · rê chuột mép trái → dải trượt ra mà trang **không nhúc nhích** · F4 ghim/bỏ ghim · thu sidebar rồi mới F11 → F4 vẫn gọi lại được dải · thoát F11 → sidebar về đúng trạng thái cũ (BI-32, BI-22) |
| Bề rộng sidebar (`--sidebar-w`, `applySidebarWidth`, `#sidebar-resizer`) | Kéo rộng/hẹp → dừng đúng ở 130/300 · **kéo–thả 1 PDF từ ngoài vào giữa dải thumbnail → chèn đúng vị trí** (BI-33) · bấm đúp tay nắm → về 180 · đóng mở app → nhớ bề rộng · thu sidebar (F4) → tay nắm biến mất · F11 → lớp phủ đúng bề rộng đã kéo (BI-34) |
| Tuỳ chọn hiện đường dẫn (`set-breadcrumb`, `breadcrumbEnabled`) | Tắt → dải đường dẫn biến mất **ngay**, mở lại app vẫn tắt · bật lại → hiện · mặc định máy mới = **bật** · đổi VI↔EN → dòng cài đặt đổi theo |
| Đóng hộp thoại (`dismissModal`, `topOpenModal`, `[data-modal-close]`, `.modal-x`, `data-modal-manual`) | BI-48 · probe boot phải báo `dialogs_without_close` **và** `dialogs_without_x` rỗng · thử **cả ba** đường (Esc / bấm nền / ✕) trên: **Cài đặt** (hộp cuộn được — ✕ phải **dính** ở đầu khi cuộn xuống), **Nén**, **Gộp file** · bấm **bên trong** thẻ rồi thả chuột ra nền → hộp thoại **không** đóng · mở PDF có mật khẩu rồi `Esc` → app không treo, mở lại file được · `Esc` khi đang **F11** với 1 hộp thoại mở → chỉ đóng hộp thoại, **vẫn** ở toàn màn hình · `Esc` trong trang **Hướng dẫn** khi ô tìm còn chữ → xoá chữ trước, lần hai mới đóng (BI-47) |
| `/compress` · `/compress-bin` · `_compress_pdf_bytes` · `runCompress` · **worker `--compress-worker`** · `compressEta`/`updateCompressEta` | BI-49 + **BI-54** · `.venv\Scripts\python run_tests.py` **và** `cd desktop ; npm run test:geom` · **test tay dòng ước tính:** mở **Nén** → thấy `Tài liệu … · ước tính khoảng …` · đổi mức sang **Không giảm chất lượng** → con số **tụt hẳn** · mở file **>300MB** → dòng chuyển **màu cảnh báo** và bấm Nén thì **hỏi lại**; bấm **Hủy** → tài liệu **không** bị bẩn (không có ● trên tiêu đề) · đổi ngôn ngữ sang English khi hộp đang mở → dòng này **không** bị đè bằng chữ cũ · **BI-54 test tay, BẮT BUỘC trên bản ĐÓNG GÓI** (argv frozen khác argv dev): nén một file **>25MB** → trong lúc chạy, mở **tab khác** và bấm một tính năng engine bất kỳ (Ctrl+F trong Sửa nội dung, OCR) → **phải phản hồi ngay**, không đợi nén xong · **không** nháy cửa sổ console đen · nén file **nhỏ** (<25MB) → xong **tức thì**, không có 3 giây khựng · preset sai trên file lớn → câu tiếng Việt **đọc được**, không phải ký tự rác · thoát app giữa lúc nén → **không** còn `sidecar.exe` nào sót trong Task Manager · nén một PDF **>200MB thật** → ra file, **không** báo "PDF quá lớn" · nén PDF **>500 trang** → chạy, không báo "quá nhiều trang" · nén file hỏng/preset sai → hiện **đúng câu lỗi** chứ không lưu ra PDF rác · dòng toast ghi đúng cỡ trước → sau · **rebuild sidecar** trước khi đóng gói (đụng `api.py`) |
| Thanh công cụ hàng 1 (`.brand`, `.brand-text`, `.by`, `icon-only` của `btn-save`/`btn-print`, `#sb-credit`) | Thu cửa sổ **1920 → 1600 → 1366 → 1280**: hàng 1 **không cao hơn** bản trước (đã đo bằng probe: 98 → 91px ở 1600) · nút **Lưu**/**In** rê chuột ra **đúng tooltip**, và `Ctrl+S`/`Ctrl+P` + menu **Tập tin** vẫn chạy · đổi **VI↔EN** → tooltip đổi theo, nút **không** mọc lại chữ (BI-10) · dòng `developed by Nam Ta` thấy được ở **thanh trạng thái** kể cả khi cửa sổ hẹp (dưới 1400px byline trên brand bị ẩn có chủ ý) |
| `renderer/find-replace.js` · `/text-find` · Ctrl+H | BI-50 + **BI-51** · `cd desktop ; npm run test:find` **và** `.venv\Scripts\python run_tests.py` · **BI-51 test tay:** gõ vào ô Tìm → **không** có gì chạy, app không đứng · `Enter` → quét **một** lượt · gõ thêm ký tự → hai nút **Thay** tắt, vệt tô cũ còn nguyên · file **>200MB** → hiện **"PDF quá lớn"**, không phải "không tìm thấy" · file **scan** → nhắc **OCR**, không phải "không tìm thấy" · rồi **test tay trên hợp đồng thật**: tìm một từ có ≥2 lần **trên cùng một dòng** → **Thay tất cả** → mở lại file, **cả hai** đều đổi (bẫy gộp span) · **Thay** từng cái từ trên xuống, bấm ↓ bỏ qua vài chỗ → chỉ đúng chỗ đã bấm Thay bị đổi · thay bằng chuỗi **chứa chính từ khoá** ("hợp đồng" → "phụ lục hợp đồng") → **dừng lại**, không lặp vô hạn · `Ctrl+Z` sau "Thay tất cả" → về nguyên trạng **trong một bước** · tìm xong rồi **xoá một trang** → vệt tô **biến mất** (BI-50) · mở trên **PDF scan** → báo đi OCR, không im lặng · từ khoá **có dấu** ("hợp đồng") tìm ra, gõ **không dấu** thì **không** ra (cố ý) · trang có chữ **in đậm giữa từ** → vệt **vàng nét đứt**, nút **Thay** mờ · **zoom** khi đang mở → vệt bám đúng chữ (BI-36) · đang **Chú thích**/**Sửa nội dung** → bấm Ctrl+H bị từ chối (BI-2) · **BI-53:** tìm một từ **rất phổ biến** trên file vài trăm trang cho tới khi hiện "dừng quét ở trang N" → bấm **Thay tất cả** → hộp xác nhận phải nói **"trong phần tài liệu đã quét"** kèm dòng "phần sau CHƯA được quét", **không** nói "toàn bộ tài liệu" |
| `desktop/src/sidecar.js` · `bootSidecar` trong `main.js` | **BI-53** · `cd desktop ; npm run test:sidecar` (7 ca, boot sidecar dev thật; tự SKIP nếu chưa có `.venv`) · **test tay:** mở app, đợi badge xanh, rồi `taskkill /F /IM sidecar.exe` (hoặc kill tiến trình python lúc dev) → badge phải **đỏ** trong ~1s, mọi nút engine (OCR, Nén, Dịch, Tách, Ctrl+H, Sửa nội dung) **mờ đi**, tooltip badge ghi "Engine đã dừng đột ngột" · **ca ngược, quan trọng hơn:** thoát app bình thường → **không** thấy thông báo lỗi nào chớp lên |
| `i18n.js` | Đổi VI↔EN khi đang mở tài liệu, đang chú thích, đang sửa nội dung |
| `api.py` / `src/pdf/*` | `.venv\Scripts\python run_tests.py` **và** rebuild sidecar trước khi đóng gói |

---

## 6. Checkpoint bắt buộc trước khi phát hành

1. `.venv\Scripts\python run_tests.py` → phải `N/N test files passed`.
2. `cd desktop ; npm run test:tabs` → phải `N pass, 0 fail`
   (lưới cho logic sắp xếp tab + định tuyến phím trong `src/tabs.js`).
2b. `cd desktop ; npm run test:pages` → phải `N pass, 0 fail`
   (lưới cho số học khoảng trang trong `renderer/page-range.js`).
2c. `cd desktop ; npm run test:pan` → phải `N pass, 0 fail`
   (lưới cho logic giành chuột của bàn tay trong `renderer/pan.js`).
2d. `cd desktop ; npm run test:wire` → phải `N pass, 0 fail`
   (lưới cho bộ mã hoá payload trong `renderer/wire.js` — BI-24).
2e. `cd desktop ; npm run test:geom` → phải `N pass, 0 fail`
   (hình học zoom / cột trang **cắt thẳng từ `app.js`**; `resizeRect` `require()` từ
   `annot-geom.js` từ v0.2.48 — BI-36, BI-39).
2f. `cd desktop ; npm run test:managed` → phải `N pass, 0 fail`
   (vòng round-trip của ảnh chèn: ghi → đọc lại → bake lại không phình — BI-37, BI-38.
   Từ v0.2.49 phần lớn là `require("renderer/managed-codec.js")`; chỉ `deserializeManaged`,
   `addManagedAnnot`, `edSnapshot`, `dataUrlToBytes` còn cắt-lúc-chạy vì không rời được `editor.js`).
2g. `cd desktop ; npm run test:text` → phải `N pass, 0 fail`
   (bố cục chữ trong `renderer/annot-text.js` — BI-40).
2h. `cd desktop ; npm run test:cloud` → phải `N pass, 0 fail`
   (mây revision + nhãn mũi tên trong `renderer/annot-geom.js` — BI-40).
2i. `cd desktop ; npm run test:print` → phải `N pass, 0 fail`
   (khoảng trang của hộp thoại In, **cắt thẳng từ `app.js`** + kiểm luôn 7 khoá i18n và
   `SKIP_IDS` — BI-43, BI-44. Nửa CSS "1 trang = 1 tờ" **không** nằm trong lưới này: phải
   probe `printToPDF` và **đếm tờ**).
2j. `cd desktop ; npm run test:rotate` → phải `N pass, 0 fail`
   (bù xoay trang cho **mọi** kind của `drawOneAnnot`, **cắt thẳng từ `editor.js`** và
   chạy trên chính pdf.js + pdf-lib đang ship — BI-45. Có ca canh gác dựng lại đúng lỗi
   mây bị xoay, nên lưới này **không thể** xanh một cách vô nghĩa).
2k1. `.venv\Scripts\python test_text_find.py` → phải `N pass, 0 fail`
   (luật khớp của `/text-find` — BI-52: biên nguyên-từ trên dòng, span khoảng trắng,
   cache khoá bằng toàn bộ bytes, `/text-find-bin` khớp `/text-find` từng hit).
2k. `cd desktop ; npm run test:find` → phải `N pass, 0 fail`
   (số học Tìm & Thay thế trong `renderer/find-replace.js` — BI-50. Lưới này cũng kiểm
   **mọi khoá `tr()` có trong từ điển i18n**, `fr-status` nằm trong `SKIP_IDS`,
   `btn-find-replace` nằm trong `GATED_BTNS`, và `pushUndo` đứng **trước** phép gán
   `state.bytes` — BI-3, BI-9, BI-10).
2k2. `.venv\Scripts\python test_edit_text_rotate.py` → phải `N pass, 0 fail`
   (chiều vẽ lại chữ của `/edit-text` — BI-66. Mỗi nhóm có **ca canh gác** gửi `dir=None`
   để dựng lại đúng lỗi "chữ tự quay 90°" và đòi nó phải SAI, nên lưới này **không thể**
   xanh một cách vô nghĩa. `run_tests.py` đã tự gom, mục này để nhớ khi chỉ chạy lẻ.)
2l. `cd desktop ; npm run test:defaults` → phải `N pass, 0 fail`
   (màu chú thích mặc định — BI-61. Giữ **ba** literal `#d32f2f` bằng nhau, chặn việc gộp
   4 màu có nghĩa `✓/✗/tô sáng/che`, và canh gác 2 fallback `#ffd54a` của
   `deserializeManaged` — đổi chúng là làm **file đã lưu** đổi màu khi mở lại).
2m. `cd desktop ; npm run test:combine` → phải `N pass, 0 fail`
   (verb Explorer “Gộp bằng Nabu PDF” — BI-62. Có ca canh gác “argv của Open with phải
   trả `null`”, chính sách gom của `createCombineBucket`, và **đối chiếu
   `build/installer.nsh` ↔ `src/shell-combine.js`** vì cờ/khoá registry sống ở hai file
   mà build không kiểm.
   ⚠️ Lưới này **không** chứng minh verb chạy: khoá registry chỉ được ghi lúc **cài**.
   Sau khi đóng gói phải test tay theo §5 — tối thiểu là `reg query` thấy đủ 3 value, và
   **double-click một file PDF vẫn mở tài liệu** chứ không ra hộp thoại Gộp).
3. `node --check` mọi file JS đã sửa (renderer **không** có test tự động).
3b. Nếu đụng `editor.js` / `app.js` / bất kỳ file nào được `<script>` nạp: **probe boot**
   — chạy `index.html` thật bằng Electron của dự án (`BrowserWindow({show:false})`),
   nghe `console-message`, và đòi **0** `ReferenceError` / `SyntaxError` /
   `has already been declared`, **cộng với** một câu hỏi khẳng định (`typeof $`,
   `!!window.Editor`, số key của `window.AnnotGeom`, các `id` nút mới có mặt). Chỉ
   “không có lỗi” là chưa đủ — nó cũng đúng khi script **không hề chạy**. Đây là cửa duy
   nhất bắt được BI-14: node cho mỗi module một scope riêng nên lưới vẫn xanh trong khi
   app trắng. Probe là **file dùng một lần, không commit**.
4. Nếu đụng `*.py` hoặc `sidecar.spec` → **rebuild sidecar**, nếu không OTA giao bản cũ.
5. Chạy `npm start`, test tay các mục ở §5 tương ứng với thứ vừa sửa.
6. Cập nhật `HANDOFF.md` + tài liệu này nếu phát sinh bất biến mới.

**Bài học quy trình đã có tiền lệ tốt:** commit `c75e355` viết lưới test cho `api.py`
**trước** khi refactor `65b38bf`. Với thay đổi lớn, hãy dựng lưới an toàn trước.
