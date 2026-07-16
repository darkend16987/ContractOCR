# Handoff — Nabu PDF

> Bàn giao trạng thái để tiếp tục ở session/máy khác. Đọc kèm:
> [DESIGN.md](DESIGN.md) (kiến trúc), [ROADMAP.md](ROADMAP.md) (tiến độ chi tiết),
> [SETUP.md](SETUP.md) (dựng môi trường).

_Cập nhật: 2026-07-17 · v0.2.34_

> v0.2.34 — **Sửa chữ từ vòng 2 trở đi không còn ra ô vuông (□)** (chỉ sidecar `api.py` — phải rebuild binary; renderer KHÔNG đổi):
> - **Triệu chứng**: sửa 1 dòng tiếng Việt (giữ font) → Áp dụng → sửa tiếp **bất cứ dòng nào** (kể cả dòng chưa từng đụng tới) → **toàn bộ** ký tự thành □. Để dòng đó cho vòng 1 thì lại đúng ⇒ lỗi do **trạng thái file sau khi Áp dụng**, không phải do dòng/font.
> - **Gốc — chuỗi 3 mắt xích, không mắt nào raise** ([`api.py`](api.py) `_fresh_fontname`): (1) `page.insert_font(fontname=X, fontfile=F)` khớp theo **tên resource** — trang đã có `/X` thì PyMuPDF trả font cũ và **bỏ qua `F`**, im lặng (đọc source PyMuPDF xác nhận). (2) `/edit-text` kết thúc bằng `subset_fonts()`, nên **chính vòng tạo ra** `/vnedit`,`/loc0` cũng đã cắt font đó xuống còn glyph của riêng vòng đó. (3) Font là **Identity-H** (đánh địa chỉ bằng glyph id) → subset **vứt luôn bảng cmap unicode**: font đã subset trả `has_glyph()==0` cho **cả ký tự chính nó đang chứa**. Vòng sau xin lại đúng tên → nhận subset cũ → **mọi** tra cứu unicode→glyph = glyph 0 = notdef = □. Mắt xích (3) giải thích vì sao **mọi** ký tự vỡ chứ không chỉ ký tự mới, và vì sao **dòng chưa đụng tới** cũng vỡ.
> - **KHÔNG phải regression của v0.2.32**: chạy **cùng một kịch bản** trên `api.py` trước/sau v0.2.32 → vỡ **y hệt nhau, cùng một vòng**. `subset_fonts()` + cách đặt tên `vnedit`/`loc%d` có từ **v0.1.5 / v0.2.23**. v0.2.32 chỉ **làm lộ** ra: trước đó `_vietnamese_font()` không tìm thấy DejaVu trong app đóng gói nên **vòng 1 đã ra □** rồi → không ai đi tiếp tới vòng 2 để thấy bug cũ.
> - **Fix**: `_fresh_fontname(page, base)` — luôn nhúng dưới tên trang **chưa dùng** (`vnedit`→`vnedit1`→…). Áp cho `/edit-text` (`vnedit`/`loc`) **và** `/translate-pdf` (`trvn`/`trloc`, cùng lỗi: dịch lại file đã dịch tới lần 3 → 27 notdef). Bỏ `local_seq` (reset về 0 mỗi request — chính nó làm vòng 2 xin lại `/loc0`). **Tái dùng font cũ là bất khả** (cmap đã mất) ⇒ tên mới là cách duy nhất đúng.
> - **Verify file thật** (`QD-997-mau-hop-dong.pdf`, giữ font, 4 vòng, trang 3): trước = vòng 2/3/4 ra **44/88/132** notdef; sau = **0** cả 4 vòng, kể cả vòng in đậm (giữ đúng `Times New Roman,Bold`). Vỡ ngay **vòng 2** (fixture tổng hợp thì vòng 3) vì `Times New Roman` **resolve được ở mọi vòng** → luôn xin lại `/loc0` ⇒ với tài liệu Word/hợp đồng bình thường thủ phạm thực tế là nhánh **`/loc0`**, `/vnedit` chỉ là đường vòng. `/translate-pdf`: lần dịch 3 từ 27 notdef → **0**.
> - **Test**: thêm [`test_edit_text_rounds.py`](test_edit_text_rounds.py) (4 test: vòng 2 sạch, nhiều vòng sạch, bất biến "không tái dùng tên resource", unit `_fresh_fontname`) + `test_retranslating_an_output_does_not_draw_boxes` trong [`test_translate_layout.py`](test_translate_layout.py). **Kiểm ngược từng cái**: mọi test hành vi đều **FAIL trên code chưa vá**.
> - **Đánh đổi đã biết**: mỗi lần Áp dụng thêm 1 font subset mới → file phình **~34 KB/vòng** trên file thật (470 KB → 306 KB sau vòng 1 do subset ép nhỏ → **409 KB sau 4 vòng**, vẫn nhẹ hơn bản gốc). Không xoá được font cũ vì **chữ của vòng trước còn tham chiếu** nó. Muốn triệt để phải chuyển `subset_fonts()` từ "mỗi lần Áp dụng" sang **chỉ khi xuất file** — đụng vòng đời `state.bytes` của editor, **chưa làm**.

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
