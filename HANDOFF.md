# Handoff — Nabu PDF

> Bàn giao trạng thái để tiếp tục ở session/máy khác. Đọc kèm:
> [DESIGN.md](DESIGN.md) (kiến trúc), [ROADMAP.md](ROADMAP.md) (tiến độ chi tiết),
> [SETUP.md](SETUP.md) (dựng môi trường).

_Cập nhật: 2026-07-30 · v0.2.50 đã phát hành (dưới đây)_

> **v0.2.50 — vẽ tay giữ Shift ra đoạn thẳng + dấu ✓/✗, và vá thanh chú thích bị tràn**
> (chỉ renderer + test + tài liệu — **sidecar KHÔNG đổi, không cần rebuild**).
>
> **1. Vẽ tay + Shift.** Giữ Shift giữa nét → đoạn thẳng **góc bất kỳ** từ điểm neo tới
> con trỏ; thả Shift → vẽ tay tiếp từ đúng đầu mút đó, nên một nét trộn được cả gấp khúc
> lẫn nét tay. `e.shiftKey` đọc **live từ event** (đúng khuôn `resizeRect` đã có ở
> `onMove`) nên nhấn/thả giữa chừng ăn ngay — không dùng cờ `keydown` toàn cục, thứ sẽ
> **kẹt** khi Shift được thả lúc cửa sổ mất focus.
>
> Luật nằm ở [`annot-geom.js`](desktop/renderer/annot-geom.js) `strokeExtend()` — thuần,
> nên vào được lưới. Nó có **đúng một** cái bẫy và bẫy đó im lặng tuyệt đối: điểm neo phải
> **chốt một lần** lúc Shift vừa nhấn rồi mang theo (`drag.lineFrom`). Suy lại neo =
> "điểm cuối" ở mỗi `mousemove` sẽ ghim nó vào chính điểm vừa ghi ⇒ đoạn thẳng luôn dài 0
> ⇒ **Shift trông như không làm gì**, không lỗi, không cảnh báo. `test:cloud` có ca canh
> gác dựng lại đúng lỗi đó.
>
> **2. Dấu ✓ / ✗.** Hai kind chú thích mới (`check` / `cross`), hai nút riêng, phím `K` /
> `J` (`x` đã là redact). Bấm = cỡ mặc định 18pt căn giữa điểm bấm và **kẹp vào trong
> trang**; kéo = tự chọn cỡ — việc này nằm ở **`onUp`**, không phải `onDown`, vì lúc
> `onDown` chưa biết cử chỉ sẽ là bấm hay kéo. Vào `RESIZABLE_KINDS` nên **miễn phí** có
> 4 tay nắm + Shift-giữ-tỷ-lệ + move + undo.
>
> Hình học ở `symbolStrokes()` — **cùng khuôn BI-40**: một hàm, hai người đọc (`<svg>`
> overlay và `page.drawLine` lúc bake). Viết riêng hình cho phần bake là tái lập đúng lớp
> lỗi im lặng của BI-40.
>
> Màu: ✓ và ✗ **nhớ màu riêng** (`ed.checkColor` xanh / `ed.crossColor` đỏ, khuôn
> `redactColor`) nhưng **dùng chung ô "Màu"**. `colorSlotFor()` là chỗ duy nhất quyết định
> ghi vào đâu và nó ưu tiên **kind của mục đang chọn** hơn công cụ hiện tại — nếu không,
> dưới công cụ Chọn việc đổi màu một dấu ✗ sẽ âm thầm ghi đè màu chung của bút tô
> sáng/vẽ tay. Hai loại này **flatten** khi bake (như draw/box/cloud), không round-trip.
>
> **3. Vá thanh chú thích bị tràn — lỗi CÓ SẴN, phát hiện nhờ đo trước khi thêm nút.**
> `.edit-bar` là một hàng flex **không** `flex-wrap`. Đo bằng probe Electron trên chính
> `app.css`, width nhỏ nhất còn bấm được "Xong": `select` 959px · `box/ellipse` 1451px ·
> **`cloud/cloudpen` 1667px**. Tức laptop **1366px đã mất nút "Xong"/"Hủy bỏ"** ở vài
> công cụ **từ trước bản này** — chú thích được mà không có đường ghi lại. Kèm theo
> `#ed-hint` (`min-width: 0`) bị bóp về 0 rồi chữ xuống dòng dựng đứng, đẩy thanh cao
> **381px**. Mỗi nút công cụ thêm vào tốn **+76px** trên mọi ngưỡng, nên 2 nút mới làm
> nó nặng thêm. Vá bằng `flex-wrap: wrap` → mọi width 900–1920px đều OK, thanh cao
> 46–127px. Xem **BI-41**.
>
> **Kiểm chứng.** Lưới tự động **566 pass / 0 fail** (8 bộ; +41 ca mới ở `test:cloud`).
> Ngoài ra ba probe Electron chạy trên **`index.html` thật**: 28/28 (boot + tương tác +
> bake), 20/20 (hồi quy: phím tắt, Esc giữa chừng, undo/redo, chọn/di chuyển/đổi cỡ, các
> công cụ cũ), và một probe **render PDF đã bake bằng pdf.js rồi đếm pixel** — 819 px
> xanh nằm trong đúng ô đã vẽ, **0 px** ở dải y-đối xứng (bẫy lật trục), và **trang xoay
> 90°** cũng đúng.
>
> ⚠️ **Bài học về cách kiểm bake, đáng nhớ hơn cả tính năng:** lần đầu tôi kiểm bake bằng
> cách đọc lại content stream của PDF. Stream đã **nén Flate** ⇒ regex khớp chuỗi rỗng ⇒
> `[].every()` là `true` ⇒ **mọi assertion "pass" một cách rỗng tuếch**. Đọc lại output
> của chính pdf-lib cũng chỉ là nhắc lại thứ mình vừa yêu cầu. Cách đúng là cho byte đã
> lưu đi qua **một bộ đọc độc lập** (pdf.js — đúng engine app dùng để xem) rồi **nhìn
> pixel**. Cùng bài học với `open-findings-2026-07-26`.
>
> Ghi vào [`docs/REGRESSION-GUARD.md`](docs/REGRESSION-GUARD.md): **BI-41** (ngân sách bề
> rộng thanh chú thích) + **BI-42** (hai bất biến của tính năng mới), và 3 dòng mới ở ma
> trận §5.
>
> **Hai điểm còn nợ, cố ý không sửa trong đợt này:** (1) tooltip công cụ cũ (`"Vẽ tay"`…)
> không dịch được sang EN vì registry i18n khớp **nguyên chuỗi** mà `title` thật có hậu tố
> `"(phím D)"` — lỗi có sẵn, key mới của v0.2.50 đã viết đúng nguyên chuỗi; (2) ✓/✗ chưa
> round-trip (sửa lại sau khi Lưu) — muốn có thì xem cái giá ở BI-37/38.

> **v0.2.49 — tách `managed-codec` khỏi `editor.js` + sửa font nhãn
> mũi tên/watermark** (chỉ renderer + test + tài liệu — **sidecar KHÔNG đổi, không cần
> rebuild**).
>
> Nốt cuối của việc tách bắt đầu ở v0.2.48 phần 4. Điều kiện tự đặt lúc đó — *"chỉ tách
> code đã ship và đã test tay"* — nay đã thoả, nên 13 hàm + 6 hằng của lớp object PDF
> riêng chuyển sang [`renderer/managed-codec.js`](desktop/renderer/managed-codec.js).
> `editor.js` **3323 → 3181 dòng**. `test:managed` (49 ca) chuyển từ cắt-hàm-lúc-chạy sang
> `require()` thẳng; chỉ còn 4 thứ phải cắt, mỗi thứ có lý do ghi rõ trong file test:
> `deserializeManaged` (cần `ed.seq`), `addManagedAnnot` (gọi rasteriser canvas),
> `edSnapshot` (hệ undo), `dataUrlToBytes` (adapter 3 dòng, riêng của `editor.js`).
> 13/13 thân hàm **byte-identical** với bản tiền-move.
>
> **⚠️ Bài học đáng giá nhất của bản này, và nó tốn một lần app trắng để thấy.**
> Bản đầu khai `const { PDFName, PDFRawStream, PDFDict, degrees } = PDFLib` ở **top level**
> của classic script mới. `app.js:17` cũng khai `degrees` ở top level. Hai `const` cùng tên
> trong cùng global scope = **SyntaxError**, và nó **không** giết file mới mà giết
> **`app.js`** (nạp sau) ⇒ `$` biến mất ⇒ `pan.js`/`editor.js`/`capture.js`/`sign.js` đổ
> theo ⇒ **app trắng**.
>
> Điều đáng ghi nhớ: **`node` không thấy lỗi này. Lưới 537/537 xanh trong khi app đang vỡ**,
> vì `require()` cho mỗi module một scope riêng. Chỉ **probe Electron** bắt được, qua đúng
> ba tín hiệu: `Identifier 'degrees' has already been declared`, `window.Editor` thành
> `undefined`, và `$ is not defined` hàng loạt. Lúc kiểm trùng tên trước khi move tôi chỉ
> kiểm **tên hàm** đem đi, không kiểm **binding destructure** mới thêm vào — đó là chỗ hổng.
>
> Cách sửa thành **khuôn mức thứ tư** cho §2: bọc **IIFE** để binding riêng thành private,
> publish bề mặt bằng `Object.assign(window, SURFACE)` — property của global object vẫn
> phân giải như tên trần khi *đọc*, mà không thể trùng khai báo. Ghi ở **BI-14 (nửa sau)**,
> kèm lệnh grep kiểm nhanh. **Mọi file classic mới có destructure từ thư viện phải theo
> khuôn này.**
>
> **Kèm bản sửa font — thứ DUY NHẤT trong v0.2.49 người dùng thấy được.**
> `fontFamily(falsy)` trả `'"sans", sans-serif'` (font tên **literal** `sans`, không tồn tại)
> thay vì stack `sans` ⇒ **Arial**. Hộp văn bản không đi vào nhánh đó (`normTextStyle` luôn
> cấp `font: "sans"`), nhưng `textFont(fpx)` gọi **không có** `opts` thì có — và đó đúng là
> `renderArrowPng` + `renderWatermarkPng`. Nên **nhãn mũi tên và watermark render bằng
> Arial** suốt nhiều phiên bản còn mọi hộp văn bản dùng Segoe UI. Không ai phát hiện được
> vì **cả hai không có tuỳ chọn font** (`TOOL_CTLS.arrow` = `["color","penwidth","arrowlabel"]`;
> modal watermark chỉ có size/angle/opacity/color) — không có nút nào để thấy nó sai.
>
> Phạm vi đã **đo bằng probe**, không suy luận: `layoutTextBox` **0/1248** lệch ·
> `measureText` **0/1248** · hình học mây/mũi tên **0/178** · `textFont` **1104/1248** —
> đúng những ca không có `font` tường minh (144 ca còn lại có `serif`/`mono`/font hệ thống
> nên không đổi). Hộp văn bản và hình học **không đổi gì**; chỉ nhãn mũi tên + watermark
> **bake mới** đổi font, file đã lưu là pixel nên không đổi. Ca test từng **ghim hành vi
> cũ** đã được cập nhật **có chủ ý** — đúng như chính nó dặn. Xem BI-40.
>
> ⚠️ Cho người dùng **chọn** font nhãn mũi tên / watermark là **tính năng khác**, chưa làm:
> phải thêm field `font` vào annot mũi tên + object watermark, thêm `"font"` vào
> `TOOL_CTLS.arrow`, và truyền style vào `textFont` ở hai rasteriser. (`labelSize` cũng đang
> hardcode `14` ở `editor.js:945`.)
>
> **Verify:** 8 lưới **538 pass / 0 fail** · `node --check` 25/25 · probe Electron: **37/37
> tên trần**, `window.Editor` đủ 10 key, `Pan`/`AnnotText`/`AnnotGeom`/`ManagedCodec` đủ,
> hai shim (`pushB64Chunks`, `normTextStyle`) phân giải về **tên trần** trong trình duyệt,
> **2674 ca tương đương 0 lệch**, **0 lỗi console mới** so với baseline tiền-tách.
> ⚠️ **Phát hành KHÔNG qua test tay GUI** (quyết định của chủ dự án, 2026-07-29): thay đổi
> thuần renderer, đã có 538 ca lưới + 2674 ca tương đương trong Electron thật + probe
> 0 lỗi console mới. Phần lưới **không** phủ là tương tác chuột. Nếu có báo lỗi từ người
> dùng, hai đường đáng soi trước là **ảnh round-trip** (managed-codec) và **font nhãn mũi
> tên/watermark**.

> **v0.2.48 — zoom mượt + cột trang chạy theo trang đang đọc + ảnh chèn
> vẫn là object sửa được** (chỉ renderer + tài liệu — **sidecar KHÔNG đổi, không cần rebuild**).
> Ba order feedback của người dùng, xử lý trong một lượt vì cả ba đụng cùng vùng
> `app.js` (viewer) / `editor.js` (overlay).
>
> **1 · Zoom không còn khựng — `zoomTo` thôi gọi `renderViewer()`.**
> Thủ phạm không phải “render liên tục” theo nghĩa vẽ nhiều, mà là **mỗi nấc lăn chuột
> phá sạch DOM rồi dựng lại**: `renderViewer` xoá toàn bộ `.page-wrap`, dựng lại canvas,
> nối lại hai IntersectionObserver, rasterise 2 trang đầu — trước khi có gì nhúc nhích
> trên màn hình. Tệ hơn, cờ `zooming` **âm thầm bỏ** những nấc tới trong lúc nó chạy, nên
> lăn nhanh còn bị mất nấc. Nay tách hai nửa như Acrobat/Foxit:
> `applyScaleToDom()` **đồng bộ, chỉ đổi CSS box** (compositor kéo giãn bitmap đang có →
> bám tay ngay, hơi mềm một nhịp) rồi `commitScale()` **hoãn 160 ms** mới rasterise lại
> đúng những trang đang giữ bitmap. Vì `.page-wrap` **được dùng lại**, overlay chú thích,
> ô nhập chữ đang mở, highlight Ctrl+F và hình học cuộn đều sống nguyên qua một lần zoom —
> điều bản cũ không hứa được.
> Hai chi tiết đáng nhớ: (a) `.text-layer` **không cần vẽ lại** — pdf.js 3.x ghi vị trí span
> bằng `calc(var(--scale-factor) * Npx)`, đổi đúng một biến CSS là cả lớp tự dàn lại
> (đã kiểm chứng trong bundle vendor, rồi probe lại trong Chromium thật); (b) bước lăn
> chuột chuyển sang **phép nhân** (1.1/nấc) và làm tròn tỷ lệ lên **3 chữ số** — cộng cố
> định 0.1 là nhảy 25% ở mức 40% mà chỉ 3% ở mức 300%, và làm tròn 2 chữ số thì pinch
> trackpad bị vo về đúng tỷ lệ cũ ⇒ cử chỉ chết. Xem **BI-36**.
>
> **2 · Cột trang trượt & sáng theo trang đang đọc** (`syncThumbFocus`). Quyết định quan
> trọng nhất ở đây là **không** đổi `state.selected`: “trang đang xem” và “trang đang chọn”
> là hai thứ khác nhau, nhập chúng lại là cuộn qua trang khác rồi bấm Xoá sẽ xoá trang vừa
> cuộn tới — đúng loại hậu quả BI-26. Nên cue hình cũng phải khác `.selected` (nền + số
> trang đổi màu, không phải viền accent). Cuộn bằng **số học** `nearestScrollDelta` chứ
> không `scrollIntoView()` (cái đó cuộn cả phần tử cha + có animation, đánh nhau với
> smooth-scroll của viewer), và **đứng im khi đang kéo sắp xếp trang** (BI-33). Xem **BI-39**.
>
> **3 · Ảnh chèn round-trip như hộp văn bản** — `image` vào `MANAGED_KINDS`, ghi ra
> `/Stamp` + `/AP` + `/NabuData`, mở lại là object kéo/đổi cỡ/xoá được. Phần khó **không**
> phải cái annot mà là **byte ảnh gốc để lại đâu**, và câu trả lời chỉ ra được sau khi đo:
> - không khôi phục được từ ảnh trong `/AP` (pdf-lib giải mã PNG thành mẫu thô + `/SMask`,
>   bỏ container);
> - nhét base64 vào `/NabuData` như mọi kind khác thì **hex tốn ~1.46× cỡ ảnh và >1 s để
>   ghi 1 MB**, và — điều chặn đứng phương án này — **cả `PDFHexString.decodeText` lẫn
>   `PDFString.decodeText` ném `RangeError` khi payload > ~150 KB** (chúng spread cả buffer
>   qua `String.fromCharCode`), tức một PNG chữ ký đã không đọc lại được;
> - **stream thô riêng `/NabuSrc` không có `/Filter`** = **1.00×**, ~5 ms cho 2 MB, đọc ra
>   đã là byte. Chọn cái này. Và chính chỗ “không có `/Filter`” thành **khoá an toàn**: có
>   filter nghĩa là tool khác đã nén lại ⇒ annot thành **chỉ đọc** chứ tuyệt đối không bị
>   xoá lúc bake (BI-37).
>
> Hai thứ **phải sửa kèm**, không phải tuỳ chọn:
> - **Bỏ liên kết annot là chưa đủ.** pdf-lib giữ mọi object nó đọc và ghi lại tất cả, nên
>   `arr.remove(i)` để lại appearance cũ trong file **mãi mãi** — một hộp văn bản bake 10
>   lần là 10 bản PNG (bug âm thầm **có từ trước**, ảnh chỉ làm nó lộ ra vì to). Nay giải
>   phóng cả chuỗi object riêng của annot; an toàn vì `embedPng` của pdf-lib trả **ref mới
>   mỗi lần gọi**. Thứ tự bắt buộc: **bỏ liên kết cả tài liệu trước, giải phóng sau** — một
>   `/NabuSrc` được chia sẻ cho mọi trang “áp nhiều trang”, xoá giữa vòng lặp là ảnh nhân
>   đôi. Kết quả: “áp 1 chữ ký cho 20 trang” giờ **nhúng ảnh 1 lần**, tức **nhỏ hơn cả bản
>   cũ**. Xem **BI-38**.
> - **`rasterRedacted` phải tắt annotation** trên trang có annot round-trip. Bug này cũng
>   có từ trước (redact + hộp văn bản đã bake trên **cùng một trang** ⇒ hộp chữ hiện hai
>   lần, và ảnh vừa xoá quay lại thành pixel không xoá được). Chỉ tắt trên trang thật sự
>   có annot của ta, để annot lạ ở trang khác vẫn được burn vào raster như cũ.
> - **`edSnapshot` không được clone base64 nữa.** Vì ảnh round-trip nên nó **sống trong
>   `ed.annots` cả phiên**, và `JSON.parse(JSON.stringify(...))` sẽ nhân bản chuỗi
>   multi-MB vào cả 50 ô undo (đo được: 60 ô × ảnh 5 MB ⇒ ~300 MB). Nay `dataUrl` được đổi
>   thành token khi stringify và trả lại **theo tham chiếu** — đo lại: **0.1 MB**. Đúng bài
>   học BI-24, lần này trên heap.
>
> **4 tay nắm góc + Shift giữ tỷ lệ.** Trước đây object chỉ có **một** tay nắm ở góc
> dưới-phải. Nay 4 góc, góc đối diện đứng yên (`resizeRect`), giữ **Shift** = giữ đúng tỷ
> lệ — áp cho cả tô sáng / redact / chữ nhật / elip, không riêng ảnh.
>
> **Lưới test — thêm cách thứ hai để test renderer mà KHÔNG tách file.** §1 của
> REGRESSION-GUARD nói `app.js`/`editor.js` không test tự động được; v0.2.48 mở rộng đúng
> mẹo đã dùng ở v0.2.47: test **cắt thẳng hàm ra khỏi file đang ship lúc chạy** rồi cấp cho
> nó những tên nó khép kín ⇒ cái được test **chính là** cái chạy, và không phải tách file
> thứ tư. `npm run test:geom` (39 ca) + `npm run test:managed` (42 ca, chạy trên chính
> pdf-lib đã đối chiếu sha256 với bản vendor). Nửa DOM thì probe bằng **chính Electron của
> dự án** (30/30). Bốn lưới cũ + 11/11 test Python đều xanh.
> **4 · Tách lõi thuần khỏi `editor.js` — +180 ca test mới, 0 call site đổi.**
>
> **Xuất phát từ một câu hỏi, không phải một lỗi:** “`editor.js` 4k dòng, có nên module
> hoá?”. Đo trước khi trả lời — và câu trả lời là **KHÔNG, không module hoá toàn bộ**:
> 57% file (58 hàm / 2075 dòng) bám DOM/canvas, tách ra chỉ *di chuyển* code chứ không
> làm nó test được. Bốn rào cản đo được (ESM chết vì `file://`, bundler phá lưới hiện
> có, `ed` là 345 chỗ dính, không có áp lực cộng tác) ghi ở
> [REGRESSION-GUARD §1](docs/REGRESSION-GUARD.md) để không phải điều tra lại.
>
> **Cái ĐÃ làm là phần thuần: 2 file mới, ~460 dòng, 0 call site nào đổi.**
> - [`renderer/annot-text.js`](desktop/renderer/annot-text.js) — `layoutTextBox` và bạn bè.
>   Đây là hàm quan trọng nhất trong cả `editor.js`: nó định vị **từng glyph** và là nguồn
>   duy nhất cho **cả** hộp trên màn hình (`measureText`) **và** PNG đem bake
>   (`renderTextPng`). Hai đường lệch nhau = chữ tràn khung **trong file đã lưu**, màn hình
>   vẫn đẹp. → `npm run test:text`, **104 ca**.
> - [`renderer/annot-geom.js`](desktop/renderer/annot-geom.js) — mây revision, nhãn mũi tên,
>   `resizeRect`. Mây trả **một** chuỗi SVG path cho cả overlay và pdf-lib. → lưới **mới**
>   `npm run test:cloud`, **73 ca** (trước đây phần này **không có test nào**);
>   `resizeRect` chuyển từ `eval` sang `require()` trong `test:geom` (39 ca vẫn xanh —
>   đó chính là bằng chứng tương đương của nó).
> - **Cùng mức `wire.js`, không phải `page-range.js`** — giữ **tên trần**, vì ~36 chỗ gọi
>   đã có sẵn. Hệ quả quan trọng: phía `editor.js` của lần này là **thuần xoá**, không
>   một call site nào đổi ⇒ hành vi **không thể** lệch. Đánh đổi: hai file **phải nạp
>   trước** `editor.js`. Xem [§2](docs/REGRESSION-GUARD.md) + BI-14.
>
> **Cách kiểm chứng — 3 tầng, không tầng nào là “đọc code thấy ổn”:**
> 1. **Byte-identical**: script so từng dòng thân hàm đã move với bản trong `git HEAD` →
>    **7/7 khớp tuyệt đối**. Nên đây là đổi chỗ ở, không phải viết lại.
> 2. **Tương đương lúc chạy, trong Electron thật**: probe nạp `index.html` **thật**, eval
>    bản gốc tiền-tách vào **cùng trang** rồi so kết quả trên **font metrics thật** —
>    **2674 ca, 0 lệch** (1248 layout + 1248 measureText + 178 mây/mũi tên). Cùng probe
>    khẳng định **18/18 tên trần** thấy được qua ranh giới `<script>` và `window.Editor`
>    đủ 10 key (IIFE chạy trọn). Chạy baseline trên renderer HEAD để so: **0 lỗi console
>    mới**, và baseline cho `REFERENCE-ERROR` trên cả 18 tên → phép kiểm **không rỗng**.
> 3. **Lưới**: 352 → **532 pass, 0 fail** (8 lưới) · `node --check` 24/24 · Python 11/11.
>
> **Kèm một lỗi thật đã sửa:** `dataUrlToBytes` bị **nhân bản 3 lần** — `editor.js` và
> `sign.js` giống hệt nhau từng dòng, và cả hai lặp lại `b64ToU8` của `wire.js` (bộ decode
> đã chuẩn hoá, đã có 51 ca test). Đúng khuôn bệnh đã sinh ra BI-27. Nay cả hai delegate.
> **Có guard nổ tiếng**: `b64ToU8` dung thứ payload rỗng (trả 0 byte, `test:wire` ghim ca
> đó), mà 0 byte ở đây nghĩa là **nhúng một ảnh RỖNG** — nên adapter phải `throw`.
> 3 ca canh gác trong `test:managed` (42 → 45).
>
> **Một quirk đã ghim, CHƯA sửa** (cần bạn quyết): `fontFamily("")`/`fontFamily(null)`
> không trả stack `sans` mà trả `'"sans", sans-serif'` → **nhãn mũi tên + watermark render
> bằng Arial**, còn hộp văn bản dùng Segoe UI. Có từ trước. `test:text` ghim hành vi hiện
> tại; sửa là **đổi hình dáng file đã lưu**, nên để bạn quyết — xem BI-40.
>
> **Cố ý CHƯA tách khối `managed-codec`** (`managedSrcBytes`, `managedSrcDataUrl`,
> `collectManagedChain`, `freeManagedTrash`) — **việc còn lại cho phiên sau.** Lúc làm
> phần 4 này, 4 hàm đó còn là code mới của phần 3 ở trên: **chưa từng ship, chưa test tay
> GUI**. Tách chúng ngay lúc đó sẽ làm đợt test tay không phân biệt được lỗi là của tính
> năng mới hay của phép move — trên đúng đường code mà sai là **mất ảnh của người dùng**
> (BI-37/38). Nay v0.2.48 **đã** ship và **đã** test tay, nên điều kiện đó đã thoả:
> tách được ở phiên sau. Đổi lại, phần này **không** thêm coverage mới (42 → 45 ca của
> `test:managed` đã phủ, qua cách cắt-hàm-lúc-chạy) — cái mua được là bỏ một hack `eval`
> và giảm ~140 dòng nữa khỏi `editor.js`. Ưu tiên thấp hơn hai file đã tách.
>
> ✅ **Đã test tay trên GUI** (2026-07-29): tất cả các mục ở §5 đều đạt.
>
> **Hai thứ lộ ra lúc đóng gói, đã sửa trong chính bản này:**
> - **Sidecar đã stale 2 release.** Marker còn trỏ `10bbccf` (**v0.2.39**, build
>   2026-07-23T10:12Z) trong khi `api.py` + `src/pdf/fonts.py` đổi **324 dòng** ở
>   **v0.2.40** và **v0.2.43**. Nghĩa là *"sửa trắng trang khi Sửa nội dung trên PDF
>   lớn"* và *"sửa chữ giữ đúng font/cỡ/nền"* **chưa từng đến tay người dùng** — đúng
>   loại lỗi mà `check-sidecar-fresh.js` được dựng để chặn (comment của
>   `write-sidecar-marker.js` ghi rõ nó **đã** xảy ra một lần trước đó). Guard chạy
>   đúng; nó đã bị bỏ qua ở hai release đó. **Bản này rebuild** → marker `e336fcc7`,
>   smoke-test `/health` 200. **Luật: đừng bao giờ `SKIP_SIDECAR_CHECK=1`.**
> - **`SHA256SUMS.txt` mô tả sai thứ nó đi kèm.** `checksums.js` hash **mọi** `.exe`
>   trong `dist-app/`, mà thư mục đó không bị xoá giữa các build ⇒ file publish ra có
>   **55 dòng** trải từ `0.2.1`, gồm cả những version đã bị xoá khỏi Releases, và chỉ
>   **1 dòng** thuộc release hiện tại. Nay script **giới hạn theo `version` trong
>   package.json** và hash bằng **stream** (trước đó `readFileSync` kéo ~10 GB qua RAM
>   mỗi lần chạy: >120 s → **1,5 s**).
>
> **Kích thước installer: 387 → 455 MB (+68 MB)**, hệ quả trực tiếp của việc rebuild
> sidecar từ nguồn v0.2.39 lên nguồn hiện tại. Không phải lỗi, nhưng **đáng làm nhẹ ở
> phiên sau**: `dist/sidecar` giải nén là **1155 MB**, trong đó `torch` 446 · `cv2` 148 ·
> `scipy` 83 · **`pyarrow` 78** · `rapidocr` 47 · `pymupdf` 46 · `onnxruntime` 38 ·
> `matplotlib` 21 · `pandas` 13.
>
> **Đã truy nguồn từng cái (đừng đoán lại):**
> - **`matplotlib` 21 MB — BẮT BUỘC, đừng bỏ.** `src/pdf/fonts.py` import `font_manager`
>   ở 4 chỗ, và `collect_all("matplotlib")` là nguồn **duy nhất** của
>   `mpl-data/fonts/ttf/DejaVuSans.ttf` cho lớp text vô hình tiếng Việt — comment đầu
>   `sidecar.spec` đã ghi. Bỏ là vỡ Searchable + Sửa chữ.
> - **`pyarrow` 78 MB — ứng viên thật.** Kẻ import nó trong site-packages: `altair`,
>   `narwhals`, `streamlit` (cả ba thuộc streamlit, **đã** trong `excludes`),
>   `modelscope`, `sklearn`, `pandas`. **Không** có đường nào từ code dự án.
> - **`pandas` 13 MB — ứng viên yếu.** `pymupdf/table.py:1670` import pandas **bên trong**
>   `to_pandas()`; ta chỉ dùng `find_tables()` (`src/output/pdf_office.py:69`,
>   `src/pdf/layout.py:127`), không dùng `to_pandas()`. Nhưng đó là đường của PDF→Office
>   và dịch-giữ-layout, nên chỉ được bỏ sau khi **test thật hai tính năng đó**.
>
> Ước tính sau khi truy nguồn: **~91 MB**, không phải 110. Chưa làm trong bản này vì đổi
> spec ⇒ rebuild ⇒ phải test tay lại OCR/Searchable/dịch/PDF→Office. **Cách kiểm đúng là
> build thật rồi chạy từng endpoint, không phải đọc `excludes` rồi suy luận.**

