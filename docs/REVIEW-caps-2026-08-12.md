# Rà soát: hệ quả của việc nâng/bỏ trần dung lượng (v0.2.55 → v0.2.56)

_Lập 2026-08-12 · cây code `8934f72` (v0.2.56) · máy đo: Windows 11, 17 GB RAM, Python
3.12 + PyMuPDF 1.27.2, Electron 33.4.11._

**Câu hỏi:** hai đợt nâng trần — `/compress-bin` (`_MAX_PDF_BIN` 1 GB,
`_COMPRESS_MAX_PAGES` 500 → 3000) và `/text-find-bin` (bỏ trần 200 MB cho việc *tìm*) —
có làm hỏng tính năng khác, hại hiệu năng, hay gây hồi quy không?

**Trả lời ngắn:** **không có hồi quy chức năng.** Mọi hợp đồng cũ vẫn đúng, bán kính ảnh
hưởng của v0.2.56 trong `api.py` chỉ gói trong khối `text-find`. Nhưng việc nâng trần đã
mở đường cho **bốn vấn đề vận hành** mà bản thân code cũ không gặp vì trần thấp đã chặn
sẵn — nặng nhất là **một lệnh Nén có thể treo toàn bộ engine ~19 phút** mà không có nút
huỷ, không có tiến độ, và **kéo theo mọi tab khác**.

---

## 1. Phương pháp

Không đọc code rồi suy đoán. Bốn tầng, tầng sau bắt cái tầng trước không thấy:

1. **Đọc diff theo phạm vi** — `git diff` từng bản, liệt kê **hunk** để biết chính xác cái
   gì bị đụng ngoài tính năng mới.
2. **Chạy lại toàn bộ lưới có sẵn** để có mốc so sánh (baseline).
3. **Đo bằng probe Python** — chi phí thật của `_compress_pdf_bytes` (tách trục *theo
   trang* khỏi trục *theo byte*), RAM `_FIND_CACHE` giữ, chi phí blake2b.
4. **Probe HTTP thật + probe Electron thật** — dựng `uvicorn` có token + CORS và bắn
   request y như renderer bắn; dựng `BrowserWindow` thật để đo `ipcRenderer.invoke`.
   Gọi thẳng coroutine hay `await` hàm Python **không** nhìn thấy tầng middleware, CORS,
   hay giới hạn IPC.

> **Một cái bẫy đã dính và đã gỡ:** probe đầu tiên báo `X-Original-Size = None` và
> `expose_headers = None` → trông y hệt lỗi thật của BI-49. Không phải: probe tra header
> bằng `dict` **phân biệt hoa thường** và **không gửi `Origin`**, mà `CORSMiddleware` chỉ
> phát header CORS cho request có `Origin`. Đo lại với `Origin: null` (đúng thứ renderer
> `file://` gửi) → **cả bốn header đều đọc được**. Ghi lại để lần sau không báo động giả.

---

## 2. Mốc so sánh (chạy trên chính cây code này)

| Lưới | Kết quả |
|---|---|
| `.venv\Scripts\python run_tests.py` | **12/12 file PASS** |
| 12 lưới JS (`tabs 113 · pages 50 · print 39 · pan 57 · wire 51 · geom 55 · managed 50 · text 105 · cloud 175 · rotate 96 · help 249 · find 129`) | **0 fail** |

---

## 3. Những gì đã kiểm chứng là **KHÔNG** vỡ

