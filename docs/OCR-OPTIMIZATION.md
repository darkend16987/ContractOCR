# OCR Optimization — Research & Roadmap

_Nghiên cứu tối ưu chức năng OCR: thời gian, độ chính xác, crash. Bao gồm cả đề xuất đổi phương pháp._
_Soạn: 2026-06-26 (sau v0.2.4). Dữ liệu đo trên CPU 12 nhân, torch 2.12.1+**cpu**, paddleocr 3.7.0 / paddlepaddle 3.3.1._

---

## 1. Trạng thái hiện tại & gốc rễ

| Vấn đề | Nguyên nhân |
|--------|-------------|
| OCR chậm (40–76s/trang) | Nâng paddleocr **2.x → 3.x**: mặc định model PP-OCRv5 **server** (nặng); `enable_mkldnn` crash `ConvertPirAttribute2RuntimeAttribute` (paddlepaddle 3.3 PIR+oneDNN) → buộc tắt → CPU không có oneDNN → chậm 5–10x |
| Hybrid càng chậm | VietOCR transformer chạy **mỗi dòng** trên CPU (~76s/trang) |
| Crash đóng gói (đã fix v0.2.3) | PyInstaller không bundle `.dist-info` → paddlex `DependencyError` |
| torch CPU-only | `2.12.1+cpu` — không dùng được GPU kể cả máy có card |

**Bản 0.0.x/0.1.x nhanh + chuẩn** vì PaddleOCR **2.x** = PP-OCRv4 mobile + mkldnn chạy được.

### Số đo (1 trang ~20–30 dòng, CPU, warm)
| Cấu hình | Thời gian |
|----------|-----------|
| hybrid (cũ, mặc định trước v0.2.4) | **76s** |
| paddleocr server-det (mặc định 3.x) | 42s |
| paddleocr **mobile-det** (v0.2.4) | **18–21s** |
| paddleocr mobile det+rec | 14s (nhưng hỏng dấu: Công→Cong) |
| mkldnn=True (mọi biến thể) | ❌ crash |
| threads / det_limit_side_len | không đổi (nút thắt là recognition từng dòng) |

→ v0.2.4 đã giảm ~3-4x nhưng **vẫn chậm hơn bản 2.x cũ**. Trần tốc độ của paddle-CPU-không-mkldnn đã chạm.

---

## 2. Ba trục tối ưu

### 2.1 Thời gian (CPU là môi trường thực tế của user)

**Quick wins (giữ paddle 3.x, rủi ro thấp):**
- ✅ Mobile detector (đã làm v0.2.4).
- **Downscale ảnh đầu vào**: frontend `rasterize(scale=2)` → ảnh lớn. Trang scan 300dpi không cần. Chuẩn hoá về cạnh dài ~1600px trước khi gửi (det vốn tự co, nhưng recognition crop theo ảnh gốc). Ước giảm 20-40%.
- **Bỏ qua trang trắng / vùng không có text** sớm (detect rỗng → skip).
- **Song song theo trang**: PDF nhiều trang chạy tuần tự. Pool 2-3 process (mỗi process 1 engine) → gần tuyến tính theo số nhân. Cẩn thận RAM (~1GB/engine).

**Đổi backend inference (rủi ro trung bình, lợi ích lớn — xem §3):**
- **ONNX Runtime** thay paddle inference → có MLAS/oneDNN ổn định trên CPU, **không dính bug mkldnn**. Đây là đòn bẩy lớn nhất.

**Phục hồi mkldnn (rủi ro cao):** thử paddlepaddle 3.0/3.1 xem hết crash; rủi ro tái phát WinError 127 DLL trên Windows. Không khuyến nghị.

### 2.2 Độ chính xác (tiếng Việt)

- **Recognizer**: PP-OCRv5 `lang=vi` (đang dùng) > mobile rec (hỏng dấu). VietOCR vẫn nhỉnh hơn cho chữ in đẹp nhưng quá chậm/dòng.
- **Tiền xử lý ảnh** (lợi ích cao, rẻ): deskew (xoay thẳng), binarize/adaptive threshold, khử nhiễu, chuẩn hoá DPI. Scan lệch/mờ là nguyên nhân sai dấu chính.
- **Orientation**: với scan xoay 90/180°, cần bật lại detection orientation (đang tắt để nhanh) — làm theo heuristic/tuỳ chọn, không bật mặc định.
- **Hậu xử lý bằng LLM**: bước "Bóc tách" đã gọi Gemini — có thể nhờ Gemini sửa lỗi OCR tiếng Việt (đã làm gián tiếp). Với flow OCR thuần, thêm tuỳ chọn "làm sạch bằng AI".

### 2.3 Crash / ổn định