> v0.2.47 — **hotfix: hợp nhất số học khoảng trang trong hộp thoại "Áp ảnh/chữ ký cho
> nhiều trang"** (chỉ renderer — **sidecar KHÔNG đổi, không cần rebuild**):
> - `editor.js` có một bản sao riêng của số học khoảng trang, viết **trước** khi
>   BI-27 (docs/REGRESSION-GUARD.md) bắt số học đó phải sống ở
>   [`page-range.js`](desktop/renderer/page-range.js). Bản cũ chỉ gây hại: gạch en
>   `1–3` (thứ Word/Excel dán vào) và dấu chấm phẩy bị coi là rác, một token hỏng
>   làm hỏng **cả chuỗi**. Nay dùng chung `window.PageRange.parseSpec`.
> - Đi kèm hai thay đổi hành vi **có chủ ý**: token rác bị bỏ qua thay vì từ chối cả
>   chuỗi, số vượt trang cuối bị kẹp thay vì biến mất. Cả hai chỉ chấp nhận được vì
>   hộp thoại giờ có **bản xem trước sống** trước khi bấm Áp dụng (`syncImgPages`,
>   cùng khuôn hộp thoại xoá theo khoảng) + khoá nút khi không còn trang nào áp được.
> - Kiểm chứng bằng probe cắt thẳng hai hàm từ `editor.js` lúc chạy (không copy tay),
>   chạy với `page-range.js` thật: 22/22 pass, gồm 4 ca tái tạo đúng lỗi cũ.

> v0.2.46 — **Mở file vào tab hay cửa sổ (tuỳ chọn) + vá OOM Ảnh→PDF + hai lưới test mới**
> (chỉ renderer/main + tài liệu — **sidecar KHÔNG đổi, không cần rebuild**):
> - **Tuỳ chọn “Mở file mới trong: Tab mới / Cửa sổ mới”** (Cài đặt, mặc định *Tab mới* =
>   hành vi cũ). Điều đáng nhớ khi làm: **có BA đường mở file**, không phải một — nút Mở /
>   Ctrl+O, kéo–thả PDF vào tab đang có tài liệu, và Explorer “Open with”. Nối tuỳ chọn
>   vào mỗi nút Mở là ra đúng loại setting làm nửa vời. Vì đường thứ ba có thể tới lúc
>   **chưa có cửa sổ nào** (không có renderer để hỏi), tuỳ chọn phải sống ở **main** —
>   file mới [`src/prefs.js`](desktop/src/prefs.js), `userData/prefs.json`, cùng lý do
>   `session.js` giữ cờ `restore` trên đĩa. Hai luật: **tab trống thắng tuỳ chọn** (không
>   thì chọn 3 file trong cửa sổ trắng sẽ để nguyên cửa sổ trắng đó rồi mở cửa sổ thứ hai)
>   và **nhiều file + “cửa sổ mới” = MỘT cửa sổ** chứa cả loạt (mỗi file một cửa sổ =
>   mỗi file một tiến trình renderer). Quyết định nằm ở `Tabs.planOpen()` — thuần, có lưới.
>   Xem **BI-35**.
> - **Vá phình bộ nhớ “Ảnh → PDF”** — chỗ cuối cùng còn vi phạm BI-24, và nó phình **hai
>   lần**: giữ base64 của *mọi* ảnh đã chọn suốt lúc hộp thoại mở, rồi `JSON.stringify` cả
>   mảng đó thành một chuỗi nữa (100 ảnh 5MB ⇒ ~670MB tạm chồng lên ~670MB đang giữ). Nay
>   giữ **byte thô**, mã hoá theo mảnh lúc gửi (`binArrayJsonBody`), xoá danh sách sau khi
>   tạo xong — giữ lại khi lỗi để còn thử lại. **Xoá luôn `u8ToB64`**: sau khi vá nó là hàm
>   chết, và là công cụ duy nhất dựng được payload thành một chuỗi JS — tức chính cái bẫy
>   BI-24 sinh ra để chặn.
> - **Hai lưới test mới cho renderer/main.** Tiêu chí chọn *không* phải “file to” mà là
>   **“sai ở đây có im lặng không”**: (1) file mới [`renderer/wire.js`](desktop/renderer/wire.js)
>   tách bộ mã hoá payload khỏi `app.js` → `npm run test:wire` (51 ca), có **ca canh gác**
>   chứng minh chunk không bội của 3 thật sự làm hỏng payload; (2) `prefs.js` + `planOpen`
>   vào `npm run test:tabs` (89 → 113 ca). `wire.js` **cố tình giữ tên trần** vì 16 chỗ gọi
>   `pdfJsonBody`/`b64ToU8` có sẵn — đổi sang `window.Wire.*` là tự chuốc rủi ro BI-14.
>   Đã probe trong Chromium thật (24/24) rằng tên trần nhìn thấy được từ script khác và
>   `btoa` của Chromium ra y hệt node ở mọi mốc biên.
> - Ngược lại, **lưới đầy đủ cho `app.js`/`editor.js`/`text-edit.js` bị bác bỏ có chủ ý**:
>   ~11.000 dòng bám DOM/canvas/pdf.js, jsdom không chạy được pdf.js lẫn canvas → lưới dựng
>   ra sẽ test phần vô hại và bỏ sót phần nguy hiểm. Công cụ đúng ở đó là probe trình duyệt.
>   Ghi ở [docs/REGRESSION-GUARD.md](docs/REGRESSION-GUARD.md) §1.

> v0.2.45 — **Bàn tay (pan) + dải thumbnail trong Toàn màn hình + kéo giãn danh sách trang**
> (chỉ renderer + tài liệu — **sidecar KHÔNG đổi, không cần rebuild**):
> - **Bàn tay / pan** — file mới [`renderer/pan.js`](desktop/renderer/pan.js). Trước đây
>   `#viewer` chỉ là một `overflow:auto`: zoom 250% vào bản vẽ A1 xong **không có cách nào
>   kéo trang** ngoài thanh cuộn. Làm đúng bộ chuẩn mà Acrobat / Foxit / pdf.js đều dùng:
>   nút Bàn tay + **phím H** (V quay lại chọn chữ) · **giữ Space** = mượn bàn tay một nhịp
>   rồi tự trả về công cụ cũ · **kéo nút giữa chuột** = pan mọi lúc, kể cả đang Chú thích.
>   Con trỏ `grab`/`grabbing`; lớp chọn chữ đứng yên khi bàn tay bật. Công cụ được **nhớ
>   qua các lần mở app** (`localStorage`, giống theme).
> - **Logic giành chuột tách riêng thành hàm thuần** → `npm run test:pan` (57 ca). Đây là
>   file renderer **thứ hai** có lưới tự động, vì quyết định “cử chỉ này có phải pan không”
>   đọc **6 mẩu trạng thái của 4 module khác** — đúng loại thứ hỏng trong im lặng.
> - **Dải thumbnail trong Toàn màn hình (F11)**: trước đây sidebar bị `display:none`. Giờ nó
>   là **lớp phủ tự-ẩn** trượt ra khi rê chuột vào mép trái (kiểu Reading Mode của Acrobat),
>   F4 để ghim. **Bất biến:** nó tuyệt đối không chiếm chiều rộng layout, vì `fitPage()` đã
>   đo một lần lúc vào — **BI-32**.
> - **Hai lỗi thật do chạy probe trong Chromium mới lòi ra** (đọc code không thấy):
>   `Object.assign` **sao chép GIÁ TRỊ của getter**, nên `window.Pan.tool` đông cứng ở giá
>   trị lúc nạp file; và `stopPropagation()` **không chặn listener khác trên cùng phần tử**
>   → cửa chặn của `capture.js` vẫn chạy, phải đổi sang `stopImmediatePropagation` — **BI-30**.
> - **Kéo giãn được danh sách trang** (`#sidebar-resizer`, biến CSS `--sidebar-w`): 130–300px,
>   bấm đúp tay nắm về 180, nhớ qua các lần mở app, dùng chung bề rộng đó cho lớp phủ F11.
>   **Cố ý giữ MỘT CỘT** ở mọi bề rộng: gợi ý chèn khi kéo–thả PDF vào dải thumbnail chọn
>   trên/dưới bằng `e.clientY`, xếp lưới là chèn nhầm vị trí trang trong im lặng — **BI-33**.
>   Trần 300px do **raster thumbnail cố định 150px** quyết định, không phải thẩm mỹ — **BI-34**.
> - **Tuỳ chọn hiện/ẩn dải đường dẫn** trong Cài đặt (`set-breadcrumb`), **mặc định bật**.
>   Lưu ở `localStorage` phía renderer như theme, vì ngoài cửa sổ này không ai cần biết.
> - Bất biến mới **BI-30/31/32/33/34** + 4 dòng ma trận trong [`docs/REGRESSION-GUARD.md`](docs/REGRESSION-GUARD.md).

> v0.2.44 — **Tác vụ trang trong tầm tay + xoá theo khoảng + tách bạch trạng thái OCR / API**
> (chỉ renderer + tài liệu — **sidecar KHÔNG đổi, không cần rebuild**):
> - **5 lối tắt tác vụ trang lên thanh công cụ** ([`renderer/index.html`](desktop/renderer/index.html)):
>   xoay trái/phải · thêm trang trắng | tách trang đang chọn · tách thành nhiều file.
>   Icon-only, hai cụm ngăn bằng vạch dọc, dùng **đúng handler cũ** (id khác vì id phải
>   duy nhất). Vẽ thêm sprite `ic-split-files` để không lẫn với `ic-scissors`.
> - **Menu chuột phải trên thumbnail** (`openThumbMenu`, [`renderer/app.js`](desktop/renderer/app.js)):
>   dùng lại widget `.ctx-menu` của `capture.js` (mở rộng `separator`/`header`/`danger`,
>   phơi qua `window.Capture.showMenu`) ⇒ **một widget, một kiểu đóng**. Thêm trang trắng
>   **ngay trên/dưới** trang đang trỏ, chèn PDF khác phía dưới — bỏ hẳn bước hỏi vị trí.
>   Chuột phải ngoài vùng đang chọn → chọn mỗi trang đó; trong vùng → giữ nguyên nhiều trang.
>   Gate bản quyền ở **tầng hàm** (mục menu là `<div>`, `GATED_BTNS` không thấy) — **BI-26**.
> - **Xoá nhiều trang theo khoảng** — từ trang X đến Y, **trừ** `3, 5-7`, không cần tick.
>   Xem trước sống “Sẽ xoá 5 trang: 2, 4, 8–10 · còn lại 15 trang.”, nút Xoá tự mờ khi
>   khoảng ăn hết tài liệu. Số học tách ra [`renderer/page-range.js`](desktop/renderer/page-range.js)
>   — **file renderer duy nhất không đụng DOM** nên là file renderer duy nhất có lưới tự
>   động: `npm run test:pages` (50 ca). Dựng lưới **trước** đã bắt ngay 2 lỗi thật:
>   `"1 - 3"` có dấu cách bị tách thành token rác, và `"-3"` bị hiểu là số âm rồi kẹp về
>   trang 1 ⇒ **xoá nhầm trang 1**. **BI-27**.
> - **Hai badge trạng thái thay vì một** ([`renderer/app.js`](desktop/renderer/app.js)):
>   `OCR:` (engine trên máy) và `API:` (key Gemini cho Bóc tách/Dịch). Một badge
>   “OCR: sẵn sàng” bị đọc thành “mọi thứ chạy được”, trong khi AI cần thêm key. Tín hiệu
>   **không chỉ bằng màu**: chấm **đặc = sẵn sàng**, **rỗng = chưa**. Badge API bấm được →
>   mở thẳng Cài đặt. Ba trạng thái, `null` = *chưa biết* (engine chưa lên) **không** vẽ
>   thành “chưa có key”. **BI-29**.
> - **Sửa 2 lỗi có sẵn** (đã chứng minh bằng chạy thật trước khi sửa):
>   `window.Editor.active()` gọi một **boolean getter** như hàm ở 2 nhánh `keydown` →
>   ném `TypeError` mỗi lần bấm ↑/↓/Delete lúc đang chú thích, nuốt luôn phần còn lại của
>   handler (**BI-28**); và tên file gợi ý khi Tách trang liệt kê **mọi** số trang —
>   200 trang = **714 ký tự**, vượt trần 255 của Windows (`extractFileName`, **BI-27**).
> - **[`desktop/SIGNING.md`](desktop/SIGNING.md) viết lại** sau khi rà cứu: **EV không còn
>   gỡ SmartScreen** (Microsoft bỏ đường tắt), và **Azure Artifact Signing không mở cho
>   pháp nhân Việt Nam**. Đường khả thi: OV + cloud HSM. Kèm 3 bẫy cấu hình đã kiểm chứng
>   trên electron-builder 25.1.8 (`azureSignOptions` không có `publisherName`; `az login`
>   không đủ; nó tự cài module PowerShell `TrustedSigning`).
> - Bất biến mới **BI-26/27/28/29** + 5 dòng ma trận trong [`docs/REGRESSION-GUARD.md`](docs/REGRESSION-GUARD.md).