| Hạng mục | Cách kiểm | Kết quả |
|---|---|---|
| Bán kính v0.2.56 trong `api.py` | liệt kê hunk | chỉ `import hashlib` + khối `text-find`. **Không endpoint nào khác bị đụng.** |
| Hợp đồng `/compress-bin` | HTTP thật | thành công `200 application/pdf`, body mở được `%PDF`; preset sai `400 application/json`; body rỗng `400`; body rác `400 "Không mở được PDF"` |
| Hợp đồng `/text-find-bin` | HTTP thật | `success=true`, 5000 hit, `truncated=true`, `cached` false→true ở lần hai, **số hit hai lần bằng nhau** |
| Header `X-*` đọc được từ renderer | HTTP thật, `Origin: null` | `expose-headers` liệt kê đủ 4 tên ⇒ JS đọc được cả ba `X-*` |
| Preflight CORS | `OPTIONS` thật | `200`; `Content-Type: application/pdf` **không** phải simple request nên Chromium bắt buộc preflight — middleware token bỏ qua `OPTIONS` đúng như thiết kế |
| Cổng token trên route mới | HTTP thật | `401` khi thiếu `X-Sidecar-Token` |
| `/edit-text?raw=1` | HTTP thật | `X-Pages-Changed` vẫn ra, `expose_headers` bao gồm nó |
| Buffer bị "detach" khi đổi sang `Blob` | đọc code | `pdf.js` **luôn** nhận `state.bytes.slice()` (app.js:553, 1227, 2028) ⇒ `new Blob([state.bytes])` không thể gặp buffer đã detach |
| `Ctrl+H` giẫm phím khác | đọc code | `pan.js` `keyTool` loại bỏ `ctrlKey/metaKey/altKey/shiftKey` ⇒ không xung đột |
| Bộ cứu font TCVN3 dùng chung | đọc code | `/text-find` và `/text-spans` cùng gọi `src/pdf/legacy_text.py` — **không** nhân bản ⇒ "Sửa nội dung" không thể lệch với "Tìm" |
| `savePdf` qua IPC có chịu nổi file lớn không | probe Electron thật | **có**: 64→1024 MB đều qua, 1 GB mất 5.4 s. IPC **không** phải chỗ thắt |
| `fitz.open(stream=)` có copy cả buffer không | đo RSS | **không** — +1 MB trên file 6.2 MB. RAM khi nén bị chi phối bởi vùng làm việc ảnh, không phải cỡ file |

---

## 4. Phát hiện — xếp theo mức độ

### F1 · CAO — `_COMPRESS_MAX_PAGES = 3000` treo **cả engine** tới ~19 phút

**Số đo.** Nén ảnh (preset `ebook`), tài liệu quét A4 200 dpi, ảnh **khác nhau** mỗi trang:

| Số trang | Cỡ file | Thời gian | s/trang | Đỉnh RSS trên nền |
|---|---|---|---|---|
| 12 | 32.8 MB | 4.6 s | 0.382 | +217 MB |
| 36 | 98.4 MB | 13.6 s | 0.378 | +160 MB |

⇒ **0.377 s/trang** (≈ 0.138 s/MB), và **RAM gần như không tăng theo số trang** —
PyMuPDF xử lý từng ảnh một, vùng làm việc ~150–220 MB bất kể tài liệu dài bao nhiêu.

Quy đổi ra trần mới:

- **3000 trang → ~19 phút**; trần cũ 500 trang → ~3.1 phút.
- 1000 MB → ~2.3 phút (trục byte rẻ hơn nhiều trục trang).

**Vì sao đây là vấn đề chứ không chỉ là "chạy lâu":** đo trên HTTP thật, trong lúc một
lệnh nén 30 trang chạy, `/health` **không được trả lời suốt 13.1 giây** (lúc rảnh: 24 ms).
Cả **30 route** trong `api.py` đều là `async def` và gọi PyMuPDF **đồng bộ** ⇒ chúng dùng
chung **một** event loop. Mà app có **một** sidecar cho **mọi tab và mọi cửa sổ**.

Hệ quả người dùng thấy: nén một bộ scan 1500 trang ⇒ tab đó hiện `"Đang nén PDF…"`
**mười phút**, và **mọi** thao tác engine ở tab khác (OCR, Dịch, Tìm & Thay thế, Sửa nội
dung, So sánh) treo theo. `runCompress` **không có timeout, không có huỷ, không có tiến
độ** (`app.js:3047`). Kết cục nhiều khả năng là người dùng tắt app giữa chừng.

> Đây **không** phải lỗi mới do commit nào gây ra — nó là tính chất sẵn có của kiến trúc.
> Việc nâng trần chỉ **gỡ mất cái chốt đang che nó**: 500 trang ≈ 3 phút còn ở mức "chờ
> được", 3000 trang thì không.

