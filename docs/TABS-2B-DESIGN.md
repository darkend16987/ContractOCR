# Lớp 2b — Tách tab thành cửa sổ riêng (tab tearing)

_Lập 2026-07-25. Tiếp nối `docs/TABS-DESIGN.md` (GĐ2, mục được đánh dấu “rủi ro cao”)._
_Đọc kèm: `docs/REGRESSION-GUARD.md`._

---

## 1. Việc này xong khi nào

> Kéo một tab ra khỏi thanh tab và thả ra ngoài → tab đó trở thành **cửa sổ riêng**,
> **tài liệu bên trong không bị nạp lại**: nội dung đang sửa, lịch sử hoàn tác, phiên
> chú thích, cuộn/zoom giữ nguyên y như trước khi kéo. Kéo thả vào thanh tab của một
> cửa sổ khác → tab **nhập** vào cửa sổ đó. Cửa sổ nguồn hết tab thì tự đóng.

Không đạt tiêu chí này thì tính năng **vô giá trị và nguy hiểm** — người dùng mất
việc đang làm dở chỉ vì lỡ tay kéo.

---

## 2. Hai giả định phải kiểm chứng trước khi viết code

Cả tính năng đứng trên hai giả định. Tôi không suy luận từ trí nhớ mà dựng probe chạy thật
(`scratchpad/probe/`).

### 2.1 Giả định A — “`WebContentsView` đang sống chuyển được sang `BaseWindow` khác”

**Đã CHỨNG MINH.** Probe A tự động hoàn toàn: nạp một trang có bộ đếm chạy nền + một mã
`boot` ngẫu nhiên sinh một lần mỗi lần **load**, rồi `removeChildView` khỏi cửa sổ A và
`addChildView` sang cửa sổ B (kích thước khác), sau đó **huỷ cửa sổ A**, rồi chuyển tiếp
sang cửa sổ C.

| Kiểm chứng | Kết quả |
|---|---|
| Cùng một renderer (mã `boot` không đổi) sau **2 lần** chuyển | ✅ |
| `did-finish-load` vẫn đếm **1** — chưa hề nạp lại | ✅ |
| Bộ đếm vẫn chạy sau khi chuyển | ✅ |
| Bố cục lại theo kích thước cửa sổ mới (`innerWidth/Height` đổi đúng) | ✅ |
| Thực sự có vẽ ở cửa sổ mới (`capturePage` không rỗng, đúng kích thước) | ✅ |
| Sống sót khi **cửa sổ nguồn bị huỷ** | ✅ |
| `render-process-gone` | không xảy ra |

→ Nền của 2b an toàn. **Đây là kết quả quan trọng nhất của cả đợt nghiên cứu.**

### 2.2 Giả định B — “thanh tab biết được cú thả xảy ra bên ngoài nó”

**KHÔNG chứng minh được bằng máy.** Thanh tab chỉ cao 40px; muốn tách tab thì phải biết
con trỏ đã rời khỏi nó. Tôi dựng probe bơm chuột thật ở mức OS (`SetCursorPos` +
`mouse_event` qua PowerShell) và gặp hai rào:

1. **Sandbox của công cụ chặn bơm input** — `SetCursorPos` trả `True` nhưng con trỏ nhảy
   sai chỗ. Chỉ chạy được khi tắt sandbox.
2. Tắt sandbox rồi thì Chromium **bỏ qua phần lớn input tổng hợp** trong đường kéo–thả:
   dù `WindowFromPoint` xác nhận điểm nhấn nằm đúng trên cửa sổ probe và cửa sổ probe
   đang là foreground, renderer thanh tab **không nhận được `pointerdown`/`dragstart`**.

Ba lần chạy chỉ lọt vài sự kiện rời rạc. **Kết luận trung thực: cử chỉ kéo phải do tay
người kiểm thử.** Vì vậy §3 chọn cơ chế mà **kịch bản hỏng là “không làm gì cả”**, chứ
không phải “làm sai”.

### 2.3 Những thứ probe VẪN xác lập được (có giá trị thật)

