# Handoff — Nabu PDF

> Bàn giao trạng thái để tiếp tục ở session/máy khác. Đọc kèm:
> [DESIGN.md](DESIGN.md) (kiến trúc), [ROADMAP.md](ROADMAP.md) (tiến độ chi tiết),
> [SETUP.md](SETUP.md) (dựng môi trường).

_Cập nhật: 2026-06-24 · v0.2.2_

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
| P5 — Đóng gói portable .exe | ✅ Build xong: `sidecar.exe` (PyInstaller) + `NabuPDF-0.0.1-portable.exe` / `-x64.exe` (NSIS) ở `desktop/dist-app/`. Còn: auto-update + chốt bundle weights + test máy sạch. |

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
4. ~~**P5 — Đóng gói**~~ ✅ **XONG**: `sidecar.exe` (PyInstaller) + `NabuPDF-0.0.1-portable.exe`
   / `-x64.exe` (NSIS) ở `desktop/dist-app/`. Đã smoke-test bản đóng gói: app mở, sidecar boot,
   `/health` 200, token gate 401, `/config` (nhập API key) 200. Xem [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md).

### Còn lại cho phiên sau
- **▶️ Test máy Windows sạch** (chưa cài Python): copy `NabuPDF-0.0.1-portable.exe` sang →
  xác minh self-contained; lần OCR đầu cần mạng tải weights PaddleOCR/VietOCR (~vài trăm MB vào
  cache user). Đây là phép thử quan trọng nhất chưa làm được (cần máy thứ 2).
- **▶️ Các test GUI** P3/P4/P6 ở trên (1–3b) — làm trên bản dev hoặc bản đóng gói.
- **▶️ Bóc tách (P2) trên bản đóng gói**: bấm ⚙ → dán `GEMINI_API_KEY` → Lưu → thử bóc tách.
- (Tùy chọn) Icon app + ký số (bỏ cảnh báo SmartScreen) + auto-update + chốt chiến lược weights (T0.11).

MVP (P1/P2) + P3 (searchable/nén) + P4 (overlay editor) + P6 (sửa chữ gốc) + Security (token/sandbox)
+ **P5 (đóng gói portable/installer)** + **Settings API key trong app** đã xong ở mức code & build.
Phần còn lại chủ yếu là **kiểm thử thực tế** (đặc biệt trên máy sạch).