> ### ⚠️ Đề xuất đầu tiên của mục này ĐÃ SAI — ghi lại vì phép đo mới là thứ đáng giữ
>
> Bản đầu của memo này đề nghị `await run_in_threadpool(_compress_pdf_bytes, …)`, gọi
> đó là "sửa 2 dòng, rủi ro trung bình". **Đo lại thì nó không hoạt động**, vì ba lý do
> — cả ba đều đo được, không phải suy luận:
>
> 1. **`doc.rewrite_images()` chiếm 98,9% thời gian và giữ GIL suốt.** Thread quan sát
>    chạy trong lúc nén 24 trang được **0,1%** thời gian, và **không xong nổi một vòng
>    lặp** cho tới khi nén xong (dấu thời gian đầu tiên rơi ở giây thứ **10,79** của
>    một lệnh dài 10,96 s). Thread không mua được gì.
> 2. **Nó là một lệnh mức document, không có tham số khoảng trang** ⇒ cũng không cắt
>    nhỏ để chèn `await` giữa các trang được.
> 3. **PyMuPDF gọi `mupdf.reinit_singlethreaded()` ngay lúc import**, bỏ khoá nội bộ
>    của MuPDF. Nên chạy hai lệnh PyMuPDF trên hai thread không chỉ vô ích mà **không
>    an toàn** — điều này cũng loại luôn phương án "chuyển `_text_find_core` sang
>    thread", vì nó sẽ chạy song song với PyMuPDF đang chạy trên event loop.
>
> Bài học chung: **"chạy lâu" và "giữ GIL" là hai chuyện khác nhau**, và chỉ có phép đo
> phân biệt được. Hai probe đầu tôi viết còn tự mâu thuẫn (5 vòng lặp trong 10,8 s
> nhưng chu kỳ đo được chỉ 43 ms) vì chúng chỉ đo *trong* `sleep()` chứ không đo
> khoảng chờ giành lại GIL ở điều kiện vòng lặp. Chỉ khi in **dấu thời gian tuyệt đối**
> mới thấy sự thật.

**Cách sửa thật sự: đưa việc nén ra TIẾN TRÌNH RIÊNG.** Tiến trình con có GIL riêng và
context MuPDF riêng; tiến trình cha chờ nó bằng `subprocess.run` chạy trong một thread —
mà chờ tiến trình thì **nhả** GIL, nên event loop rảnh thật. Worker chính là **chương
trình này chạy lại** với `--compress-worker` nên không có nhị phân thứ hai phải build/ký.
Chi tiết ở **BI-54**; kết quả đo lại: `/health` **13.088 ms → 32 ms**.

Còn lại (chưa làm): ước tính thời gian trong hộp thoại Nén, và nút Huỷ — nút Huỷ giờ
**khả thi** vì đã có tiến trình để kill, nhưng vẫn là việc riêng.

---

### F2 · TRUNG BÌNH-CAO — `_FIND_CACHE` ghim ~300–450 MB, và không bao giờ được thả

`_FIND_CACHE_MAX_PARTS = 300_000` có chú thích là để "file bệnh hoạn không ghim hàng trăm
MB trong sidecar". **Đo thực tế thì trần đó cho phép đúng hàng trăm MB:**

- PDF 600 trang chữ thật: **27.000 span → +41 MB** ⇒ ~**1.5 KB mỗi span**.
- Cận dưới chỉ tính riêng tuple (probe tổng hợp): ~0.4 KB/span.
- ⇒ ở trần 300.000 part: **~130 MB (cận dưới) đến ~450 MB (đo thật)**.

Và cache **chỉ bị thay khi index một tài liệu khác** (`api.py:1803`). Đóng panel, đóng
tài liệu, đóng tab đều **không** thả. Tìm một lần trong bộ bản vẽ lớn rồi làm việc khác cả
buổi ⇒ chỗ RAM đó nằm lại trong sidecar đến hết phiên.

**Đề xuất:** hạ `_FIND_CACHE_MAX_PARTS` xuống ~**80.000** (≈100 MB theo số đo trên). Tài
liệu vượt trần **vẫn tìm được**, chỉ là phải parse lại mỗi lần — đúng hành vi đã có sẵn,
nên đây là đổi hằng số chứ không đổi logic.

*Ghi chú kèm:* cache giữ **một** tài liệu. Mở hai file lớn ở hai tab rồi tìm luân phiên ⇒
**luôn trượt cache**, mỗi lần tìm trả giá parse đầy đủ (đo được 1.8 s cho 600 trang chữ;
bộ A1 480 trang còn nặng hơn nhiều). Nâng lên LRU 2 ô sẽ xoá hẳn ca này.