> v0.2.43 — **Sửa chữ giữ đúng font, đúng cỡ, đúng nền + Toàn màn hình đọc trọn trang**
> (renderer + main + **sidecar CÓ ĐỔI → đã rebuild khi đóng gói**):
> - **Font gốc bị thay trong im lặng** ([`src/pdf/fonts.py`](src/pdf/fonts.py), [`api.py`](api.py)):
>   tên font trong PDF hay dính kiểu chữ vào họ **không có dấu gạch** —
>   `TimesNewRomanBold` (hoá đơn/biên lai in qua driver hay thế). `_clean_font_name` chỉ
>   cắt ở `-` nên tên tới matplotlib là một họ **không ai cài**, `findfont` ném lỗi, và
>   bản vẽ lại rơi xuống **DejaVu Sans** — không lỗi, không cảnh báo. Thêm
>   `_family_candidates()`: thử tên cũ **trước** (nên mọi tên đang chạy được giữ nguyên
>   đường resolve), rồi tới tên đã bỏ hậu tố kiểu chữ, rồi tên đầy đủ (cho họ có gạch
>   thật như `SVN-Times New Roman`). ⚠️ **"Roman" KHÔNG phải từ kiểu chữ** — cắt nó là
>   hỏng "Times New Roman".
> - **Bậc 2 mới — dùng lại chính font nhúng trong PDF** ([`_page_font_buffers`](src/pdf/fonts.py)):
>   font công ty/CAD (SVN-*, UTM-*, .Vn*) không có trên máy nào cả; bản duy nhất nằm
>   trong tài liệu. Trích ra **trước `apply_redactions()`** rồi nhúng lại. Vì đó là
>   **font con**, cửa `_font_covers` ở bậc này chạy **không điều kiện** (kể cả ASCII) —
>   thả lỏng là quay lại đúng lỗi ô vuông □ của v0.2.34.
> - **Không phải hồi quy của bản vá hôm qua**: `git diff 10bbccf..HEAD -- api.py src/pdf/`
>   cho thấy backend font **y hệt v0.2.39**; v0.2.40 chỉ đổi đường truyền (`?raw=1`).
>   Lỗi này luôn có với dạng tên đó — file test của user là ca đầu tiên chạm vào.
> - **Toàn màn hình đọc (F11)** ([`tabs.js`](desktop/src/tabs.js), [`app.js`](desktop/renderer/app.js)):
>   trước chỉ có `role:"togglefullscreen"` của Electron — giãn cửa sổ nhưng **giữ nguyên
>   thanh công cụ, sidebar, thanh tab và mức zoom**, nên trang **không** nằm trọn màn hình.
>   Nay: main phóng cửa sổ + thu thanh tab về 0, renderer ẩn chrome + `fitPage()`.
>   **Main giữ cờ, renderer chỉ phản ứng** (BI-22) — bám `leave-full-screen` để thoát bằng
>   nút cửa sổ không bỏ lại một UI mất thanh công cụ. Thêm nút **"Vừa cả trang"**.
> - **Sàn zoom cho lệnh "vừa…"**: `zoomTo` chặn ở 40%, nên "vừa trang/ngang/dọc" trên khổ
>   A0–A1 **không bao giờ vừa được**. Ba lệnh fit nay dùng sàn riêng 8% (zoom tay vẫn 40%).
> - **Sửa chữ không còn để lại vệt trắng** ([`api.py`](api.py), BI-23): hộp redaction là
>   bbox của **chữ**, mà `/edit-text` lại tô `fill=(1,1,1)` + để mặc định `images`/`graphics`
>   → sửa 1 chữ trong ô bảng **có nền** thì thủng một mảng trắng đúng bằng hộp chữ cũ, che
>   luôn đường kẻ dưới. `/translate` đã xử đúng từ trước; nay `/edit-text` theo cùng luật
>   (`fill=False` + `IMAGE_NONE` + `LINE_ART_NONE`). `fill` **vẫn còn trong API** cho ai cố
>   ý muốn tô đè. Lưới mới `test_edit_text_layout.py` (5 ca) **kiểm theo pixel** — nét vector
>   vẫn “còn” dưới lớp fill nên đếm object sẽ pass trong khi trang đã hỏng.
> - **Hết đường OOM chiều GỬI LÊN** ([`app.js`](desktop/renderer/app.js) `pdfJsonBody`, BI-24):
>   v0.2.40 chỉ vá chiều tải về; mỗi lần gọi vẫn dựng `JSON.stringify({pdf_b64: u8ToB64(…)})`
>   = **ba bản sao cỡ đầy đủ** trên heap renderer (~500MB rác tạm cho file 134MB). Nay ghép
>   `Blob` theo mảnh 48KB (bội của 3 — base64 chỉ pad ở cuối luồng), byte nằm trong blob
>   store của Blink. **Định dạng trên dây KHÔNG đổi** → sidecar không phải sửa gì. Áp cho cả
>   **14 chỗ gọi**, gồm `/compare` mang **2 tài liệu** một lúc (payload nặng nhất app).
> - **Vá kèm khi đụng tới**: `runSplit()` mã hoá `state.bytes` **trước** `bakePending()` →
>   tách file bằng bản chưa nướng chú thích đang chờ; nay đọc bytes sau. `loadTemplates()`
>   đặt cờ sau `await` → boot gọi `/templates` 2 lần. `window.History` (che constructor của
>   DOM, guard không bao giờ sai được) → đổi thành **`window.DocHistory`** ở cả 4 chỗ.
>   Esc lúc vừa bật Copy ảnh vừa toàn màn hình → nay Copy ảnh được ưu tiên.
> - **Chữ sửa xong không còn to ra** ([`api.py`](api.py), BI-25): sửa đúng font rồi mới lộ ra
>   lỗi thứ hai — chữ vẽ lại **rộng hơn ~24%** (đè sang chữ bên cạnh) và **cao hơn ~10%**.
>   Nguyên nhân **không phải** cỡ chữ sai: font gốc là subset **mất cmap** nên cửa glyph từ
>   chối (BI-21) và buộc thay bằng font hệ thống — mà “TimesNewRomanBold” nhúng trong file
>   chỉ bằng **0.83 bề rộng / 0.91 chiều cao** Times New Roman Bold của Windows, advance từng
>   chữ còn lệch **ngược chiều** (T hẹp hơn, o rộng hơn). Không cỡ chữ nào chỉnh được cả hai,
>   nên thêm **hai** phép hiệu chỉnh độc lập: cỡ chữ khớp **line box**, rồi `morph` ép **scale
>   x** theo bề rộng chuỗi gốc. Renderer gửi kèm `orig_text` + `orig_size` (đều optional).
>   ⚠️ Phải đo **nguyên chuỗi, không `strip()`** — bbox đang chia là bbox của cả chuỗi
>   (cắt chuỗi mà giữ bbox: median 1.03, tệ nhất 1.08). Đo trên 10 span thật của hoá đơn:
>   **rộng 0.9994× (0.985–1.000), cao 0.9996×**. Vùng chết ±2% ⇒ tài liệu bình thường không đụng.
> - **Verify**: Python **11/11** (mới: `test_edit_text_font.py` 8 ca, `test_edit_text_metrics.py`
>   7 ca, `test_edit_text_layout.py`
>   5 ca) · **round-trip thật qua HTTP** với sidecar dev: `/text-spans` 200 (132 span),
>   `/edit-text?raw=1` 200 → PDF hợp lệ nhúng `Times New Roman Bold`, `/compare` 200 —
>   tất cả bằng body `Blob` kiểu mới · `npm run test:tabs`
>   **89/89** (thêm 10 ca tầng cửa sổ) · `node --check` sạch · renderer chạy thật ngoài
>   Electron: F11 vào/Esc ra, chrome ẩn/hiện đúng, khoá khi đang sửa nội dung, A0 fit 12%,
>   đổi VI/EN không mất số trang · file hoá đơn của user: sửa 1 dòng → nhúng
>   `Times New Roman Bold` (trước: `DejaVu Sans Bold`). **Chưa test GUI tương tác.**

> v0.2.42 — **Tách tab thành cửa sổ riêng (Lớp 2b) + khôi phục phiên** (renderer + main; **sidecar KHÔNG đổi**, không cần rebuild):
> - **Kéo tách tab thành cửa sổ riêng** ([`src/tabs.js`](desktop/src/tabs.js), [`renderer/shell.js`](desktop/renderer/shell.js), [`main.js`](desktop/src/main.js)): `detachTab`/`adoptTab` là đường **chuyển nhà**, tách bạch hoàn toàn với `destroyTab` (**khai tử**) — trộn hai đường này là mất tài liệu của user (BI-15/16). Kéo thả ra ngoài thanh tab → cửa sổ mới tại chỗ thả; thả vào thanh tab cửa sổ khác → tab **nhập** vào đó (nối cuối); nguồn hết tab thì tự đóng. Thêm **menu chuột phải trên tab** (Tách ra cửa sổ riêng · Chuyển tới cửa sổ ▸ · Đóng tab) làm đường vào chắc chắn 100%, không phụ thuộc cử chỉ.
> - **Giả định nền đã CHỨNG MINH bằng probe chạy thật** (`docs/TABS-2B-DESIGN.md` §2.1): chuyển một `WebContentsView` đang sống giữa hai `BaseWindow` **không nạp lại renderer** (`did-finish-load` vẫn đếm 1 sau **2 lần** chuyển), vẫn chạy, vẫn vẽ, và **sống sót khi cửa sổ nguồn bị huỷ**. Không suy luận từ trí nhớ.
> - **Hai bẫy probe moi ra**: (1) `event.screenX/screenY` trong một `WebContentsView` **lệch 26px** (tính từ khung cửa sổ, không phải content) → toạ độ thả **chỉ đọc ở main** bằng `screen.getCursorScreenPoint()`; (2) kéo tab qua vùng tài liệu là **vô hại** — renderer nhận `dataTransfer.types === []` nên guard `includes("Files")` sẵn có làm nó im lặng tuyệt đối.
> - **Cơ chế hỏng-thì-không-làm-gì**: `dragend` → main phân loại bằng `classifyDrop()` (thuần, có test) → sắp xếp / chuyển / tách. Vùng đệm 24×60px chống tách nhầm khi tay run. Chặn cứng: không tách tab duy nhất, không tách tab đang chờ hộp thoại Lưu. Cử chỉ kéo là phần **duy nhất máy không test được** (Chromium bỏ qua input tổng hợp — đã thử, xem `docs/TABS-2B-DESIGN.md` §2.2).
> - **`bindTabKeys` phải tra chủ sở hữu ĐỘNG** (BI-17): listener `before-input-event` gắn vào `webContents`, mà `webContents` **đổi cửa sổ** khi tách tab → closure cũ sẽ điều khiển cửa sổ đã bị huỷ.
> - **Khôi phục phiên** ([`src/session.js`](desktop/src/session.js) MỚI, [`docs/SESSION-RESTORE.md`](docs/SESSION-RESTORE.md)): mở lại app thì trả về đúng bộ tab/cửa sổ lần trước. Lưu **đường dẫn thôi, không bao giờ bytes** — ranh giới cứng với khôi phục sự cố (BI-18), nhờ vậy lỗi ở đây **không thể** làm mất tài liệu. Tab chưa lưu bao giờ không nằm trong phiên.
> - **Nạp trễ là điều kiện cần, không phải tối ưu**: chỉ tab đang xem lúc thoát mới đọc file; các tab khác hiện tên và nằm im tới khi bấm vào (`createTab({deferred})` → `_wakeDeferred`). Thiếu nó thì khôi phục 10 tab × 100MB = **treo máy lúc khởi động**.
> - **Cái khó là "đừng ghi khi nào"** (BI-20, bảng đầy đủ `SESSION-RESTORE.md` §3.2): lúc teardown danh sách tab rỗng dần → cờ `_closing` chặn ghi. ✕ cửa sổ còn tab = ghi **trước** khi phá (lần sau mở lại đủ); đóng lần lượt hết tab = ghi **sau** (lần sau app rỗng).
> - **Va chạm với khôi phục sự cố đã gỡ** (BI-19): lời nhắc bản nháp chỉ hiện ở tab trống, mà khôi phục phiên làm mọi tab đều có tài liệu. Thêm `tab:reserved` để tab đã đặt chỗ tự rút lui (vá luôn một cuộc đua âm ỉ ở đường "Open with" cũ), và nếu **có** bản nháp thì main mở thêm một tab trống cho lời nhắc.
> - **Bấm đúp file = chỉ mở file đó**, không kéo phiên cũ về. Công tắc **Cài đặt → Mở lại phiên trước** (mặc định BẬT); cờ nằm trong `session.json` chứ không phải `localStorage` vì main phải đọc trước khi có renderer nào.
> - **Verify**: Python 8/8 · **`npm run test:tabs` 79/79** (21 ca cũ + 58 ca mới: `classifyDrop`, `detachTab`/`adoptTab`/`moveTabTo`, `sanitizeBounds`, `snapshotSession`, `session.js`) · `node --check` sạch · **vòng đời khôi phục phiên chạy thật tự động 4/4** (ghi đúng file · khởi động lại trả tab về · mở bằng file khác không kéo phiên cũ · cờ TẮT được tôn trọng) · **user đã test GUI cả hai tính năng**.
> - **Chưa làm**: nhớ vị trí cuộn/zoom từng tab · chèn đúng vị trí khi thả vào cửa sổ khác (hiện nối cuối) · kéo cả cửa sổ thả vào cửa sổ khác · P2–P5 trong PERF-MEMORY.

> v0.2.41 — **Mở nhiều tài liệu bằng TAB + chuẩn hoá phím tắt + trần RAM cho undo** (renderer + main; **sidecar KHÔNG đổi**, không cần rebuild):
> - **Tab đa tài liệu** ([`src/tabs.js`](desktop/src/tabs.js) MỚI, [`renderer/shell.html`](desktop/renderer/shell.html)+[`shell.js`](desktop/renderer/shell.js)+[`src/shell-preload.js`](desktop/src/shell-preload.js) MỚI, [`main.js`](desktop/src/main.js)): một `BaseWindow` = thanh tab (`WebContentsView`) + N view tài liệu, mỗi view nạp `index.html` **nguyên vẹn** → renderer một-tài-liệu (state/history/autosave/recovery singular) tái sử dụng y hệt, thay đổi chỉ ở tầng cửa sổ. Chấm cam = chưa lưu; ✕/chuột giữa để đóng; **kéo sắp xếp thứ tự tab**. Guard "chưa lưu" chạy **theo từng tab**: đóng cửa sổ hỏi lần lượt, một lần Huỷ là huỷ cả thao tác (IPC `window:close-cancelled` để main không treo chờ).
> - **Mọi cách mở đều ra TAB MỚI** ([`app.js`](desktop/renderer/app.js), [`main.js`](desktop/src/main.js)): menu/nút Mở và kéo-thả trước đây nạp đè lên tab đang xem → **mất tài liệu cũ**. Nay mở tab mới, chỉ dùng lại tab hiện tại khi nó còn trống. Chọn nhiều file = mỗi file một tab. `dialog:pick-pdfs` chỉ trả **đường dẫn** (không đọc bytes) để main đọc thẳng vào renderer đích, tránh đọc đôi file lớn.
> - **Phím tắt đúng chuẩn**: **Ctrl+W đóng TAB** (trước dùng `role:"close"` của Electron → đóng **cả cửa sổ**, kéo theo mọi tab), Ctrl+Shift+W đóng cửa sổ, **Ctrl+T** tab mới, **Ctrl+Tab/Ctrl+Shift+Tab** xoay vòng, **Ctrl+1–8** nhảy tab, **Ctrl+9** tab cuối. Menu Tập tin thêm "Tab mới"/"Đóng tab".
> - **Trần dung lượng lịch sử undo** ([`app.js`](desktop/renderer/app.js)): `HISTORY_LIMIT=30` chỉ chặn **số bước**, mỗi bước là bản sao đầy đủ → 30 × 128MB ≈ **3,8GB một tab** (đo thật: 4 tab file 128MB = **2.383MB** RAM, mỗi tab một tiến trình riêng, tab nền không nhả). Thêm `HISTORY_BYTES_BUDGET=512MB` + `trimHistoryToBudget()`, luôn giữ ≥1 bước. File <~17MB **không đổi gì**.
> - **Gọn thanh công cụ**: vào Chú thích/Sửa nội dung thì **ẩn hàng công cụ 2** (lúc đó nó đã bị vô hiệu hoá sẵn) — thanh ngữ cảnh **thay thế** thay vì chồng lên; nút **Ghi chú chuyển lên hàng 1** (bắt buộc: nút này cố ý vẫn dùng được khi đang chú thích). Tách **"Xuất ▾"** (Office + 3 mục ảnh) khỏi "Công cụ ▾"; **"Ký số" lên cấp 1** (trước chôn 2 lớp), `mi-sign`→`btn-sign`. ⚠️ `btn-export`/`btn-sign` đã thêm vào `GATED_BTNS` — trước chúng được che bởi `btn-tools` đã gated.
> - **Sửa ô tìm kiếm mất nền + viền**: `.find-box` dùng `var(--panel)`/`var(--border)` mà hai biến này **chưa từng được định nghĩa** → đổi sang `--bg-2`/`--line`.
> - **Tài liệu tham chiếu MỚI**: [`docs/REGRESSION-GUARD.md`](docs/REGRESSION-GUARD.md) (14 bất biến BI-1…BI-14 + ma trận "đụng gì → test gì" + checkpoint phát hành — **đọc trước khi sửa renderer**), [`docs/PERF-MEMORY.md`](docs/PERF-MEMORY.md) (đo RAM đa tab + P1–P5), [`docs/UX-REVIEW.md`](docs/UX-REVIEW.md) (8 phát hiện UX).
> - **Verify**: Python 8/8 · **`npm run test:tabs` 21/21** (lưới tự động MỚI cho logic sắp xếp tab + định tuyến phím, [`desktop/test/tabs-logic.test.js`](desktop/test/tabs-logic.test.js)) · `node --check` 16/16 · boot Electron sạch · **user đã test GUI**: tab, guard đóng, Ctrl+W, ẩn hàng công cụ, Xuất/Ký số, đổi VI-EN — tất cả OK. **Chưa test tay**: thao tác kéo sắp xếp tab (mới thêm sau đợt test).
> - **Chưa làm**: kéo **tách** tab thành cửa sổ riêng (Lớp 2b, rủi ro cao) · P2–P5 trong PERF-MEMORY (tab nền nhả bitmap, autosave co giãn, chặn mềm số tab, canvas màn So sánh).

> v0.2.40 — **Sửa lỗi "Sửa nội dung" trên PDF lớn làm trắng trang + truyền binary** (renderer + sidecar; **binary rebuild** vì đổi `api.py`):
> - **Lỗi trắng trang sau khi sửa text (PDF ~100MB+)** ([`app.js`](desktop/renderer/app.js), [`text-edit.js`](desktop/renderer/text-edit.js), [`compare.js`](desktop/renderer/compare.js)): nguyên nhân gốc là `Uint8Array.from(atob(data_b64), c=>c.charCodeAt(0))` — đường iterator+callback sinh ~1 object tạm/byte → **nổ heap V8** khi giải mã PDF lớn trả về; render trang vừa sửa thất bại rồi bị `catch` nuốt im lặng, và canvas đã bị xoá trắng trước khi vẽ → trang trắng, không báo lỗi. Đã chứng minh crash trên chính file 134MB của người dùng. **Fix:** helper chung `b64ToU8()` (vòng lặp chỉ số) thay **14** chỗ decode → hết crash (peak ~1.3GB < trần ~4GB); **gia cố `renderPageCanvas`** render ra canvas offscreen rồi mới đắp lên khi thành công (lỗi thì giữ ảnh cũ + log, không còn trắng trang im lặng). Lỗi này từng tiềm ẩn ở MỌI thao tác toàn-tài-liệu (đóng dấu/nén/đánh số/dịch…) vì dùng chung pattern decode đó.
> - **Truyền binary cho `/edit-text`** ([`api.py`](api.py), [`text-edit.js`](desktop/renderer/text-edit.js)): thêm `?raw=1` → sidecar trả thẳng bytes `application/pdf` (metadata ở header) thay vì base64 JSON; renderer đọc bằng `arrayBuffer()` → bỏ hẳn tầng base64 nặng nhất ở chiều nhận. `raw` mặc định False nên các caller/test khác **không đổi**. ⚠️ Cần rebuild sidecar để có `?raw=1` (frontend mới coi JSON là lỗi). Verify: round-trip test 4/4, nhánh raw=True trả PDF hợp lệ chứa chữ đã sửa.
> - **Kế hoạch Tab** ([`docs/TABS-DESIGN.md`](docs/TABS-DESIGN.md) MỚI, chưa code): thiết kế mở nhiều tài liệu bằng tab (`BaseWindow`+`WebContentsView`, mỗi tab 1 renderer `index.html` nguyên vẹn) — GĐ1 ~2–3 ngày, cần test GUI trước khi phát hành.
> - **Verify**: test Python 8/8 · `node --check` renderer OK · mô phỏng đúng chuỗi cấp phát `apply()` cho file 134MB → hết crash. **CHƯA smoke-test GUI** (user chấp nhận phát hành bản vá; tab để nhánh test riêng).
> - **Đã biết (chưa sửa, có task riêng):** lịch sử undo giữ tối đa 30 bản sao toàn tài liệu (`HISTORY_LIMIT`) → file lớn có thể tới ~4GB, nguy cơ OOM sau nhiều lần sửa.

