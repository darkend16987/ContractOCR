# Spec — Dịch PDF (text-based) bằng Gemini

> Chuẩn bị cho một session sau. Trạng thái: **chưa build**. Mục tiêu bản đầu (Phase 1):
> dịch PDF có text thật (không phải scan) và **giữ nguyên layout/format** — xuất ra file mới,
> có xem trước + Hoàn tác (WYSIWYG). Phase 2: ghi đè tại chỗ (in-place) + glossary.
>
> Đọc kèm: [DESIGN.md](../DESIGN.md), [HANDOFF.md](../HANDOFF.md), [api.py](../api.py).

## 1. Vì sao khả thi cao (tận dụng cái đã có)

| Cần gì | Đã có sẵn | File · dòng |
| --- | --- | --- |
| Đọc span text + bbox/font/size/color/origin/flags | `POST /text-spans` → `TextSpansResponse` | [api.py](../api.py) `text_spans` (~1530) |
| Xoá glyph cũ + vẽ text mới **đúng chỗ, đúng font** (redact + `insert_text` trên baseline gốc; nhúng DejaVu VN-safe + font hệ thống theo tên family) | `POST /edit-text` → `EditTextResponse` (`TextEdit` list) | [api.py](../api.py) `edit_text` (~1625) |
| Gọi Gemini, ép trả JSON | `GeminiAgent._generate(prompt, system_instruction)` (`response_mime_type=application/json`) | [src/agents/gemini_agent.py](../src/agents/gemini_agent.py) (~85) |
| Key + model | `get_gemini_key()`, `GEMINI_MODEL` (mặc định `gemini-3-flash-preview`) | [src/utils/config.py](../src/utils/config.py) |
| Fetch sidecar có token + overlay/undo/preview UI | renderer đã có (`sidecarFetch`, `pushUndo`, pattern của **Đánh số trang**) | [desktop/renderer/app.js](../desktop/renderer/app.js) |

**Ý tưởng lõi**: translate = chèn Gemini vào giữa `text-spans` → `edit-text`. KHÔNG viết engine render mới.

## 2. Vấn đề khó nhất: text co giãn (fit)

Bản dịch dài/ngắn khác gốc (VI↔EN lệch ±30%). Box PDF cố định → tràn hoặc hụt.

- **Dịch theo BLOCK/paragraph**, không dịch theo từng span rời (span-by-span = vụn, MT dở).
  Gom span theo `block` (PyMuPDF `get_text("dict")` đã có block/line/span) → dịch cả đoạn →
  phân bổ lại xuống các span/line trong block.
- **Auto-fit font**: sau khi có bản dịch cho block, ép cỡ chữ nhỏ dần đến khi vừa `block bbox`
  (dùng `fitz.get_text_length(txt, fontname, fontsize)` để đo). Cho phép wrap qua nhiều dòng
  bằng `insert_textbox(block_rect, ...)` thay vì `insert_text` từng baseline khi block nhiều dòng.
- Chấp nhận định vị: "dịch giữ layout" ≈ Acrobat/Foxit, KHÔNG phải DTP hoàn hảo. Đặt kỳ vọng đúng.

## 3. Rủi ro khác + cách xử

- **Cột/bảng/reflow**: gom theo block giữ được cấu trúc; KHÔNG cố reflow toàn trang.
- **Glyph coverage**: font đích phải có glyph ngôn ngữ đích. VI↔EN ổn với DejaVu bundled.
  Nếu dịch sang ngôn ngữ font gốc thiếu → fallback DejaVu (đã có `needs_unicode` logic trong `edit_text`).
- **Không-dịch**: số, ngày, mã, email, tên riêng, đơn vị. Prompt phải yêu cầu giữ nguyên;
  cân nhắc regex mask trước khi gửi + khôi phục sau.
- **Cost/latency**: batch cả trang (hoặc cả doc) trong 1 lần gọi Gemini, JSON in/out. Có tiến trình.
- **Scan PDF (no text layer)**: `text-spans.has_text=false` → route qua OCR (overlay), KHÔNG in-place.
  Phase 1 chỉ làm PDF có text thật; báo rõ nếu là scan.
- **Trang xoay**: `text-spans` trả `rotation`; `edit-text` đã xử baseline. Kiểm thử trang 90/180/270.