---

### F3 · TRUNG BÌNH — "Thay tất cả" nói **"trong toàn bộ tài liệu"** kể cả khi lượt quét đã bị cắt

`max_hits = 5000` là trần cứng của `/text-find`. Đo trên PDF 600 trang: một từ khoá phổ
biến **dừng quét ở trang 28/600 — tức 5% tài liệu**.

`runFind` có báo đúng (`"…dừng quét ở trang {p}"`, qua `setSticky` — BI-51), **nhưng
`fr` không lưu cờ `truncated`**, nên `replaceAll` không biết. Câu xác nhận vẫn là:

> `Thay {n} vị trí trong toàn bộ tài liệu?`

Người dùng bấm đồng ý, nhận `"Đã thay 5000 vị trí."`, và tài liệu **vẫn còn hàng nghìn
chỗ chưa đổi**. Không hỏng dữ liệu (quét lại sau đó sẽ hiện lại cảnh báo), nhưng **câu
duy nhất được thiết kế để chặn bất ngờ lại đang nói sai** — đúng loại lỗi BI-51 vừa sửa,
nhìn từ phía kia.

**Đề xuất:** lưu `fr.truncated` / `fr.truncatedPage` trong `runFind`; khi bật thì đổi câu
xác nhận thành *"…trong 5000 vị trí đầu tiên (lượt quét dừng ở trang P) — chạy lại sau khi
thay để xử lý phần còn lại"*. Thuần chuỗi + một cờ; lưới `test:find` đã có chỗ để thêm ca.

---

### F4 · TRUNG BÌNH — sidecar chết là **chết im lặng**, và trần mới làm nó dễ chết hơn

- `desktop/src/sidecar.js:92` — `child.on("exit", …)` chỉ `console.log`.
- `bootSidecar` (`main.js:398`) chỉ đặt trạng thái từ promise **lúc khởi động**.
- `restartSidecar` **có** trong `preload.js:10` nhưng **không một file renderer nào gọi**.

⇒ nếu sidecar bị OOM-kill giữa một lệnh nén 1 GB, `sidecarState` vẫn là `"ready"`, mọi nút
engine vẫn sáng, và mỗi lần bấm là một lỗi `fetch` thô. Cách chữa duy nhất: khởi động lại
app. Trước đây trần 200 MB / 500 trang khiến ca này gần như không chạm tới; giờ thì chạm
được.

**Đề xuất:** trong `child.on("exit")`, nếu không phải đang tắt app thì
`setSidecarState({ state: "error", error: … })` — nút sẽ tự mờ theo `updateToolbar()` sẵn
có. Cho tự dựng lại **một** lần là tuỳ chọn thêm, không bắt buộc.

---

### F5 · THẤP — `_MAX_PDF_BIN = 1 GB` là trần **lý thuyết**, không phải trần thực dụng

IPC không phải chỗ thắt (đo: 1 GB qua được, 5.4 s). Nhưng ở đỉnh của một lệnh nén 1 GB:

- **renderer**: `state.bytes` (1 GB) + bản sao Blob (1 GB) + `arrayBuffer` kết quả
- **sidecar**: body request (1 GB) + bytes ra + ~200 MB vùng làm việc ảnh

Máy đo có 17 GB nên qua được; máy 8 GB thì không. Con số 1 GB **không sai**, chỉ là nó
không phải giới hạn thật.

**Đề xuất:** hoặc ghi rõ trong Hướng dẫn, hoặc hạ xuống ~500 MB, hoặc cảnh báo trước khi
chạy với file trên ~300 MB. Không gấp.

---

### F6 · THẤP — bẫy ngủ: hit cắt-qua-span mang toạ độ **đã xoay** trong trường `bbox`

`api.py:1890` dựng `bbox` từ hợp của `parts[i][3]` — mà `[3]` **là** `bbox_view` (đã nhân
`rotation_matrix`). Docstring của trường lại ghi *"UNROTATED span box; this is what
/edit-text redraws into"*.

