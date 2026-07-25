# Thiết kế: Mở nhiều tài liệu bằng Tab (thay cho nhiều cửa sổ)

Trạng thái: **BẢN THIẾT KẾ — CHƯA CODE** (chờ duyệt)
Bối cảnh: Nabu PDF hiện mở mỗi file trong **1 `BrowserWindow` riêng**. Yêu cầu: mở file
thành **tab** trong cùng một cửa sổ ("mở ở tab mới"), và (giai đoạn sau) kéo–thả cửa sổ
thành tab / xé tab ra cửa sổ.

---

## 1. Mục tiêu & phạm vi

| Hạng mục | Giai đoạn 1 (đề xuất làm) | Giai đoạn 2 (sau, tùy chọn) |
|---|---|---|
| Mở file → tab mới trong cửa sổ hiện tại | ✅ | |
| Thanh tab: chuyển / đóng / đổi tên hiển thị / dấu ● chưa lưu | ✅ | |
| Kéo sắp xếp lại thứ tự tab (trong 1 cửa sổ) | ✅ | |
| "Cửa sổ mới" vẫn còn (đa cửa sổ song song với đa tab) | ✅ | |
| Kéo tab ra thành cửa sổ riêng (tab tearing) | | ⚠️ khó, rủi ro cao trên Windows |
| Kéo cửa sổ thả vào cửa sổ khác thành tab | | ⚠️ khó |

**Tiêu chí hoàn thành GĐ1 (definition of done):** mở ≥2 PDF trong 1 cửa sổ dạng tab, chuyển
tab tức thì, mỗi tab giữ nguyên **toàn bộ** chức năng hiện có (xem, sửa text, editor overlay,
undo/redo, autosave/khôi phục, ký số, in, so sánh…) **không sửa gì trong code renderer tài liệu**.

**Nguyên tắc ràng buộc:** không được phá vỡ luồng single-doc của renderer. Cách đạt được: mỗi
tab vẫn là **một renderer `index.html` độc lập, nguyên vẹn** — ta chỉ thêm lớp "vỏ" quản lý tab
ở main process + một trang thanh-tab mỏng.

---

## 2. Kiến trúc hiện tại (tóm tắt, đã đọc code)

- `desktop/src/main.js`
  - `windows: Set<BrowserWindow>` — mọi cửa sổ đang mở.
  - `createWindow(openPath)` — tạo `BrowserWindow` (preload, `contextIsolation`, `sandbox`),
    `loadFile(index.html)`, và khi `did-finish-load` thì `sendFileToWindow(win, openPath)`.
  - **Sidecar dùng chung**: 1 tiến trình Python cho tất cả cửa sổ (cùng port + token) →
    *tab không ảnh hưởng sidecar*.
  - Guard đóng cửa sổ: `win.on("close")` → gửi `window:before-close` để renderer hỏi
    Lưu/Không/Hủy; renderer gọi lại `window:force-close`.
  - Menu → `win.webContents.send("menu:cmd", cmd)` cho **cửa sổ đang focus**.
  - In → `senderWindow(e).webContents.print(...)`.
  - `attachContextMenu(win)` cho mỗi cửa sổ.
  - `second-instance` / `open-file` / argv → `createWindow(filePath)`.
- `desktop/renderer/*` — mỗi renderer giữ **một** tài liệu: `state.bytes`, lịch sử undo,
  editor, text-edit, autosave (`docId`), recovery. **Giả định "một cửa sổ = một tài liệu"
  ăn sâu** → đây là lý do KHÔNG gộp nhiều tài liệu vào chung một renderer.

---

## 3. Phương án chọn & lý do

### 3.1 Các phương án đã cân nhắc

| Phương án | Mô tả | Đánh giá |
|---|---|---|
| **A. Native OS tabs** | `win.addTabbedWindow` + `tabbingIdentifier` | ❌ **chỉ macOS**; app chạy Windows |
| **B. Một renderer, tab = state trong JS** | Một `index.html` giữ nhiều tài liệu, chuyển tab = swap `state.bytes` | ❌ **Rủi ro rất cao**: phải viết lại toàn bộ giả định single-doc (state, undo, editor, autosave, recovery, sidecar docId…). Dễ vỡ mọi thứ. |
| **C. `BaseWindow` + `WebContentsView`/tab** ⟵ **CHỌN** | 1 cửa sổ vỏ chứa: 1 view thanh-tab + N view tài liệu (mỗi view = `index.html` nguyên vẹn) | ✅ **Renderer tài liệu không đổi 1 dòng.** Cô lập tiến trình như cửa sổ riêng. API hiện đại (Electron 30+). |

### 3.2 Vì sao C

- Electron dự án đang dùng **33.4.11** → có `BaseWindow` + `WebContentsView` (không dùng
  `BrowserView` đã deprecated).
