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
| `desktop/renderer/managed-codec.js` | ~275 | Lớp object PDF riêng của chú thích sửa-lại-được. **Hậu quả cao nhất trong repo**: sai là **mất ảnh của người dùng** hoặc phình file âm thầm. Có lưới `npm run test:managed` → xem BI-37, BI-38, BI-14. |
| `desktop/renderer/annot-geom.js` | ~420 | Đường mây revision + nhãn mũi tên + `resizeRect` + (v0.2.50) `strokeExtend` (luật Shift của vẽ tay) + `symbolStrokes` (hình ✓/✗) + (v0.2.52) `snapLineEnd` (kéo một đầu mũi tên) và `annotBounds`/`translateAnnot`/`unionBounds`/`fitShift` (số học của copy–paste vật thể). Rủi ro **thấp** nhờ `npm run test:cloud` + `test:geom`; sai ở đây làm mây/dấu lệch chỗ **trong PDF đã lưu** (trên màn hình vẫn đúng), hoặc dán một mục ra **ngoài mép giấy** nơi không tay nắm nào tóm lại được → xem BI-40, BI-42, BI-46. |
| `desktop/renderer/editor.js` — khối bake (`drawOneAnnot`) | ~200 dòng | Bù xoay trang. Rủi ro **cao và im lặng**: overlay trên màn hình luôn đúng, chỉ **file đã lưu** sai, và **chỉ trên trang có `/Rotate`** — tức đúng loại tài liệu (scan nằm ngang) mà người viết code không mở hằng ngày. Nay có lưới `npm run test:rotate` đi qua **mọi** kind → xem BI-45. |
| `desktop/src/main.js` + `src/tabs.js` | — | Tầng cửa sổ/tab — **hệ con mới nhất, ít va đập thực tế nhất** (ra mắt v0.2.41). Có lưới tự động `npm run test:tabs` cho phần logic thuần. |
| `desktop/renderer/page-range.js` | ~170 | Số học khoảng trang. Rủi ro **thấp** vì có lưới `npm run test:pages`, nhưng hậu quả sai là **mất trang tài liệu** → xem BI-27. |
| `desktop/renderer/pan.js` | ~380 | Bàn tay/pan. Rủi ro **trung bình**: nó giành sự kiện chuột **trên cùng phần tử** với `editor.js`/`capture.js`. Nửa logic có lưới `npm run test:pan`; nửa DOM thì không → xem BI-30/31. |
| `desktop/renderer/find-replace.js` | ~590 | Tìm & Thay thế. Rủi ro **trung bình** nhưng hậu quả **cao và im lặng**: nó **ghi vào chữ gốc** của tài liệu hàng loạt. Nửa số học có lưới `npm run test:find`; nửa DOM thì không → xem BI-50. |
| `desktop/renderer/wire.js` | ~130 | Bộ mã hoá payload nhị phân. Rủi ro **thấp** nhờ lưới `npm run test:wire`, nhưng sai ở đây **im lặng**: request vẫn đúng cú pháp, chỉ là base64 hỏng → xem BI-24. |
| `desktop/renderer/app.js` — khối zoom | ~130 dòng | `applyScaleToDom`/`commitScale` đụng CSS box của **mọi** trang + 4 lớp overlay. Sai là zoom mờ mãi hoặc chú thích lệch. Nửa số học có lưới `npm run test:geom` → xem BI-36. |
| ~~`editor.js` — ảnh round-trip~~ → `managed-codec.js` (v0.2.49) | ~180 dòng | Ghi/đọc/giải phóng object PDF riêng. Sai ở đây **mất ảnh của người dùng** hoặc phình file âm thầm. Có lưới `npm run test:managed` → xem BI-37, BI-38. |
| `desktop/renderer/app.css` — khối `@media print` + `app.js` `buildPrintPages` | ~50 dòng | Bố cục **tờ giấy**. Rủi ro **cao và im lặng**: sai ở đây không có lỗi, không có cảnh báo — chỉ là máy in nhả gấp đôi số tờ, hoặc mất phần dưới trang, và **chỉ trên khổ giấy mà người viết code không dùng** (A3/Letter). Nửa số học có lưới `npm run test:print`; nửa CSS chỉ probe `printToPDF` **đếm tờ** mới thấy → xem BI-43, BI-44. |
| `desktop/src/prefs.js` | ~80 | Tuỳ chọn phía main. Rủi ro thấp; nằm trong lưới `npm run test:tabs`. |
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