Hôm nay **vô hại**: hit cắt-qua-span luôn `replaceable=False`, và `editForSpan` chỉ được
gọi cho hit `replaceable` (`replaceCurrent` chặn, `groupEdits` bỏ qua qua `spanKey`). Nhưng
nếu sau này ai đó cho phép thay loại hit này, `/edit-text` sẽ **redact sai hình chữ nhật
trên trang xoay** — im lặng, và chỉ trên trang có `/Rotate`.

**Đề xuất:** dựng `bbox` từ hợp của `parts[i][2]` (hộp chưa xoay) — một chữ số — hoặc ghi
thẳng ngoại lệ vào docstring.

---

## 5. Kế hoạch xử lý

| Bước | Việc | Rủi ro | Trạng thái |
|---|---|---|---|
| 1 | **F2** hạ `_FIND_CACHE_MAX_PARTS` 300k → 80k | rất thấp (đổi hằng số) | ✅ **xong** |
| 2 | **F6** `bbox` của hit cross-span dùng hộp chưa xoay | rất thấp | ✅ **xong** |
| 3 | **F3** `fr.truncated` + câu xác nhận đúng | thấp (chuỗi + 1 cờ) | ✅ **xong** |
| 4 | **F4** báo trạng thái khi sidecar thoát | thấp, nằm ở `sidecar.js`/`main.js` | ✅ **xong** |
| 5 | **F1** nén ở **tiến trình riêng** (~~`run_in_threadpool`~~ — xem hộp cảnh báo ở F1) | **trung bình** — thêm tiến trình con vào bản frozen | ✅ **xong** (còn 1 việc kiểm tra, dưới) |
| 6 | **F1b** ước tính thời gian trong hộp thoại Nén | thấp | ✅ **xong** |
| 7 | **F5** quyết định trần thực dụng + ghi vào Hướng dẫn | — | ✅ **xong** |

**Đụng `api.py` và `sidecar.py` ⇒ bắt buộc `npm run build:sidecar` trước khi đóng gói.**

> ### ⚠️ Việc còn nợ của bước 5: PHẢI thử trên bản ĐÓNG GÓI
> Worker chạy bằng `sys.executable`, mà giá trị đó **khác nhau** giữa dev (python của
> venv + đường dẫn `sidecar.py`) và bản frozen (`sidecar.exe`, cờ đi thẳng). Nhánh frozen
> **chưa từng chạy trên máy này** — ở đây chỉ có nhánh dev.
> `test_compress_worker_command_shape` canh *hình dạng* argv ở cả hai nhánh, nhưng không
> thay được một lần chạy thật. Danh sách thử tay nằm ở dòng ma trận của **BI-54**; hai
> mục dễ trượt nhất là **nháy cửa sổ console đen** và **`sidecar.exe` sót lại** sau khi
> thoát app giữa lúc nén.

---

## 5b. Bước 1–4 — đã làm gì, kiểm chứng ra sao

| File | Thay đổi |
|---|---|
| `api.py` | `_FIND_CACHE_MAX_PARTS` 300.000 → **80.000**, kèm con số đo được trong chú thích · `_find_scan_index` dựng **hai** union cho hit cross-span: `bbox` từ hộp chưa xoay `parts[i][2]`, `bbox_view` từ hộp hiển thị `parts[i][3]` |
| `renderer/find-replace.js` | `fr.truncated` / `fr.truncatedPage` — đặt lại ở **đầu** `runFind` (trước request) và ghi từ response · `replaceAll` đổi câu xác nhận theo cờ đó, thêm dòng "phần sau CHƯA được quét" · `closePanel` dọn cờ |
| `renderer/i18n.js` | 3 khoá EN mới cho các câu trên |
| `src/sidecar.js` | `startSidecar(token, onExit)` + `handle.stopping`; `stopSidecar` đặt cờ **trước** khi kill |
| `src/main.js` | `bootSidecar` truyền `onExit` → `setSidecarState({state:"error"})`, kèm chốt `if (sidecar !== handle) return` |
| `test_text_find.py` | **R10c/R10d** — hit cross-span trên trang xoay: hai hộp phải khác nhau, `bbox` đúng bằng union **chưa xoay**; trên trang không xoay hai hộp phải **trùng** |
| `desktop/test/find-replace.test.js` | 6 assertion cho BI-53 nửa "Thay tất cả" (cờ được ghi, được dọn **trước** request, câu chữ rẽ nhánh theo cờ, `closePanel` dọn) |
| `desktop/test/sidecar-lifecycle.test.js` (**mới**, `npm run test:sidecar`) | 7 ca, **boot sidecar dev thật**: chết đột ngột → `onExit` bắn kèm đúng handle; `stopSidecar` → **im lặng**; `stopSidecar(null)` không ném |
| `docs/REGRESSION-GUARD.md` | BI-52 thêm hai gạch đầu dòng (trần cache đo được, hai hộp) · **BI-53** mới · hai dòng ma trận test |

