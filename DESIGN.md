# Nabu PDF — Thiết kế hệ thống

> Tài liệu thiết kế cho Nabu PDF — mở rộng từ engine OCR + bóc tách hợp đồng thành
> một phần mềm PDF native chạy local. Cập nhật khi quyết định kiến trúc thay đổi.

## 1. Bối cảnh & xuất phát điểm

Đã có sẵn (phần khó nhất — **không làm lại**):

- **OCR tiếng Việt**: RapidViet (RapidOCR ONNX detect + VietOCR — nhanh & đúng dấu) mặc định; Hybrid/RapidOCR/PaddleOCR là tuỳ chọn — `src/ocr/engine.py`
- **Bóc tách field bằng AI**: Gemini agent + template field tùy chỉnh — `src/agents/`
- **Pipeline export**: JSON / Excel / CSV / Markdown / Google Sheet — `src/output/`
- **2 vỏ ngoài**: FastAPI (`api.py`), Streamlit (`app.py`), CLI (`cli.py`), và web Next.js (`web/`)

Mục tiêu mở rộng: đọc / merge-split-insert / edit / nén / xuất PDF + OCR bóc tách (đã có).

## 2. Các quyết định kiến trúc đã chốt

| # | Quyết định | Lý do |
|---|-----------|-------|
| D1 | **Sản phẩm = desktop native (Electron), portable .exe** | OCR local chính xác hơn, file không rời máy, gọi binary nén/edit native thuận. Cầm USB cài nhanh. |
| D2 | **Local-first / self-host** | Hợp đồng nhạy cảm; OCR chạy local. Cloud AI (Gemini) là tùy chọn bật/tắt. |
| D3 | **OCR mặc định = RapidViet (RapidOCR ONNX detect + VietOCR rec)** (v0.2.7) | Vừa nhanh (~3-4s/trang, detect ONNX không cần paddle) vừa đúng dấu (VietOCR là engine cục bộ duy nhất đọc đúng dấu chồng; dict PP-OCR latin/đa ngữ THIẾU ký tự VN). Thay cho RapidOCR thuần (v0.2.5 sai dấu) và Hybrid-paddle (v0.2.6 chậm). Hybrid/RapidOCR/Paddle giữ tuỳ chọn (`OCR_ENGINE`). |
| D4 | **"Edit PDF" giai đoạn 1 = overlay editing** | Annotate/watermark/form/redact khả thi & đủ 90% nhu cầu. KHÔNG làm WYSIWYG sửa text gốc (rất khó, để giai đoạn sau). |
| D5 | **Thao tác PDF nhẹ chạy ở renderer (pdf-lib/pdf.js); chỉ gọi Python khi cần OCR/nén/AI** | App phản hồi tức thì, Python chỉ là "động cơ nặng" khi thật sự cần. |
| D6 | **Sidecar Python chạy & đóng gói bằng Python 3.12** (không phải 3.13) | vietocr ghim các dep cũ (gdown, Pillow~10.2) chỉ có wheel tới cp312; trên 3.13 phải build nguồn → fail. PyInstaller cũng phải build bằng 3.12. Venv dev: `.venv/` (py -3.12). |

## 3. Kiến trúc

```
┌─────────────────────────────────────────────────────────┐
│  ELECTRON  (electron-builder → portable .exe + installer) │
│  ┌───────────────────────────────────────────────────┐  │
│  │  RENDERER  (P0: HTML tối giản → P1+: React/Next)   │  │
│  │  • pdf.js   → xem, thumbnail, nav, zoom            │  │
│  │  • pdf-lib  → merge/split/insert/rotate/reorder    │  │
│  │              annotate, watermark, form, redact     │  │
│  │              (CHẠY TRONG APP — không cần Python)   │  │
│  └───────────────────────────────────────────────────┘  │
│            │ HTTP 127.0.0.1:<port động> (chỉ khi cần)    │
│  ┌─────────▼─────────────────────────────────────────┐  │
│  │  PYTHON SIDECAR  (FastAPI = api.py, đóng PyInstaller)│ │
│  │  • OCR RapidViet (RapidOCR det+VietOCR — ĐÃ CÓ) │  │
│  │  • Bóc tách custom fields (gemini_agent — ĐÃ CÓ)   │  │
│  │  • Nén  → Ghostscript / qpdf (binary bundle)       │  │
│  │  • Searchable PDF → OCRmyPDF                       │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

Vòng đời (từ P1, **lazy**): Electron `main` load renderer (UI PDF) **ngay lập tức**, song song
spawn sidecar ở nền → chọn **port trống động** → poll `GET /health` → khi OK đẩy trạng thái
`ready` + port về renderer qua IPC `sidecar:status`. UI PDF không chờ sidecar; chỉ feature OCR
mới phụ thuộc badge `ready`. Đóng app → kill sidecar.
(Trước P1 thì main chặn UI tới khi /health OK — đã bỏ vì vi phạm D5.)

## 4. Feature theo nơi xử lý

**Renderer (pdf-lib / pdf.js) — không cần server:**
- Xem PDF, thumbnail, điều hướng, zoom
- Merge · Split (trang/range) · Insert/chèn trang · Reorder kéo-thả · Rotate · Xóa trang
- Overlay edit: text box, highlight, vẽ tay, chèn ảnh, watermark, điền form, chữ ký ảnh, **redact**
- Xuất PDF đã sửa · xuất trang ra ảnh

**Python sidecar:**
- **Nén PDF** (Ghostscript presets: screen/ebook/printer, chỉnh DPI)
- **OCR + bóc tách custom fields** (đã có)
- **OCR → searchable PDF** (OCRmyPDF — feature mới)
- Xuất kết quả bóc tách → Excel/CSV/JSON (đã có)

## 5. Bẫy đã biết / không làm

- **WYSIWYG sửa text gốc + reflow**: PDF lưu glyph theo tọa độ tuyệt đối, không phải dòng text.
  Cực khó, ngay cả Acrobat/Stirling để mức alpha. Với PDF scan thì bất khả thi nếu không OCR lại.
  → KHÔNG nằm trong phạm vi gần. Chỉ làm overlay.
- **Footprint ML**: torch nặng GB, có native lib + tải weights runtime → khâu đóng gói khó nhất.
  Giảm rủi ro bằng cách giải quyết ở **Phase 0** trước mọi feature.
  _(v0.2.8: paddle đã bỏ khỏi bundle — chỉ đóng gói RapidViet = torch + onnxruntime + vietocr.)_

## 6. Khâu đóng gói — điểm rủi ro cao nhất

| Thành phần | Độ khó đóng gói | Cách xử lý |
|-----------|----------------|-----------|
| Vỏ Electron + UI | 🟢 Dễ | `electron-builder` → portable + nsis |
| FastAPI sidecar | 🟡 TB | PyInstaller onedir (`sidecar.spec`) |
| Ghostscript / qpdf | 🟢 Dễ | Bundle binary, gọi subprocess |
| **torch + onnxruntime** | 🔴 Khó | `collect_all` trong spec; iterate theo ModuleNotFoundError (paddle đã loại) |
| Model weights | 🟡 TB | P0: tải lần đầu (cần net). P5: bundle cache để offline tuyệt đối. |

Xem chi tiết thực thi ở [ROADMAP.md](ROADMAP.md).