> v0.2.39 — **Định dạng hộp văn bản + In khổ lớn + sửa 3 lỗi + xuất Office** (renderer + sidecar; **binary rebuild** vì đổi `api.py` và thêm `python-docx`):
> - **Định dạng hộp văn bản** ([`editor.js`](desktop/renderer/editor.js), [`index.html`](desktop/renderer/index.html), [`app.css`](desktop/renderer/app.css)): bảng **Định dạng** bên phải khi chọn/tạo hộp văn bản — căn lề trái/giữa/phải/**đều**, thụt lề −/＋, **bullet/đánh số**, giãn dòng/đoạn/ký tự/từ, **co giãn ngang**, độ mờ, gạch ngang, và **Sắp xếp theo trang** (căn giữa ngang/dọc/cả hai + sát mép). Một "engine dàn chữ" dùng chung cho đo/xem-trước/ghi-PNG nên WYSIWYG khớp; mọi field lưu vào `/NabuData` (file cũ tự nhận mặc định an toàn). Verify: layout 20/20 + round-trip 21/21 (Node).
> - **#3 In khổ A0/A1/A2** ([`index.html`](desktop/renderer/index.html), [`main.js`](desktop/src/main.js), [`app.js`](desktop/renderer/app.js)): thêm A0/A1/A2 (Electron 33 hỗ trợ sẵn) + **cap megapixel thích ứng** cho `buildPrintPages` (A5–A2 giữ 150 DPI; A1≈124, A0≈88 DPI) tránh OOM khi in bản vẽ khổ lớn nhiều trang; báo tiến trình theo trang.
> - **#4a Ký số hết "Not Responding"** ([`signing.js`](desktop/src/signing.js), [`signing-worker.js`](desktop/src/signing-worker.js) MỚI, [`main.js`](desktop/src/main.js), [`sign.js`](desktop/renderer/sign.js)): chuyển pdf-lib/@signpdf sang **utilityProcess** riêng + ghi file async → main thread không treo khi ký+lưu. Logic ký giữ nguyên byte-for-byte. **Đã test token thật** (chữ ký hợp lệ, đúng thumbprint, integrity OK).
> - **#4b Hộp văn bản chú thích hết "đơ" sau Hủy bỏ** ([`editor.js`](desktop/renderer/editor.js), [`text-edit.js`](desktop/renderer/text-edit.js), [`app.js`](desktop/renderer/app.js)): thay `window.confirm` (chặn renderer + blur mất con trỏ) bằng modal in-DOM `uiConfirm`.
> - **#1 Dịch EN→VI hết ô vuông □** ([`api.py`](api.py)): `/translate-pdf` thêm guard phủ font Unicode (mirror `/edit-text`) — font nguồn không đủ tiếng Việt thì fallback. Regression test thêm.
> - **#2 Xuất PDF → Office** ([`src/output/pdf_office.py`](src/output/pdf_office.py) MỚI, [`api.py`](api.py), `python-docx`): endpoint `/pdf-to-office` + menu "Xuất ra Office" → **xlsx/docx/csv** (thông minh theo định dạng: bảng có cấu trúc + văn bản). Test 6/6.

> v0.2.38 — **Ký số PKI bằng USB token (BẬT)** — kích hoạt F3 đã ship dormant ở v0.2.37:
> - Máy build đã cài **.NET 8 SDK** (8.0.423). [`build-helper.js`](desktop/scripts/build-helper.js) tự chọn `dotnet` **x64** (bản x86 ở `Program Files (x86)` che PATH → `--list-sdks` rỗng); [`NabuSign.csproj`](desktop/signing-helper/NabuSign.csproj) thêm `PackageReference System.Security.Cryptography.Pkcs 8.0.1` (sửa CS1069).
> - Helper build OK → `dist-helper/nabu-sign.exe` (~33.6MB self-contained). `list-certs` chạy thật đọc đúng cert từ Windows store (JSON UTF-8, exit 0).
> - Bật lại: bỏ `hidden` menu `mi-sign`; thêm lại extraResources `dist-helper→signing-helper` + helper freshness-check.
> - Landing (/site): thêm card "Ký số bằng USB token".
> - **CHƯA test ký với token thật** (máy build không có token) — user chấp nhận phát hành, test sau. Đường ký/PIN/TSA chỉ verify được với token.

> v0.2.37 — **Mũi tên linh hoạt hơn + Tự lưu/khôi phục khi sự cố** (renderer + main; sidecar KHÔNG đổi):
> - **F1 — Mũi tên** ([`editor.js`](desktop/renderer/editor.js), [`index.html`](desktop/renderer/index.html)): nhãn chữ chọn đặt ở **đầu (mũi nhọn) hoặc cuối (gốc)** (`a.labelEnd`, mặc định `head` → mũi tên cũ không đổi; helper `arrowLabelPos` dùng chung render/bake/ô nhập). Mũi tên vào **`MANAGED_KINDS`** → **sửa & di chuyển lại được sau khi Áp dụng** y như hộp văn bản (round-trip `/Stamp`+`/AP` raster qua `renderArrowPng` + `/NabuData`). Trang xoay → fallback flatten. Verify Node: geometry/màu/nhãn VN/labelEnd 11/11.
> - **F2 — Tự lưu & khôi phục** ([`app.js`](desktop/renderer/app.js), [`preload.js`](desktop/src/preload.js), [`main.js`](desktop/src/main.js)): cờ dirty ở nút thắt `pushUndo`, chỉ báo `●` trên tiêu đề; **autosave nền** (interval 120s + debounce 15s) snapshot `state.bytes` vào `userData/recovery/<docId>`; mở lại sau crash → **mời khôi phục** bản mới nhất (guard chống double-prompt đa cửa sổ); GC bản >14 ngày. Đóng cửa sổ khi còn thay đổi → hộp thoại native **Lưu / Không lưu / Huỷ** (guard skip khi `appQuitting` để menu Thoát không treo).
> - **F3 — Ký số PKI (token USB): mã đã có nhưng ẨN ở bản này.** Helper .NET 8 ([`signing-helper/`](desktop/signing-helper)) + [`src/signing.js`](desktop/src/signing.js) + [`renderer/sign.js`](desktop/renderer/sign.js) code xong nhưng menu "Ký số" để `hidden`, helper CHƯA build (máy build thiếu .NET 8 SDK) và chưa test token. Build-integration (extraResources + helper freshness-check) tạm gỡ; bật lại khi có SDK + test token thật. Xem [memory] digital-signature-pki.
> - **Verify**: test Python 7/7 · node --check renderer OK · pipeline @signpdf+pdf-lib 12/12 (data). **CHƯA smoke-test GUI F1/F2** (user chấp nhận phát hành, verify mức dữ liệu + test tự động xanh).

> v0.2.36 — **Tổng rà UX/UI toolbar + sửa lỗi sửa/di chuyển chú thích** (chủ yếu renderer; **binary rebuild** vì gói lại các refactor `api.py`/`src/pdf/*` tích luỹ từ trước — bản thân sidecar không đổi hành vi):
> - **Sửa được text/comment sau khi tạo** ([`editor.js`](desktop/renderer/editor.js)): bấm đúp hộp văn bản/ghi chú/nhãn mũi tên để mở lại editor giờ chạy từ **mousedown thứ 2 (`e.detail>=2`)** thay vì sự kiện `dblclick` — `select()` re-render layer giữa 2 click làm trình duyệt retarget dblclick về layer nên editor không bao giờ mở; click vào textarea đang mở cũng bị `onDown` huỷ. Đăng ký `ed._taCommit` để click ra ngoài **commit** (không mất chữ vì innerHTML-wipe không bắn blur). Tool text/note bấm vào annot cùng loại → sửa/mở thread thay vì tạo đè.
> - **Push undo lười cho move/resize** ([`editor.js`](desktop/renderer/editor.js)): trước đây click-chọn thuần (không kéo) cũng `pushEdUndo()` ⇒ `_dirty=true` ⇒ thoát là bake lại dù không đổi gì. Nay chỉ push ở lần dịch chuyển thật đầu tiên (`drag.pushed`); guard `cancelDrag` để Esc không pop nhầm snapshot thao tác trước.
> - **Toolbar gọn lại** (index.html/app.css/app.js): gom hàng công cụ 2 thành **Trang ▾** (ghép/chèn/tách/xoay/xoá/đánh số) + **Công cụ ▾** (OCR văn bản/dịch/nén/so sánh/copy ảnh/ảnh↔pdf/khoá) → chrome 1366px **221px→102px**, hết wrap. Top-level chỉ còn 3 quy trình: **Chú thích · Sửa nội dung · Bóc tách** (đổi tên từ Chỉnh sửa/Sửa chữ/Searchable). Cơ chế dropdown tổng quát `wireDropdown`/`closeAllMenus`.
> - **Thêm điều hướng trang** `‹ [N]/tổng ›` cạnh zoom (PageUp/PageDown), **panel Ghi chú** (danh sách comment toàn tài liệu, bấm nhảy tới), **status bar** (trang · kích thước mm · zoom), **sidebar collapse F4**, **phím tắt công cụ** (V/T/H/D/R/O/C/F/A/N/I/X/M), find box thu gọn responsive, nút **Hủy bỏ** tách khỏi **Xong** + màu cảnh báo, hint "Bấm đúp để sửa".
> - **Verify**: harness renderer (dựng ngoài Electron) — dblclick mở editor + không mất chữ, push lười (proxy nút undo), toolbar 1 dòng @1366, dropdown, page-nav, panel Comments (thêm/xoá/badge/jump), sidebar collapse, status bar (A4=210×297mm), phím tắt + guard. **CHƯA test tay trong app thật**: page-nav scroll-tracking & panel Comments đọc annotation baked ở chế độ xem (harness không render pdf.js — tái dùng hàm đã chạy tốt).

> v0.2.35 — **Hộp văn bản & comment sửa lại được sau khi Áp dụng + chỉnh cỡ hình mây** (chỉ renderer: [`editor.js`](desktop/renderer/editor.js), [`app.js`](desktop/renderer/app.js), [`index.html`](desktop/renderer/index.html); sidecar KHÔNG đổi — **không rebuild binary**):
> - **Round-trip text/comment (Option B)** ([`editor.js`](desktop/renderer/editor.js)): trước đây Áp dụng làm phẳng hộp văn bản thành PNG trong content-stream + xoá `ed.annots` ⇒ không sửa/di chuyển lại được; comment nướng ra PDF Text-annot nhưng mở lại không comment tiếp được. Nay text/note là **"managed annotation"**: bake thành annotation PDF **thật** mang key riêng `/NabuData` (JSON model sửa được). Text → `/Stamp` với **ảnh appearance** (`/AP /N` = chính PNG Vietnamese-safe cũ, không nhúng font) → Foxit/Acrobat **thấy được**; note → `/Text` (giữ `/Contents` cho viewer khác) + `/NabuData`. Vào Chỉnh sửa: `importManaged()` dựng lại chúng thành overlay sửa được; `bakePending` strip-rồi-add lại (thay thế, **không tích luỹ**); `stripManagedAnnots` + cờ `_dirty`/`_managedPages` giữ vòng đời sạch. Mở lại file (kể cả máy khác / Nabu khác) vẫn kéo/gõ lại/comment tiếp được.
> - **Ẩn annotation khi đang sửa** ([`app.js`](desktop/renderer/app.js) `renderPageCanvas`): trong lúc Chỉnh sửa render với `annotationMode: DISABLE` để bản nướng không vẽ đôi với overlay sống (thoát ra hiện lại); `addNoteMarkers` bỏ qua khi đang sửa và **tô màu marker theo `/C`** (note không còn nướng ô màu vào content nên marker tự mang màu). Thêm `window.repaintRenderedPages()` để repaint tại chỗ khi vào/ra chế độ sửa.
> - **Đánh đổi đã biết**: khi đang Chỉnh sửa thì **mọi** annotation tạm ẩn (kể cả của app khác) — thoát ra hiện lại. **Text trên trang xoay** (`/Rotate≠0`) vẫn làm phẳng như cũ (chưa sửa lại được — phần hiếm, `addManagedAnnot` trả false → fallback flatten). Mỗi lần Áp dụng ghi lại ảnh appearance của text.
> - **Chỉnh cỡ hình mây** ([`editor.js`](desktop/renderer/editor.js), [`index.html`](desktop/renderer/index.html)): `CLOUD_BUMP` (đường kính vỏ sò) từng hardcode 16 → user chê to. Nay mỗi mây mang `bump` riêng (`bumpOf(a)` luồn qua mọi điểm render/bake của `cloud` + `cloudpen`), thanh trượt **"Cỡ mây" (6–28)** trên thanh Chỉnh sửa, mặc định mới **12** (đặc hơn); chọn 1 mây để chỉnh riêng.
> - **pnpm ghim** ([`desktop/package.json`](desktop/package.json)): thêm `"packageManager": "pnpm@10.30.2"` — `node_modules`/store dựng bằng pnpm 10, chưa ghim nên corepack kéo pnpm 11 → đòi **xoá & tải lại toàn bộ node_modules** (kể cả Electron 188MB). Ghim đúng bản đã dựng để không xoá nhầm.
> - **Verify**: **app thật + hợp đồng thật** (`QD-997`): tạo hộp văn bản + comment → Áp dụng → mở file lưu bằng pdf-lib thấy `/Stamp`+`/AP` và `/Text`, cả hai có `/NabuData`; mở lại → text hiện (pdf.js vẽ Stamp AP), vào Chỉnh sửa → cả hai quay lại **sửa được, không nhân đôi**, bấm vào text có khung chọn. Cộng: probe pdf-lib (dựng/đọc/xoá annotation-ảnh + key Việt) + test round-trip Node (thay-thế-không-tích-luỹ qua sửa/xoá) + `node --check` + cổng freshness sidecar (renderer-only nên **không** làm lệch marker). **CHƯA test máy sạch.**

> v0.2.34 — **Sửa chữ từ vòng 2 trở đi không còn ra ô vuông (□)** (chỉ sidecar `api.py` — phải rebuild binary; renderer KHÔNG đổi):
> - **Triệu chứng**: sửa 1 dòng tiếng Việt (giữ font) → Áp dụng → sửa tiếp **bất cứ dòng nào** (kể cả dòng chưa từng đụng tới) → **toàn bộ** ký tự thành □. Để dòng đó cho vòng 1 thì lại đúng ⇒ lỗi do **trạng thái file sau khi Áp dụng**, không phải do dòng/font.
> - **Gốc — chuỗi 3 mắt xích, không mắt nào raise** ([`api.py`](api.py) `_fresh_fontname`): (1) `page.insert_font(fontname=X, fontfile=F)` khớp theo **tên resource** — trang đã có `/X` thì PyMuPDF trả font cũ và **bỏ qua `F`**, im lặng (đọc source PyMuPDF xác nhận). (2) `/edit-text` kết thúc bằng `subset_fonts()`, nên **chính vòng tạo ra** `/vnedit`,`/loc0` cũng đã cắt font đó xuống còn glyph của riêng vòng đó. (3) Font là **Identity-H** (đánh địa chỉ bằng glyph id) → subset **vứt luôn bảng cmap unicode**: font đã subset trả `has_glyph()==0` cho **cả ký tự chính nó đang chứa**. Vòng sau xin lại đúng tên → nhận subset cũ → **mọi** tra cứu unicode→glyph = glyph 0 = notdef = □. Mắt xích (3) giải thích vì sao **mọi** ký tự vỡ chứ không chỉ ký tự mới, và vì sao **dòng chưa đụng tới** cũng vỡ.
> - **KHÔNG phải regression của v0.2.32**: chạy **cùng một kịch bản** trên `api.py` trước/sau v0.2.32 → vỡ **y hệt nhau, cùng một vòng**. `subset_fonts()` + cách đặt tên `vnedit`/`loc%d` có từ **v0.1.5 / v0.2.23**. v0.2.32 chỉ **làm lộ** ra: trước đó `_vietnamese_font()` không tìm thấy DejaVu trong app đóng gói nên **vòng 1 đã ra □** rồi → không ai đi tiếp tới vòng 2 để thấy bug cũ.
> - **Fix**: `_fresh_fontname(page, base)` — luôn nhúng dưới tên trang **chưa dùng** (`vnedit`→`vnedit1`→…). Áp cho `/edit-text` (`vnedit`/`loc`) **và** `/translate-pdf` (`trvn`/`trloc`, cùng lỗi: dịch lại file đã dịch tới lần 3 → 27 notdef). Bỏ `local_seq` (reset về 0 mỗi request — chính nó làm vòng 2 xin lại `/loc0`). **Tái dùng font cũ là bất khả** (cmap đã mất) ⇒ tên mới là cách duy nhất đúng.
> - **Verify file thật** (`QD-997-mau-hop-dong.pdf`, giữ font, 4 vòng, trang 3): trước = vòng 2/3/4 ra **44/88/132** notdef; sau = **0** cả 4 vòng, kể cả vòng in đậm (giữ đúng `Times New Roman,Bold`). Vỡ ngay **vòng 2** (fixture tổng hợp thì vòng 3) vì `Times New Roman` **resolve được ở mọi vòng** → luôn xin lại `/loc0` ⇒ với tài liệu Word/hợp đồng bình thường thủ phạm thực tế là nhánh **`/loc0`**, `/vnedit` chỉ là đường vòng. `/translate-pdf`: lần dịch 3 từ 27 notdef → **0**.
> - **Test**: thêm [`test_edit_text_rounds.py`](test_edit_text_rounds.py) (4 test: vòng 2 sạch, nhiều vòng sạch, bất biến "không tái dùng tên resource", unit `_fresh_fontname`) + `test_retranslating_an_output_does_not_draw_boxes` trong [`test_translate_layout.py`](test_translate_layout.py). **Kiểm ngược từng cái**: mọi test hành vi đều **FAIL trên code chưa vá**.
> - **Đánh đổi đã biết**: mỗi lần Áp dụng thêm 1 font subset mới → file phình **~34 KB/vòng** trên file thật (470 KB → 306 KB sau vòng 1 do subset ép nhỏ → **409 KB sau 4 vòng**, vẫn nhẹ hơn bản gốc). Không xoá được font cũ vì **chữ của vòng trước còn tham chiếu** nó. **QUYẾT ĐỊNH (2026-07-19): wontfix** cho tới khi có bằng chứng file phình gây phiền thật — lợi vài chục KB không bõ: (1) muốn "subset chỉ khi xuất" thì **Lưu phải đi qua sidecar** (hiện thuần renderer, luôn chạy được kể cả engine chưa nạp — mất độ bền đường lưu); (2) làm nửa vời (chỉ bỏ subset per-round) còn tệ hơn — mỗi vòng nhúng nguyên font đầy đủ ~750KB–1MB; (3) `_fresh_fontname` vẫn phải giữ vĩnh viễn (file đã subset mở lại sửa tiếp) nên code không gọn đi. **Người dùng cần gọn file → dùng Nén** (`/compress` đã chạy `subset_fonts()` + `garbage=4`, gom hết subset tích luỹ; nén xong sửa tiếp vẫn an toàn). Nếu sau này vẫn làm: giữ `_fresh_fontname` làm lưới, nâng thành "tái dùng tên cũ nếu cmap còn phủ được text mới", subset best-effort trong `saveDoc` (sidecar hỏng → lưu bản chưa subset, không chặn lưu), `state.bytes` trong RAM giữ bản chưa subset; test ma trận sửa→lưu→mở lại→sửa.

> v0.2.33 — **Chọn vùng để khoanh mây khi xuất bản vẽ B + dịch PDF giữ đúng cột trong bảng** (renderer + sidecar CÓ đổi `api.py` — phải rebuild binary):
> - **Tick chọn vùng khoanh mây** ([`drawing.py`](src/compare/drawing.py), [`compare.js`](desktop/renderer/compare.js), [`app.css`](desktop/renderer/app.css)): trước đây xuất bản B là khoanh mây **mọi** khác biệt, không chọn được. Gốc vấn đề là **không có liên kết change ↔ box**: `changes[]` và `b_boxes{}` là 2 danh sách rời. Thêm `a_box`/`b_box` = `[page, i]` trỏ vào đúng ô của nó (`None` khi trang chỉ có ở 1 bên). Renderer: checkbox mỗi dòng + "Chọn tất" (**mặc định tick hết**), vùng bỏ tick **mờ + nét đứt trên cả A và B**, nút xuất hiện `(n/tổng)` và **khoá khi n=0**. Trang lazy-render vẫn đọc đúng trạng thái tick (`drawBoxes` gắn `data-p`/`data-bi`).
> - **An toàn tương thích**: chế độ **văn bản** và **sidecar cũ** (report không có `b_box`) → `canSelect()`=false → picker ẩn, xuất khoanh **toàn bộ** y như trước. `drawing.py` chỉ **thêm key**, không đổi logic diff/align.
> - **Dịch PDF: bảng không còn xô chữ** ([`api.py`](api.py) `/translate-pdf`): MuPDF gom **cả hàng bảng vào 1 block** → dịch cả hàng thành 1 đoạn, các cột **sụp về sát lề trái** + chữ co lại. Thêm `find_tables()` → tách **1 block/ô**, mỗi ô typeset vào **đúng ô của nó**, **đọc lại căn lề** từ vị trí chữ gốc (cột số = phải, tiêu đề = giữa) và **mọc vào chỗ trống** thay vì co chữ. Ô **gộp full-width** (hàng tổng cộng hoá đơn) tách tiếp theo **khoảng trống cỡ tab** (`_split_runs`, gap > 2×cỡ chữ) — gom lại thì số tiền bị kéo ra giữa trang. Phải nhóm theo **baseline** (`_visual_lines`) chứ không theo `lines` của MuPDF (mỗi nhãn/giá trị là 1 "line" riêng).
> - **`_fit_fontsize` dùng metric thật**: `insert_textbox` **vẽ ra KHÔNG GÌ CẢ** và **không raise** khi chữ không vừa (trả số âm) → ước lượng sai = **mất chữ im lặng**. Công thức thật: `fs*(nlines*(ascender-descender) - descender)`; thêm ceil cho từ dài quá 1 dòng + vòng lặp hạ cỡ khi insert bị từ chối.
> - **Redaction khi dịch không còn "vá trắng"**: bỏ `fill=(1,1,1)` + `images=PDF_REDACT_IMAGE_NONE, graphics=PDF_REDACT_LINE_ART_NONE` — trước đây dịch ô có **nền màu** để lại **mảng trắng**, và **gạch chân/ảnh nền** dưới chữ bị xoá. Dịch là thay **chữ**, không thay thứ chữ nằm trên. Có nhánh fallback cho PyMuPDF cũ (<1.25, chưa có tham số `graphics`). **KHÔNG đụng** redact an toàn (editor.js rasterise) và `/edit-text` (fill do người dùng chọn — cố ý).
> - **Test**: thêm [`test_translate_layout.py`](test_translate_layout.py) (8 test: giữ cột/căn lề, tách ô gộp, ô toàn số không bị đụng, nền màu không thủng, gạch chân còn, chữ dài co chứ không mất, trang thường không đổi, fuzz `_fit_fontsize`). **Mutation-test**: bẻ 7 hành vi trong `api.py` → 6 bị test bắt (1 sống sót = vòng lặp retry, chỉ là lưới an toàn). `/deploy` nay chạy **cả 3** file test (trước chỉ `test_export.py` → compare & translate không có lưới).
> - **Còn nợ**: ô **quá nhỏ** để chứa bản dịch ở cỡ tối thiểu 5pt → bị redact rồi **bỏ trống** (mất chữ). Cần ~10× giãn nở trong ô tí hon mới chạm; đã ghi trong docstring, **chưa sửa**. Fix đúng: tính fit **trước** khi redact, không vừa thì giữ nguyên chữ gốc.

> v0.2.32 — **Sửa chữ tiếng Việt bản vẽ CAD/Revit: chữ lỗi font (OCR lấy lại) + ô nhận diện đúng vị trí trên trang xoay + công cụ Đo & ghi kích thước (dim)** (renderer + sidecar CÓ đổi `api.py` — phải rebuild binary):
> - **Ô sửa chữ sai vị trí / tự xoay dọc trên bản vẽ xoay** ([`api.py`](api.py) `/text-spans`, [`text-edit.js`](desktop/renderer/text-edit.js)): trang CAD `/Rotate 90/270` — `get_text` trả bbox hệ CHƯA xoay còn viewport ĐÃ xoay → ô lệch. Thêm `bbox_view = bbox × page.rotation_matrix` cho overlay (trang không xoay → identity, không đổi gì); lọc span rác (w/h<0.5). Redraw vốn đã dùng bbox/origin chưa xoay nên đúng sẵn. Verify: file thật xoay 270° — 375/375 span vào đúng vùng.
> - **Chữ Việt lỗi font → OCR lấy lại** ([`api.py`](api.py) `/ocr-span` + dò `suspect`, [`text-edit.js`](desktop/renderer/text-edit.js)): PDF CAD/Revit hay dùng font `get_text` giải mã sai (Arial-BoldMT ToUnicode hỏng → mojibake Cyrillic; font `.Vn` TCVN3 cổ). Đổi font vô ích vì chuỗi đã sai. Ô chữ lỗi tô **cam nét đứt**, bấm vào **tự OCR** vùng đó (rotation-aware) điền chữ đúng; nút **"OCR ô này"** thủ công cho ô rớt dấu. Dò `suspect` bảo thủ (chỉ mojibake / `.Vn` non-ASCII — KHÔNG đụng mã ASCII đúng). Fast-path transcode TCVN3→Unicode (có validation gate). Verify file thật: `&+,7,ӂ7...`→`CHI TIẾT SƠN ĐỖ XE PCCC...`; 116 span tốt→0 gắn cờ sai.
> - **Guard font khi gõ chữ mới** ([`api.py`](api.py) `/edit-text`): `insert_text(helv)` im lặng vẽ ô vuông cho chữ có dấu — thêm `_font_covers()` + ép DejaVu, không bao giờ helv cho Unicode; `_vietnamese_font()` tìm thêm `sys._MEIPASS`/exe-dir (frozen app trước mất DejaVu).
> - **Công cụ Đo & ghi kích thước (dim)** ([`editor.js`](desktop/renderer/editor.js), [`index.html`](desktop/renderer/index.html), [`app.css`](desktop/renderer/app.css)): công cụ `measure` (icon thước) — kéo 1 đoạn ĐÃ BIẾT rồi nhập số thật → hiệu chuẩn tỷ lệ; các đoạn khác kéo ra **tự ghi kích thước theo tỷ lệ**. Annot `kind:"dim"` (đường + tick 2 đầu + nhãn), bake pdf-lib. Nút "Hiệu chuẩn lại". (Dò dim trống tự động = phase sau, cần CV.)
> - **An toàn**: chỉ thêm nhánh/endpoint mới, không đụng logic cũ; trang không xoay & font tốt không đổi hành vi (verify 0 regression). `node --check` toàn bộ JS + AST/import `api.py` OK; test E2E `/text-spans`+`/ocr-span`+`/edit-text` trên file thật. **CHƯA GUI-test thao tác tay trong app thật** (OCR-on-click, công cụ dim).

> v0.2.31 — **Hotfix: chồng lớp (overlay) — chế độ Tô màu khác biệt phủ full màn hình** (chỉ renderer `compare.js`; sidecar KHÔNG đổi — không rebuild):
> - **Lỗi**: pdf.js render nền **đục** (trắng/sheet bản vẽ) → mọi pixel có alpha. Code cũ tô màu bằng `globalCompositeOperation="source-in"` + fillRect → source-in tô **mọi pixel có alpha** = cả canvas → nguyên mảng màu che hết. (Non-tint cũng lỗi ngầm: lớp B nền trắng che lớp A.)
> - **Sửa** ([`compare.js`](desktop/renderer/compare.js) `keyOutBackground()`): suy alpha từ độ tối từng pixel — `alpha = 255 − luminance` (nét đậm→đục, nền trắng→trong suốt) cho **cả 2 lớp**; tint mode đổi màu nét (A đỏ / B xanh). Giờ 2 bản vẽ chồng lộ nhau: đỏ=chỉ A, xanh=chỉ B, đen=trùng. Robust dù pdf.js render nền đục hay trong. `node --check` OK. **CHƯA GUI-test tay.**

> v0.2.30 — **Sửa zoom bị crop + Vừa chiều dọc + phím ↑/↓ nhảy trang + mũi tên kèm nhãn + ghi chú dạng chuỗi bình luận + chồng lớp 2 bản vẽ** (renderer + sidecar CÓ đổi — endpoint overlay mới, phải rebuild binary):
> - **Zoom hết crop** ([`app.css`](desktop/renderer/app.css)): `.viewer` là scroll-container nhưng dùng `align-items:center` → khi trang rộng/cao hơn viewer, phần tràn trái/trên không kéo tới được (như bị cắt). Đổi `align-items: safe center` (căn giữa khi vừa, về đầu khi tràn).
> - **Vừa chiều dọc** ([`app.js`](desktop/renderer/app.js), [`index.html`](desktop/renderer/index.html)): `fitHeight()` (soi gương `fitWidth`, theo `clientHeight`) + nút `#btn-fit-height` (icon `ic-fit-h`) cạnh Vừa bề ngang. Chủ yếu cho văn bản landscape.
> - **Phím ↑/↓ nhảy trang** ([`app.js`](desktop/renderer/app.js)): `currentPageIndex()` (trang phủ đỉnh viewport) → ↓ trang kế / ↑ trang trước. Guard: không khi đang gõ, có modal, đang So sánh/Chồng lớp, hoặc trong overlay editor. (Kết quả search ↑↓ không đổi.)
> - **Mũi tên kèm nhãn** ([`editor.js`](desktop/renderer/editor.js)): annot arrow thêm `a.label`. Vẽ xong tự mở ô nhập ở đầu mũi tên (bỏ trống/Esc = không nhãn); double-click để sửa. Render SVG `<text>` ngoài mũi tên; bake qua `renderTextPng`→PNG (dấu tiếng Việt nhúng chuẩn) căn giữa điểm sau đầu mũi tên.
> - **Ghi chú dạng chuỗi (note-of-note)** ([`editor.js`](desktop/renderer/editor.js), [`app.css`](desktop/renderer/app.css)): note thêm `replies[]` (chỉ nối thêm, KHÔNG xoá text gốc). `openNoteEditor` thành panel: chuỗi gốc+reply (chỉ đọc) + ô "Thêm bình luận" + "Sửa gốc" + "Đóng". Marker hiện badge số reply. Bake gộp gốc+reply vào 1 PDF Text-annot `Contents` (`noteThreadText()`) — mọi viewer đọc được.
> - **Chồng lớp 2 bản vẽ** ([`src/compare/drawing.py`](src/compare/drawing.py), [`api.py`](api.py), [`compare.js`](desktop/renderer/compare.js)): backend `overlay_drawings()` tái dùng fingerprint page-match + phaseCorrelate `_register` → endpoint `POST /overlay-drawings` trả cặp trang khớp + offset căn (điểm PDF). Mode **"Chồng lớp"** trong dialog So sánh → view `#overlay-view` onion-skin: 2 canvas A/B chồng, slider mờ lớp B, **tô màu khác biệt** (A đỏ / B xanh, ink recolor `source-in` + nền trong suốt + top `mix-blend multiply` → đỏ=chỉ A, xanh=chỉ B, đen=trùng), toggle căn tự động, nudge tay (nút + phím mũi tên), chuyển cặp (PageUp/Dn), zoom/fit.
> - **An toàn**: chỉ thêm nhánh/endpoint mới, không đụng logic cũ; CSP không đổi; `/overlay-drawings` chỉ đọc 2 PDF trả offset (không render ngược). `node --check` toàn bộ JS + AST backend + 5/5 test drawing + `test_export.py` OK; overlay backend smoke-test (ghép cặp + offset đúng). **CHƯA GUI-test thao tác tay trong app thật.**

> v0.2.29 — **Menu chuột phải (copy/paste/select + copy ảnh/vùng, dán ảnh) + căn lại icon toolbar Chỉnh sửa + written-offer AGPL trong app** (chỉ Electron/renderer; mã sidecar KHÔNG đổi — binary rebuild vì bản trước build ở máy khác):
> - **Context menu native** ([`main.js`](desktop/src/main.js)): `attachContextMenu(win)` bám `webContents 'context-menu'` — trong ô nhập liệu: Undo/Redo/Cut/Copy/Paste/Select All (bật/tắt theo `editFlags`, dùng native roles nên chạy dưới sandbox); có vùng bôi đen: Copy + Select All; trên link http(s): Sao chép/Mở liên kết. Song ngữ theo `menuLang`. Non-editable + không bôi đen → KHÔNG popup (nhường menu canvas của renderer).
> - **Menu canvas** ([`capture.js`](desktop/renderer/capture.js), [`app.css`](desktop/renderer/app.css)): right-click trên `.page-wrap` → custom menu **Sao chép ảnh** (bật khi có object ảnh dưới trỏ — `objectRectAt`), **Sao chép vùng…** (vào capture mode kéo khung), **Dán ảnh vào trang** (bật khi clipboard có ảnh). Nhường native khi đang bôi đen text-layer / trỏ trong ô nhập liệu. IPC mới `clipboard:read-image` (Electron `clipboard.readImage().toDataURL()` — **chỉ đọc ảnh, không đọc text**) → `Editor.beginImagePaste` (tái dùng công cụ Ảnh, click để đặt — giống Ctrl+V).
> - **Căn icon toolbar Chỉnh sửa**: nút `.tool` không có class `.icon-only` nên dính `button .ic { margin-right:6px }` → icon lệch trái ~3px trong nút căn giữa. Sửa: `.edit-bar .tool` dùng `inline-flex` center + `.tool .ic { margin:0 }`.
> - **AGPL trong app** ([`index.html`](desktop/renderer/index.html)): bỏ link repo GitHub trong "Giới thiệu", thay bằng written-offer §6b ("mã nguồn tương ứng cung cấp miễn phí theo yêu cầu ≥3 năm — email liên hệ"). Dọn handler `about-source-link` mồ côi trong `app.js`.
> - **An toàn**: 100% client-side, KHÔNG đổi Python, CSP không đổi. `clipboard:read-image` chỉ trả ảnh. `node --check` toàn bộ + `test_export.py` OK. **CHƯA GUI-test thao tác tay** (menu chuột phải/paste trong app thật).

> v0.2.28 — **Đóng dấu ảnh/chữ ký nhiều trang + Vẽ mây tự do (bút/điểm) + Opacity nền** (chỉ renderer; mã sidecar KHÔNG đổi — không rebuild binary):
> - **Đóng dấu ảnh nhiều trang** ([`editor.js`](desktop/renderer/editor.js), [`index.html`](desktop/renderer/index.html)): đặt ảnh/chữ ký trực quan trên 1 trang → chọn → nút **"Áp nhiều trang"** → nhập khoảng trang (`1-3, 5, 8-10`) qua dialog `imgpages-modal` → `parsePageRanges` → clone cùng x/y/w/h sang mỗi trang (trang gốc tự bỏ qua). Thêm `toEmbeddable()`: **BMP/GIF/WebP tự convert PNG** qua canvas (pdf-lib chỉ nhúng PNG/JPEG) — `chooseImage`/`beginImagePaste` dùng chung.
> - **Vẽ mây tự do** — tool `cloudpen` mới (nút ✎ cạnh mây cũ). Giữ kéo = freehand (thả tự khép); bấm điểm = polygon, đóng bằng bấm-điểm-đầu / Enter / bấm-đúp, huỷ bằng Esc/Delete/đổi-tool. Scallop cho polygon bất kỳ: `cloudPathPoly()` resample chu vi ~`CLOUD_BUMP` + `arcApex()` chọn hướng bướu ra ngoài theo centroid (**winding-independent**; node-verify 100% bướu ngoài trên rect/tri/blob cả 2 chiều). Bake `drawSvgPath` như mây chữ nhật.
> - **Opacity nền 0–100%** — slider **"Mờ nền"** (`ed-fill-opacity`). Lưu `a.fillOpacity` trên box/ellipse/cloud/cloudpen. Overlay dùng `rgba`/`fill-opacity`; bake truyền `opacity` cho `drawRectangle`/`drawEllipse`/`drawSvgPath` (chỉ nền — viền vẫn đặc).
> - **An toàn**: 100% client-side, KHÔNG đổi Python, không network/eval. Chỉ thêm nhánh kind mới + mở rộng list — không đụng logic cũ. Poly state dọn sạch khi Delete/đổi-tool/exit/click-trang-khác. `node --check` toàn bộ JS + `test_export.py` OK. Geometry mây node-verified + browser-render valid. **CHƯA GUI-test thao tác tay trong app thật.**

> v0.2.27 — **Nhiều cửa sổ + "Open with Nabu PDF" + Copy/Paste ảnh trong trang** (mã sidecar KHÔNG đổi — không rebuild binary):
> - **Nhiều cửa sổ** ([`main.js`](desktop/src/main.js), [`updater.js`](desktop/src/updater.js)): bỏ singleton `mainWindow` → `Set windows`; `createWindow()`/`primaryWindow()`/`senderWindow(e)`. Mọi cửa sổ **chung 1 sidecar** (chung port+token, broadcast status) — model OCR nạp 1 lần. Menu **"Cửa sổ mới" (Ctrl+N)**. IPC dialog/print target đúng cửa sổ gửi. Updater nhận window-provider fn.
> - **Open with** ([`electron-builder.yml`](desktop/electron-builder.yml), `main.js`, `preload.js`): `fileAssociations: pdf` (NSIS ghi registry, hiện trong "Open with", KHÔNG ép mặc định). Parse argv (launch + `second-instance`) + macOS `open-file` → mở cửa sổ mới load file. Portable .exe không đăng ký association được (chỉ bản cài NSIS).
> - **Copy/Paste ảnh** ([`capture.js`](desktop/renderer/capture.js) mới, `editor.js`, `main.js`): nút **"Copy ảnh"** → chế độ capture (Esc thoát). Object mode: hover ảnh nhúng (detect qua pdf.js `getOperatorList` + tracking CTM) → click copy high-res. Region mode: kéo khung copy vùng. Render region → PNG (offscreen `page.render`, offset tuyến-tính theo scale → xoay trang vẫn đúng). Clipboard qua IPC `clipboard:write-image` (Electron, **chỉ ghi ảnh — không đọc clipboard**). Paste: DOM `paste` event → `Editor.beginImagePaste` đặt ảnh lên trang (tái dùng công cụ Ảnh). 100% client-side, KHÔNG đổi Python.
> - **An toàn**: CSP không đổi (đã có `img-src`/`worker-src blob:`). argv/file guard chỉ đọc `.pdf` tồn tại. `node --check` toàn bộ + `test_export.py` OK. Boot app clean. Toán tọa độ F3 verify khớp fitz chính xác (rotation 0/90/180 + nhiều scale). **CHƯA GUI-test thao tác tay** (copy/paste/multi-window/open-with sau cài).

> v0.2.26 — **Tối ưu RAM viewer: virtualize canvas trang (windowing)** (chỉ renderer `app.js`; mã sidecar KHÔNG đổi — binary rebuild để bắt kịp py stale từ v0.2.23/0.2.25):
> - **Vấn đề**: viewer render trang một lần rồi giữ bitmap **mãi mãi** (observer `unobserve` sau khi vẽ). Cuộn hết PDF 100 trang → ~1.8GB RAM canvas không bao giờ giải phóng (mỗi trang full-res × devicePixelRatio ≈ 18MB).
> - **Cách sửa** ([`app.js`](desktop/renderer/app.js)): 2 `IntersectionObserver` — `pageObserver` (margin 500px) render khi gần viewport (bỏ `unobserve`); `keepObserver` (margin `KEEP_MARGIN_PX`=1500) gọi `freePageCanvas` khi trang trôi xa → hạ `canvas.width/height=0` giải phóng bitmap. Khoảng đệm 500↔1500 là hysteresis chống thrash. Cờ `m.rendering` + `pageFarFromViewport` trong `finally` chống race khi cuộn nhanh. RAM: ~1.8GB → **~hằng số ~90MB**; PDF nhỏ không đổi.
> - **An toàn**: `freePageCanvas` CHỈ hạ bitmap, giữ `canvas.style.*` + mọi layer (annotation/text/search/note) — tất cả overlay đọc `canvas.style` chứ không đọc pixel; `addTextLayer`/`addNoteMarkers`/`drawSearchLayer` đã idempotent (xoá-rồi-vẽ). `rerenderChanged(null)` (watermark toàn trang) sửa để chỉ repaint trang trong window thay vì rasterise cả tài liệu. Search/print/compare/dịch dùng canvas riêng — không ảnh hưởng.
> - `node --check` 3 file + `test_export.py` OK. Boot app + renderer nạp sạch. **Đã test GUI: cuộn/search/annotate/watermark/text-edit OK.**

> v0.2.25 — **Tuỳ chọn in (khổ giấy + 1/2 mặt) + chọn model Gemini trong Cài đặt** (sidecar CÓ đổi — phải rebuild):
> - **Hộp thoại In** (`#print-modal`, [`index.html`](desktop/renderer/index.html)): chọn **máy in**, **khổ giấy** (A4/A5/A3/Letter/Legal), **hướng** (dọc/ngang), **kiểu in** (1 mặt / 2 mặt lật cạnh dài / lật cạnh ngắn), **số bản**, + checkbox mở hộp thoại hệ thống. `printDoc` raster trang → `#print-root` → mở modal; `runPrint` gửi tuỳ chọn qua IPC `print:page` → main `mainWindow.webContents.print({silent, deviceName, pageSize, duplexMode, landscape, copies})`. In **DOM ảnh** (không phải plugin PDFium) nên print có tuỳ chọn hoạt động đúng. `print:printers` (getPrintersAsync) đổ danh sách máy in; preload `getPrinters`/`printPage` ([`preload.js`](desktop/src/preload.js)).
> - **Chọn model Gemini**: [`config.py`](src/utils/config.py) thêm `get/set_gemini_model` (lưu `settings.json`, ưu tiên UI > env > mặc định `gemini-3.1-flash-lite`). [`api.py`](api.py) `/config` GET trả `gemini_model`/`gemini_model_default`/`gemini_model_choices`; POST nhận `gemini_model` → reset agent. `_get_gemini()` dùng `get_gemini_model()` → áp cho cả **Bóc tách và Dịch**. UI: input `#set-gemini-model` (datalist gợi ý + gõ tự do) trong Cài đặt; `saveSettings` cho lưu **model không cần nhập lại key**. i18n VI/EN đầy đủ nhãn mới.
> - `node --check` 4 file + `test_export.py` + config round-trip OK. **Cần test in thật + đổi model.**

> v0.2.24 — **Sửa lỗi In ra giấy trắng** (renderer + main; sidecar KHÔNG đổi):
> - **Lỗi**: v0.2.22 in qua main-process — mở PDF trong `BrowserWindow` ẩn rồi `webContents.print()`. Chromium render PDF bằng **plugin PDFium ở frame con**, print của trang chủ KHÔNG bắt được nội dung → **ra giấy trắng tinh** (dù kết nối máy in OK).
> - **Cách sửa**: in **hoàn toàn ở renderer** ([`app.js`](desktop/renderer/app.js) `printDoc`/`buildPrintPages`): pdf.js raster từng trang → `<canvas>` ở ~150 DPI → `<img>` (data-URL) trong `#print-root`, `@media print` chỉ hiện container này (1 ảnh/tờ, `@page{margin:0}`), rồi `window.print()` → **hộp thoại in hệ điều hành** như cũ (chọn máy in/khoảng trang/số bản). `await img.decode()` trước khi in để ảnh không kịp giải mã → tránh lại ra trắng. `state.bytes.slice()` để pdf.js không neuter buffer gốc. CSP `img-src ... data:` đã cho phép.
> - Gỡ đường in cũ ở main: bỏ IPC `print:pdf` + `os` require ([`main.js`](desktop/src/main.js)) + `printPdf` ([`preload.js`](desktop/src/preload.js)). Nút **In**/menu **Tập tin▸In…**/Ctrl+P giữ nguyên, chỉ đổi ruột. CSS `#print-root`/`@media print` trong [`app.css`](desktop/renderer/app.css).
> - `node --check` 3 file OK + `test_export.py` OK. **Cần test in thật** (in ra "Microsoft Print to PDF" kiểm tra không trắng).