**Kết quả chạy sau khi sửa:** `run_tests.py` **12/12 file** · **13 lưới JS** 0 fail
(`find-replace` 129 → **138** ca, `text-find` 46 → **52** ca, `sidecar-lifecycle` **7** ca
mới) · `node --check` sạch trên 4 file JS đã sửa.

**Vì sao hai phép sửa ở `api.py` không đổi hành vi tài liệu thường:** trên trang **không**
xoay `rotation_matrix` là ma trận đơn vị nên hai union cho ra **cùng một** hình chữ nhật —
R10d chốt đúng điều đó; còn hạ trần cache **không từ chối** tài liệu nào, vượt trần chỉ có
nghĩa là lần tìm sau parse lại (hành vi đã có sẵn từ v0.2.56).

---

## 5c. Bước 5 (F1) — đã làm gì, đo lại ra sao

| File | Thay đổi |
|---|---|
| `sidecar.py` | Chế độ thứ hai `--compress-worker <in> <out> <preset>`: nén một file rồi thoát. Kiểm argv **trước** `argparse` (cờ này không phải tuỳ chọn của server) · `_err()` ghi stderr **UTF-8 tường minh** |
| `api.py` | `_compress_worker_cmd` (argv frozen ≠ argv dev) · `_compress_via_worker_blocking` (temp file → `subprocess.run` → đọc kết quả; `CREATE_NO_WINDOW` trên Windows) · `_COMPRESS_WORKER_MIN_BYTES = 25 MB` · `/compress-bin` chọn đường theo ngưỡng, và **quay về nén tại chỗ** nếu `OSError` lúc khởi chạy |
| `test_pdf_ops.py` | 5 ca mới: worker ra **đúng** tài liệu như đường tại chỗ · lỗi người gọi → 400 với câu tiếng Việt **so từng ký tự** · file hỏng → 400 · hình dạng argv cả hai nhánh · ngưỡng giữ file nhỏ ở đường tại chỗ |
| `docs/REGRESSION-GUARD.md` | **BI-54** + dòng ma trận test (gồm danh sách thử tay **trên bản đóng gói**) |

**Đo lại trên HTTP thật, cùng harness với số "trước":**

| | Trước | Sau |
|---|---|---|
| `/health` xấu nhất trong lúc nén 30 trang | **13.088 ms** | **32 ms** (lúc rảnh: 32 ms) |
| probe `/health` thất bại | — | **0/89** |
| nén file nhỏ (1,5 KB) | 0,00 s | **0,00 s** (không đụng worker) |
| nén 86,7 MB / 30 trang | 13,4 s | **16,8 s** |
| hai lệnh nén cùng lúc | (nối đuôi) | cùng xong sau 18,4 s, **kích thước ra giống hệt nhau** |

Đánh đổi đã biết và chấp nhận: **+~3,5 s cố định** cho mỗi lần nén file lớn (khởi động
worker + ghi/đọc temp file). Trên một việc vốn đã 13 giây và có thể lên hàng chục phút, đổi
lấy việc app không đứng là đáng.

**Một lỗi thật đã bắt được lúc làm:** ca thử đầu tiên của worker ném `UnicodeDecodeError` ở
tiến trình cha — `sys.stderr.write` trong con mã hoá theo codepage console còn cha giải mã
UTF-8, nên "preset phải là…" sẽ đến tay người dùng thành ký tự rác. Nay cả hai đầu chốt
UTF-8, và `test_compress_worker_reports_caller_errors_as_400` so **đúng từng ký tự**.

---

## 5d. Bước 6–7 (F1b + F5) — ước tính thời gian, và trần thực dụng