- Mỗi `WebContentsView` là một web contents **độc lập** (tiến trình renderer riêng, preload
  riêng, sandbox riêng) → tái sử dụng nguyên `index.html`/`app.js` mà **không** phải đụng tới
  logic single-doc. Đây là điểm mấu chốt để "không phá logic/function hệ thống".
- Đổi tab = **ẩn/hiện view + đặt lại bounds** ở main process; nội dung tab được giữ sống
  (không reload) → chuyển tab tức thì, không mất trạng thái sửa dở.

### 3.3 Ghi chú về bộ nhớ (quan trọng cho file lớn)

Tab **không giảm RAM**: mỗi tài liệu vẫn là một renderer + một bản sao PDF trong pdf.js worker,
y như cửa sổ riêng. Mở 3 file 130 MB dạng tab ≈ mở 3 cửa sổ về mặt bộ nhớ. Đây là cải thiện
**trải nghiệm**, không phải tiết kiệm bộ nhớ. (Xem thêm rủi ro lịch sử undo ở §8.)

---

## 4. Thiết kế chi tiết (Giai đoạn 1)

### 4.1 Sơ đồ cây view

```
BaseWindow  (cửa sổ vỏ — thay cho BrowserWindow tài liệu hiện tại)
 └─ contentView (BaseView gốc)
     ├─ tabStripView : WebContentsView  →  shell.html  (thanh tab, cao ~40px, ghim trên cùng)
     └─ docViews[]   : WebContentsView  →  index.html  (mỗi tab một cái)
            • chỉ view của tab đang active được addChildView + set bounds phủ vùng dưới thanh tab
            • các view khác: removeChildView (vẫn sống, không hiển thị)
```

### 4.2 Thành phần MỚI ở main process (`src/tabs.js` — module mới)

Một lớp `TabbedWindow` gói mỗi cửa sổ vỏ:

```
class TabbedWindow {
  base: BaseWindow
  tabStrip: WebContentsView            // shell.html
  tabs: Array<{ id, view, title, dirty, docId, filePath }>
  activeId
  createTab({ openPath })              // tạo docView(index.html); nạp file khi did-finish-load
  activateTab(id)                      // add active view + set bounds; remove view cũ; báo tabStrip
  closeTab(id)                         // guard chưa-lưu → destroy view; nếu hết tab → đóng cửa sổ
  moveTab(id, toIndex)                 // đổi thứ tự; báo tabStrip vẽ lại
  layout()                            // theo base 'resize': đặt bounds tabStrip + active docView
  broadcast(channel, payload)         // gửi tới mọi docView (vd sidecar:status)
}
const tabbedWindows = new Set<TabbedWindow>()
```

- `createTab` tái dùng đúng `webPreferences` của `createWindow` hiện tại (preload, sandbox…).
- `layout()` gọi khi `base.on('resize')` và khi đổi/đóng/mở tab:
  - `tabStrip.setBounds({x:0,y:0,width:W,height:TAB_H})`
  - `activeDocView.setBounds({x:0,y:TAB_H,width:W,height:H-TAB_H})`
- Trạng thái `dirty`/`title` của tab lấy từ tín hiệu renderer (xem §4.5).

### 4.3 Trang vỏ MỚI (`renderer/shell.html` + `shell.js` + preload dùng chung)

- Thuần UI thanh tab: danh sách tab (tiêu đề + dấu ● chưa lưu + nút ✕), nút **＋** (tab mới),
  kéo để sắp xếp.
- Chỉ nói chuyện với main qua IPC (không đụng sidecar, không pdf.js):
  - gửi: `tabs:new`, `tabs:activate(id)`, `tabs:close(id)`, `tabs:move(id, toIndex)`
  - nhận: `tabs:state(tabs[], activeId)` để vẽ lại thanh tab.
- Kéo–thả sắp xếp: HTML5 drag trong thanh tab → `tabs:move`. (Không liên quan tab tearing.)

### 4.4 Định tuyến IPC (thay đổi so với hiện tại)

| Hành vi | Hiện tại | Sau khi có tab |
|---|---|---|
| Menu lệnh (`menu:cmd`) | gửi cửa sổ focus | gửi **docView của tab active** trong cửa sổ focus |
| In (`print`) | `senderWindow(e)` | web contents gọi in **chính là** docView gửi IPC → vẫn đúng (dùng `e.sender`) |
| `sidecar:status` | for-each `windows` | for-each **mọi docView** của mọi `TabbedWindow` |
| Dialog cha (Open/Save…) | `senderWindow(e)` là BrowserWindow | `BaseWindow` là cha; `senderWindow` map `e.sender`→`TabbedWindow.base` |
| Context menu | `attachContextMenu(win)` | `attachContextMenu(docView.webContents)` cho từng tab |

