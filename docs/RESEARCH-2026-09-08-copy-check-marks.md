# Nghiên cứu — **copy dấu ✓ / ✗ sang file PDF khác**

_Lập 2026-09-08 · khảo sát trên nhánh `claude/vietnamese-ocr-ai-iSvwV`, cùng phiên với
`RESEARCH-2026-09-08-split-view.md`. Yêu cầu nguyên văn của người dùng:_

> "Bổ sung tính năng copy được dấu tích V hoặc x trong chú thích (chỉ copy - paste chứ không
> edit được cái đã có, đã xong rồi) cho phép copy trong 1 file và file này sang file khác
> (như hộp chú thích)"

---

## 0. Kết luận ngắn

| Câu hỏi | Trả lời |
|---|---|
| Copy ✓ / ✗ **trong cùng một file** có sẵn chưa? | **Có rồi.** Chọn dấu ✓ → `Ctrl+C` → sang trang khác → `Ctrl+V`. Đường này chạy từ v0.2.5x và không đụng gì tới thay đổi lần này. |
| Copy **sang file khác** có được không? | **Trước bản này: KHÔNG.** Bộ lọc chia sẻ liên-tab chặn đúng ✓ / ✗. Đây là toàn bộ khoảng trống của yêu cầu. |
| Sửa ở đâu | **Một biểu thức** trong `renderer/editor.js` (`isShareableKind`) + một tập hằng số mới. |
| Có phải đổi cách lưu file không? | **Không.** ✓ / ✗ vẫn **bị dán chết** (flatten) khi bấm **Xong**, đúng như BI-42. Không byte nào trong PDF xuất ra đổi khác. |
| Rủi ro | **Rất thấp.** Không mở kênh IPC mới, không đổi định dạng, không đụng đường bake, không mở lỗ cổng bản quyền. |
| Phạm vi **cố ý không làm** | Sửa lại dấu ✓ **đã bấm Xong** — chính người dùng đã loại nó ra ("không edit được cái đã có"). Lý do kỹ thuật ở §5. |

---

## 1. Hiện trạng — đã đọc tận nơi

### 1.1 ✓ / ✗ là annotation sống bình thường, cho tới khi bấm **Xong**

`renderer/editor.js:77` `SYMBOL_KINDS = new Set(["check", "cross"])`, và
`editor.js:65` `RESIZABLE_KINDS` có cả hai. Nghĩa là trước khi bake, một dấu ✓ **chọn được,
kéo được, đổi cỡ được, đổi màu được** — y như khung chữ nhật.

Hình dạng của nó nằm ở `renderer/annot-geom.js:253` `symbolStrokes(kind, x, y, w, h)`, là
**một nguồn sự thật đọc hai lần**: `<svg>` trên màn hình (`editor.js:1046`) và `drawLine` của
pdf-lib lúc bake (`editor.js:3295`). Dữ liệu nó cần chỉ là `x / y / w / h / color / width` —
toàn số và chuỗi JSON, không có tham chiếu nào ra ngoài.

### 1.2 Clipboard đối tượng: cùng-tab **đã** cho ✓ / ✗ qua

`editor.js` `copySelected()` không lọc kind nào cả — nó chép **cả selection**. Nên
`Ctrl+C` → `Ctrl+V` một dấu ✓ trong **cùng một tab** vốn đã chạy, kể cả sang trang khác
(`pasteClip` giữ nguyên toạ độ, chỉ lệch `PASTE_STEP` khi dán lại đúng trang cũ).

### 1.3 Cái chặn nằm ở **bộ lọc chia sẻ liên-tab**

Từ v0.2.67 clipboard được **soi gương qua main** (`annots:clip-write`, BI-77) để copy được
sang tab / cửa sổ khác. Nhưng chỉ những kind lọt qua bộ lọc này mới được gửi:

```js
const SHARE_EXCLUDED = new Set(["image"]);
const isShareableKind = (k) => isManagedKind(k) && !SHARE_EXCLUDED.has(k);
```

`isManagedKind` đến từ `managed-codec.js:121`:

```js
const MANAGED_KINDS = new Set(["text","note","image","arrow","box","ellipse","cloud","cloudpen","draw"]);
```