> v0.2.23 — **Dịch PDF (AI) giữ layout + đổi model Gemini mặc định → `gemini-3.1-flash-lite`** (sidecar CÓ đổi — phải rebuild):
> - **Endpoint mới** `POST /translate-pdf` trong [`api.py`](api.py) (Phase 1 = xuất **file mới**, giữ bố cục). Pipeline tái dùng đường redraw của `/edit-text`: `_page_text_blocks` gom block text/trang → `_mask_terms`/`_unmask_terms` che số/ngày/email bằng sentinel private-use (`N`) để Gemini không sửa số → `_translate_blocks` gọi Gemini **1 lần/trang** (JSON, guard theo index, thiếu block thì giữ gốc, không crash trang) → `add_redact_annot` xoá glyph cũ + `insert_textbox` với `_fit_fontsize` (auto-shrink) giữ font/màu span gốc. Bản scan (không lớp text) → trả `is_scan=true`, báo rõ thay vì âm thầm OCR. Font VN an toàn qua DejaVu bundled + font hệ thống theo family (`_resolve_local_font`).
> - **UI**: nút **"Dịch"** (`#btn-translate`, icon `#ic-translate`) cạnh Searchable, gate `engine ready + có doc`. Modal `#tr-modal`: ngôn ngữ nguồn (Auto/…), đích, phạm vi (toàn bộ / các trang đang chọn), toggle giữ số/ngày/email. `openTranslate`/`runTranslate` ([`app.js`](desktop/renderer/app.js)) → gọi sidecar, lưu file mới qua `savePdf`. i18n VI/EN đầy đủ ([`i18n.js`](desktop/renderer/i18n.js)).
> - **Model Gemini mặc định** đổi `gemini-3-flash-preview` → **`gemini-3.1-flash-lite`** ở [`config.py`](src/utils/config.py), [`gemini_agent.py`](src/agents/gemini_agent.py), dropdown [`app.py`](app.py), README. (Ảnh hưởng cả Bóc tách lẫn Dịch.) Web app `web/` là frontend riêng — CHƯA đổi model.
> - Đã test headless (mock Gemini): dịch OK, giữ 123/ngày/email, scan báo đúng, mask round-trip PASS. `test_export.py` + node --check cả 3 file OK. **Chưa test Gemini mạng thật + chưa test GUI** — cần thử 1 PDF text thật sau khi cài.

