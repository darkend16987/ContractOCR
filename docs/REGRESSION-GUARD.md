# Sổ bất biến & chống hồi quy — Nabu PDF

_Lập 2026-07-25. Mục đích: **sửa tính năng mới không được làm hỏng tính năng cũ đang chạy tốt** — nhất là những thứ vừa fix xong ở bản trước._

**Cách dùng:** trước khi sửa, tra mục §5 (“đụng gì → test gì”). Sau khi sửa, chạy đúng
các mục test được chỉ. Khi phát hiện một hợp đồng ngầm mới, **ghi thêm vào §3** —
tài liệu này chỉ có giá trị nếu được cập nhật.

---

## 1. Bản đồ rủi ro: file nào dễ vỡ nhất

| File | Dòng | Vì sao rủi ro cao |
|---|---|---|
| `desktop/renderer/app.js` | ~3750 | State trung tâm + 12 hàm nút thắt. **Gần như mọi bản phát hành đều đụng.** |
| `desktop/renderer/editor.js` | ~3340 | Overlay annotation, bake, form. Diff lớn nhất mỗi lần release. |
| `desktop/src/main.js` + `src/tabs.js` | — | Tầng cửa sổ/tab — **hệ con mới nhất, ít va đập thực tế nhất** (ra mắt v0.2.41). Có lưới tự động `npm run test:tabs` cho phần logic thuần. |
| `desktop/renderer/page-range.js` | ~120 | Số học khoảng trang. Rủi ro **thấp** vì có lưới `npm run test:pages`, nhưng hậu quả sai là **mất trang tài liệu** → xem BI-27. |
| `api.py` + `src/pdf/*.py` | — | Có lưới test tự động (`run_tests.py`) → rủi ro thấp hơn renderer. |

> Renderer gần như **không có** test tự động — ngoại lệ duy nhất là `page-range.js`
> (không đụng DOM nên chạy được dưới node). Mọi bảo đảm còn lại ở renderer đến từ tài
> liệu này + test tay. Đó là lý do sổ bất biến tồn tại.

---

## 2. Kiến trúc phải nhớ trước khi sửa

- 8 file JS của renderer (`i18n, page-range, app, editor, text-edit, compare, capture, sign`)
  nạp bằng `<script>` **classic**, dùng chung **một scope**. `state`, `toast`, `sidecarFetch`,
  `showOverlay`… là biến toàn cục dùng chéo, **không phải module** → đổi tên một hàm
  trong `app.js` có thể làm `editor.js` chết mà không hề có cảnh báo lúc build.
  (`page-range.js` là ngoại lệ có chủ ý: nó **chỉ** phơi ra `window.PageRange`, không thả
  tên trần nào vào scope chung, nên cũng `require()` được từ node để chạy test.)
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
- `app.js` `openDialog()` + nhánh drop; `main.js` `tabs:open-paths`.
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
- `pdfJsonBody()` (`app.js`) — dùng ở **14 chỗ gọi** trong `app.js`/`text-edit.js`/`compare.js`.
- `JSON.stringify({pdf_b64: u8ToB64(bytes), …})` tốn **ba bản sao cỡ đầy đủ** trên heap
  renderer (chuỗi nhị phân trong `u8ToB64`, base64 nó trả về, và bản sao của
  `stringify`) ⇒ ~500MB rác tạm cho file 134MB, chồng lên `state.bytes` + lịch sử undo.
  Đúng loại hết-heap mà v0.2.40 đã vá cho chiều **tải về** và bỏ sót chiều **gửi lên**.
- `pdfJsonBody` ghép `Blob` theo mảnh → byte nằm trong blob store của Blink (tràn ra đĩa
  được), mỗi lúc chỉ có **một mảnh 48KB** là chuỗi JS. **Định dạng trên dây không đổi.**
- **Kích thước mảnh phải là bội của 3** — base64 chỉ chèn `=` ở cuối luồng, chia đúng
  mốc 3 byte thì các mảnh nối thẳng được. Đổi thành số khác là hỏng payload **im lặng**.
- Nhận cả `Uint8Array` (→ `pdf_b64`) lẫn object `{tên: bytes}` cho `/compare` (2 tài liệu).

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

