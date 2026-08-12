# SPEC — Kéo trang từ tài liệu A sang tài liệu B (2 cửa sổ)

_Lập 2026-08-12. Trạng thái: **đã thi công B1→B5 + B7 — xem §10**. Còn B6 + 22 mục test tay (§7.1)._
_§1–§9 giữ nguyên là bản thiết kế trước khi code; §10 ghi những chỗ thi công đi lệch và vì sao._
_Đọc kèm: `docs/TABS-2B-DESIGN.md` (cơ chế thả liên cửa sổ đã phát hành), `docs/REGRESSION-GUARD.md`._

---

## 1. Câu hỏi của người dùng

> Mở 2 file PDF ở 2 cửa sổ, kéo 1 trang ở File A và thả vào File B — có được không?

## 2. Kết luận ngắn

**Khả thi.** Không cần đổi kiến trúc, không cần thư viện mới, không đụng vào định dạng
PDF. Ba mảnh cần thiết **đều đã có sẵn và đã chạy thật trong bản phát hành**:

| Mảnh cần | Đã có ở đâu | Bằng chứng |
|---|---|---|
| Nhiều cửa sổ, mỗi tab là một renderer độc lập | `BaseWindow` + `WebContentsView` | `desktop/src/tabs.js:23`, `window:new` tại `desktop/src/main.js:798` |
| Biết được cú thả **liên cửa sổ** rơi vào cửa sổ nào | `dragend` + con trỏ đọc từ main | `desktop/src/main.js:829` → `classifyDrop` (`desktop/src/tabs.js:623`) → `handleDragEnd` (`:661`) |
| Chèn trang lạ vào tài liệu đang mở (undo, dirty, autosave đầy đủ) | `insertBuffersAt` | `desktop/renderer/app.js:1749` (đang phục vụ Chèn trang + kéo file PDF từ Explorer vào cột trang) |
| Bóc trang ra thành PDF nhỏ | `extractSelected` dùng `copyPages` | `desktop/renderer/app.js:1808` |
| Kéo–thả sắp xếp trong cùng tài liệu | `wireThumb` (HTML5 DnD) | `desktop/renderer/app.js:1404` |

Việc phải làm mới chỉ là **đường ống chuyển trang giữa hai renderer** và **luật phân loại
cú thả**, đúng khuôn mẫu đã dùng cho tách tab.

**Mức công việc:** ~250–300 dòng thật (main + preload + renderer) + 1 lưới test thuần số
học + 1 lưới test tay. Rủi ro hồi quy **thấp** nếu tuân thủ §5.

---

## 3. Ba phương án, và vì sao chọn phương án 2

### 3.1 PA1 — Kéo file thật ra ngoài (`webContents.startDrag`)

Bóc trang ra file PDF tạm rồi khởi tạo **kéo cấp OS**. Cửa sổ B nhận được như một file
`.pdf` thả vào → **đường đón đã có sẵn nguyên vẹn**: `wireThumb` đã xử lý `Files` +
vẽ cue khe chèn + gọi `insertBuffersAt` (`app.js:1404–1500`). Bonus: kéo được cả sang
Explorer/Outlook.