> v0.2.22 — **In tài liệu + giao diện song ngữ Việt/Anh + gọn thanh công cụ Chỉnh sửa** (renderer + main; mã sidecar KHÔNG đổi, chỉ rebuild lại binary cho khớp api.py v0.2.21):
> - **In (print)** — MỚI: nút **"In"** cạnh "Lưu", mục **Tập tin ▸ In…**, phím tắt **Ctrl+P**. Renderer `printDoc()` ([`app.js`](desktop/renderer/app.js)) bake pending edit rồi gửi bytes qua IPC `print:pdf`. Main ([`main.js`](desktop/src/main.js)) ghi file tạm, mở `BrowserWindow` ẩn (partition riêng → không dính CSP handler, `plugins:true` bật PDF viewer PDFium), gọi `webContents.print({silent:false})` → **hộp thoại in hệ điều hành** (chọn máy in, khoảng trang, số bản, in 2 mặt…). Dọn file tạm + cửa sổ sau khi in; user bấm Hủy = `ok:false reason:"cancel"` (không báo lỗi). Icon `#ic-print`, preload `printPdf`.
> - **Ngôn ngữ giao diện Việt/Anh** — MỚI: [`i18n.js`](desktop/renderer/i18n.js) — bộ dịch **chrome** (nhãn nút/menu/dialog/tooltip), KHÔNG dịch nội dung PDF. Cơ chế registry: quét 1 lần các text-node + thuộc tính `title`/`placeholder` tĩnh khớp từ điển (262 khoá VI→EN); đổi ngôn ngữ = render lại đúng các node đã bắt (không bao giờ đụng nội dung động do JS chèn — badge/breadcrumb/tên file… loại qua `SKIP_IDS`). Menu native đổi theo qua IPC `menu:set-lang` ([`main.js`](desktop/src/main.js) `MENU_STR`). Bộ chọn ở **Cài đặt ▸ Ngôn ngữ**, lưu `localStorage nabu-lang`. Prose dài (Giới thiệu/API-key) tạm giữ tiếng Việt.
> - **Thanh công cụ Chỉnh sửa gọn hơn** ([`editor.js`](desktop/renderer/editor.js)): công cụ **Chọn/di chuyển/đổi cỡ** trước đây bày ra *mọi* ô điều khiển (màu, màu che, font, nét, nền…) — giờ chỉ hiện ô hợp với mục **đang chọn** (theo `KIND_CTLS`), không chọn gì thì ẩn hết. Các công cụ vẽ giữ nguyên (`TOOL_CTLS`).
> - Thuần renderer/main, không đụng logic PDF cũ. Đã `node --check` cả 6 file + `test_export.py` OK. Chờ test GUI (in thật + đổi ngôn ngữ).

> v0.2.21 — **Đánh số trang (page numbers)** (sidecar CÓ đổi — phải rebuild):
> - **Endpoint mới** `POST /add-page-numbers` trong [`api.py`](api.py) (`PageNumberRequest` + helper `_fmt_page_label`, `_hex_rgb01`). Dùng PyMuPDF, font Base-14 **helv** (mọi kiểu số đều ASCII: "Trang", chữ số, `/`, `-` → không nhúng font, tránh bẫy FontPath). 5 kiểu (`n`, `n_of_n`, `page_n`, `page_n_of_n`, `dash_n`), 6 vị trí, bắt đầu từ số tuỳ chọn, **bỏ qua trang bìa**, cỡ chữ + màu.
> - **Xoay trang (/Rotate) đúng tuyệt đối**: đặt điểm ở toạ độ **hiển thị** (`page.rect`) rồi map ngược về hệ chưa xoay bằng `page.derotation_matrix`, `insert_text(..., rotate=page.rotation)` → số luôn ở đúng góc & chữ thẳng đứng trên trang xoay 90/180/270. Đã render pixel xác nhận cả 4 góc.
> - **UI**: mục "Đánh số trang…" trong menu **Chuyển đổi ▸ Trang** ([`index.html`](desktop/renderer/index.html) `#pgnum-modal`). Handler `openPageNumbers`/`runPageNumbers` ([`app.js`](desktop/renderer/app.js)) — **áp dụng tại chỗ + `pushUndo()`** (WYSIWYG, Hoàn tác được rồi mới Lưu), không xuất file mới.
> - Thuần thêm mới, không đụng tính năng cũ. Đã test headless (4 góc xoay + bỏ bìa + x/N + input rác→400) + `test_export.py` + node --check. Chờ test GUI.

> v0.2.20 — **UX: zoom gõ được + Ctrl+wheel + fit-width; undo/redo & Esc trong Chỉnh sửa; nút Xong/Hủy bỏ; confirm thoát Sửa chữ** (renderer-only; sidecar KHÔNG đổi). Đã test GUI OK:
> - **Zoom** ([`app.js`](desktop/renderer/app.js)): `#zoom-label` (readout) → `#zoom-input` gõ tỷ lệ (Enter/blur áp dụng, Esc revert); `zoomTo(next, anchor)` hợp nhất zoom/zoomReset, **neo điểm dưới con trỏ** khi Ctrl+lăn chuột (bước 10%, listener `{passive:false}` trên `#viewer`); nút **Vừa bề ngang** `#btn-fit-width` (`fitWidth()` từ `state.pageMetas[].vp.width/scale`). `updateToolbar` bật/tắt input riêng (sweep `[data-needs-doc] button` không đụng `<input>`).
> - **Undo/redo cấp annotation trong Chỉnh sửa** ([`editor.js`](desktop/renderer/editor.js)): stack `edHist` (snapshot `ed.annots`+watermark, cap 50, coalesce 800ms cho color-picker/spinner qua `pushEdUndo(key)`), push trước MỌI mutation (tạo/kéo/resize/xóa/text/note/ảnh/watermark/style); tạo hình tí hon bị discard → `dropLastEdUndo()`. Ctrl+Z/Y + nút toolbar + menu native **route về `Editor.undo/redo` khi editor mở** (sửa bug cũ: Ctrl+Z lúc đang chỉnh sửa undo cấp document → desync overlay). Thoát trả nút về `updateUndoRedo()`.
> - **Esc ladder** (editor): hủy hình đang kéo (`cancelDrag()` restore orig/xóa annotation đang tạo) → bỏ chọn → về công cụ Chọn (+hủy ảnh pending). KHÔNG auto-thoát mode. Textarea tự xử Esc như cũ.
> - **Nút editor đổi ngữ nghĩa** ([`index.html`](desktop/renderer/index.html)): trước `#ed-apply` và `#ed-exit` **cùng trỏ `exit()`** (trùng nhau, không có đường hủy). Nay: **"Xong"** = bake+thoát (như cũ); **"Hủy bỏ"** = `discardExit()` vứt annotation chưa bake (confirm nếu có). Toggle nút "Chỉnh sửa" = Xong.
> - **Sửa chữ** ([`text-edit.js`](desktop/renderer/text-edit.js)): `confirmExit()` — thoát khi còn N đoạn staged → confirm ghi (OK=apply)/bỏ (Cancel), thay vì vứt im lặng; áp dụng cho cả nút Thoát lẫn toggle `btn-text-edit`.
> - CSS `.zoom-input`, icon `ic-fit`. Đã `node --check` cả 3 file + user test GUI OK.

> v0.2.19 — **Gộp nhiều PDF thành một file (chọn & sắp xếp thứ tự, không cần mở file trước) + cập nhật landing page** (renderer + site only; sidecar KHÔNG đổi):
> - **Gộp nhiều PDF** (mới): nút "Gộp file" cạnh "Mở" (luôn bật — không cần mở doc, không gated) + link "Gộp nhiều PDF…" trong empty-state. Mở modal `#combine-modal`: nút "Thêm file PDF…" (chọn nhiều), danh sách `#combine-list` **sắp xếp được** bằng kéo–thả *hoặc* nút ↑/↓, có nút xoá từng file + đếm trang. `combineList`/`openCombine`/`addCombinePdfs`/`renderCombineList`/`moveCombine`/`wireCombineList`/`runCombine` trong [`app.js`](desktop/renderer/app.js). Gộp thuần **renderer** (pdf-lib `PDFDocument.create()` + `copyPages`/`addPage` theo thứ tự), lưu qua `savePdf` rồi `loadBytes` mở kết quả để xem. Khác "Ghép" cũ (bắt buộc đã mở 1 doc, chèn vào doc đang mở). Bỏ qua file đọc lỗi (có mật khẩu) kèm toast, không giết cả mẻ. CSS `.combine-*` trong [`app.css`](desktop/renderer/app.css). Tên file dùng `textContent` (an toàn với tên lạ).
> - **Landing page cập nhật** ([`site/app.js`](site/app.js)/[`site/index.html`](site/index.html)): thêm thẻ tính năng "Gộp nhiều PDF thành một" + "So sánh PDF & bản vẽ" (đưa v0.2.14/0.2.16 lên site); thẻ Trang bổ sung "tách thành nhiều file"; sửa hero/meta + đếm công cụ 12+→14+.
> - Thuần thêm mới, không đụng tính năng cũ. Đã `node --check` app.js OK. Sidecar KHÔNG đổi (nhưng /deploy vẫn rebuild để guard chống binary stale).

> v0.2.18 — **Khoanh mây (revision cloud) + màu nền cho khoanh vùng** (renderer-only; sidecar KHÔNG đổi logic — chỉ rebuild vì binary cũ 2026-06-26 đã stale so với source 07-01/02/06):
> - **Khoanh mây (revision cloud)** (mới): công cụ vẽ mới trong thanh **Chỉnh sửa**, cạnh Hình chữ nhật/Elip. Viền vòng cung lồi ra ngoài đúng chuẩn kỹ thuật/xây dựng. Hình học ở [`editor.js`](desktop/renderer/editor.js) `cloudPath()` (chuỗi cung `A r r 0 0 1 …`, duyệt biên chiều kim đồng hồ → bump lồi ra), overlay `<svg>` WYSIWYG, bake bằng `page.drawSvgPath` (pdf-lib có parser cung `A`) — khớp pixel với overlay ở rotation 0 (cùng giới hạn ảnh/text trên trang xoay). Icon `ic-cloud`, nút `data-tool="cloud"`.
> - **Màu nền + trong suốt cho khoanh vùng** (mới): trước Hình chữ nhật/Elip chỉ có viền. Nay cả **chữ nhật / elip / khoanh mây** có ô "Nền" + checkbox "Trong suốt" (mặc định trong suốt). Bake: `drawRectangle`/`drawEllipse`/`drawSvgPath` thêm `color`. State `ed.fillOn`/`ed.fillColor`, `effFill()`.
> - **Ảnh → PDF**: xác nhận đã có sẵn (menu Chuyển đổi ▸ Ảnh → PDF, endpoint `/images-to-pdf`, nhận JPG/PNG/BMP/TIFF/WebP qua Pillow) — không đụng.
> - Thuần thêm mới, không đụng tính năng cũ. Đã `node --check` + `test_export.py` + bake thử cloud/box/ellipse fill với pdf-lib vendored + kiểm tra hình học (bump lồi ra cả 4 cạnh). Chờ test GUI như các tính năng editor khác.

> v0.2.17 — **Tách PDF thành nhiều file + So sánh phóng to/vừa màn hình + logo mới** (sidecar CÓ đổi — phải rebuild):
> - **Tách thành nhiều file** (mới): endpoint `POST /split` trong [`api.py`](api.py) (`SplitRequest`, `_parse_ranges`) → trả **ZIP** nhiều PDF qua `insert_pdf` (không sửa file gốc). 2 chế độ: "mỗi N trang 1 file" hoặc "theo khoảng trang" (`1-3,5,8-10`, tự kẹp trong biên, tối đa 1000 file). UI: mục "Tách thành nhiều file…" trong menu **Chuyển đổi** → modal `#split-modal`; `openSplit`/`runSplit` trong [`app.js`](desktop/renderer/app.js). Lấp khoảng trống so với pdf24/smallpdf (trước chỉ "Tách" = trích trang chọn → 1 file).
> - **So sánh: phóng to & vừa màn hình** ([`compare.js`](desktop/renderer/compare.js)): bỏ scale cứng 1.1. Mở lên **tự vừa bề ngang** (`fitScale()` = min bề rộng khung / bề rộng trang rộng nhất, chung cho cả A+B). Nút −/%/+ và "Vừa màn hình" trên thanh; phím +/−/0, Ctrl+lăn chuột; tự vừa lại khi đổi cỡ cửa sổ tới khi người dùng tự zoom. Nhảy tới khác biệt nay `scrollIntoView(center)` đúng **ô thay đổi** (không phải đầu trang) + nhấp nháy xanh + readout "Thay đổi i/N · A tr X · B tr Y".
> - **Menu Chuyển đổi sắp xếp lại** ([`index.html`](desktop/renderer/index.html)): chia nhóm có tiêu đề **Trang / Ảnh / Bảo mật** (`.dd-head`) cho dễ tìm.
> - **Logo/icon mới**: [`desktop/build/make_icon_from_logo.py`](desktop/build/make_icon_from_logo.py) sinh `icon.ico`/`icon.png` từ `logo_nabu.png` (thay bản vẽ tay make_icon.py). Đổi shortcut Windows sau khi cài bản mới.
> - Thuần thêm mới, không đụng tính năng cũ. Đã test `_parse_ranges`/split (page-count, kẹp biên, input rác) + node --check + `test_export.py`.

> v0.2.16 — **So sánh BẢN VẼ (CAD/Revit PDF) bằng diff hình ảnh** (sidecar CÓ đổi — phải rebuild):
> - Chế độ so sánh mới cho bản vẽ kỹ thuật xuất từ AutoCAD/Revit. Diff **raster** kiểu Bluebeam (render 2 trang → so pixel), KHÔNG diff vector-path (mỗi lần export CAD chia/gộp path khác nhau → false positive tràn). Backend mới [`src/compare/drawing.py`](src/compare/drawing.py): (1) **fingerprint** mỗi trang (dHash 16×16 + Jaccard từ trong khung tên) → (2) **ghép trang** bằng Needleman–Wunsch (nhận diện trang chèn thêm/xoá/dồn số; chỉ ghép khi sim > 2×gap) → (3) **diff từng cặp**: render 3000px, `cv2.phaseCorrelate` bù lệch in ấn (**bắt buộc Hanning window** — không có thì viền trang nuốt tín hiệu shift), mặt nạ mực <200 với dung sai giãn 3px chống răng cưa, morphology gom vùng, `connectedComponents` → hộp → phân loại xoá(đỏ)/thêm(xanh)/sửa(vàng). Trang lệch margin thuần diff sạch 0 vùng. Trả CÙNG shape với `/compare` nên renderer dùng lại nguyên.
> - 2 endpoint mới trong [`api.py`](api.py): `POST /compare-drawings` (sensitivity low/normal/high) + `POST /compare-drawings/export` (đóng dấu **đám mây revision** = `add_rect_annot` + `set_border(clouds=2)`, màu theo loại thay đổi; trang xoay xử lý qua `derotation_matrix`; bỏ qua box rác). Mọi lỗi bọc trong try → JSON `success:false`, không bao giờ thoát 500.
> - UI: gộp vào modal So sánh sẵn có ([`index.html`](desktop/renderer/index.html)/[`compare.js`](desktop/renderer/compare.js)) — thêm chế độ "Bản vẽ (CAD/Revit)", ô chọn độ nhạy (ẩn/hiện theo chế độ), nút "Tải B đã đánh dấu" trên thanh kết quả. View side-by-side + highlight + danh sách thay đổi + lazy-load (IntersectionObserver) dùng lại từ compare text. Thuần thêm mới, không đụng tính năng cũ.
> - Kiểm chứng: [`test_compare_drawings.py`](test_compare_drawings.py) 5/5 pass (không có pytest trong venv — runner `__main__`); chạy thật trên mặt bằng tầng KS A1 thật (1 sheet, 2.2s, 63 vùng đúng chỗ, khung tên không flag oan); multipage A=[V1,V1,V1]/B=[V1,V2,V1] chỉ trang giữa flag. `cv2` đã có sẵn trong `sidecar.spec` hiddenimports.

> v0.2.15 — **Hotfix: So sánh PDF bị lỗi 500 trên bản đóng gói** (sidecar CÓ đổi — phải rebuild):
> - 0.2.14 ship sidecar có `api.py` **cũ** (endpoint `/compare` còn `report["pages"]` của bản comparator v1) trong khi comparator đã là v2 (trả `a_boxes/b_boxes/changes`) → `KeyError: 'pages'` → HTTP 500 → renderer nhận text "Internal Server Error", báo `Unexpected token 'I'... is not valid JSON`. **Gốc:** PyInstaller cache thư mục `build/sidecar` phục vụ bản `api.py` cũ (đã sửa mã nguồn giữa/sau lần build trước — xem [[sidecar-stale-build-guard]] mục false-fresh). **Sửa:** xoá `build/` trước khi build:sidecar; build endpoint gói toàn bộ trong try + `report.get(...)` nên không bao giờ thoát ra 500; renderer đọc `res.text()` rồi `JSON.parse` phòng thủ (báo status máy chủ thay vì crash parse). **Quy trình mới:** sau build:sidecar phải PROBE `dist/sidecar/sidecar.exe` `/compare` = 200 trước khi đóng gói/release.