- 13 file JS của renderer (`i18n, page-range, wire, annot-text, annot-geom, managed-codec,
  app, pan, editor, text-edit, compare, capture, sign`) nạp bằng `<script>` **classic**, dùng
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
- Hai loại này **flatten** khi bake (như draw/box/cloud), **không** round-trip — chúng
  không nằm trong `MANAGED_KINDS`. Muốn sửa lại sau khi Lưu là **tính năng khác** (xem
  BI-37/38 để biết cái giá).
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
  tên · ảnh) quay lại thành đối tượng sống sau khi Lưu. Mây, box, elip, vẽ tay, ✓/✗
  **flatten thành pixel** (BI-42) ⇒ đã áp dụng rồi thì **không còn đối tượng để chọn**.
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
| Ảnh round-trip (`addManagedAnnot` nhánh image, `managedSrcBytes`, `collectManagedChain`, `freeManagedTrash`, `MANAGED_KINDS`) | `cd desktop ; npm run test:managed` · chèn 1 ảnh → Áp dụng → Lưu → **mở lại** → Chỉnh sửa → ảnh **kéo/đổi cỡ/xoá được**, “Áp nhiều trang” vẫn dùng được · lưu 3–4 lần liên tiếp → **cỡ file không phình** · áp 1 chữ ký cho 20 trang → file ~1 lần cỡ ảnh, không 20 · ảnh trên trang **đã xoay** → vẫn dán chết như trước (đúng) · xoá ảnh round-trip rồi **thêm ô redact trên chính trang đó** → Áp dụng: ảnh **không** quay lại thành pixel, và ảnh còn lại **không nhân đôi** (BI-37, BI-38) |
| Tay nắm đổi cỡ (`resizeRect`, `RESIZABLE_KINDS`, `.handle.h-*`) | `npm run test:geom` · kéo **cả 4 góc** của ảnh/tô sáng/redact/chữ nhật/elip → góc đối diện **đứng yên** · **giữ Shift** → không méo · Esc giữa lúc kéo → về đúng vị trí+cỡ cũ · Ctrl+Z sau khi đổi cỡ · bấm vào tay nắm rồi **không kéo** → không tạo bước undo rỗng |
| `editor.js` bake | Chú thích → Xong → sửa lại được · số trang không đổi · comment panel còn đúng (BI-5) |
| Tầng tab/cửa sổ (`main.js`, `tabs.js`) | Toàn bộ `docs/TABS-TEST-L1.md` (24 mục) |
| Tách tab / kéo tab (`detachTab`, `adoptTab`, `classifyDrop`, `shell.js` dragend) | `docs/TABS-2B-DESIGN.md` §6.2 (18 mục) · BI-15/16/17 · **mục #1 là hồi quy của tính năng sắp xếp tab** |
| Khôi phục phiên (`src/session.js`, `snapshotSession`, `_closing`, `tab:reserved`) | `docs/SESSION-RESTORE.md` §5.3 (14 mục) · BI-18/19/20 · **mục #12 là hồi quy của khôi phục sự cố** |
| Guard đóng | BI-6: nút X vs menu Thoát vs Ctrl+Q — cả 3 đường |
| Recovery/autosave | BI-7: mở 2 tab, chỉ tab đầu được hỏi khôi phục |
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
| Chọn font ở `/edit-text` hay `src/pdf/fonts.py` | `test_edit_text_font.py` **và** `test_edit_text_rounds.py` · mở 1 hoá đơn Times New Roman thật, sửa 1 dòng với “Giữ nguyên” → **không** đổi sang DejaVu, **không** ra □ (BI-21) |
| Toàn màn hình (`setPresentation`, `_layout`, `.presenting`) | `npm run test:tabs` (10 ca cuối) · F11 vào/ra · Esc ra · thoát bằng nút cửa sổ → thanh công cụ phải quay lại · chuyển tab khi đang toàn màn hình · thử bật lúc đang Chú thích (phải từ chối) — BI-22 |
| `pan.js` hay bất kỳ listener chuột nào trên `#viewer` | `cd desktop ; npm run test:pan` (57 ca) · bật Bàn tay → kéo trang chạy, **không** bôi đen chữ · tắt Bàn tay → bôi đen chữ lại được · giữ Space kéo rồi thả → về đúng công cụ cũ · kéo chuột giữa lúc **đang Chú thích** → trang chạy, **không** vẽ ra hình · lúc **đang Copy ảnh** → trang chạy, **không** ra khung marquee · bấm vào ghi chú (note marker) khi Bàn tay bật → popup vẫn mở (BI-30, BI-31) |
| Toàn màn hình / dải thumbnail (`applyPresentation`, `body.presenting .sidebar`, `#present-rail`) | F11 → trang vẫn vừa trọn màn hình · rê chuột mép trái → dải trượt ra mà trang **không nhúc nhích** · F4 ghim/bỏ ghim · thu sidebar rồi mới F11 → F4 vẫn gọi lại được dải · thoát F11 → sidebar về đúng trạng thái cũ (BI-32, BI-22) |
| Bề rộng sidebar (`--sidebar-w`, `applySidebarWidth`, `#sidebar-resizer`) | Kéo rộng/hẹp → dừng đúng ở 130/300 · **kéo–thả 1 PDF từ ngoài vào giữa dải thumbnail → chèn đúng vị trí** (BI-33) · bấm đúp tay nắm → về 180 · đóng mở app → nhớ bề rộng · thu sidebar (F4) → tay nắm biến mất · F11 → lớp phủ đúng bề rộng đã kéo (BI-34) |
| Tuỳ chọn hiện đường dẫn (`set-breadcrumb`, `breadcrumbEnabled`) | Tắt → dải đường dẫn biến mất **ngay**, mở lại app vẫn tắt · bật lại → hiện · mặc định máy mới = **bật** · đổi VI↔EN → dòng cài đặt đổi theo |
| Đóng hộp thoại (`dismissModal`, `topOpenModal`, `[data-modal-close]`, `.modal-x`, `data-modal-manual`) | BI-48 · probe boot phải báo `dialogs_without_close` **và** `dialogs_without_x` rỗng · thử **cả ba** đường (Esc / bấm nền / ✕) trên: **Cài đặt** (hộp cuộn được — ✕ phải **dính** ở đầu khi cuộn xuống), **Nén**, **Gộp file** · bấm **bên trong** thẻ rồi thả chuột ra nền → hộp thoại **không** đóng · mở PDF có mật khẩu rồi `Esc` → app không treo, mở lại file được · `Esc` khi đang **F11** với 1 hộp thoại mở → chỉ đóng hộp thoại, **vẫn** ở toàn màn hình · `Esc` trong trang **Hướng dẫn** khi ô tìm còn chữ → xoá chữ trước, lần hai mới đóng (BI-47) |
| `/compress` · `/compress-bin` · `_compress_pdf_bytes` · `runCompress` | BI-49 · `.venv\Scripts\python run_tests.py` · nén một PDF **>200MB thật** → ra file, **không** báo "PDF quá lớn" · nén PDF **>500 trang** → chạy, không báo "quá nhiều trang" · nén file hỏng/preset sai → hiện **đúng câu lỗi** chứ không lưu ra PDF rác · dòng toast ghi đúng cỡ trước → sau · **rebuild sidecar** trước khi đóng gói (đụng `api.py`) |
| Thanh công cụ hàng 1 (`.brand`, `.brand-text`, `.by`, `icon-only` của `btn-save`/`btn-print`, `#sb-credit`) | Thu cửa sổ **1920 → 1600 → 1366 → 1280**: hàng 1 **không cao hơn** bản trước (đã đo bằng probe: 98 → 91px ở 1600) · nút **Lưu**/**In** rê chuột ra **đúng tooltip**, và `Ctrl+S`/`Ctrl+P` + menu **Tập tin** vẫn chạy · đổi **VI↔EN** → tooltip đổi theo, nút **không** mọc lại chữ (BI-10) · dòng `developed by Nam Ta` thấy được ở **thanh trạng thái** kể cả khi cửa sổ hẹp (dưới 1400px byline trên brand bị ẩn có chủ ý) |
| `renderer/find-replace.js` · `/text-find` · Ctrl+H | BI-50 · `cd desktop ; npm run test:find` **và** `.venv\Scripts\python run_tests.py` · rồi **test tay trên hợp đồng thật**: tìm một từ có ≥2 lần **trên cùng một dòng** → **Thay tất cả** → mở lại file, **cả hai** đều đổi (bẫy gộp span) · **Thay** từng cái từ trên xuống, bấm ↓ bỏ qua vài chỗ → chỉ đúng chỗ đã bấm Thay bị đổi · thay bằng chuỗi **chứa chính từ khoá** ("hợp đồng" → "phụ lục hợp đồng") → **dừng lại**, không lặp vô hạn · `Ctrl+Z` sau "Thay tất cả" → về nguyên trạng **trong một bước** · tìm xong rồi **xoá một trang** → vệt tô **biến mất** (BI-50) · mở trên **PDF scan** → báo đi OCR, không im lặng · từ khoá **có dấu** ("hợp đồng") tìm ra, gõ **không dấu** thì **không** ra (cố ý) · trang có chữ **in đậm giữa từ** → vệt **vàng nét đứt**, nút **Thay** mờ · **zoom** khi đang mở → vệt bám đúng chữ (BI-36) · đang **Chú thích**/**Sửa nội dung** → bấm Ctrl+H bị từ chối (BI-2) |
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
2k. `cd desktop ; npm run test:find` → phải `N pass, 0 fail`
   (số học Tìm & Thay thế trong `renderer/find-replace.js` — BI-50. Lưới này cũng kiểm
   **mọi khoá `tr()` có trong từ điển i18n**, `fr-status` nằm trong `SKIP_IDS`,
   `btn-find-replace` nằm trong `GATED_BTNS`, và `pushUndo` đứng **trước** phép gán
   `state.bytes` — BI-3, BI-9, BI-10).
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