- **B-1 · Kéo tab qua vùng tài liệu là vô hại.** Renderer tài liệu nhận `dragenter`/
  `dragover` với `dataTransfer.types === []`. Guard sẵn có ở `app.js:3591,3607`
  (`types.includes("Files")`) khiến nó **im lặng tuyệt đối** — không có nguy cơ tab bị
  hiểu nhầm thành file thả vào.
- **B-2 · `event.screenX/screenY` trong một `WebContentsView` KHÔNG đáng tin.** Đo được
  lệch **26px** so với gốc vùng nội dung (nó tính từ khung cửa sổ, không phải content).
  → **Không bao giờ dùng toạ độ từ renderer để quyết định thả.** Main phải tự hỏi
  `screen.getCursorScreenPoint()`. Đây là cái bẫy suýt nữa thì dính.
- **B-3** Vùng tài liệu *có* tham gia phiên kéo → phiên kéo đi xuyên ranh giới view,
  không bị nhốt trong thanh tab.

---

## 3. Cơ chế đã chọn

### 3.1 Tín hiệu: `dragend` + con trỏ đọc từ main

Thanh tab **đang dùng HTML5 drag-and-drop** cho việc sắp xếp (đã phát hành v0.2.41).
Giữ nguyên, chỉ thay việc làm ở `dragend`:

```
shell.js  dragend  ──►  tabs:drag-end { id, order }        (KHÔNG kèm toạ độ)
main.js            ──►  điểm = screen.getCursorScreenPoint()
                   ──►  classifyDrop(điểm, …)  →  reorder | move | tear
```

Vì sao chọn đường này:

| | |
|---|---|
| **`dragend` luôn bắn** | Chuẩn HTML quy định `dragend` bắn tại **node nguồn** ở cuối mọi phiên kéo, bất kể thả ở đâu. Nó cũng **đã là** đường sống của tính năng sắp xếp hiện hành — không thêm phụ thuộc mới nào. |
| **Toạ độ lấy ở main** | Né hẳn B-2. `screen.getCursorScreenPoint()` trả DIP màn hình, cùng hệ với `base.getContentBounds()` → so sánh được trực tiếp. |
| **Hỏng thì không làm gì** | Nếu `dragend` không bắn: **không tách, tab đứng yên**. Không mất dữ liệu, không cửa sổ ma. Đây là lý do chính chọn cơ chế này thay vì bám đuổi con trỏ. |

### 3.2 Luật phân loại cú thả (thuần số học, test được)

`classifyDrop(point, sourceRect, targets, pad)` — không đụng Electron, không đụng DOM:

1. Điểm nằm trong thanh tab của **chính** cửa sổ nguồn → **reorder** (giữ nguyên hành vi cũ).
2. Điểm nằm trong thanh tab của **cửa sổ khác** → **move** sang cửa sổ đó.
3. Điểm nằm trong thanh tab nguồn đã **nới rộng** `pad` (24px ngang, 60px dọc) → **reorder**.
   *Vùng đệm này chống tách nhầm khi tay run lúc sắp xếp.*
4. Còn lại → **tear** (cửa sổ mới tại vị trí con trỏ).

Chặn cứng, không có ngoại lệ:

- **Không tách tab duy nhất của một cửa sổ.** Vô nghĩa (chỉ tạo lại đúng cửa sổ đó) và
  là nguồn của mọi lỗi “cửa sổ rỗng”. Chrome cũng vậy.
- **Không tách tab đang chờ quyết định đóng** (`_pendingClose`) — nếu không thì hộp thoại
  “Lưu / Không lưu / Huỷ” mồ côi ở cửa sổ đã biến mất.

### 3.3 Đường đi chắc chắn thứ hai: chuột phải lên tab

Cử chỉ kéo phụ thuộc nhiều thứ ngoài tầm; **menu chuột phải thì không**. Nó là lối vào
xác định 100% của cùng một khả năng, và cũng dễ khám phá hơn:

```
Tab mới                     Ctrl+T
────────────────────────────────────
Tách ra cửa sổ riêng        (mờ khi chỉ còn 1 tab)
Chuyển tới cửa sổ        ▸  (ẩn khi không có cửa sổ khác)
────────────────────────────────────
Đóng tab                    Ctrl+W
```