> v0.2.14 — **So sánh 2 file PDF + sửa "Kiểm tra cập nhật" (bản cài)** (sidecar CÓ đổi — phải rebuild):
> - **Sửa auto-update bản cài**: gốc lỗi ở khâu đóng gói — `electron-updater` khai báo trong `package.json` nhưng **thiếu trong `node_modules`** → không được nhồi vào `app.asar` → `require("electron-updater")` ném lỗi → `autoUpdaterRef` null → nút báo "Bản này không hỗ trợ tự cập nhật". Đã `pnpm install` lại + thêm **guard** trong [`check-sidecar-fresh.js`](desktop/scripts/check-sidecar-fresh.js): prebuild fail nếu thiếu runtime dep (electron-updater). Lưu ý: bản 0.2.13 đã cài KHÔNG tự cập nhật được (dep thiếu trong asar của nó) — user phải tải 0.2.14 thủ công 1 lần.
> - **So sánh PDF** (mới): [`src/compare/comparator.py`](src/compare/comparator.py) + endpoint `POST /compare` trong [`api.py`](api.py). Diff theo trang + theo dòng bằng `difflib` (chuẩn hoá khoảng trắng để reflow không bị coi là khác). Trang text-layer: lấy dòng + bbox từ PyMuPDF; trang scan: OCR (RapidViet) `recognize_boxes`, có bbox khi trang không xoay. UI [`compare.js`](desktop/renderer/compare.js) + modal/khung xem trong [`index.html`](desktop/renderer/index.html): chọn 2 file, xem cạnh nhau, tô hộp đỏ (xoá)/xanh (thêm)/vàng (đổi), danh sách trang có huy hiệu khác biệt, panel diff dòng + từ. Nút "So sánh" trên thanh công cụ (chỉ cần engine sẵn sàng, không cần mở doc). Thuần thêm mới, không sửa tính năng cũ.

> v0.2.13 — **Che thông tin chọn màu + Hộp văn bản có font/đậm/nghiêng/gạch chân + Thêm trang trắng** (renderer-only, sidecar KHÔNG đổi):
> - **Redact chọn màu** ([`editor.js`](desktop/renderer/editor.js)): redact không còn cứng màu đen. Thêm color picker riêng `#ed-redact-color` (mặc định `#000000`), state `ed.redactColor`. Annot redact lưu `color` của nó; overlay vẽ `el.style.background = a.color`; `rasterRedacted()` tô **từng box theo màu của nó** (vẫn bảo mật — xoá pixel gốc, không chỉ phủ). Bỏ `fillStyle="#000"` cứng.
> - **Hộp văn bản giàu định dạng** ([`editor.js`](desktop/renderer/editor.js)): text annot thêm `font`/`bold`/`italic`/`underline`. Có picker Font (`#ed-font`: Sans/Serif/Mono + optgroup "Font máy" nạp lười từ `/fonts`) và 3 nút B/I/U (`te-fmt`). `textFont(px, opts)` dựng CSS font shorthand; `renderTextPng()` vẽ gạch chân thủ công (canvas không có underline) — bake bằng canvas→PNG nên **không cần đụng backend** (khác "Sửa chữ" gửi sidecar). Overlay + textarea soạn thảo phản ánh đúng style.
> - **Thanh công cụ ngữ cảnh** ([`editor.js`](desktop/renderer/editor.js) `syncCtlVisibility` + `index.html` `data-ctl`): mỗi control chỉ hiện với tool liên quan (vd redact→chỉ "Màu che"; text→Font/Cỡ/B I U). CSS `.edit-bar [data-ctl][hidden]{display:none!important}` để `hidden` thắng `display:flex`.
> - **Thêm trang trắng** ([`app.js`](desktop/renderer/app.js) `addBlankPage`): nút "Trang trắng" cạnh "Chèn"; dùng `choosePosition()` chung, `doc.insertPage(at,[w,h])` cỡ theo trang liền trước (fallback A4). Có trong `[data-needs-doc]` + `GATED_BTNS`.
> - Có lệnh phát hành mới: [`.claude/commands/deploy.md`](.claude/commands/deploy.md) (`/deploy`).

> v0.2.10 — **Tìm kiếm (Ctrl+F) + bôi đen text + searchable doc trộn nhanh hơn**:
> - **Tìm kiếm trong tài liệu** ([`app.js`](desktop/renderer/app.js)): thanh Ctrl+F (input + ‹/› + đếm `n/total` + Esc), highlight vàng, kết quả hiện màu cam, cuộn tới. **Không dấu vẫn tìm ra có dấu** (`foldText`: NFD bỏ combining + đ→d, case-insensitive) — gõ "dieu khoan" thấy "Điều khoản". Index cache theo `state.pdf`; vẽ box từ `item.transform`+`width` qua `pdfjsLib.Util.transform` nên đúng ở mọi mức zoom.
> - **Bôi đen/chọn text** ([`app.js`](desktop/renderer/app.js) `addTextLayer`): phủ `pdfjsLib.renderTextLayer()` lên trang text-based → kéo chọn/copy như Foxit. Trang scan không có text → bỏ qua (đúng). **Bẫy pdf.js 3.x: phải set CSS var `--scale-factor`** trên container, dùng tham số `textContentSource`.
> - **Searchable doc trộn text+scan** ([`api.py`](api.py) `/searchable`): bỏ qua OCR trang đã có text layer (`get_text >= 20 ký tự`) → nhanh hẳn + hết chồng 2 lớp text; cờ `force_ocr` để ép. Cô lập lỗi **từng trang** (1 trang lỗi không giết cả tài liệu). Engine load lười (doc thuần digital trả ngay). Bỏ box rác <3px.
> - **Fix B — lớp text vô hình fit bề rộng box** ([`api.py`](api.py)): chuyển `insert_text` (fontsize chỉ theo chiều cao) → `TextWriter` + `Font.text_length()` + `morph=fitz.Matrix(sx,1)` scale ngang cho khớp box (kiểu OCRmyPDF). Kiểm chứng: text trích xuất ra rộng 227.7pt vs box 228pt → bôi đen/tìm trên trang OCR không còn lệch.
> - Sidecar **CÓ đổi** (Fix B + skip + isolate) → phải rebuild sidecar cho OTA.

> v0.2.9 — **Fix THỰC SỰ: ghi chú (note) đọc được trong app**:
> - Note bake ra PDF `Text` annotation, nội dung nằm ở `/Contents`. `addNoteMarkers()` ([`app.js`](desktop/renderer/app.js)) đọc `a.contents` — nhưng **pdf.js 3.x đã bỏ trường này**, chuyển text sang `a.contentsObj.str` ({str,dir}). Nên `notes` luôn rỗng → marker không bao giờ hiện (Foxit/Acrobat tự parse `/Contents` nên vẫn đọc được). Lần "fix" v0.2.x trước chưa từng chạy.
> - Sửa: đọc `a.contentsObj?.str || a.contents` (giữ fallback cũ) cho cả filter, tooltip và popup. Kiểm chứng bằng pdf.js 3.11 thật trên PDF có note: `a.contents=undefined`, `a.contentsObj.str="Ghi chú…"`. Filter giữ subtype `Text` nên annotation `Popup` đi kèm không tạo marker trùng.
> - Sidecar KHÔNG đổi — chỉ đóng gói lại Electron.

> v0.2.8 — **Installer nhẹ ~400MB + fix font khi sửa chữ**:
> - **Bỏ paddle khỏi bundle** ([`sidecar.spec`](sidecar.spec)): RapidViet là hot path duy nhất được đóng gói nên gỡ `paddle`/`paddleocr`/`paddlex` (~392+19+2MB) khỏi `HEAVY_PACKAGES` + `METADATA_PACKAGES`, thêm vào `excludes` để chắc chắn không bị kéo lại. `AutoOCREngine` vẫn fallback an toàn (RapidViet→RapidOCR→VietOCR). Giữ `scipy`/`scikit-image` (vietocr cần qua albumentations/imgaug) + `shapely`/`pyclipper` (post-process detection của RapidOCR). [`requirements.txt`](requirements.txt): paddle chuyển sang khối tuỳ chọn (không cài mặc định).
> - **Fix font tính năng Sửa chữ** ([`api.py`](api.py) `_resolve_local_font`): matplotlib 3.11 `findfont()` trả về `FontPath` (subclass `str` kèm face-index) mà PyMuPDF `insert_font` từ chối (`bad fontfile`) → lỗi bị nuốt → **mọi** font cục bộ (chọn từ máy *hoặc* giữ font gốc) rơi về DejaVu. Sửa: coerce `str(found)` + thêm index tên font chuẩn hoá để khớp tên PDF dạng `TimesNewRomanPSMT`→`Times New Roman`. Đã kiểm chứng e2e qua `/edit-text`: giữ đúng font gốc & áp đúng font chọn.
> - ⚠️ Build venv: cần `pip install -r requirements.txt` (đã gồm `rapidocr`/`onnxruntime`, bỏ paddle) trước `build:sidecar`.

> v0.2.7 — **RapidViet: nhanh VÀ đúng dấu** (RapidOCR ONNX detect + VietOCR rec):
> - Engine mới `RapidVietHybridOCREngine` ([`engine.py`](src/ocr/engine.py)) = detection bằng RapidOCR (ONNX, ~1s, không cần paddle) + recognition bằng VietOCR (batch, đúng dấu chồng). Đo CPU ấm: **~3-4s/trang** (vs Hybrid-paddle 44s cold/v0.2.6). Trả box cho searchable PDF.
> - Default OCR `hybrid`→**`rapidviet`** ([`api.py`](api.py) `_get_ocr`); `AutoOCREngine` ưu tiên RapidViet→Hybrid→RapidOCR→Paddle→VietOCR; factory thêm key `rapidviet`.
> - **Bằng chứng dứt điểm:** dict onnx của PP-OCR latin/đa ngữ (rapidocr/paddle 3.x) **THIẾU** ký tự dấu chồng VN (ạ/ấ/ộ/ợ/ử/ữ/ự...) — kiểm bằng `session.get_character_list()`. Nên recognition PHẢI dùng VietOCR; detection thì onnx dùng được (không cần ký tự).
> - paddlepaddle giờ KHÔNG nằm trong hot path nữa (chỉ còn ở engine `hybrid`/`paddleocr` tuỳ chọn) → có thể cân nhắc bỏ paddle khỏi bundle ở bản sau để giảm installer (torch vẫn cần cho VietOCR).

> v0.2.6 — **Hotfix: RapidOCR đọc SAI dấu tiếng Việt → đổi mặc định về Hybrid (VietOCR)**:
> - **Lỗi v0.2.5:** RapidOCR (`LangRec.EN`) làm hỏng dấu trên scan thật (`CỘNG HOÀ`→`CNG HOÀ`, `Cổ phần`→`C phn`). Benchmark v0.2.5 dùng ảnh tổng hợp nên không lộ.
> - **Gốc rễ:** PaddleOCR **3.x bỏ recognizer tiếng Việt chuyên dụng** (`vi_PP-OCRv3_rec` của 2.x). Cả RapidOCR EN/LATIN lẫn paddle 3.x `lang="vi"` (→ v6 medium rec) đều không đọc được dấu chồng (ộ/ử/ấ/ề/ị). Đây là gốc rễ THẬT của hồi quy 0.0.x→nay (cả tốc độ lẫn độ chính xác).
> - **Fix:** mặc định OCR đổi `rapidocr`→**`hybrid`** (detection + VietOCR — engine cục bộ duy nhất đúng dấu) ([`api.py`](api.py) `_get_ocr`, [`engine.py`](src/ocr/engine.py) `AutoOCREngine` ưu tiên Hybrid). RapidOCR giữ tuỳ chọn nhanh/latin. Đánh đổi: chậm hơn (VietOCR transformer/dòng).
> - **Tiếp theo (v0.2.7):** phục hồi vi-rec dạng **ONNX** (paddle2onnx + dict VN nạp vào RapidOCR) → nhanh **và** đúng dấu, bỏ paddle khỏi hot path. Xem [`docs/OCR-OPTIMIZATION.md`](docs/OCR-OPTIMIZATION.md) §3c.

> v0.2.5 — **Đổi OCR engine sang RapidOCR (ONNX Runtime)** ⚠️ _(đã thu hồi ở v0.2.6 — sai dấu tiếng Việt)_:
> - Engine mặc định: **RapidOCR** (PP-OCR trên onnxruntime) thay PaddleOCR/hybrid ([`engine.py`](src/ocr/engine.py) `RapidOCREngine`, [`api.py`](api.py) `_get_ocr`). Đo CPU: ~1-3s/trang vs PaddleOCR ~7-19s, độ chính xác dấu tiếng Việt tương đương, vẫn trả box cho searchable. Hết crash mkldnn của paddlepaddle.
> - paddleocr/paddlepaddle/vietocr giữ làm fallback, chọn qua env `OCR_ENGINE` (rapidocr|paddleocr|hybrid|vietocr|auto).
> - Deps: thêm `rapidocr>=3.0.0` + `onnxruntime>=1.20.0` ([`requirements.txt`](requirements.txt)); bundle trong [`sidecar.spec`](sidecar.spec). Model RapidOCR tải lần đầu (1 lần cần mạng, như paddle trước đây). **Đã smoke-test frozen sidecar.exe: /ocr OK 5.7s, tiếng Việt chuẩn.**
> - Nghiên cứu đầy đủ + benchmark: [`docs/OCR-OPTIMIZATION.md`](docs/OCR-OPTIMIZATION.md).

> v0.2.4 — **OCR tăng tốc ~3-4x**:
> - Engine mặc định đổi từ **hybrid** (PaddleOCR detect + VietOCR recognize) sang **paddleocr** ([`api.py`](api.py) `_get_ocr`, env `OCR_ENGINE` override). Hybrid chạy transformer VietOCR mỗi dòng trên CPU → ~76s/trang; paddleocr 1 pass nhanh hơn nhiều, độ chính xác tiếng Việt vẫn tốt.
> - PaddleOCR đổi detector sang **PP-OCRv5_mobile_det** ([`engine.py`](src/ocr/engine.py)): detector server mặc định là phần nặng nhất (~42s → ~18s/trang, cùng số dòng). Giữ recognizer lang="vi" mặc định (mobile rec làm hỏng dấu: "Công"→"Cong"). Tắt `use_textline_orientation`. Override qua env `PADDLE_DET_MODEL`/`PADDLE_REC_MODEL`.
> - `enable_mkldnn` vẫn TẮT: paddlepaddle 3.3.1 crash `ConvertPirAttribute2RuntimeAttribute` kể cả khi tắt PIR — chờ nâng cấp paddle.
> - Đo (CPU, trang ~20-30 dòng): hybrid 76s → paddleocr warm ~10-18s.

> v0.2.3 — **OCR/Extract fixes + Custom fields**:
> - **Fix bóc tách báo 500 plaintext** ([`api.py`](api.py)): `/extract` nay bọc `engine.recognize()` trong try/except → trả JSON `{success:false,error}` thay vì `Internal Server Error` (vỡ `res.json()` ở renderer → lỗi "Unexpected token 'I'").
> - **Fix OCR/searchable dependency error đóng gói** ([`sidecar.spec`](sidecar.spec)): PaddleOCR 3.x kiểm tra extra `ocr-core` qua `importlib.metadata.version()`; PyInstaller không bundle `.dist-info` của dependency → `DependencyError` ("A dependency error occurred during pipeline creation"). Thêm `copy_metadata` cho paddlex/paddleocr/paddlepaddle + 6 dep ocr-core (imagesize, opencv-contrib-python, pyclipper, pypdfium2, python-bidi, shapely).
> - **Form trường tùy chỉnh** (Bóc tách): chọn mẫu "Tùy chỉnh…" → khai báo trường tự do; auto-slug tên VN → key JSON, lưu localStorage. Gửi `custom_fields` cho `/extract` (backend đã sẵn). [`index.html`](desktop/renderer/index.html), [`app.js`](desktop/renderer/app.js), [`app.css`](desktop/renderer/app.css).

> v0.2.2 — **UI/UX Polishing**:
> - **Two-row Toolbar**: Giao diện toolbar chính được thiết kế lại thành 2 dòng (.tb-row), giúp không gian thoáng và hiện đại hơn. Khắc phục lỗi tràn menu và mất nội dung bên phải khi thay đổi kích thước cửa sổ (bổ sung flex-wrap).
> - **Sumerian Na Logo**: Thiết kế icon logo mới đại diện cho chữ nêm "Na" trong ngôn ngữ Sumerian, thay cho icon tìm kiếm cũ.
> - Bảng OCR (`.ext-panel`) được định vị lại bằng Absolute Position nội bộ vào Workspace thay vì Fixed đè màn hình.

> v0.2.1 — **AGPL notices + security/perf review fixes**:
> - **Third-party licenses bundled**: [`scripts/gen-third-party-licenses.js`](desktop/scripts/gen-third-party-licenses.js)
>   quét `.venv/*.dist-info` + node_modules → `THIRD-PARTY-LICENSES.txt` (25 phần, gồm text AGPL/Apache/MIT/BSD).
>   Ship qua electron-builder `extraResources` (kèm `LICENSE.txt`). Mục Giới thiệu thêm link mở 2 file
>   (IPC `licenses:open`). Đóng nốt yêu cầu Apache/MIT "notice phải đi kèm binary".
> - **P1 lazy OCR**: bỏ nạp model ở lifespan; `_get_ocr()` nạp lần đầu khi gọi OCR/extract/searchable
>   ([`api.py`](api.py)). Giảm RAM nhàn rỗi (~GB) + `/health` 200 ngay. `health.engine` = "lazy"|"loaded".
> - **Electron hardening** ([`main.js`](desktop/src/main.js)): `setWindowOpenHandler` deny + `will-navigate`
>   guard (S2); `requestSingleInstanceLock` (H2); CSP qua `onHeadersReceived` (S3 — connect-src cho
>   loopback sidecar, worker-src cho pdf.js). **Smoke test dev: /health + /templates 200 qua CSP OK.**
> - **H1 sidecar kill-tree**: [`sidecar.js`](desktop/src/sidecar.js) `taskkill /T /F` trên win32 → hết
>   orphan `sidecar.exe` khóa file lúc rebuild (EBUSY). Đã verify: thoát app không còn process thừa.
> - **Update message**: bản portable nay báo rõ "dùng bản cài đặt .exe để bật tự cập nhật".
>   (Lý do bạn thấy "không hỗ trợ tự cập nhật" ở 0.1.8 = bạn chạy bản **portable**; chỉ bản NSIS tự update.)

> v0.2.0 — **Miễn phí & mã nguồn mở (AGPL-3.0)**:
> - Lý do: app nhúng **PyMuPDF = AGPL-3.0**; bản đóng + khóa serial trước đây **vi phạm**
>   giấy phép. Nay mở mã + bỏ khóa để tuân thủ (giải pháp rẻ nhất, giữ nguyên PyMuPDF).
> - **Tắt khóa serial**: `ENFORCE = false` trong [`license.js`](desktop/src/license.js) →
>   mọi tính năng mở, ẩn UI kích hoạt (`#lic-section`). Code license-server giữ lại nhưng ngủ.
> - Thêm `LICENSE` (AGPL-3.0) ở gốc repo; README đổi MIT→AGPL + bảng giấy phép bên thứ ba;
>   mục "Giới thiệu" trong app thêm link giấy phép + mã nguồn (mở bằng `shell.openExternal`
>   qua IPC mới `shell:open-external`).
> - ⚠️ Nếu sau này muốn bản trả phí/đóng: AGPL chặn closed features → phải mua giấy phép
>   thương mại Artifex hoặc thay PyMuPDF (pypdfium2+pikepdf, mất redaction/sửa-chữ gốc).
>
> v0.1.9 — fix khung nét đứt kéo–thả bị kẹt ([`app.js`](desktop/renderer/app.js) window
> drag handlers + thumbnail drop: xoá `.dropping` đúng lúc).

