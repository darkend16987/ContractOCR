# Nabu PDF

Bộ công cụ **PDF desktop** (Electron) cho tiếng Việt: xem · ghép · tách · chèn ·
thêm trang trắng · xoay · chú thích · hộp văn bản (font/đậm/nghiêng/gạch chân) ·
watermark · redact (che thông tin chọn màu) · sửa chữ · nén · so sánh 2 file
(văn bản & **bản vẽ CAD/Revit** — khoanh mây revision vùng thay đổi) ·
tạo PDF tìm-kiếm-được, kèm **OCR + bóc tách hợp đồng** bằng AI. Chạy hoàn toàn trên máy
(local-first).

> **Ứng dụng desktop** nằm trong [`desktop/`](desktop/) — xem
> [desktop/README.md](desktop/README.md) để build bản `.exe` / portable.
> Phần dưới mô tả **pipeline OCR + AI** (engine Python dùng chung, cũng chạy được
> độc lập qua Web UI Streamlit / CLI).

## Tổng quan

```
Image/PDF → OCR (RapidViet: RapidOCR detect + VietOCR) → AI Agent (Gemini) → Structured Output (JSON/Excel/GSheet/Markdown)
```

**Pipeline:**
1. **Input**: Upload ảnh scan hoặc PDF hợp đồng
2. **OCR**: Trích xuất text tiếng Việt bằng RapidViet (RapidOCR detect + VietOCR — nhanh & đúng dấu; Hybrid/RapidOCR/PaddleOCR là tuỳ chọn)
3. **AI Agent**: Gemini phân tích text → trích xuất các trường vào schema cố định
4. **Output**: Lưu JSON, Excel, Google Sheet, hoặc Markdown

## Cài đặt

### Yêu cầu
- Python 3.10+
- Poppler (cho xử lý PDF): `sudo apt-get install poppler-utils`

### Setup

```bash
# Clone repo
git clone https://github.com/darkend16987/NabuPDF.git
cd NabuPDF

# Tạo virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate   # Windows

# Cài đặt dependencies
pip install -r requirements.txt

# Cấu hình
cp .env.example .env
# Sửa .env: thêm GEMINI_API_KEY
```

## Sử dụng

### Web UI (Streamlit)

```bash
streamlit run app.py
```

Mở browser tại `http://localhost:8501`:
1. Nhập Gemini API Key ở sidebar
2. Upload ảnh/PDF hợp đồng
3. Chọn loại hợp đồng (template)
4. Bấm **Xử lý**
5. Xem kết quả và tải file output

### CLI

```bash
# Xử lý 1 file
python cli.py contract_scan.jpg

# Xử lý nhiều file, chọn template và output format
python cli.py file1.jpg file2.pdf --template mua_ban --output-format all

# Chỉ định engine và API key
python cli.py scan.png --engine rapidocr --api-key YOUR_KEY --verbose
```

**Options:**
| Flag | Mô tả | Default |
|------|--------|---------|
| `--engine` | OCR engine: `auto`, `rapidviet`, `hybrid`, `rapidocr`, `paddleocr`, `vietocr` | `auto` |
| `--api-key` | Gemini API key | từ `.env` |
| `--model` | Gemini model | `gemini-3-flash-preview` |
| `--template` | Template trường: `generic`, `mua_ban`, `lao_dong`, `dich_vu` | `generic` |
| `--output-format` | Output: `json`, `excel`, `markdown`, `all` | `json` |
| `--output-dir` | Thư mục output | `results/` |
| `-v` | Log chi tiết | off |

## Templates trường trích xuất

| Template | Mô tả | Số trường |
|----------|--------|-----------|
| `generic` | Chung cho mọi loại hợp đồng | 12 |
| `mua_ban` | Hợp đồng mua bán | 19 |
| `lao_dong` | Hợp đồng lao động | 18 |
| `dich_vu` | Hợp đồng dịch vụ | 16 |

Có thể tùy chỉnh trường qua Web UI hoặc truyền JSON custom.

## Kiến trúc

```
Nabu-PDF/
├── app.py                    # Streamlit Web UI
├── desktop/                  # Electron desktop app (Nabu PDF)
├── cli.py                    # CLI entry point
├── src/
│   ├── pipeline.py           # Pipeline orchestrator
│   ├── ocr/
│   │   └── engine.py         # OCR engines (RapidOCR, PaddleOCR, VietOCR, Auto)
│   ├── agents/
│   │   ├── gemini_agent.py   # Gemini AI extraction agent
│   │   └── field_templates.py # Predefined field templates
│   ├── output/
│   │   └── writer.py         # Output writers (JSON, Excel, GSheet, MD)
│   └── utils/
│       ├── config.py         # Configuration from .env
│       └── image_processing.py # Image preprocessing
├── templates/                # Contract template schemas
├── uploads/                  # Uploaded files (gitignored)
├── results/                  # Output files (gitignored)
├── requirements.txt
├── .env.example
└── Dockerfile
```