### 3.4 Nguyên hàm: `detachTab` / `adoptTab`

Mọi thứ ở trên quy về hai hàm, tách bạch với `destroyTab`:

- `detachTab(id)` — gỡ khỏi `tabs[]` và khỏi cây view, **không** đụng `webContents`.
  Trả về bản ghi tab. Sau đó **bắt buộc** phải có người nhận (nếu không là rò tiến trình).
- `adoptTab(tab)` — nhận bản ghi tab, `addChildView`, kích hoạt.

`destroyTab` (đường đóng tab) **không đổi một dòng nào** — đó là ranh giới an toàn giữa
“chuyển nhà” và “khai tử”.

---

## 4. Bẫy đã rà và cách xử lý

| # | Bẫy | Vì sao chết người | Xử lý |
|---|---|---|---|
| T1 | `bindTabKeys` đóng gói `this` = cửa sổ **cũ** | Sau khi tách, Ctrl+Tab / Ctrl+1–9 trong tab đó điều khiển cửa sổ cũ (có thể đã bị huỷ) → `TypeError` hoặc chuyển nhầm tab ở cửa sổ khác | Đổi sang tra chủ sở hữu **động** (`ownerOf(webContents)`) tại thời điểm gõ phím. Listener chỉ gắn **một lần** lúc tạo tab, không gắn lại khi nhận nuôi (tránh nhân đôi). |
| T2 | `_onClosed` đóng `webContents` của mọi tab trong `tabs[]` | Nếu tách rồi cửa sổ nguồn đóng mà tab chưa kịp rời `tabs[]` → **giết tài liệu vừa tách** | `detachTab` xoá khỏi `tabs[]` **trước**, đồng bộ, rồi mới bàn giao |
| T3 | Cửa sổ nguồn rỗng sau khi chuyển tab cuối | Cửa sổ trắng trơ | Nguồn hết tab → `_forceClose = true` rồi `close()`. Không chạy guard chưa-lưu (tab đã sang nhà mới cùng nguyên trạng dirty) |
| T4 | Cửa sổ mới tạo ra ngoài màn hình | Người dùng mất tab | Kẹp vào `workArea` của màn hình chứa con trỏ |
| T5 | `_pendingClose` treo sau khi chuyển | Main chờ vĩnh viễn một câu trả lời từ cửa sổ đã chết | Cấm tách khi đang chờ (§3.2) |
| T6 | Thả tab vào ứng dụng khác chèn text lạ | `setData("text/plain", id)` | **Giữ nguyên** — giống hệt hành vi kéo tab của Chrome (Jakob's Law), và sửa nó là đụng vào đường sắp xếp đang chạy tốt mà không có cách test tự động |
| T7 | `senderWindow`, `tab:meta`, guard đóng trỏ nhầm cửa sổ | Hộp thoại mở sai cửa sổ cha | **Không cần sửa** — cả ba đã tra bằng `Tabs.findDoc()` quét mọi cửa sổ nên tự bám theo tab. Đã rà lại từng chỗ. |
| T8 | Chèn đúng vị trí khi thả vào cửa sổ khác | Main không biết bố cục pixel của thanh tab đích | v1 **nối vào cuối**. Đơn giản, đoán trước được; muốn khác thì kéo sắp xếp tiếp. Ghi rõ trong lưới test. |

---

## 5. Bất biến mới (bổ sung cho REGRESSION-GUARD §3)

- **BI-15 · `detachTab` không bao giờ được đóng `webContents`.** Chỉ `destroyTab` mới có
  quyền đó. Trộn hai đường này = tách tab làm mất tài liệu.
- **BI-16 · Sau `detachTab`, tab BẮT BUỘC có người nhận.** Không nhận nuôi = một tiến
  trình renderer mồ côi giữ nguyên RAM của cả tài liệu, không lối nào đóng được.
- **BI-17 · Đường tắt bàn phím của tab phải tra chủ sở hữu động.** Đừng đóng gói `this`
  vào listener `before-input-event` của một webContents có thể đổi cửa sổ.

---

## 6. Lưới kiểm thử

### 6.1 Tự động (`npm run test:tabs`)

Phần thuần logic — chạy được không cần GUI:
`classifyDrop` (4 luật + vùng đệm + biên), `detachTab` (sổ sách `tabs[]`/`activeId`,
không đụng webContents), `adoptTab`, và điều kiện chặn tách.

### 6.2 Tay (bắt buộc — cử chỉ kéo máy không test được)

| # | Thao tác | Kỳ vọng |
|---|---|---|
| 1 | Mở 3 tab, kéo tab giữa **thả trong thanh tab** | Sắp xếp lại như cũ. **Không** sinh cửa sổ mới _(kiểm tra hồi quy v0.2.41)_ |
| 2 | Kéo một tab thả xuống **giữa vùng tài liệu** | Thành cửa sổ riêng tại chỗ thả |
| 3 | Tab ở #2 phải **sửa dở** (có chấm ●) trước khi kéo | Sang cửa sổ mới: nội dung sửa còn nguyên, chấm ● còn, Ctrl+Z hoàn tác đúng bước |
| 4 | Kéo tab đang **chú thích dở** ra | Phiên chú thích còn nguyên, không nạp lại trang |
| 5 | Kéo tab thả **hơi lệch xuống dưới thanh tab ~30px** | Vẫn là sắp xếp, **không** tách (vùng đệm) |
| 6 | Cửa sổ chỉ có **1 tab**, kéo ra ngoài | Không có gì xảy ra, tab đứng yên |
| 7 | Kéo tab từ cửa sổ A thả vào **thanh tab cửa sổ B** | Tab sang B (nối cuối), A còn lại đúng số tab, B được focus |
| 8 | Lặp #7 cho tới khi A hết tab | A **tự đóng**, không hỏi lưu |
| 9 | Sau khi tách: bấm **Ctrl+Tab / Ctrl+2** trong cửa sổ mới | Chuyển tab của **cửa sổ mới**, không đụng cửa sổ cũ _(T1)_ |
| 10 | Sau khi tách: **In** ở cửa sổ mới | In đúng tài liệu đó |
| 11 | Sau khi tách: **Lưu thành…** ở cửa sổ mới | Hộp thoại mở làm con của **cửa sổ mới** |
| 12 | Sau khi tách: đóng cửa sổ mới khi tài liệu bẩn | Hỏi Lưu/Không/Huỷ; bấm Huỷ thì cửa sổ ở lại |
| 13 | Chuột phải lên tab → **Tách ra cửa sổ riêng** | Như #2 |
| 14 | Chuột phải lên tab khi chỉ còn **1 tab** | Mục “Tách ra cửa sổ riêng” **mờ** |
| 15 | Chuột phải → **Chuyển tới cửa sổ ▸** | Liệt kê đúng các cửa sổ khác; chọn thì tab chuyển sang |
| 16 | Kéo tab thả ra **ngoài màn hình / sát mép** | Cửa sổ mới vẫn nằm trong vùng nhìn thấy _(T4)_ |
| 17 | Kéo tab thả vào **vùng tài liệu** của cửa sổ khác | Tách thành cửa sổ riêng (không nhập vào cửa sổ đó) — đúng thiết kế |
| 18 | Trạng thái sidecar (badge OCR) ở cửa sổ vừa tách | Vẫn nhận cập nhật |

---

## 7. Ngoài phạm vi (cố ý)

- **Xem trước lúc kéo** (ảnh tab bay theo con trỏ như Chrome). Chromium tự vẽ ảnh kéo
  mặc định của phần tử tab — đủ dùng. Làm cửa sổ preview thật đắt và rủi ro.
- **Kéo cả cửa sổ thả vào cửa sổ khác** (`docs/TABS-DESIGN.md` §1). Cần hook vào việc di
  chuyển cửa sổ ở mức OS — hạng mục riêng.
- **Chèn đúng vị trí** khi thả vào cửa sổ khác — xem T8.
- **Khôi phục phiên** (mở lại đúng bộ tab lần trước).