> v0.1.5:
> - **Font máy local khi sửa chữ**: dropdown `te-font` thêm "Giữ nguyên (font gốc)" + nhóm "Font máy"
>   (đổ từ `GET /fonts`). Sửa đoạn giữ đúng font gốc (frontend gửi tên font span, backend resolve qua
>   `matplotlib.font_manager.findfont` → TTF local → embed; `doc.subset_fonts()` để nhẹ file). Code:
>   [`api.py`](api.py) `_resolve_local_font`/`_list_local_font_families`/`/fonts` + nhánh font `/edit-text`;
>   [`text-edit.js`](desktop/renderer/text-edit.js) `loadSystemFonts` + map `__keep__`→font gốc lúc `apply`.
> - **Native menu + phím tắt** (chuẩn phần mềm PDF): menu Tập tin/Chỉnh sửa/Trang/Hiển thị/Trợ giúp
>   ([`main.js`](desktop/src/main.js) `buildMenu`). Ctrl+O mở, **Ctrl+S Lưu (ghi đè im lặng nếu đã có
>   đường dẫn), Ctrl+Shift+S Lưu thành** (`saveDoc`/`saveAsDoc` + IPC `file:write-pdf`), Ctrl+Z/Y
>   hoàn tác/làm lại, Ctrl +/–/0 zoom, Delete xóa trang. Phím xung đột gõ chữ để `registerAccelerator:false`
>   → renderer keydown tự xử (guard `isTyping`). Menu→renderer qua kênh `menu:cmd` (`onMenuCommand`).
> - ⚠️ font_manager quét font máy lúc chạy → cần **test trên sidecar.exe đóng gói** (matplotlib cache).
>
> v0.1.4:
> - **Sửa chữ — bold/italic dùng font variant thật** thay faux-stroke/shear (trước đây đậm bị blob xấu,
>   nghiêng là shear giả). DejaVu `-Bold/-Oblique/-BoldOblique.ttf` cho tiếng Việt + Base14
>   `hebo/tibo/cobo…` cho Latin; faux chỉ còn là fallback. Underline vốn là `draw_line`, không lỗi.
>   Code: [`api.py`](api.py) `_dejavu_variant`/`_BUILTIN_VARIANTS` + nhánh `/edit-text`.
> - **Chèn ảnh/chữ ký**: sniff magic-byte (PNG/JPG) thay vì tin MIME; loại định dạng lạ + cảnh báo JPG
>   (nền đặc) ngay lúc chọn; mỗi annotation bake trong try/catch riêng nên 1 ảnh hỏng không mất cả mẻ.
>   Code: [`editor.js`](desktop/renderer/editor.js) `sniffImage`/`drawOneAnnot`.
> - ⚠️ "Chữ ký" hiện chỉ là **ảnh overlay**, KHÔNG phải chữ ký số PKI/PAdES (chưa có; đề xuất pyhanko
>   nếu cần). Kế hoạch tiếp theo v0.1.5: lấy font từ máy local khi sửa chữ.
>
> v0.1.3: kéo–thả file PDF từ Windows vào khe giữa hai trang ở cột thumbnail để **chèn tại vị trí**
> (phát hiện nửa trên/dưới → chèn trước/sau; nhận nhiều file). Dùng chung lõi `insertBuffersAt` với nút
> Chèn. Code: [`app.js`](desktop/renderer/app.js) `wireThumb` + `insertBuffersAt`; CSS `.thumb.insert-before/after`.

## Tình trạng: P0–P6 + Security + **đóng gói (P5)** xong; còn test GUI & test máy sạch

| Phase | Trạng thái |
|-------|-----------|
| P0 — Vỏ Electron + sidecar | ✅ Code xong. Build .exe (T0.9/T0.10) **chưa làm**. |
| P1 — PDF core (xem/ghép/tách/chèn/xoay/xóa/sắp xếp/lưu) | ✅ Xong, GUI tested. |
| P2 — OCR + bóc tách field + xuất Excel/CSV/JSON | ✅ Xong, GUI tested + backend headless tested. |
| P3 — Searchable PDF + Nén | ✅ Code + test backend xong (`/searchable`, `/compress` — nén bằng PyMuPDF, không cần Ghostscript). |
| P4 — Overlay edit (annotate/watermark/form/redact) | ✅ Code xong (`editor.js`). Chờ test GUI (T4.6). |
| P6 — **Sửa chữ gốc** (native text edit, span-replace) | ✅ Code + test backend xong (`/text-spans`,`/edit-text` + `text-edit.js`). Chờ test GUI. |
| P7 — **Chuyển đổi** (khoá file / xuất ảnh / PDF↔ảnh) | ✅ Code + test backend xong (`/encrypt`,`/extract-images`,`/pdf-to-images`,`/images-to-pdf`; nút dropdown "Chuyển đổi" + menu native). Chờ test GUI. |
| **Security** — token sidecar + size guard + sandbox | ✅ Code + test backend xong (token gate 401/200 qua TestClient). |
| P5 — Đóng gói portable .exe | ✅ Build xong: `sidecar.exe` (PyInstaller) + `NabuPDF-0.2.30-portable.exe` / `-x64.exe` (NSIS) ở `desktop/dist-app/`. Còn: auto-update + chốt bundle weights + test máy sạch. |

## Chạy app (dev)

```powershell
cd desktop
pnpm install      # nếu máy mới (postinstall tự vendor pdf libs)
pnpm start        # UI PDF hiện ngay; badge "OCR: sẵn sàng" nếu có .venv 3.12
```

OCR cần `.venv` Python 3.12 ở gốc repo + `GEMINI_API_KEY` trong `.env`. Xem [SETUP.md](SETUP.md).

## Máy hiện tại (máy đã làm P1/P2)

- `.venv/` = Python **3.12.10** (winget `Python.Python.3.12`), deps đã cài (~3GB: torch 2.12 cpu, paddle 3.3.1, vietocr, google-genai, openpyxl, fastapi…).
- Model weights PaddleOCR/VietOCR đã tải về cache user (`~/.paddlex`, `~/.cache`) → chạy nhanh.
- `.env` có `GEMINI_API_KEY`. Máy này còn cả Python 3.13 (mặc định `py`), nhưng app dùng `.venv` 3.12.
- ⚠️ Máy **mới** chưa có gì: phải dựng lại `.venv` 3.12 theo SETUP.md trước khi dùng OCR. PDF core (P1) chạy không cần Python.

## Bản đồ code

**Desktop (Electron, renderer thuần JS — chưa React):**
- `desktop/src/main.js` — lazy sidecar (UI load ngay), IPC: `dialog:open-pdf|save-pdf|save-file`, `sidecar:status|restart`.
- `desktop/src/sidecar.js` — spawn sidecar port động, ưu tiên `.venv` 3.12, poll `/health`.
- `desktop/src/preload.js` — bridge `window.desktop` (openPdf/savePdf/saveFile/sidecar status).
- `desktop/renderer/index.html` + `app.css` + `app.js` — UI + logic PDF/OCR (P1/P2).
- `desktop/renderer/editor.js` — **P4 overlay editor** (annotate/watermark/redact/form). Module IIFE
  dùng chung global của `app.js`; xuất `window.Editor` (`syncOverlays`/`bakePending`/`reset`/`active`).
  `app.js` chỉ móc 4 chỗ: `renderViewer` (sync overlay), `loadBytes` (reset), `saveDoc` (bake trước khi lưu),
  `updateToolbar` (khoá thao tác trang khi đang sửa).
- `desktop/renderer/editor.js` — P4 overlay editor: select/text/highlight/draw/image/redact/watermark/form
  + **khoanh vùng & ghi chú** (T4.8): `box` (khung chữ nhật), `ellipse`, `arrow` (mũi tên), `note`.
  `note` bake thành **PDF Text annotation thật** (`/Contents` UTF-16 tiếng Việt) + marker 💬 nhìn thấy được.
- `desktop/renderer/text-edit.js` — **P6 sửa chữ gốc**. IIFE dùng chung global `app.js`; xuất
  `window.TextEdit` (`active`/`syncOverlays`/`reset`). Gọi `/text-spans` (đọc span trang đang xem) →
  vẽ ô bấm theo `bbox*scale` → sửa inline → `/edit-text` (xoá thật + ghi lại tại `origin`). `app.js`
  móc 3 chỗ: `renderViewer` (sync), `loadBytes` (reset), `updateToolbar` (khoá khi đang sửa + nút
  `#btn-text-edit`). Chỉ chạy khi sidecar `ready` (khác overlay editor chạy thuần renderer).
- `desktop/renderer/vendor/` — pdf-lib UMD + pdfjs-dist **v3** UMD (offline; `scripts/vendor-libs.js`).

**Backend (Python sidecar, FastAPI):**
- `api.py` — endpoints: `/health`, **`/config`** (GET/POST API key), `/ocr`, `/templates`, `/extract`,
  `/export`, **`/searchable`** + **`/compress`** (P3), **`/text-spans`** + **`/edit-text`** (P6).
  Middleware token bắt buộc header `X-Sidecar-Token` (trừ `/health`) khi env `SIDECAR_TOKEN` được set.
- `src/utils/config.py` — `get_gemini_key()`/`set_gemini_key()` đọc/ghi `settings.json` ở `_data_root()`
  (frozen = `%LOCALAPPDATA%\Nabu PDF`). Key người dùng nhập trong app **thắng** env `GEMINI_API_KEY`.
  Nhờ vậy bản đóng gói không cần `.env`/biến môi trường — người dùng dán key qua nút ⚙ trong UI.
- `src/ocr/engine.py` — Hybrid PaddleOCR detect + VietOCR recognize (paddle 3.x). **`recognize_boxes()`**
  trả `(text, [x0,y0,x1,y1])` cho lớp text searchable.
- `src/agents/gemini_agent.py` + `field_templates.py` — bóc field + 5 mẫu.
- `src/output/writer.py` — JSON/Excel/CSV/Markdown/GoogleSheet writers.
- `sidecar.py` — entry uvicorn (đọc `--port`).

## Bẫy đã giải (đừng "sửa cho mới")

- **Python phải 3.12** (không 3.13) — vietocr thiếu wheel cp313. paddle/paddleocr **3.x** (numpy 2).
- **pdfjs v3 (UMD)**, không v4 (ESM-only vỡ trên `file://`).
- **CSP meta + `file://`** chặn worker pdf.js → đã bỏ CSP meta.
- **`[hidden]{display:none!important}`** trong app.css — bắt buộc, nếu không `.overlay`/`.ext-panel` (`display:flex`) đè `hidden` → che màn lúc khởi động.
- Sidecar **lazy/non-blocking** — đừng cho UI chờ `/health` (vi phạm D5).
- **P4 redact phải an toàn**: chỉ vẽ ô đen đè = lỗ hổng (text gốc trích xuất được). Cách đang dùng:
  raster hoá trang có redact + burn ô đen + thay nội dung trang bằng ảnh → text gốc bị xoá thật.
- **Text/watermark tiếng Việt = PNG nhúng**, không dùng `drawText` (Helvetica của pdf-lib không
  encode được dấu; và không muốn vendor font Unicode). Đánh đổi: text baked không search/copy được.
- **P3 font searchable**: dùng `matplotlib.get_data_path()/fonts/ttf/DejaVuSans.ttf` (str), **KHÔNG**
  `font_manager.findfont()` — nó trả object `FontPath` → PyMuPDF báo "bad fontfile".
- **P6 sửa chữ gốc**: dùng `insert_text` tại **baseline `span["origin"]`**, **KHÔNG** `insert_textbox`
  (nó trả số âm = tràn khi text 1 dòng không vừa ô cao bằng cỡ chữ → không ghi được gì). Xoá chữ cũ
  bằng `add_redact_annot(fill=trắng)+apply_redactions()` (xoá thật, không phải che). Chữ mới ghi bằng
  font `vnedit`=DejaVuSans (encode được tiếng Việt). Chỉ áp dụng cho PDF có text thật; PDF scan trả
  `has_text:false` → app báo dùng Searchable/Bóc tách.
- **Ghi chú (note) đọc được trong app**: note bake ra **PDF `Text` annotation thật** — pdf.js chỉ vẽ
  canvas trang, **không vẽ chữ annotation** → trước đây app mình thấy ô marker nhưng không đọc được
  nội dung (Foxit/Acrobat đọc được). Sửa: `addNoteMarkers()` ở `app.js` đọc `page.getAnnotations()`
  mỗi lần render trang, đè hotspot trong suốt lên marker → hover = tooltip, click = popup nội dung.
- **Zoom KHÔNG được gọi `renderViewer()`** (v0.2.48): `renderViewer` là đường cho **đổi tài liệu**,
  nó xoá sạch `.page-wrap` → mất overlay chú thích/ô nhập chữ/highlight tìm kiếm và tốn O(trang) mỗi
  nấc lăn chuột (chính là cảm giác "khựng/giật"). Đổi tỷ lệ đi qua `applyScaleToDom()` (đồng bộ, chỉ
  CSS box) + `commitScale()` (hoãn 160 ms mới rasterise). `.text-layer` không cần vẽ lại — pdf.js 3.x
  dàn span bằng `calc(var(--scale-factor)*Npx)`. Xem BI-36.
- **Byte ảnh gốc của ảnh round-trip nằm ở stream `/NabuSrc` KHÔNG filter**, không nhét vào `/NabuData`
  (v0.2.48): đo trên pdf-lib 1.17.1 → hex ~1.46× cỡ ảnh + >1 s/MB, **và** cả `PDFHexString.decodeText`
  lẫn `PDFString.decodeText` **ném `RangeError` khi payload > ~150 KB**; stream thô = 1.00×, ~5 ms/2 MB.
  Có `/Filter` = tool khác nén lại ⇒ annot thành **chỉ đọc**, không bao giờ bị xoá lúc bake. Xem BI-37.
- **Strip annot round-trip phải GIẢI PHÓNG object, và giải phóng SAU khi bỏ liên kết cả tài liệu**
  (v0.2.48): pdf-lib ghi lại mọi object nó đọc ⇒ chỉ `arr.remove()` là để lại appearance cũ mãi mãi
  (bake 10 lần = 10 bản PNG). Một `/NabuSrc` được **chia sẻ** cho mọi trang "áp nhiều trang" nên xoá
  giữa vòng lặp = ảnh nhân đôi. Xem BI-38.
- **Re-render sau Áp dụng = chỉ trang đổi** (`rerenderChanged(changed)` ở `app.js`, thay `renderAll`):
  bake đổi `state.bytes` nên pdf.js phải reload doc, **nhưng số trang không đổi** → giữ DOM page-wrap +
  bitmap trang không đổi, chỉ repaint canvas/thumbnail trang thực sự đổi. Editor (P4): `changed` = các
  trang có annot (watermark→null=mọi trang). Sửa chữ (P6): `changed`=đúng trang đang sửa. Plain exit
  (toggle off không áp dụng) chỉ bỏ lớp ô, **không re-render**. Tránh reload cả file 10 trang.
- **"Áp dụng" (P4) = bake + thoát**: nút `#ed-apply` nối thẳng `exit()` (không phải `bakePending()`) →
  áp dụng xong tự đóng menu Chỉnh sửa.
- **Thumbnail render lười** (`renderThumbs` + `renderThumbCanvas` ở `app.js`): trước render MỌI
  thumbnail cùng lúc → thủ phạm chính làm reload chậm sau reorder/chèn/ghép trên doc nhiều trang.
  Giờ dùng IntersectionObserver (root `#thumbs`) giống viewer — chỉ vẽ thumbnail gần khung nhìn.
  Lợi cho mọi lần reload (mở/reorder/chèn/ghép/xóa/xoay). `refreshThumb` tái dùng `renderThumbCanvas`.
- **Chèn/Ghép chọn vị trí** (`choosePosition()` + modal `#pos-modal`): Ghép trước chỉ append cuối,
  Chèn ngầm "sau trang chọn". Giờ cả hai mở modal chọn đầu/cuối/sau-trang-N (mặc định = trang đang
  chọn). `merge` chuyển từ `addPage` → `insertPage(pos++)`. Trang mới được auto-select sau khi xong.
  Reorder/chèn/ghép đổi số trang + thứ tự index → KHÔNG dùng được `rerenderChanged` (giữ DOM cũ),
  phải rebuild DOM; tốc độ dựa vào render lười (thumbnail + viewer) thay vì né reload.
- **Token sidecar**: `main.js` sinh token mỗi lần chạy → truyền cho sidecar qua env `SIDECAR_TOKEN` +
  cho renderer qua `sidecar:status` (field `token`). Renderer gọi qua `sidecarFetch()` (tự gắn header).
  Chạy `api.py`/`app.py` thuần (không set env) thì middleware bỏ qua — giữ tương thích dev.
- **Đóng gói sidecar (PyInstaller)**: `build:sidecar` PHẢI gọi `.venv\Scripts\python -m PyInstaller`
  (không `pyinstaller` trần — không trên PATH, và phải đúng Python 3.12 của venv). `sidecar.spec` đã
  thêm `fitz/pymupdf` + `matplotlib` vào `HEAVY_PACKAGES` (lazy-import nên static analysis bỏ sót →
  thiếu sẽ crash Searchable/Nén/Sửa-chữ + thiếu DejaVuSans.ttf). Các dòng `ERROR: Hidden import
  'torch.distributed._shard.checkpoint.*' not found` lúc build là **vô hại** (alias torch cũ).
- **electron-builder + winCodeSign symlink (Windows không admin/Dev Mode)**: build installer tải
  `winCodeSign-2.6.0.7z` chứa 2 symlink `.dylib` của macOS → 7za báo "Cannot create symbolic link:
  A required privilege is not held" → exit 2 → electron-builder coi là fail dù file Windows
  (`signtool.exe`) đã extract đủ. **Cách vá KHÔNG cần quyền**: copy 1 thư mục tạm đã extract hoàn
  chỉnh thành `…\Cache\winCodeSign\winCodeSign-2.6.0` (tên thư mục "finalized" mà electron-builder
  tìm) → nó bỏ qua bước extract. (Cách khác: bật Windows Developer Mode hoặc chạy terminal admin.)
- **Lock `dist-app` khi build lại**: nếu app `win-unpacked\Nabu PDF.exe` còn chạy (kèm `sidecar.exe`
  con) → electron-builder lỗi `EBUSY`/`Access denied`. Kill process `Nabu PDF`+`sidecar` trước khi build.

## Bước tiếp theo (gợi ý)

0. **▶️ Test tay GUI cho v0.2.48 (BẮT BUỘC trước khi phát hành)** — ba thay đổi này đều là
   renderer/DOM nên lưới tự động chỉ phủ phần số học + phần object PDF; phần cảm giác thì
   phải mắt thấy tay kéo. Danh sách đầy đủ ở `docs/REGRESSION-GUARD.md` §5 (4 dòng mới:
   Zoom · Cột trang · Ảnh round-trip · Tay nắm đổi cỡ). Bốn phép thử đáng làm trước nhất:
   - Ctrl+lăn **nhanh liên tục** trên PDF nhiều trang & trên bản vẽ A0 → trang bám tay, dừng
     ~0.2 s là nét, **không nấc nào bị bỏ**; rồi zoom **trong lúc đang Chú thích** → hình vẽ
     theo đúng tỷ lệ và ô nhập chữ đang mở **không mất**.
   - Tick chọn vài trang → cuộn đi trang khác → bấm **Xoá trang**: phải xoá **đúng các trang
     đã tick** (BI-39/BI-26).
   - Chèn 1 ảnh → Áp dụng → Lưu → **mở lại** → Chỉnh sửa → kéo/đổi cỡ/xoá được; lưu **3–4
     lần** liên tiếp → **cỡ file không phình**; áp 1 chữ ký cho ~20 trang → file ~1 lần cỡ ảnh.
   - Xoá 1 ảnh round-trip rồi thêm **ô redact trên chính trang đó** → Áp dụng: ảnh **không**
     quay lại thành pixel và ảnh còn lại **không nhân đôi** (BI-38).

1. **▶️ Test GUI P4 (T4.6)**: bật "Chỉnh sửa" → thử đủ công cụ → Áp dụng → Lưu → mở lại; kiểm tra
   redact thật sự xoá text gốc (bôi đen vùng rồi sau khi lưu thử copy/search không ra chữ cũ).
2. **▶️ Test GUI P3 (T3.4)**: mở PDF scan → nút "Searchable" → mở file `*-searchable.pdf` ra app
   khác, thử Ctrl+F / bôi-copy chữ.
3. **▶️ Test GUI nén (T3.5b)**: mở PDF nhiều ảnh → nút "Nén" → thử các mức → kiểm tra size giảm.
3b. **▶️ Test GUI P6 (sửa chữ gốc)**: mở PDF xuất từ Word (chữ thật) → "Sửa chữ" → ô chữ hiện viền
   → sửa 1 đoạn có dấu → Áp dụng → Lưu → mở lại copy/search đoạn cũ không ra, đoạn mới đúng. Mở PDF
   scan → "Sửa chữ" → kỳ vọng toast "ảnh scan, không có chữ để sửa".
4. ~~**P5 — Đóng gói**~~ ✅ **XONG**: `sidecar.exe` (PyInstaller) + `NabuPDF-0.2.30-portable.exe`
   / `-x64.exe` (NSIS) ở `desktop/dist-app/`. Đã smoke-test bản đóng gói: app mở, sidecar boot,
   `/health` 200, token gate 401, `/config` (nhập API key) 200. Xem [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md).

### Còn lại cho phiên sau
- **▶️ Test máy Windows sạch** (chưa cài Python): copy `NabuPDF-0.2.30-portable.exe` sang →
  xác minh self-contained; lần OCR đầu cần mạng tải weights PaddleOCR/VietOCR (~vài trăm MB vào
  cache user). Đây là phép thử quan trọng nhất chưa làm được (cần máy thứ 2).
- **▶️ Các test GUI** P3/P4/P6 ở trên (1–3b) — làm trên bản dev hoặc bản đóng gói.
- **▶️ Bóc tách (P2) trên bản đóng gói**: bấm ⚙ → dán `GEMINI_API_KEY` → Lưu → thử bóc tách.
- (Tùy chọn) Icon app + ký số (bỏ cảnh báo SmartScreen) + auto-update + chốt chiến lược weights (T0.11).

MVP (P1/P2) + P3 (searchable/nén) + P4 (overlay editor) + P6 (sửa chữ gốc) + Security (token/sandbox)
+ **P5 (đóng gói portable/installer)** + **Settings API key trong app** đã xong ở mức code & build.
Phần còn lại chủ yếu là **kiểm thử thực tế** (đặc biệt trên máy sạch).