> **Điểm mấu chốt:** phần lớn IPC hiện đã dựa trên `e.sender` (web contents đã gửi). Vì mỗi
> tab là một web contents, các handler thao tác PDF (open/save/export/sign/print…) **hầu như
> chạy đúng nguyên trạng** — chỉ cần đổi cách suy ra "cửa sổ cha" từ web contents sang `BaseWindow`.

### 4.5 Tín hiệu tab (renderer → main, để vẽ thanh tab)

Renderer tài liệu đã có sẵn khái niệm tiêu đề + cờ dirty (`document.title`, `state.dirty`,
`updateDirtyIndicator`). Thêm **một** kênh nhỏ, không đụng logic:
- Khi tiêu đề/dirty đổi, renderer gửi `tab:meta { title, dirty }` (đặt trong `updateDirtyIndicator`
  và sau khi nạp file). Main cập nhật `tab.title/dirty` → `broadcast` `tabs:state` cho tabStrip.
- Đây là bổ sung thuần thông báo; nếu bỏ qua thì app vẫn chạy (thanh tab chỉ kém "tươi").

### 4.6 Vòng đời & guard chưa-lưu

- **Đóng 1 tab:** `tabs:close(id)` → main hỏi docView đó `window:before-close` (đúng cơ chế
  hiện tại) → renderer trả Lưu/Không/Hủy → `window:force-close` → main `view.webContents.destroy()`
  + gỡ khỏi `tabs[]`. Nếu là tab cuối → đóng luôn cửa sổ vỏ.
- **Đóng cả cửa sổ (`base.on('close')`):** duyệt lần lượt các tab dirty, mỗi tab hỏi guard; chỉ
  đóng khi tất cả đã xử lý (hoặc người dùng Hủy → dừng). Tái dùng nguyên logic `window:before-close`
  của renderer — không viết lại hộp thoại.
- **Autosave/recovery:** không đổi — mỗi renderer tự snapshot theo `docId` của nó (đã per-doc).
  Khôi phục sau crash vẫn hoạt động; chỉ cần khi khởi động mở các bản khôi phục thành **tab** thay
  vì cửa sổ (tùy chọn).

### 4.7 Luồng mở file (điểm giao với yêu cầu người dùng)

- **Ctrl+O / menu Mở:** mở vào **tab mới trong cửa sổ hiện tại** (mặc định). Có thể thêm cấu hình
  "mở file vào tab mới / cửa sổ mới".
- **second-instance / open-file / kéo file vào icon / "Open with":** mở **tab mới ở cửa sổ đang
  focus** (thay cho `createWindow`). Nếu chưa có cửa sổ nào → tạo `TabbedWindow` mới.
- **Menu "Cửa sổ mới" (Ctrl+N):** tạo `TabbedWindow` mới (một cửa sổ vỏ mới, một tab trống) →
  giữ khả năng đa cửa sổ song song đa tab.
- **Kéo file thả vào vùng tài liệu:** giữ nguyên (renderer tự xử lý) — mở trong **tab hiện tại**
  (thay tài liệu, có guard chưa-lưu như hiện nay). Nếu muốn "kéo vào để thêm tab" thì cần thả lên
  **thanh tab** (bổ sung nhỏ ở shell.js).

---

## 5. Các bước triển khai (đề xuất, có thể chia PR nhỏ)

1. **Khung vỏ (không chức năng tab):** thêm `src/tabs.js` với `TabbedWindow` tạo `BaseWindow` +
   `tabStripView` + **một** docView; `layout()` theo resize. Chuyển `createWindow` cũ thành
   `createTabbedWindow` gọi `createTab`. Mục tiêu: app mở **y hệt hiện tại** nhưng qua đường mới
   (1 tab). *Checkpoint: mọi chức năng cũ chạy nguyên với 1 tab.*
2. **Thanh tab UI:** `shell.html`/`shell.js` vẽ danh sách tab + nút ＋ + ✕; IPC `tabs:new/activate/close`.
3. **Nhiều tab + chuyển tab:** `activateTab` add/remove childView + set bounds; giữ view sống.
4. **Tín hiệu `tab:meta`** (tiêu đề + ●) từ renderer → cập nhật thanh tab.
5. **Guard đóng tab / đóng cửa sổ** theo §4.6.
6. **Định tuyến lại IPC** menu/sidecar-status/context-menu/dialog cha theo §4.4.
7. **Luồng mở file** (Ctrl+O, second-instance, open-file, New Window) theo §4.7.
8. **Kéo sắp xếp tab** (`tabs:move`).
9. **Đánh bóng:** phím tắt (Ctrl+T tab mới, Ctrl+W đóng tab, Ctrl+Tab chuyển tab), middle-click đóng,
   menu chuột phải trên tab, tiêu đề cửa sổ = tab active.

