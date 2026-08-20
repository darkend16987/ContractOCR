# "Sửa nội dung" + "Tìm & Thay thế" tự xoay chữ trên trang `/Rotate` — chẩn đoán & phương án

Trạng thái: **đã thi công — xem §5.** Bất biến: [BI-66](REGRESSION-GUARD.md).
Ngày: 2026-08-20 · Nguồn: 1 report từ người dùng, kèm file thật
`260521_CLD_NAVY_SGSU_TENDER_ID_ARC.pdf`.

> Đọc kèm [SPEC-annot-rotated.md](SPEC-annot-rotated.md) — **cùng lớp lỗi, khác tầng.**
> Tài liệu đó nói về **chú thích** (pdf-lib, phía renderer). Tài liệu này nói về **chữ thật
> của trang** (PyMuPDF, phía sidecar). Hai đường **không** dùng chung một dòng số học nào,
> nên vá một bên không hề vá bên kia — đó chính là lý do lỗi này còn sống sau BI-45/BI-65.

---

## 1. Report và kết luận

Người dùng báo: sau loạt sửa chống tự-xoay ở v0.2.52/v0.2.61, **Sửa nội dung** và **chữ thay
thế của Tìm & Thay thế** vẫn bị **tự động xoay** trên trang landscape.

**Kết luận: đúng, và không phải hồi quy — đây là chỗ chưa ai vá.** BI-45/BI-65 vá đường bake
chú thích. Chữ thật của trang đi qua `/edit-text`, và endpoint đó **chưa bao giờ** biết chiều
của chữ nó đang thay.

---

## 2. Nguyên nhân — đã ĐO, không suy luận

PyMuPDF 1.27.2 (bản đang ship). Gọi `page.insert_text((100,200), "ABC", fontsize=20)` trên
trang `/Rotate` 0 / 90 / 180 / 270 → **cùng một bbox** `[100.0, 178.5, 141.1, 206.0]`, **cùng
một** `dir (1,0)`:

| `page.set_rotation` | bbox sau khi ghi | `line["dir"]` |
|---|---|---|
| 0 | `[100.0, 178.5, 141.1, 206.0]` | `(1, 0)` |
| 90 | `[100.0, 178.5, 141.1, 206.0]` | `(1, 0)` |
| 180 | `[100.0, 178.5, 141.1, 206.0]` | `(1, 0)` |
| 270 | `[100.0, 178.5, 141.1, 206.0]` | `(1, 0)` |

Nghĩa là: **mọi hàm ghi nội dung của PyMuPDF vẽ ở không gian trang CHƯA XOAY và bỏ qua hoàn
toàn `/Rotate`.** `get_text` cũng báo ở đúng không gian đó (đó là lý do `/text-spans` phải
nhân `page.rotation_matrix` ra `bbox_view`).

Trên bản vẽ `/Rotate 90`, chữ gốc được vẽ **DỌC** trong không gian chưa xoay để đọc **xuôi**
sau khi viewer xoay lại. `/edit-text` xoá glyph cũ (redaction — đúng, vì rect axis-aligned
đúng ở cả hai không gian) rồi vẽ lại **ngang** ⇒ chữ mới **quay 90°**.

Ảnh chụp từ chính file report, trang 5, chữ mới tô đỏ:

- **trước bản vá:** `NABU GẠCH XÂY 4 LỖ` chạy dọc xuống, vắt qua các dòng bên cạnh.
- **sau bản vá:** nằm đúng hàng với `4 HOLLOWS BURNT BRICK WALL` ngay dưới nó.

---

## 3. Vì sao `page.rotation` là câu trả lời SAI

Đếm trên chính file report — 30 trang, **trang nào cũng** `/Rotate 90`:

| `line["dir"]` trong không gian chưa xoay | số span | nó là gì trên màn hình |
|---|---|---|
| `(0, -1)` | **5799** | chữ đọc **xuôi** |
| `(-1, 0)` | **902** | nhãn kích thước **dựng dọc** |
| `(0.002, -1)` / `(-0.002, -1)` / `(-1, -0.002)` | 136 | như trên, lệch ~0.1° |
| `(0.656, 0.755)`, `(0.966, -0.259)`, `(0.383, -0.924)`… | 40 | nhãn dẫn **chéo** (15°–49°) |

Một góc trang **không thể** mô tả cả hai nhóm đầu. Lấy `page.rotation` mà vá thì 5799 span
đúng nhưng **902 span kia sai theo kiểu mới** — trước bản vá chúng lệch 180°, sau đó sẽ lệch
90°. Đó là đổi một lỗi thành một lỗi khác, không phải sửa.

⇒ **Nguồn sự thật là `line["dir"]` của chính đoạn chữ**, và nó phải đi suốt đường:
`/text-spans` · `/text-find` → renderer → `/edit-text`.

---

## 4. Ba phép tính, không phải một

Chỉ sửa chiều vẽ là biến một lỗi **lộ** thành hai lỗi **im**:

1. **Chiều vẽ.** `insert_text(rotate=…)` chỉ nhận bội số 90; nhãn dẫn chéo thì không dùng
   được. Dùng `morph` mang ma trận thay thế: **đã đo pixel-identical** với `rotate=`
   ở cả 4 góc vuông, cả chữ 1 dòng và nhiều dòng, **và** làm được góc chéo.
   Ma trận là `Matrix(hscale, 0, shear, 1, 0, 0) * Matrix(theta)` — **thứ tự bắt buộc**:
   đảo lại thì trên đoạn đã xoay, phép nén ngang rơi vào **chiều cao glyph** thay vì bước
   tiến (đo được: `h=0.5` làm bề ngang 27.5 → 13.7 mà độ dài 111.1 **không đổi**).