**Bác bỏ cho v1.** `startDrag` phải quyết định **ngay lúc `dragstart`** và nó **thay thế**
phiên HTML5 DnD. Lúc đó chưa biết người dùng sẽ thả trong hay ngoài cửa sổ ⇒ muốn dùng nó
thì phải **hy sinh đường sắp xếp nội bộ** (kéo trong cùng tài liệu sẽ biến thành "chèn bản
copy" thay vì "di chuyển") — tức đụng thẳng vào tính năng cũ đang chạy tốt. Giữ lại làm
**tính năng riêng về sau**: "kéo trang ra desktop thành file".

### 3.2 PA2 — `dragend` + con trỏ đọc từ main ✅ **CHỌN**

Đúng cơ chế của tách tab (`TABS-2B-DESIGN.md` §3.1), chỉ đổi payload từ "một tab" thành
"một/nhiều trang":

Sơ đồ dưới đây là **đường đã thi công** (bản thiết kế ban đầu cho đích *xin* bytes bằng một
token; thi công thì main **tự đẩy** — xem §10.1 mục 2, chặt hơn và bớt một khái niệm):

```
A: thumb dragstart ──► pages:drag-start     main: ghi nhớ webContents nguồn
                                                  bật vòng đọc con trỏ 80ms + watchdog 30s
   (đang kéo)                               main → cửa sổ dưới con trỏ:
                    ◄── pages:hover {x,y}         toạ độ ĐÃ đổi về hệ client của view tài liệu
B: vẽ cue khe chèn (elementFromPoint → thumbGapAt)   ← ĐÚNG HÀM CỦA ĐƯỜNG CŨ
A: thumb dragend   ──► pages:drag-end       main: điểm = screen.getCursorScreenPoint()
                                                  classifyPageDrop(…) → self | send(B) | none
                                            main → B: pages:can-accept {at}   ← hỏi ĐÍCH TRƯỚC
B: gap = gapAt(at) ─────────────────────────────► {ok, gap}   (không phải khe chèn ⇒ ok:false)
                                            main → A: pages:export
A: pdf-lib copyPages → Uint8Array ──────────────► main → B: pages:receive {bytes, gap}
B: insertBuffersAt(bytes, gap)   ← ĐƯỜNG CŨ
B: {ok, inserted} chỉ khi numPages THẬT SỰ tăng ─► main → A: kết quả của pages:drag-end
A: deletePages(indices)   ← chỉ khi giữ Shift, ok, và tài liệu A không đổi (BI-56)
```

Ưu điểm quyết định:

- **`dragend` luôn bắn** ở node nguồn, bất kể thả ở đâu (chuẩn HTML), và **đang là** đường
  sống của tính năng sắp xếp trang hiện hành ⇒ không thêm phụ thuộc mới.
- **Toạ độ lấy ở main.** Né bẫy đã đo được: `event.screenX/screenY` trong một
  `WebContentsView` lệch ~26px (`TABS-2B-DESIGN.md` §2.3 / B-2). Main dùng
  `getContentBounds()` trừ đi dải tab 40px — đúng số học `stripScreenRect` (`tabs.js:413`)
  đã chạy thật.
- **Hỏng thì không làm gì.** Mất tín hiệu ở bất kỳ chặng nào ⇒ trang **ở lại A**, B không
  đổi. Không có trạng thái nửa vời.
- **Không viết logic PDF mới.** Bóc dùng `copyPages` như `extractSelected`, chèn dùng
  đúng `insertBuffersAt` ⇒ undo/dirty/autosave/recovery có sẵn (`pushUndo` →
  `markDirty`, `app.js:167,265`).

### 3.3 PA3 — Dùng MIME type riêng, để B tự đọc payload lúc `drop`

Đặt `setData("application/x-nabu-pages", …)` rồi để B đọc trong `drop` của chính nó. Nếu
Chromium giữ được custom type qua ranh giới cửa sổ thì **cue chèn là native, real-time,
không cần vòng đọc con trỏ nào**.

**Chưa chứng minh được.** Chromium chạy DnD liên cửa sổ qua clipboard OS và chặn đọc data
trong lúc `dragover` (protected mode); còn `drop` có bắn ở cửa sổ khác hay không thì
**phải thử tay** — §2.2 của TABS-2B-DESIGN đã chứng minh **máy không bơm được cử chỉ kéo**
(Chromium bỏ qua input tổng hợp trong đường DnD; 3 lần chạy chỉ lọt vài sự kiện rời rạc).

→ **Thứ tự làm đúng:** dựng PA2 (tự chủ 100%), rồi **thử tay 5 phút** xem B có nhận
`dragover`/`drop` không. Có thì **bỏ vòng đọc con trỏ**, dùng cue native. Không thì giữ
vòng đọc con trỏ. Kiến trúc không đổi theo kết quả — chỉ khác nguồn của cue.

---

## 4. Phạm vi: cái gì kéo được, cái gì KHÔNG

| Tình huống | Kéo được? | Vì sao |
|---|---|---|
| Hai **cửa sổ** cạnh nhau | ✅ | Đúng phạm vi PA2 |
| Hai **tab** trong cùng một cửa sổ | ❌ **về nguyên tắc** | Chỉ view của tab **đang hoạt động** được gắn vào cây (`tabs.js` `_layout`); tab kia **không có mặt trên màn hình** để mà thả vào. Không phải hạn chế cài đặt — không có đích để nhắm. |
| Cửa sổ đích đang **chú thích / sửa chữ** | ❌ từ chối | Cấu trúc trang bị đóng băng — cùng luật với `openThumbMenu` (`app.js:1515–1519`) và `updateToolbar` |
| Cửa sổ đích **chưa mở tài liệu** | ❌ từ chối (v1) | `insertBuffersAt` cần `state.bytes`. Mở-thành-tài-liệu-mới là việc khác, để sau. **Đã chốt §9.4** → cách từ chối: §4.1 |
| Cửa sổ đích **thu gọn cột trang** | ✅ tự bung | **Đã chốt §9.4** → cơ chế bung: §4.1 |

**Vì mục "hai tab" là ❌**, tính năng **bắt buộc** có đường thứ hai xác định 100% —
đúng khuôn `TABS-2B-DESIGN.md` §3.3 (chuột phải lên tab):

> Chuột phải lên trang → **“Chuyển trang tới ▸”** → liệt kê mọi tab của mọi cửa sổ
> (`Cửa sổ 2 · hopdong.pdf`) → chọn → hỏi vị trí chèn (`choosePosition`, đã có).

Đường này **không phụ thuộc cử chỉ kéo**, chạy cho **cả tab lẫn cửa sổ**, test được, và
dễ khám phá hơn.

### 4.1 Hai ca biên của cửa sổ đích (chốt §9.4)

**a) Cột trang đang thu gọn ⇒ tự bung, kiểu "spring-loaded".**

