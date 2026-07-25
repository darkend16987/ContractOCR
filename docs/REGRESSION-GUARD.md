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
| `api.py` + `src/pdf/*.py` | — | Có lưới test tự động (`run_tests.py`) → rủi ro thấp hơn renderer. |

> Renderer **không có** test tự động. Mọi bảo đảm ở renderer đến từ tài liệu này +
> test tay. Đó là lý do sổ bất biến tồn tại.

---

## 2. Kiến trúc phải nhớ trước khi sửa

- 7 file JS của renderer (`i18n, app, editor, text-edit, compare, capture, sign`) nạp bằng
  `<script>` **classic**, dùng chung **một scope**. `state`, `toast`, `sidecarFetch`,
  `showOverlay`… là biến toàn cục dùng chéo, **không phải module** → đổi tên một hàm
  trong `app.js` có thể làm `editor.js` chết mà không hề có cảnh báo lúc build.
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
| `pushUndo()` | `app.js:148` | 3 module, 10 chỗ — xem BI-3 |
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
| `i18n.js` | Đổi VI↔EN khi đang mở tài liệu, đang chú thích, đang sửa nội dung |
| `api.py` / `src/pdf/*` | `.venv\Scripts\python run_tests.py` **và** rebuild sidecar trước khi đóng gói |

---

## 6. Checkpoint bắt buộc trước khi phát hành

1. `.venv\Scripts\python run_tests.py` → phải `N/N test files passed`.
2. `cd desktop ; npm run test:tabs` → phải `N pass, 0 fail`
   (lưới cho logic sắp xếp tab + định tuyến phím trong `src/tabs.js`).
3. `node --check` mọi file JS đã sửa (renderer **không** có test tự động).
4. Nếu đụng `*.py` hoặc `sidecar.spec` → **rebuild sidecar**, nếu không OTA giao bản cũ.
5. Chạy `npm start`, test tay các mục ở §5 tương ứng với thứ vừa sửa.
6. Cập nhật `HANDOFF.md` + tài liệu này nếu phát sinh bất biến mới.

**Bài học quy trình đã có tiền lệ tốt:** commit `c75e355` viết lưới test cho `api.py`
**trước** khi refactor `65b38bf`. Với thay đổi lớn, hãy dựng lưới an toàn trước.