**Hiệu chuẩn trước, viết code sau.** Câu hỏi "ước tính theo gì" có câu trả lời đo được, và
nó khác trực giác:

| Tài liệu | Trang | MB | giây | **s/MB** | **s/trang** |
|---|---:|---:|---:|---:|---:|
| scan toàn ảnh | 20 | 57,8 | 8,78 | 0,152 | 0,439 |
| chữ, 45 dòng/trang | 600 | 6,1 | 0,60 | 0,098 | 0,001 |
| vector kiểu CAD, A0 | 120 | 0,7 | 0,14 | 0,189 | 0,001 |

⇒ **s/MB trải 2 lần, s/trang trải 439 lần.** Ước tính **phải** theo dung lượng. Và phải
theo **preset** — cùng file 57,8 MB: screen 0,047 · ebook 0,155 · printer 0,179 ·
**lossless 0,003** s/MB (nó bỏ hẳn `rewrite_images`).

Công thức: `giây ≈ MB × hệ_số_preset + 3s (nếu ≥25MB, tức đi qua worker)`. Đối chiếu:
86,7 MB/ebook → ước tính 17 s, **đo 16,8 s**; 57,8 MB/ebook → 12 s, đo 8,78 + 3 = 11,8 s.

**Đã làm:** dòng `Tài liệu … · ước tính khoảng …` trong hộp Nén, cập nhật theo cả dung
lượng lẫn preset; overlay lúc chạy mang luôn con số; `#cmp-eta` vào `SKIP_IDS`; 6 khoá EN
mới.

**F5 — quyết định, và lý do:** **giữ `_MAX_PDF_BIN` = 1 GB.** Hạ nó xuống sẽ **từ chối**
những tài liệu chạy tốt trên máy 32 GB, mà giới hạn thật là **máy chứ không phải định
dạng** — đỉnh bộ nhớ cả chuỗi ≈ **4 lần cỡ file**, rải trên ba tiến trình. Nên thay vì đổi
trần: **cảnh báo ở 300 MB** (≈1,2 GB bộ nhớ — chỗ máy 8 GB bắt đầu đuối), có hộp hỏi lại
nêu rõ thời gian, mức RAM và việc **không dừng được**; và **ghi thẳng vào tài liệu** — mục
Khắc phục sự cố + Yêu cầu máy trong `HUONG-DAN-SU-DUNG.md`, và hai mục mới trong trang Trợ
giúp trong app (song ngữ).

**Lưới:** `npm run test:geom` **55 → 86 ca** — đối chiếu ước tính với chính các số đo trên,
bậc thang worker, đơn điệu, preset lạ rơi về ebook, mọi preset trong `<select>` đều có hệ
số, 6 khoá i18n, `cmp-eta` ∈ `SKIP_IDS`, và **thứ tự hỏi-trước-khi-bake**.

> **Hai lỗi của chính tôi mà lưới bắt được** (đáng ghi, vì cả hai đều "im lặng"):
> lưới `test:help` chặn `*nghiêng*` — help.js chỉ hiểu `**đậm**` và `` `mã` ``, chữ đó sẽ
> hiện nguyên dấu sao; và assertion thứ tự lúc đầu khớp trúng chữ `bakePending` trong
> **chú thích** tôi vừa viết chứ không phải lời gọi, nên phải neo vào `Editor.bakePending()`.
> Bài học: assertion trên source phải neo vào **cú pháp gọi**, đừng neo vào tên trần.

---

## 6. Phạm vi đã rà và **chưa** rà

**Đã rà kỹ:** `/compress`, `/compress-bin`, `_compress_pdf_bytes`, `/text-find`,
`/text-find-bin`, `_find_build_index`/`_find_index_for`/`_find_scan_index`,
`renderer/find-replace.js` toàn bộ, `runCompress`, đường `savePdf`, tầng khởi động sidecar,
middleware token + CORS.

**Chưa rà trong đợt này** (không nằm trong họ "trần dung lượng"): `editor.js` (bake chú
thích), `sign.js`, `compare.js`, `capture.js`, `tabs.js`/khôi phục phiên, `updater.js`, và
đường in. Nếu cần một lượt rà toàn app thì nên đi theo bảng rủi ro ở §1 của
`REGRESSION-GUARD.md`, mỗi hệ con một đợt.