`check` / `cross` **không** có trong đó ⇒ `isShareableKind("check") === false` ⇒ `shareClip()`
lọc chúng ra ⇒ tab kia không bao giờ thấy. **Đó là toàn bộ nguyên nhân.**

---

## 2. Chẩn đoán: hai câu hỏi khác nhau bị buộc làm một

`MANAGED_KINDS` trả lời câu **"kind này có sống sót qua một lần lưu không?"** — nó quyết định
việc ghi `/NabuData` + `/AP` để lần mở sau còn import lại được thành đối tượng.

Bộ lọc clipboard cần trả lời câu **"kind này có gửi sang renderer khác được không?"** — một
câu hỏi về **payload** và về **ý nghĩa ở tài liệu đích**.

Hai câu này trùng nhau ở gần hết mọi kind, nên khi viết v0.2.67 việc mượn `isManagedKind` là
đường ngắn nhất. Chính ✓ / ✗ là chỗ hai câu **khác nhau**:

| | Sống sót sau khi lưu? | Gửi sang tab khác có nghĩa không? |
|---|---|---|
| `text`, `arrow`, `box`… | ✅ | ✅ |
| `image` | ✅ | ❌ **cỡ payload** — dataUrl base64 vài MB mỗi lần `Ctrl+C` |
| **`check` / `cross`** | ❌ (flatten, BI-42) | ✅ **hoàn toàn có nghĩa** — vài chục byte JSON, và ở tài liệu đích nó **đúng bằng** thứ mà công cụ ✓ tạo ra |
| `highlight` / `under` / `strike` | ❌ | ❌ — chúng bám vào **đoạn chữ** mà tài liệu đích không có |
| `redact` | ❌ | ❌ — ô che là một lời hứa về nội dung **của chính file này** |

Nhận xét trong test cũ (`test/annot-clip.test.js`) viết *"Kinds that flatten to pixels on bake
were never live objects to copy in the first place"* — câu đó **không đúng** với ✓ / ✗: chúng
là đối tượng sống hẳn hoi cho tới lúc bake. Đã sửa lại lý do trong test cùng với thay đổi này.

---

## 3. Thay đổi

### 3.1 `renderer/editor.js`

```js
const SHARE_EXCLUDED = new Set(["image"]);
const SHARE_EXTRA    = new Set(["check", "cross"]);   // MỚI
const isShareableKind = (k) => (isManagedKind(k) || SHARE_EXTRA.has(k)) && !SHARE_EXCLUDED.has(k);
```

Một tập hằng số riêng, **không** phải nhét `check`/`cross` vào `MANAGED_KINDS`: nhét vào đó là
thay đổi **định dạng file xuất ra** cho mọi người dùng, để đổi lấy một thứ người dùng đã nói
rõ là không cần (§5).

### 3.2 Phụ: gọi tên đối tượng bằng tiếng Việt trong toast

Toast sau khi copy trước đây in thẳng tên kind: *"Đã sao chép 1 mục (check)"*. Thêm bảng
`KIND_VI` để nó thành *"Đã sao chép 1 dấu tích ✓"* — tên trùng với tên trên nút công cụ.

### 3.3 Không đụng tới

`shareClip` · `adoptSharedClip` · `pasteClip` · `annots:clip-write` ở `main.js` ·
`src/preload.js` · `managed-codec.js` · toàn bộ đường bake. Không có kênh IPC mới.

---

## 4. Vì sao **không có** rủi ro mới