## OCR Engines

### RapidViet (mặc định) ⭐
- **Detection bằng RapidOCR (ONNX)** + **recognition bằng VietOCR** — nhanh *và* đúng dấu
- Detector ONNX tìm dòng ~1s (không cần paddlepaddle, hết crash mkldnn); VietOCR là
  engine cục bộ duy nhất đọc đúng dấu chồng tiếng Việt (ộ/ử/ấ/ề/ị), chạy crop theo batch
- ~3-4s/trang (ấm) trên CPU; trả về toạ độ cho searchable PDF

> ⚠️ Recognizer PP-OCR đa ngữ/latin (RapidOCR EN/LATIN, PaddleOCR 3.x) **làm hỏng dấu
> tiếng Việt** — dict của model **thiếu** ký tự dấu chồng (ạ/ấ/ộ/ợ/ử...). Vì vậy phần
> recognition luôn dùng VietOCR.

> ℹ️ **Bản desktop (.exe) chỉ đóng gói RapidViet** để installer nhẹ (~400MB tiết kiệm).
> Các engine `hybrid`/`paddleocr` cần cài thêm paddle: `pip install paddleocr paddlepaddle`.

### Hybrid (tuỳ chọn — cần cài paddle)
- Như RapidViet nhưng detection bằng **PaddleOCR** (load chậm hơn, kéo theo paddlepaddle)

### RapidOCR (tuỳ chọn — nhanh, yếu dấu)
- PP-OCR thuần trên ONNX — nhanh nhất nhưng **không đọc đúng dấu tiếng Việt** (chỉ latin)

### PaddleOCR / VietOCR (fallback)
- PaddleOCR: full pipeline, recognizer đa ngữ yếu dấu VN; VietOCR: transformer/dòng, đúng dấu

### Auto mode
Ưu tiên RapidViet → Hybrid → RapidOCR → PaddleOCR → VietOCR. Đổi bằng env `OCR_ENGINE`.

## Deploy

### Docker

```bash
docker build -t nabu-pdf .
docker run -p 8501:8501 -e GEMINI_API_KEY=your_key nabu-pdf
```

### Cloud (Google Cloud Run / AWS)

```bash
# Google Cloud Run
gcloud run deploy nabu-pdf \
  --source . \
  --port 8501 \
  --set-env-vars GEMINI_API_KEY=your_key

# Hoặc dùng Dockerfile trên bất kỳ cloud platform nào
```

## Google Sheets Integration

1. Tạo Service Account trên Google Cloud Console
2. Tải file credentials JSON → đặt tên `credentials.json` vào root
3. Share Google Sheet với email của Service Account
4. Cấu hình trong `.env`:
   ```
   GOOGLE_SHEETS_CREDENTIALS_FILE=credentials.json
   GOOGLE_SHEETS_SPREADSHEET_ID=your_sheet_id
   OUTPUT_FORMAT=gsheet
   ```

## License

**GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](LICENSE).

© 2026 Tạ Hoàng Nam. Phần mềm **miễn phí & mã nguồn mở**, không có khóa serial /
kiểm soát máy. Bạn được tự do dùng, sửa, phân phối lại theo điều khoản AGPL-3.0;
mọi bản phân phối (kể cả dạng dịch vụ mạng) phải kèm/đề nghị mã nguồn tương ứng
theo cùng giấy phép.

### Vì sao AGPL-3.0?

Ứng dụng nhúng **PyMuPDF** (render, redaction, sửa chữ gốc, OCR text layer…),
vốn cấp phép **AGPL-3.0** (hoặc giấy phép thương mại từ Artifex). Để phân phối
hợp lệ mà không mua giấy phép thương mại, toàn bộ tác phẩm kết hợp được phát
hành dưới giấy phép AGPL-3.0 với mã nguồn mở.

### Thư viện bên thứ ba

| Thành phần | Giấy phép |
|------------|-----------|
| PyMuPDF (fitz) | AGPL-3.0 / Artifex commercial |
| PaddleOCR · VietOCR · pdf.js | Apache-2.0 |
| pdf-lib · Electron | MIT |
| PyTorch | BSD-3-Clause |
| matplotlib | Matplotlib (BSD-style) |

Các giấy phép permissive ở trên tương thích khi kết hợp vào tác phẩm AGPL-3.0.