## 4. Thiết kế API (sidecar)

Đề xuất **endpoint mới** gộp logic để renderer gọi 1 phát (tránh chuyển span qua lại):

```
POST /translate-pdf
  body: {
    pdf_b64, 
    source_lang: "auto" | "vi" | "en" | ...,
    target_lang: "en" | "vi" | ...,
    scope: "all" | [page indices],
    mode: "new_file" | "in_place",     # Phase 1: chỉ new_file
    keep: { numbers: true, emails: true, dates: true, proper_nouns: true },
    fit: "shrink" | "wrap" | "shrink_then_wrap"
  }
  resp: { success, data_b64, filename, pages_changed, blocks_translated, error? }
```

Bên trong (tái dùng hàm hiện có, không đụng endpoint cũ):
1. Mở doc (fitz). Với mỗi trang trong scope: `get_text("dict")` → gom block → mỗi block ghép text.
2. Gọi Gemini 1 lần/trang (hoặc gộp nhiều trang): gửi list block text → nhận list bản dịch (JSON,
   giữ đúng thứ tự + index block). System prompt: "dịch, GIỮ NGUYÊN số/mã/email/ngày, trả JSON
   `[{i, t}]` đúng số phần tử".
3. Với mỗi block: redact bbox block (fill = màu nền suy từ span đầu, mặc định trắng) → `insert_textbox`
   bản dịch với font/color của span đầu block, auto-fit cỡ. Tái dùng `_norm_color`, `_vietnamese_font`,
   `_resolve_local_font`, `embed_vn/embed_local` từ `edit_text`.
4. `mode="new_file"`: trả doc mới. `mode="in_place"` (Phase 2): giống hệt nhưng UI áp tại chỗ + undo.

> Lựa chọn thay thế (ít code sidecar hơn, nhiều round-trip hơn): renderer gọi `/text-spans` từng trang,
> tự gom block, gọi Gemini qua... **không** — renderer không có key Gemini (key ở sidecar). Nên
> translate PHẢI ở sidecar. → endpoint mới là đúng.

## 5. UI (renderer)

- Nút **"Dịch"** (icon `#ic-translate` mới) trên thanh công cụ hàng 2, gated `has doc + engine ready`
  (giống `btn-searchable`/`btn-ocr`). Chỉ bật khi doc có text thật (thử `text-spans` trang 0 hoặc
  để endpoint tự báo scan).
- Modal `#tr-modal`: chọn **Ngôn ngữ nguồn** (Auto/…); **đích** (Anh/Việt/…); **phạm vi** (all/đang chọn);
  **chế độ** (Phase 1: chỉ "Tạo file mới"); toggle giữ số/mã/tên riêng; nút "Dịch (AI)".
- Kết quả: `mode=new_file` → mở doc trả về (`loadBytes`) để xem, rồi Lưu. (Phase 2: áp tại chỗ + `pushUndo`.)
- Cần key Gemini (như Bóc tách) — nếu chưa có, dẫn tới Cài đặt. i18n: thêm khoá VI→EN vào
  [desktop/renderer/i18n.js](../desktop/renderer/i18n.js) cho mọi nhãn mới.

## 6. Ràng buộc môi trường (nhắc lại)

- **Sidecar CÓ đổi** (`api.py` + có thể `gemini_agent.py`) → **PHẢI rebuild sidecar** trước release
  (`cd desktop && npm run build:sidecar`, re-stamp marker). Xem [[sidecar-stale-build-guard]].
- py3.12 / PyMuPDF (AGPL — app đã AGPL, OK) / pdf.js v3.
- Test headless: dịch 1 trang text, trang xoay, trang scan (phải báo đúng), giữ số/email, font VN dấu.

## 7. Phân kỳ

- **Phase 1 (v0.2.x)**: `mode=new_file`, block-level, auto-fit shrink+wrap, keep numbers/emails.
  WYSIWYG = mở file mới xem trước. Risk thấp.
- **Phase 2**: `mode=in_place` (redact+redraw tại chỗ + undo, tái dùng đúng pipeline Sửa chữ),
  glossary/term-lock, chọn "chỉ dịch vùng bôi chọn".