---

## 6. Lưới kiểm thử (test grid) — GĐ1

| # | Kịch bản | Kỳ vọng |
|---|---|---|
| T1 | Mở 1 file (như cũ) | Hiển thị bình thường, có đúng 1 tab |
| T2 | Mở thêm file → tab mới | 2 tab; tab mới active; tab cũ giữ nguyên trạng thái (kể cả sửa dở) |
| T3 | Chuyển qua lại giữa 2 tab | Tức thì, không reload, không mất cuộn/zoom/undo |
| T4 | Sửa text ở tab A, chuyển sang B rồi về A | Sửa đổi còn nguyên; undo/redo đúng của A |
| T5 | Đóng tab có thay đổi chưa lưu | Hỏi Lưu/Không/Hủy đúng như cửa sổ hiện nay |
| T6 | Đóng tab cuối cùng | Cửa sổ đóng theo |
| T7 | Đóng cả cửa sổ khi có 2 tab dirty | Hỏi lần lượt từng tab; Hủy ở tab nào thì dừng |
| T8 | In từ tab active | In đúng tài liệu của tab đang xem |
| T9 | Trạng thái sidecar (starting→ready) | Mọi tab nhận cập nhật badge |
| T10 | Resize / maximize / phóng to | Thanh tab + view tài liệu co giãn đúng, không hở/đè |
| T11 | Kéo sắp xếp thứ tự tab | Thứ tự đổi, tab active không đổi nội dung |
| T12 | second-instance: mở file khi app đang chạy | Thành **tab mới** ở cửa sổ focus (không mở cửa sổ mới) |
| T13 | "Cửa sổ mới" (Ctrl+N) | Cửa sổ vỏ mới, độc lập, có tab riêng |
| T14 | Crash rồi mở lại | Recovery vẫn hỏi khôi phục (mở thành tab) |
| T15 | Đa cửa sổ, mỗi cửa sổ nhiều tab, đóng app | Guard chạy cho mọi tab dirty ở mọi cửa sổ |
| T16 | Editor overlay / ký số / so sánh trong một tab | Hoạt động như cửa sổ đơn (mỗi tab web contents riêng) |

---

## 7. Rủi ro & giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Chuyển `BrowserWindow`→`BaseWindow` làm lệch các chỗ giả định là BrowserWindow (dialog cha, print, updater `primaryWindow`) | Trung bình | Bọc: nơi cần "cửa sổ", trả `TabbedWindow.base`; rà soát mọi tham chiếu `BrowserWindow.*` |
| Bounds view sai khi resize/DPI/maximize | Trung bình | `layout()` tập trung một chỗ, gọi trên mọi sự kiện đổi kích thước |
| Guard đóng nhiều tab dirty thành chuỗi async phức tạp | Trung bình | Xử lý tuần tự (await từng tab), tái dùng đúng cơ chế `window:before-close` |
| Menu/phím tắt gửi nhầm tab | Thấp | Luôn resolve theo cửa sổ focus → tab active của nó |
| RAM khi nhiều tab file lớn | Trung bình | Không phải mới do tab; xem §8 (giới hạn undo) — nên xử lý kèm |
| Tab tearing (GĐ2) | Cao | Tách hẳn giai đoạn sau; GĐ1 không phụ thuộc |

---

## 8. Vấn đề liên quan phát hiện khi khảo sát (ngoài phạm vi, nêu để cân nhắc)

- **Lịch sử undo giữ tối đa 30 bản sao TOÀN tài liệu** (`HISTORY_LIMIT=30`, mỗi bản là
  `state.bytes.slice()`). Với file 130 MB, sau nhiều lần sửa, riêng undo có thể chiếm tới ~4 GB
  → nguy cơ hết bộ nhớ khi sửa nhiều lần trên file lớn (khác với lỗi trắng trang lần-sửa-đầu đã
  vá). Khi làm tab (nhiều tài liệu lớn cùng lúc) rủi ro này tăng. *Gợi ý:* giới hạn theo tổng
  dung lượng, hoặc giảm `HISTORY_LIMIT` theo kích thước file, hoặc lưu snapshot ra đĩa. — **Chưa
  sửa; nêu để bạn quyết.**

---

## 9. Ước lượng công sức (GĐ1)

- Khung vỏ + thanh tab + chuyển/đóng/mở tab + định tuyến IPC + guard: **~2–3 ngày công**.
- Đánh bóng (phím tắt, kéo sắp xếp, menu chuột phải tab): **~1 ngày**.
- Tab tearing (GĐ2): **nhiều ngày, rủi ro cao** — cân nhắc riêng.