2. **`hscale`/`vscale` (BI-25)** chia cho bề ngang / bề cao của bbox. bbox là
   **axis-aligned** ⇒ trên đoạn xoay 90° hai số **đổi chỗ**. Đoạn dài thì tỷ số rơi ra ngoài
   dải tin cậy nên bị loại (may mắn); đoạn **ngắn** thì rơi **vào trong** ⇒ chữ bị nén còn
   ~50% mà không báo gì. Ca `G1` của lưới **chứng minh** điều đó bằng số trước khi đo ca `G2`.
3. **Gạch chân** phải chạy theo chiều chữ, không theo trục x của trang.

Góc **không** phải bội số 90 thì bbox axis-aligned **không tách được** thành "dọc theo chữ" và
"ngang qua chữ" ⇒ `quadrant = None` và **cả hai** phép chỉnh hình học bị **tắt**. Thà không
chỉnh còn hơn chỉnh theo một số đo đã biết là sai. Dưới `_DIR_SNAP_DEG = 2°` thì bắt vào góc
vuông (file thật có đoạn lệch 0.11°; bắt đúng góc giữ `u`/`n` không nhiễm bụi float).

---

## 5. Đã thi công

| Chỗ | Thay đổi |
|---|---|
| [api.py](../api.py) `_text_frame()` | hàm **thuần** mới: `dir` → `(theta, u, n, quadrant)`; `dir` rỗng/rác → khung ngang (= hành vi cũ) |
| `/text-spans` `TextSpan.dir` | báo `line["dir"]` cho từng span |
| `/text-find` `TextFindHit.dir` + `_find_build_index` | trường **thứ 9** của tuple span dẹt; **một** tuple cho mỗi DÒNG, dùng chung theo tham chiếu (index giữ hàng trăm nghìn span) |
| `TextEdit.dir` | `list[float] | None`, **mặc định None** ⇒ caller cũ không đổi gì |
| `/edit-text` khối vẽ lại | `morph` mang cả góc chữ · `adv`/`thick` theo `quadrant` cho hscale/vscale · gạch chân theo `u_dir`/`n_dir` · **nhánh retry giữ nguyên góc** |
| [text-edit.js](../desktop/renderer/text-edit.js) `apply()` | `ed.dir = sp.dir \|\| null` (một chỗ, cạnh `orig_text`/`orig_size`) |
| [find-replace.js](../desktop/renderer/find-replace.js) `editForSpan()` | `dir: hit.dir \|\| null` |

**Dải chết là hợp đồng:** không có `dir` ⇒ `theta = 0` ⇒ `Matrix(0)` là ma trận đơn vị ⇒
`morph` về đúng biểu thức cũ ⇒ tài liệu Word/Excel bình thường ra **y hệt từng pixel**
(ca `D3` của lưới đo đúng điều đó).

**Không có endpoint mới, không có payload mới.** Tìm & Thay thế vẫn ghi qua `/edit-text` như
cũ — thêm **một** trường vào payload nó đã dựng, nên hai tính năng không thể lệch nhau.

---

## 6. Kiểm chứng

- `test_edit_text_rotate.py` — **107 ca**: helper thuần · dải chết · **4×4** tổ hợp
  {góc trang} × {chiều chữ} · gốc đường chân · `/Rotate` không tự đổi sau khi sửa · trục hình
  học · gạch chân · góc chéo 30° · **đường Tìm & Thay thế đi hết vòng** (`/text-find` → payload
  đúng như `editForSpan` → `/edit-text` → đọc lại).
- **Mỗi nhóm có ca canh gác** gửi `dir=None` để dựng lại đúng lỗi cũ và **đòi** kết quả phải
  SAI. Bỏ ma trận `morph` ra thì lưới **đỏ 26 ca** — nên một lưới xanh mới có nghĩa.
- `test_text_find.py` 52 → **55** ca (`dir` trong hợp đồng của hit; fixture `part()` theo kịp
  tuple 10 trường).
- `desktop/test/find-replace.test.js` 138 → **141** ca (`editForSpan` mang `dir`; sidecar cũ
  → `null`, không phải `undefined`).
- **Chạy thật trên file report** (trang 5, có cả hai chiều): sửa 1 đoạn đọc xuôi + 1 nhãn dựng
  dọc trong **một** request → cả hai giữ đúng chiều, `/Rotate` và khổ trang không đổi.

## 7. Còn lại — test tay trước khi phát hành

Xem §5 của [REGRESSION-GUARD.md](REGRESSION-GUARD.md), dòng "Chiều vẽ lại chữ". Và **rebuild
sidecar**: bản vá nằm trong `api.py`, nếu không OTA giao binary cũ.

## 8. Ngoài phạm vi (đã soi, chưa sửa)

- **`/translate`** dùng `insert_textbox` với một rect và cũng chưa biết `/Rotate` — cùng lớp
  lỗi, khác tính năng (nó **tái dàn** cả block chứ không vẽ lại một span), nên cần lưới riêng.
- **Vệt tô của Tìm & Thay thế** (`hitRect` ở `find-replace.js`) nội suy vị trí ký tự theo trục
  **x của không gian hiển thị**. Đúng cho chữ đọc xuôi; với 902 nhãn dựng dọc thì vệt tô lệch.
  Thuần **thị giác** — chữ được thay vẫn đúng — và `drawSearchLayer` của Ctrl+F dùng cùng phép
  xấp xỉ, nên sửa thì phải sửa cả hai chỗ.