Không có cột trang thì **không có khe chèn để nhắm** — cue vô nghĩa và cú thả không có toạ
độ nào diễn giải được. Vì vậy khi `pages:hover` rơi vào một cửa sổ đang thu gọn:

- Bung sau **~300ms dừng chân** (`toggleSidebar(false)`, `app.js:2298`) — không bung tức
  thì, vì con trỏ chỉ **bay qua** một cửa sổ trên đường đến cửa sổ khác là chuyện thường,
  và một cột trang nhảy ra rồi thụt vào theo mỗi cú lướt là nhiễu thị giác.
- **Nhớ trạng thái cũ và trả lại** nếu phiên kéo kết thúc mà **không** thả vào cửa sổ này
  (`pages:drag-cancel`, hoặc token đổi). Đây là điểm khiến "tự bung" an toàn: nó **không
  để lại dấu vết** khi người dùng chỉ đi ngang. Đúng quy ước spring-loaded folder của
  Explorer/Finder — người dùng đã biết cử chỉ này.
- Đường **menu** thì đơn giản hơn: chèn xong mới bung, để người dùng **thấy** trang vừa
  đáp xuống đâu (`insertBuffersAt` đã chọn sẵn trang đầu tiên vừa chèn).

**b) Chưa mở tài liệu ⇒ từ chối, nhưng phải từ chối ĐÚNG CHỖ.**

Người bấm/kéo đang nhìn cửa sổ **nguồn**. Một toast mọc ở cửa sổ đích là lời từ chối
**không ai đọc**. Vì vậy:

