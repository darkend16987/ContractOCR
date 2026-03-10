# ContractOCR

Pipeline OCR + AI để trích xuất thông tin từ hợp đồng tiếng Việt.

## Tổng quan

```
Image/PDF → OCR (VietOCR/PaddleOCR) → AI Agent (Gemini) → Structured Output (JSON/Excel/GSheet/Markdown)
```

**Pipeline:**
1. **Input**: Upload ảnh scan hoặc PDF hợp đồng
2. **OCR**: Trích xuất text tiếng Việt bằng PaddleOCR hoặc VietOCR
3. **AI Agent**: Gemini phân tích text → trích xuất các trường vào schema cố định
4. **Output**: Lưu JSON, Excel, Google Sheet, hoặc Markdown

## Cài đặt

### Yêu cầu
- Python 3.10+
- Poppler (cho xử lý PDF): `sudo apt-get install poppler-utils`

### Setup

```bash
# Clone repo
git clone <repo-url>
cd ContractOCR

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
python cli.py scan.png --engine paddleocr --api-key YOUR_KEY --verbose
```

**Options:**
| Flag | Mô tả | Default |
|------|--------|---------|
| `--engine` | OCR engine: `auto`, `paddleocr`, `vietocr` | `auto` |
| `--api-key` | Gemini API key | từ `.env` |
| `--model` | Gemini model | `gemini-2.0-flash` |
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
ContractOCR/
├── app.py                    # Streamlit Web UI
├── cli.py                    # CLI entry point
├── src/
│   ├── pipeline.py           # Pipeline orchestrator
│   ├── ocr/
│   │   └── engine.py         # OCR engines (VietOCR, PaddleOCR, Auto)
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

### PaddleOCR (khuyến nghị cho production)
- Full document OCR: detection + recognition
- Hỗ trợ tiếng Việt (`lang="vi"`)
- Xử lý layout, bảng biểu
- GPU acceleration

### VietOCR
- Transformer-based, tối ưu cho tiếng Việt
- Độ chính xác rất cao trên text typed rõ ràng
- Hoạt động trên từng dòng text

### Auto mode
Tự động chọn PaddleOCR (full document). Fallback sang VietOCR nếu PaddleOCR không khả dụng.

## Deploy

### Docker

```bash
docker build -t contract-ocr .
docker run -p 8501:8501 -e GEMINI_API_KEY=your_key contract-ocr
```

### Cloud (Google Cloud Run / AWS)

```bash
# Google Cloud Run
gcloud run deploy contract-ocr \
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

MIT