### BI-14 · Gọi hàm chéo module theo kiểu “tên trần” là điểm gãy im lặng
- `rerenderChanged` (gọi từ `editor.js:2521`, `text-edit.js:519`) và
  `showOverlay`/`hideOverlay` (gọi từ 4 module) **không** có `window.` và **không** có guard.
- Đổi tên/xoá chúng trong `app.js` → `ReferenceError` lúc chạy, không lỗi lúc build.
- Ngược lại `repaintRenderedPages` có guard `if (window.…)` — mẫu này an toàn hơn, nên theo.

---

## 4. Hàm nút thắt (đổi chữ ký = ảnh hưởng diện rộng)

| Hàm | Định nghĩa | Ai gọi |
|---|---|---|
| `toast()` | `app.js:58` | cả 6 module, ~172 chỗ |
| `sidecarFetch()` | `app.js:49` | 4 module (~28 chỗ) — điểm duy nhất gắn token `X-Sidecar-Token` |
| `pushUndo()` | `app.js:148` | 3 module, 10 chỗ — xem BI-3. Phơi ra ngoài bằng **`window.DocHistory`**, **không** phải `window.History` (tên đó là constructor của DOM → guard `if (window.History)` không bao giờ sai được) |
| `pdfJsonBody()` | `app.js:2278` | 3 module, 14 chỗ — xem BI-24 |
| `renderAll()` | `app.js:486` | 13 chỗ |
| `rerenderChanged()` | `app.js:1138` | **chỉ** module khác gọi — xem BI-14 |
| `updateToolbar()` | `app.js:3084` | 3 module, 11 chỗ — chứa BI-2 và BI-9 |
| `showOverlay/hideOverlay` | `app.js:66/70` | 4 module — xem BI-14 |
| `u8ToB64 / b64ToU8` | `app.js:2142/2156` | cầu base64 cho mọi vòng gọi sidecar |

---

## 5. Ma trận “đụng gì → phải test gì”