- Lý do từ chối luôn được **báo về nguồn** và hiện toast ở đó ("Cửa sổ đích chưa mở tài
  liệu nào." / "Cửa sổ đích đang chú thích dở."). Cùng một đường cho mọi lý do ở §4.
- Riêng đường **menu** thì đi xa hơn: **không bao giờ liệt kê một đích sẽ từ chối.** Tab
  nào không nhận được thì **làm mờ** kèm lý do ngay trong menu. Làm được vì mỗi renderer
  **đã** báo `tab:meta { title, dirty }` lên main (`preload.js` `setTabMeta`) — chỉ cần
  thêm một cờ `acceptsPages` vào đúng payload đó, không mở channel mới. Menu vì thế
  **không thể** mời một đích rồi mới báo lỗi.

---

> **Đã chốt (§9.1): v1 làm CẢ HAI đường.** Nhưng thứ tự thi công là **menu trước, kéo sau**
> — cùng một bản phát hành, khác thứ tự viết code. Lý do: menu dùng **đúng đường ống chuyển
> trang** của kéo–thả, chỉ khác cách chọn đích, nên làm nó trước là chứng minh được đường
> ống bằng thao tác **bấm chuột test được**, rồi mới cột cử chỉ kéo — thứ duy nhất máy
> không kiểm được — lên trên một nền đã chắc.

---

## 5. Bẫy đã rà (phải xử lý ngay từ bản nháp đầu)

| # | Bẫy | Vì sao chết người | Xử lý |
|---|---|---|---|
| P1 | Renderer tự khai "tôi là tài liệu X" | Một renderer bị lỗi/độc có thể xin bytes của tài liệu khác | **Token do main phát**, gắn cứng vào `webContents` nguồn tại `pages:drag-start`; main không bao giờ tin `docId` do renderer gửi. Token **một lần dùng**, hết hạn khi `dragend` hoặc sau ~30s |
| P2 | MOVE làm mất trang khi chèn thất bại | Mất tài liệu của người dùng — hậu quả nặng nhất trong repo | **Thứ tự bắt buộc:** B chèn xong + `state.bytes` đã đổi ⇒ mới báo về A ⇒ A `deletePages`. Bất kỳ lỗi/timeout ⇒ A **không xoá gì**. Kịch bản hỏng tệ nhất là **trang bị nhân đôi** (thấy được, Ctrl+Z được), không phải mất trang. _Đã chốt COPY là mặc định (§9.2) nên bẫy này chỉ còn áp cho nhánh Shift+MOVE và nút "Xoá khỏi bản gốc" — cả hai đi qua đúng một hàm._ |
| P3 | `state.dragSrc` của A dính lại sau khi thả ra ngoài | Lần hover sau vẽ cue cho phiên kéo đã chết | Đã có `dragend` dọn (`app.js:1450`) — **giữ nguyên**, chỉ thêm việc, không sửa việc cũ |
| P4 | Cue ở B không dọn khi con trỏ rời đi | Vạch chèn đứng chết trên màn hình | Main gửi `pages:hover` **kèm token**; B tự dọn khi (a) token đổi, (b) nhận `pages:drag-cancel`, (c) 300ms không có hover mới |
| P5 | Vòng đọc con trỏ chạy mãi | Tốn CPU vô nghĩa, và một `dragend` bị mất ⇒ treo vòng | Vòng **chỉ sống** giữa `drag-start` và `drag-end`, có **watchdog cứng** (mất `dragend` ⇒ tự tắt sau 30s, coi như huỷ) |
| P6 | Kéo trong cùng cột trang bị hiểu thành "gửi sang cửa sổ khác" | Phá tính năng sắp xếp đang chạy tốt (v0.2.41+) | `classifyPageDrop` **ưu tiên tuyệt đối** cửa sổ nguồn — bê nguyên luật thứ tự của `classifyDrop` (`tabs.js:623`: "source strip wins an exact hit"). Điểm nằm trong cửa sổ nguồn ⇒ **luôn** là đường cũ, không IPC gì cả |
| P7 | Thả ra vùng trống / ứng dụng khác | Sinh cửa sổ ma, hoặc chèn text lạ vào app khác | Không có đích ⇒ **không làm gì** (khác với tab: **không** "tear" trang thành cửa sổ mới ở v1). `setData` giữ đúng type nội bộ như hiện hành |
| P8 | Tài liệu đích đang chèn thì người dùng đóng tab/cửa sổ | Renderer chết giữa đường ống | Mọi `webContents.send` bọc `try/catch` như tabs.js đang làm; A chỉ xoá khi nhận **xác nhận thật** (P2) |
| P9 | Payload IPC quá lớn | Kéo 50 trang scan = hàng trăm MB qua IPC | Có tiền lệ (`recovery:save`, `dialog:open-pdf` đều chuyển cả tài liệu), nhưng đặt **trần rõ ràng** + báo "đang chuyển…" bằng `showOverlay` đã có |
| P10 | Chú thích/form trên trang được copy | Người dùng tưởng mất chú thích | **Không phát sinh mới**: dùng đúng `copyPages` mà "Ghép PDF"/"Chèn trang" đang dùng ⇒ hành vi y như hiện tại. Ghi vào tài liệu hướng dẫn, không sửa gì |
| P12 | Cột trang tự bung rồi **ở lại** dù người dùng chỉ đi ngang | Tính năng mới âm thầm đổi bố cục cửa sổ người dùng đã cố ý thu gọn | Nhớ trạng thái trước khi bung, **trả lại** khi phiên kéo không thả vào cửa sổ này (§4.1a). Bung có **dừng chân 300ms**, không bung theo mỗi cú lướt |
| P13 | Lý do từ chối hiện ở cửa sổ **đích** | Người dùng đang nhìn cửa sổ nguồn ⇒ thao tác "im lặng thất bại" | Mọi lý do từ chối **báo về nguồn** (§4.1b); menu thì làm mờ đích không nhận **trước khi** người dùng bấm, qua cờ `acceptsPages` trong `tab:meta` sẵn có |
| P11 | Gating Pro | Tính năng Pro lọt ra bản Free qua đường mới | `insertBuffersAt` **đã** gọi `gateProFeature()` (`app.js:1750`) ⇒ đường chèn tự khoá. Phải khoá thêm ở **nguồn** (`pages:drag-start`) để không kéo được rồi mới báo lỗi |

---

## 6. Bất biến mới (bổ sung REGRESSION-GUARD §3)

- **BI-55 · Token trang do MAIN phát, không bao giờ do renderer khai.** Đổi luật này là mở
  đường cho một tab đọc bytes của tab khác.
- **BI-56 · MOVE = chèn-xác-nhận-rồi-mới-xoá.** Không bao giờ xoá ở nguồn trước, hoặc song
  song với, việc chèn ở đích. Hỏng phải ra "trang nhân đôi", không được ra "trang biến mất".
- **BI-57 · Điểm thả nằm trong cửa sổ nguồn ⇒ luôn là đường sắp xếp cũ.** Đường liên cửa sổ
  không được phép chen vào một cú kéo nội bộ.
- **BI-58 · Vòng đọc con trỏ phải có watchdog.** Không có `dragend` nào được phép để lại một
  timer sống.

---

## 7. Kế hoạch từng bước

| Bước | Việc | File | Test |
|---|---|---|---|
| B0 | Chốt các quyết định ở §9 — **xong 3/4 ngày 2026-08-12**, còn mục 4 | — | — |
| B1 | `classifyPageDrop(point, sourceKey, rects, pad)` + `docViewScreenRect()` + `dragSetOf(dragged, ticked)` (§9.3) — thuần số học, không Electron/DOM | `src/tabs.js`, `renderer/page-range.js` | **mới** `test/page-drop.test.js` (`npm run test:pagedrop`): 4 luật + biên + vùng đệm + toạ độ rác + `dragSetOf`, đúng khuôn `test/tabs-logic.test.js` |
| B2 | Đường ống main: `pages:drag-start` (mint token) / `pages:hover` / `pages:drag-end` / `pages:fetch` / `pages:receive` — **dùng chung cho cả menu lẫn kéo** | `src/main.js`, `src/preload.js` | lưới B1 + test tay |
| B3 | **Đường xác định trước:** menu chuột phải **“Chuyển trang tới ▸”** (liệt kê mọi tab của mọi cửa sổ, làm mờ đích không nhận qua cờ `acceptsPages` thêm vào `tab:meta` — §4.1b) + `choosePosition` sẵn có + `exportPagesForDrag(indices)` (`copyPages`) | `renderer/app.js`, `src/main.js` | test tay (bấm được, **không cần kéo**) |
| B4 | Đích: `pages:receive` → `insertBuffersAt`; nhánh MOVE xoá ở nguồn **sau xác nhận** (BI-56) + toast "Xoá khỏi bản gốc" cho nhánh COPY (§9.2) | `renderer/app.js` | test tay |
| B5 | Cột cử chỉ kéo lên đường ống đã chạy: `dragstart` mang token + Shift=MOVE, đích vẽ cue khe chèn từ `pages:hover` (dùng lại `showThumbGapCue`/`thumbGapAt` **y nguyên**) + bung cột trang kiểu spring-loaded, có trả lại trạng thái (§4.1a) | `renderer/app.js` | test tay |
| B6 | **Thử tay** PA3: B có nhận `dragover`/`drop` không → nếu có, bỏ vòng đọc con trỏ | — | test tay |
| B7 | Tài liệu: `REGRESSION-GUARD` §3 (BI-55..58) + §5, `HUONG-DAN-SU-DUNG.md`, `renderer/help.js`, trang site | — | `npm run test:help` |

### 7.1 Lưới test tay (bắt buộc — máy không bơm được cử chỉ kéo)

| # | Thao tác | Kỳ vọng |
|---|---|---|
| 1 | Kéo trang **trong cùng** cột trang | Sắp xếp lại như cũ. **Không** IPC, không toast lạ _(hồi quy v0.2.41 — BI-57)_ |
| 2 | Kéo file PDF từ Explorer vào cột trang | Chèn như cũ _(hồi quy)_ |
| 3 | 2 cửa sổ: kéo trang 3 của A vào giữa trang 1–2 của B | B có thêm trang đúng chỗ, ● bẩn, Ctrl+Z ở B trả lại nguyên trạng. **A không đổi** (COPY là mặc định — §9.2) |
| 4 | Lặp #3 **giữ Shift** | A mất đúng trang đó, Ctrl+Z ở A trả lại |
| 4b | Lặp #3 rồi bấm **"Xoá khỏi bản gốc"** trên toast | Bằng đúng kết quả #4; bấm sau khi toast tắt thì không còn đường nào lỡ tay xoá |
| 5 | Kéo ra **vùng trống desktop** | Không có gì xảy ra, A nguyên vẹn |
| 6 | Kéo vào B khi B **đang chú thích dở** | Từ chối, có toast, phiên chú thích của B không xước |
| 7 | Kéo vào B khi B **chưa mở file** | Từ chối, và toast hiện ở **cửa sổ A** _(P13)_ |
| 7b | Chuột phải → **Chuyển trang tới ▸** khi có một tab chưa mở file | Tab đó **bị làm mờ** kèm lý do, không bấm được _(P13)_ |
| 7c | Kéo vào B khi B **thu gọn cột trang** | Dừng chân ~300ms thì cột tự bung, cue chạy bình thường, thả được _(P12)_ |
| 7d | Lướt **ngang qua** B (thu gọn cột) rồi thả ở chỗ khác | Cột trang của B **thụt lại như cũ**, không để lại dấu vết _(P12)_ |
| 8 | Đóng B ngay giữa lúc chèn | A không mất trang, không toast dối |
| 9 | Kéo trang từ A khi A **chỉ có 1 trang**, chế độ MOVE | Từ chối (không thể xoá hết trang — `deletePages` đã chặn) |
| 10 | Bản **Free** | Bị khoá ngay ở `dragstart`, thông điệp Pro như các đường khác |
| 11 | Kéo **nhiều trang** đã tick | Đúng số trang, đúng thứ tự |
| 12 | Chuột phải → **Chuyển trang tới ▸** sang **tab** khác cùng cửa sổ | Chạy được (đường không-kéo) |
| 13 | 3 cửa sổ chồng nhau, thả lên cửa sổ **trên cùng** | Trang vào đúng cửa sổ đang nhìn thấy |
| 14 | Kéo rồi **Esc** giữa đường | Không làm gì; cue ở B dọn sạch _(P4)_ |
| 15 | Chuột phải → **Chuyển trang…** khi chỉ có **một** tài liệu mở | Mục "Không có tài liệu nào khác đang mở", mờ, bấm không được |
| 16 | Sau #3: `Ctrl+Z` ở **B** rồi `Ctrl+Z` ở **A** | B trả lại nguyên trạng; ở A **không có gì để hoàn tác** (COPY không đụng A) |
| 17 | Sau #3: đợi toast tắt (~9s) | Không còn đường nào xoá trang gốc ngoài ý muốn |
| 18 | Kéo trang sang B khi **A đang chú thích dở** | Từ chối kèm câu **giọng của A** ("bấm Xong trước…"); chú thích của A không xước, B không nhận gì _(§10.2 mục 1)_ |

---

## 8. Ngoài phạm vi (cố ý)

- Kéo trang ra Explorer/ứng dụng khác thành file (PA1 — tính năng riêng về sau).
- Thả trang vào **vùng đọc** của B (không phải cột trang): v1 chỉ nhận trong cột trang,
  vì "khe chèn" chỉ có nghĩa ở đó.
- Kéo trang thành **cửa sổ mới** (kiểu "tear" của tab).
- Kéo giữa hai tab cùng cửa sổ bằng cử chỉ kéo (§4 — không có đích để nhắm).

---

## 9. Quyết định — ĐÃ CHỐT 2026-08-12

1. **Phạm vi v1: làm CẢ HAI đường trong một bản** — kéo–thả giữa 2 cửa sổ **và** menu
   "Chuyển trang tới ▸". _Thứ tự thi công vẫn là menu trước (B6 trước B3/B4) vì nó bấm được
   nên test được ngay, và nó chứng minh đường ống chuyển trang đã đúng trước khi cột thêm
   cử chỉ kéo — thứ duy nhất máy không kiểm được — lên trên._
2. **COPY là mặc định; giữ Shift = MOVE.** Sau khi copy, toast có nút **"Xoá khỏi bản gốc"**
   để chuyển thành move bằng một cú bấm. ⇒ Cú kéo lỡ tay **không bao giờ** sửa tài liệu
   nguồn, và bẫy P2 chỉ còn áp cho nhánh Shift+MOVE.
3. **Kéo cả tập trang đã tick nếu trang đang kéo nằm trong tập**, ngược lại chỉ trang đó —
   đúng quy ước `openThumbMenu` đã có (`app.js:1524–1533`).
4. **Cửa sổ đích thu gọn cột trang ⇒ tự bung. Chưa mở file ⇒ từ chối ở v1.** Chi tiết cài
   đặt ở §4.1 — "tự bung" và "từ chối" mỗi cái kéo theo một câu hỏi phải trả lời trước khi
   viết code.

---

## 10. Đã thi công — 2026-08-12

**Xong B1→B5 + B7.** Còn **B6** (một phép thử tay 5 phút, §3.3) và toàn bộ **§7.1 (22 mục
test tay)**. Chưa commit.

| File | Việc |
|---|---|
| `desktop/src/tabs.js` | `docViewScreenRect()`, `activeDocContents()`, `classifyPageDrop()`, `docViewLocalPoint()`, `pageDropTargets()`, `findTabById()`, `pageTargetTabs()`, dấu `_focusSeq` |
| `desktop/src/main.js` | `routePages()` + `askRenderer()` + 5 channel `pages:*` + vòng bám con trỏ có watchdog |
| `desktop/src/preload.js` | nhóm `desktop.pages` (10 hàm) |
| `desktop/renderer/page-move.js` | **mới** (~330 dòng) — toàn bộ hai đầu nguồn/đích |
| `desktop/renderer/page-range.js` | `actionSet()` |
| `desktop/renderer/app.js` | 3 móc: `dragstart`, `dragend`, mục menu chuột phải · `toast()` nhận thêm nút hành động |
| `desktop/renderer/app.css` | `.toast-action` |
| `desktop/renderer/index.html` · `i18n.js` · `help.js` | thẻ script · 31 chuỗi EN · mục hướng dẫn |
| `desktop/test/page-drop.test.js` | **mới** — 63 assertion (`npm run test:pagedrop`) |

Lưới: **14/14 bộ test xanh** (1052+ assertion), trong đó `test:tabs` 113 và `test:pages` 50
là hồi quy của hai hệ con bị đụng. Thêm một probe Electron thật (nạp `index.html` thật, ghi
kết quả ra file) xác nhận `window.PageMove`, cả 10 hàm bridge và 8 global dùng chung đều có
mặt trong renderer thật.

### 10.1 Sáu chỗ thi công lệch khỏi thiết kế (và vì sao)

1. **Số bất biến: BI-52..55 → BI-55..58.** BI-52/53/54 **đã có chủ** trong
   `REGRESSION-GUARD.md` (text-find, câu xác nhận, nén tiến trình riêng). Đánh trùng số là
   tạo mâu thuẫn tài liệu âm thầm — thứ chỉ phát hiện được khi có người tra sổ và đọc ra hai
   luật khác nhau cùng tên.
2. **Bỏ hẳn khái niệm "token" (§3.2, P1).** Thiết kế cho đích **xin** bytes bằng token. Thi
   công thì main **tự đẩy**: `nguồn → main → đích → main → nguồn`. Đích **không hề nhận được
   định danh nào** nên không có gì để xin — mạnh hơn token, và bớt một khái niệm.
3. **Điều kiện "đích có nhận được không" được HỎI lúc mở menu, không đẩy qua `tab:meta`
   (§4.1b).** Cờ đẩy sẵn sẽ **cũ**: nó đổi mỗi lần mở tài liệu và mỗi lần bắt đầu chú thích,
   mà `tab:meta` chỉ bắn khi tiêu đề/dirty đổi. Hỏi tại thời điểm mở menu vừa luôn đúng, vừa
   **không phải sửa gì** ở tầng tab.
4. **`routePages` hỏi ĐÍCH trước, rồi mới bắt NGUỒN bóc trang.** Đích là bên duy nhất biết
   điểm thả có phải khe chèn thật hay không; hỏi tốn vài ms còn bóc trang tốn vài giây trên
   tài liệu lớn. Thả sai chỗ vì thế không làm nguồn xay pdf-lib vô ích.
5. **Luật `z` cho cửa sổ chồng nhau — thiết kế không có.** Nó lộ ra khi soạn mục test #13:
   `classifyPageDrop` quét "hit đầu tiên thắng" sẽ trả **sai** cửa sổ khi hai cửa sổ chồng
   nhau, mà chồng nhau là chuyện thường xuyên với vùng tài liệu (khác dải tab 40px). Electron
   không phơi z-order, nên dùng **độ mới của focus** làm proxy — có dấu `_focusSeq`, và
   **cửa sổ nguồn luôn thắng bất chấp `z`** (BI-57).
6. **Vùng thả = cột trang, cộng mép tab của cột đang thu gọn.** Thả vào **vùng đọc** thì
   không làm gì và có toast chỉ đường. Lý do: cue chỉ có nghĩa ở cột trang, và "thả được ở
   nơi không có cue" là đúng cái luật BI-33 dặn đừng vi phạm — hình trên màn hình phải nói
   đúng kết quả sẽ ra.

Hai điều chỉnh nhỏ hơn, ghi để không phải điều tra lại: `hover-end` bắn **sau** khi chèn xong
(hạ cue trước làm cửa sổ đích nháy và cột vừa tự bung sẽ sập rồi mở lại — BI-58); và **không
cướp focus** của cửa sổ đích ở cả hai đường (COPY là mặc định nên tài liệu đang làm việc vẫn
là cái nguồn, còn đích là **tab** thì cướp focus sẽ giật người dùng khỏi trang họ đang đọc —
hai đầu đều toast nên không đường nào im lặng).

### 10.2 Ba lỗi tự rà ra sau khi code chạy (đã sửa)

Ghi lại vì cả ba đều **không** có test tự động nào bắt được, và cả ba đều là loại "chạy đúng
trong ca thường, sai trong ca biên".

1. **Nguồn đang chú thích dở vẫn bóc trang ra được.** `wireThumb` **không** chặn kéo trong lúc
   chú thích (chuyện có từ trước tính năng này — thanh công cụ thì đã đóng băng, cử chỉ kéo
   thì chưa). Chú thích chưa bake **không nằm trong `state.bytes`**, nên trang bay đi sẽ
   **thiếu đúng phần người dùng vừa vẽ**, và nhánh Shift còn xoá trang gốc ngay dưới một phiên
   đang sửa nó. Sửa: `answerExport` từ chối với mã riêng `src-busy`, lời nhắc nói bằng **giọng
   của nguồn** ("bấm Xong trước khi chuyển trang"), không dùng câu dành cho đích.
2. **Cột trang tự bung rồi ở lại khi chèn thất bại.** `keepColumnOpen()` gọi **trước** khi
   chèn, nên chèn lỗi là cột đã bung mà không ai thu lại. Sửa: gọi **sau** khi xác nhận tài
   liệu đã dài ra — thất bại thì `hover-end` (đến sau) tự trả lại trạng thái cũ, đúng P12.
3. **Cổng bản quyền ở `dragStart` biến cú thả của bản Free thành im lặng.** `reorderPage`
   **không** bị khoá, tức người dùng Free kéo sắp xếp trang hằng ngày; chặn ở lúc nắm thì cú
   thả sang cửa sổ khác chỉ đơn giản là không có gì xảy ra, không lời giải thích. Sửa: bỏ cổng
   ở đó, để cú chuyển đi tới đích và **đích trả lời `pro`** — nguồn nói ra thành câu. Việc chèn
   vẫn bị khoá ba lớp (`can-accept`, `insertBuffersAt`, `gateProFeature` của menu).

### 10.3 Còn nợ

- **B6:** thả một trang lên cửa sổ khác rồi xem cửa sổ đó có nhận `dragover`/`drop` không.
  Có ⇒ bỏ được vòng bám con trỏ 80ms và dùng cue native. **Không đổi kiến trúc** — chỉ đổi
  nguồn của cue. Máy không thử được (§2.2).
- **§7.1 — 22 mục test tay.** Hai mục đầu là hồi quy của kéo-sắp-xếp trang và kéo file PDF
  vào cột trang: tính năng này gắn thêm việc lên **đúng cùng một cử chỉ**, nên đó là hai mục
  không được bỏ.
- Trang landing của site + README: việc của lượt phát hành.