| Lo ngại | Trả lời |
|---|---|
| Payload IPC phình to | Một dấu ✓ là `{kind,x,y,w,h,color,width}` — vài chục byte. Lý do duy nhất `image` bị chặn (base64 vài MB) không áp dụng. |
| Tài liệu đích nhận phải thứ nó không xử lý được | Dấu ✓ dán vào **giống hệt** dấu ✓ do công cụ ✓ vẽ ra tại chỗ: `pasteClip` đẩy vào `annotsFor(page)`, đúng một dòng mà đường tạo mới cũng làm (`editor.js:1707`). Không có bước bookkeeping nào bị bỏ sót — `_managedPages` **cố ý** không đụng tới, vì ✓ không phải managed kind, đúng như khi vẽ tay. |
| Toạ độ lệch khi dán sang file khác | `annotBounds` / `translateAnnot` xếp ✓ vào **họ hộp** (`x/y/w/h`) — nhánh mặc định, đã có từ trước. `pasteClip` vẫn kẹp cả nhóm vào trong khổ trang đích bằng `fitShift(unionBounds(...))`. |
| BI-77 (quyết định dán phải **đồng bộ**) | Không đụng: `clip` vẫn là nguồn sự thật đồng bộ, `shareClip` vẫn fire-and-forget. |
| BI-42 (✓ bị flatten khi bake) | **Vẫn đúng nguyên văn.** Test khoá lại điều này: `MANAGED_KINDS.has("check") === false`. |
| BI-9 / BI-26 (cổng bản quyền) | Không mở lỗ: `text` / `arrow` / `box` vốn đã qua được clipboard liên-tab; ✓ không phải tính năng trả phí riêng. |

---

## 5. Cố ý **không** làm: sửa lại dấu ✓ đã bấm Xong

Người dùng đã tự loại nó ra ("chỉ copy - paste chứ không edit được cái đã có"). Nếu sau này
cần, đây là hình dạng của việc đó, ghi lại để khỏi phải khảo sát lại:

- thêm `check`/`cross` vào `MANAGED_KINDS` **và** `VECTOR_KINDS`;
- thêm một nhánh trong `shapeAppearance()` dựng `/AP` từ `symbolStrokes` — đường polyline với
  **round cap + round join**, đúng lập luận đã viết sẵn cho `draw`: nét bake hiện tại là N
  đoạn `drawLine` với `LineCapStyle.Round`, mực **trùng khít** với một polyline round-join;
- mở rộng `test:rotate` (BI-64) cho hai kind mới ở 0/90/180/270.

Cỡ việc: nhỏ nhưng **đổi định dạng file xuất ra**, nên phải đo lại vòng round-trip. Đó là lý
do nó nằm ngoài bản này chứ không phải vì khó.

---

## 6. Test

| Ca | Ở đâu |
|---|---|
| `check` / `cross` **qua** được biên tab | `test/annot-clip.test.js` §1 (mới) |
| `check` / `cross` **vẫn không** phải managed kind (bake không đổi) | `test/annot-clip.test.js` §1 (mới) |
| `SHARE_EXTRA` đúng bằng `{check, cross}` — không ai lén nới rộng | `test/annot-clip.test.js` §1 (mới) |
| `highlight` / `under` / `strike` / `dim` / `redact` **vẫn không** qua | `test/annot-clip.test.js` §1 (đã có, sửa lại lý do) |
| `image` vẫn bị giữ lại vì cỡ payload | `test/annot-clip.test.js` §1 (đã có) |
| BI-77 — quyết định dán vẫn đồng bộ | `test/annot-clip.test.js` §3 (đã có, không đổi) |

`npm run test:clip`: **56 → 59 ca, xanh.** Cả 21 lưới node xanh.

### 6.1 Kiểm bằng tay (GUI — máy không thay được)

1. File A: bật **Chú thích** → công cụ ✓ → đặt một dấu, chỉnh màu + cỡ → `Ctrl+C`.
2. Sang **tab khác** (file B) → `Ctrl+V`. **Mong đợi:** app tự bật Chỉnh sửa; dấu ✓ hiện đúng
   màu, đúng cỡ, đúng vị trí tương ứng.
3. Sang **cửa sổ khác** → `Ctrl+V`. Như trên.
4. Ở B bấm **Xong** → lưu → mở lại. **Mong đợi:** dấu ✓ nằm trên trang, **không** chọn lại
   được (đúng BI-42, không phải lỗi).
5. Copy một dấu ✗ **và** một hộp văn bản cùng lúc → dán sang file khác: **cả hai** phải sang.
6. Copy một dấu ✓ **và** một ảnh cùng lúc → dán sang file khác: ✓ sang, ảnh không, và toast
   phải nói rõ *"1 ảnh chỉ dán được trong tab này"*.