| Nếu bạn sửa… | Bắt buộc test lại |
|---|---|
| `pushUndo` / `snapshot` / history | Ctrl+Z–Ctrl+Y sau: xoay, xoá trang, ghép, chèn, bake chú thích, sửa nội dung · chấm ● xuất hiện · đóng file bẩn có hỏi |
| `state.bytes` ở bất kỳ đâu | Lưu ra file mở lại được · in · undo · autosave (BI-3) |
| Virtualization / `renderPageCanvas` / `freePageCanvas` | Cuộn nhanh lên-xuống PDF nhiều trang · in · so sánh · copy vùng ảnh (BI-4) |
| `editor.js` bake | Chú thích → Xong → sửa lại được · số trang không đổi · comment panel còn đúng (BI-5) |
| Tầng tab/cửa sổ (`main.js`, `tabs.js`) | Toàn bộ `docs/TABS-TEST-L1.md` (24 mục) |
| Tách tab / kéo tab (`detachTab`, `adoptTab`, `classifyDrop`, `shell.js` dragend) | `docs/TABS-2B-DESIGN.md` §6.2 (18 mục) · BI-15/16/17 · **mục #1 là hồi quy của tính năng sắp xếp tab** |
| Khôi phục phiên (`src/session.js`, `snapshotSession`, `_closing`, `tab:reserved`) | `docs/SESSION-RESTORE.md` §5.3 (14 mục) · BI-18/19/20 · **mục #12 là hồi quy của khôi phục sự cố** |
| Guard đóng | BI-6: nút X vs menu Thoát vs Ctrl+Q — cả 3 đường |
| Recovery/autosave | BI-7: mở 2 tab, chỉ tab đầu được hỏi khôi phục |
| Thêm nút tính năng mới | BI-9: khoá bản quyền có ăn không · BI-10: đổi VI/EN không mất chữ |
| Menu chuột phải trên thumbnail (`openThumbMenu`) | BI-26 · chuột phải **ngoài** vùng đang chọn → chỉ chọn trang đó · chuột phải **trong** vùng đang chọn → giữ nguyên nhiều trang · đang Chú thích/Sửa nội dung → **không** ra menu · chọn hết trang → mục Xoá phải mờ |
| `page-range.js` hay hộp thoại xoá theo khoảng | `cd desktop ; npm run test:pages` · gõ “từ 5 đến 12, trừ 7” trên tài liệu thật → trang 7 **còn nguyên** · Ctrl+Z quay lại đủ trang (BI-27, BI-3) |
| Tên file gợi ý khi Tách trang (`extractFileName`) | `npm run test:pages` · mở PDF ≥200 trang → Chọn tất cả bỏ 1 trang → Tách → tên trong hộp thoại Lưu **ngắn, đọc được**, lưu thành công (BI-27) |
| Badge trạng thái (`renderSidecarBadge`, `setApiBadge`, `/config`) | Mở app lúc engine chưa lên → OCR chấm rỗng, API “…” · engine lên & chưa có key → API chấm rỗng vàng · nhập key → chuyển xanh **ngay**, không cần khởi động lại · bấm badge API → mở Cài đặt đúng ô nhập · đổi VI↔EN → cả hai badge đổi theo (BI-29) |
| Bất kỳ điều kiện nào đọc `Editor.active` / `TextEdit.active` | Vào Chú thích rồi bấm ↑/↓/PageUp/PageDown/Delete → **không** có lỗi trong console, trang không bị xoá · thoát Chú thích → Delete xoá lại được (BI-28) |
| Menu ngữ cảnh dùng chung (`showPageMenu` trong `capture.js`) | Chuột phải lên **trang PDF** (Sao chép ảnh/vùng/Dán) vẫn đúng · mở menu này rồi mở menu kia → menu cũ đóng · cuộn dải thumbnail → menu đóng |
| Cỡ/hình học chữ vẽ lại (`hscale`, `vscale`, `orig_text`, `orig_size`) | `test_edit_text_metrics.py` · sửa 1 dòng trên hoá đơn thật → **không** dài ra đè chữ bên cạnh, **không** cao hơn dòng chưa sửa (BI-25) |
| Redaction / `add_redact_annot` / `apply_redactions` | `test_edit_text_layout.py` **và** `test_translate_layout.py` · sửa 1 chữ trong ô bảng **có nền** → không vệt trắng, không mất đường kẻ (BI-23) |
| `pdfJsonBody` hay bất kỳ chỗ gọi sidecar nào có PDF | Mở file **lớn** (≥100MB) rồi: Sửa nội dung · Nén · So sánh 2 file · Tách — không tab nào chết vì hết bộ nhớ (BI-24) |
| Chọn font ở `/edit-text` hay `src/pdf/fonts.py` | `test_edit_text_font.py` **và** `test_edit_text_rounds.py` · mở 1 hoá đơn Times New Roman thật, sửa 1 dòng với “Giữ nguyên” → **không** đổi sang DejaVu, **không** ra □ (BI-21) |
| Toàn màn hình (`setPresentation`, `_layout`, `.presenting`) | `npm run test:tabs` (10 ca cuối) · F11 vào/ra · Esc ra · thoát bằng nút cửa sổ → thanh công cụ phải quay lại · chuyển tab khi đang toàn màn hình · thử bật lúc đang Chú thích (phải từ chối) — BI-22 |
| `i18n.js` | Đổi VI↔EN khi đang mở tài liệu, đang chú thích, đang sửa nội dung |
| `api.py` / `src/pdf/*` | `.venv\Scripts\python run_tests.py` **và** rebuild sidecar trước khi đóng gói |

---

## 6. Checkpoint bắt buộc trước khi phát hành

1. `.venv\Scripts\python run_tests.py` → phải `N/N test files passed`.
2. `cd desktop ; npm run test:tabs` → phải `N pass, 0 fail`
   (lưới cho logic sắp xếp tab + định tuyến phím trong `src/tabs.js`).
2b. `cd desktop ; npm run test:pages` → phải `N pass, 0 fail`
   (lưới cho số học khoảng trang trong `renderer/page-range.js`).
3. `node --check` mọi file JS đã sửa (renderer **không** có test tự động).
4. Nếu đụng `*.py` hoặc `sidecar.spec` → **rebuild sidecar**, nếu không OTA giao bản cũ.
5. Chạy `npm start`, test tay các mục ở §5 tương ứng với thứ vừa sửa.
6. Cập nhật `HANDOFF.md` + tài liệu này nếu phát sinh bất biến mới.

**Bài học quy trình đã có tiền lệ tốt:** commit `c75e355` viết lưới test cho `api.py`
**trước** khi refactor `65b38bf`. Với thay đổi lớn, hãy dựng lưới an toàn trước.