- ✅ `/extract` đã bọc try/except (v0.2.3) → trả JSON thay vì 500.
- ✅ Bundle metadata (v0.2.3).
- Còn lại: **timeout** mỗi trang (tránh treo vô hạn), **giới hạn RAM/kích thước ảnh**, cô lập lỗi từng trang (OCR endpoint đã có), giám sát sidecar (đã có taskkill-tree).
- Gốc crash mkldnn biến mất hoàn toàn nếu bỏ paddlepaddle (xem §3).

---

## 3. Đổi phương pháp (khuyến nghị chiến lược)

Vấn đề cốt lõi: **paddlepaddle trên CPU Windows = chậm (không mkldnn) + giòn (DLL/PIR/metadata)**. Hai hướng thoát:

### 🟢 A. RapidOCR (ONNX Runtime) — thay paddlepaddle, GIỮ model PP-OCR
- Chính là PP-OCRv4/v5 det+rec chạy qua **onnxruntime** thay vì paddle.
- **Lợi**: nhanh hơn nhiều trên CPU (MLAS), **không còn bug mkldnn/PIR/DLL**, gói nhẹ hơn (bỏ paddlepaddle ~hàng trăm MB), trả về **box + text + score** → dùng được cho **Searchable PDF**. Độ chính xác = PP-OCR (tương đương hiện tại).
- **Chi phí**: thêm `rapidocr-onnxruntime` + `onnxruntime`; viết engine adapter mới (API khác); cập nhật `sidecar.spec` (bỏ paddle, thêm onnx). Đổi engine có rủi ro nhưng khu trú trong `src/ocr/`.
- **Đây là ứng viên số 1** cho cả 3 mục tiêu (thời gian + crash + giữ chính xác + giữ searchable).

### 🟢 B. Vision-LLM trực tiếp cho "Bóc tách" — bỏ OCR ở luồng này
- App **đã** gửi text OCR cho Gemini để bóc tách. Gemini-3 là **đa phương thức** → gửi thẳng ảnh trang, OCR + bóc tách trong **1 lần gọi**.
- **Lợi**: chính xác tiếng Việt cao nhất (không lỗi OCR lan truyền), nhanh, không cần model cục bộ cho luồng này. Quyền riêng tư tương đương (vốn đã gửi nội dung cho Gemini).
- **Hạn**: cần mạng + API key + chi phí token ảnh; **Searchable PDF vẫn cần OCR cục bộ** (cần toạ độ box) → không thay được hoàn toàn.
- **Kiến trúc đề xuất**: Bóc tách → vision-LLM; OCR thuần + Searchable → engine cục bộ (RapidOCR).

### 🟡 C. Tesseract (vie) — phương án nhẹ/offline
- `tesseract-ocr` + `vie.traineddata`, gọi qua `pytesseract`. CPU nhanh, offline, ổn định, có box (cho searchable).
- Độ chính xác tiếng Việt thường **thua** PP-OCR/VietOCR trên scan khó; tốt cho text in rõ. Dùng làm **fallback offline nhẹ**, không phải mặc định.

### So sánh nhanh
| Phương án | Tốc độ CPU | Chính xác VN | Hết crash paddle | Searchable (box) | Công sức |
|-----------|-----------|--------------|------------------|------------------|----------|
| Paddle 3.x mobile (v0.2.4) | trung bình | tốt | một phần | ✅ | đã xong |
| **RapidOCR (ONNX)** | **cao** | tốt | ✅ | ✅ | trung bình |
| **Vision-LLM (bóc tách)** | cao | **rất cao** | ✅ (luồng đó) | ❌ | thấp-TB |
| Tesseract | cao | khá | ✅ | ✅ | trung bình |

---

## 4. Lộ trình đề xuất

1. **v0.2.4 (đã ship)**: mobile det + paddle-only. Giảm ~3-4x. Quick win an toàn.
2. **Tiếp theo — thấp rủi ro**: tiền xử lý ảnh (deskew/binarize) + downscale đầu vào + timeout/trang. Tăng cả tốc độ lẫn chính xác mà không đổi engine.
3. **Spike RapidOCR**: prototype `RapidOCREngine` (cùng interface `BaseOCREngine`, có `recognize_boxes`), benchmark đối chứng paddle trên bộ ảnh thật. Nếu nhanh hơn rõ + chính xác tương đương → đặt làm mặc định, giữ paddle làm fallback.
4. **Vision-LLM cho Bóc tách**: thêm chế độ gửi ảnh trực tiếp cho Gemini đa phương thức; để người dùng chọn (chính xác cao, cần mạng/API).
5. **Dọn dẹp**: nếu RapidOCR thắng, cân nhắc bỏ paddlepaddle khỏi bundle → app nhẹ hơn nhiều, hết hẳn lớp crash.

> Việc cần dữ liệu thật: tất cả số đo trên dùng ảnh tổng hợp. Cần một bộ **scan hợp đồng thật** (mờ, lệch, nhiều font) để benchmark chính xác trước khi đổi engine mặc định.
