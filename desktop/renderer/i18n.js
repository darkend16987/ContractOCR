"use strict";

/**
 * Nabu PDF — UI language (Vietnamese default / English).
 *
 * This is a *chrome* translator, not a document translator: it swaps the app's
 * own labels, buttons, tooltips and menu text between Vietnamese and English.
 * It never touches the PDF content the user is viewing.
 *
 * How it works (safe by construction):
 *  - On load we build a one-time registry of the *static* text nodes and the
 *    title/placeholder attributes present in index.html whose text matches a
 *    dictionary key. Each registry entry holds a fixed node reference + its
 *    canonical Vietnamese string.
 *  - Switching language just re-renders those captured nodes from the registry
 *    (VI → dictionary[VI] for English, or back to VI). Because the registry is
 *    built once over the initial static markup, it can never accidentally
 *    rewrite user content that JS injects later (filenames, OCR text, etc.).
 *  - Elements whose text is replaced at runtime (badges, status lines, page
 *    counts…) are excluded via SKIP_IDS / [data-no-i18n] so a language switch
 *    doesn't clobber their live value.
 *
 * Dynamic strings created in JS use t("Vietnamese source") to look up the same
 * dictionary at call time.
 */
(function () {
  const STORAGE_KEY = "nabu-lang";

  // Vietnamese source → English. Keys are the exact trimmed Vietnamese strings
  // that appear in the static markup / in t() calls. Anything not present here
  // is left as-is (correct for words identical in both languages: Font,
  // Watermark, Excel, CSV, JSON, Copy, OCR, PNG, JPG, DPI, A4, Times…).
  const EN = {
    // --- top toolbar ---
    "Mở": "Open",
    "Mở PDF": "Open PDF",
    "Gộp file": "Combine",
    "Gộp nhiều file PDF thành một — chọn & sắp xếp thứ tự (không cần mở file trước)":
      "Combine several PDFs into one — pick & reorder (no need to open a file first)",
    "Lưu": "Save",
    "Lưu PDF (Ctrl+S)": "Save PDF (Ctrl+S)",
    "In": "Print",
    "In tài liệu (Ctrl+P)": "Print document (Ctrl+P)",
    "Bàn tay — kéo để di chuyển trang (phím H; phím V quay lại chọn chữ; giữ Space để dùng tạm; kéo nút giữa chuột thì pan được mọi lúc)":
      "Hand tool — drag to move the page (H; press V for text selection; hold Space to borrow it; middle-button drag pans at any time)",
    "Thu nhỏ (Ctrl+lăn chuột xuống)": "Zoom out (Ctrl+scroll down)",
    "Phóng to (Ctrl+lăn chuột lên)": "Zoom in (Ctrl+scroll up)",
    "Vừa bề ngang": "Fit width",
    "Vừa chiều dọc (văn bản ngang)": "Fit height (landscape docs)",
    "Vừa cả trang — trọn trang nằm trong khung nhìn": "Fit whole page — the entire page inside the view",
    "Toàn màn hình — trọn trang trong màn hình, ẩn thanh công cụ (F11, Esc để thoát)":
      "Full screen — whole page on screen, toolbars hidden (F11; Esc to exit)",
    "Thoát toàn màn hình (Esc)": "Exit full screen (Esc)",
    "Gõ tỷ lệ zoom (40–300) rồi Enter": "Type a zoom % (40–300) then Enter",
    "Tìm trong tài liệu…": "Find in document…",
    "Kết quả trước (Shift+Enter)": "Previous match (Shift+Enter)",
    "Kết quả tiếp (Enter)": "Next match (Enter)",
    "Cài đặt — API key cho Bóc tách": "Settings — API key for extraction",
    // --- Tìm & Thay thế (find-replace.js) ---
    "Tìm & Thay thế chữ trong PDF (Ctrl+H)": "Find & replace text in the PDF (Ctrl+H)",
    "Tìm & Thay thế": "Find & Replace",
    "Tìm": "Find",
    "Chữ cần tìm…": "Text to find…",
    "Thay bằng": "Replace with",
    "Chữ thay thế…": "Replacement text…",
    "Phân biệt hoa/thường": "Match case",
    "Đúng nguyên từ": "Whole word only",
    "Thay": "Replace",
    "Thay tất cả": "Replace all",
    "Thay vị trí đang chọn rồi sang vị trí kế": "Replace the current match and move to the next",
    "Thay mọi vị trí trong toàn bộ tài liệu": "Replace every match in the whole document",
    "Chỉ dùng được với PDF có chữ thật (không phải bản scan). Từ khoá bị chia làm nhiều đoạn định dạng sẽ được tô nhưng không thay tự động.":
      "Works only on PDFs with real text (not scans). A match split across two formatting runs is highlighted but not replaced automatically.",
    "Từ khoá bị chia làm nhiều đoạn định dạng — không thay tự động được":
      "This match is split across two formatting runs — it cannot be replaced automatically",
    "Quét toàn bộ tài liệu (Enter)": "Scan the whole document (Enter)",
    "Đang tìm…": "Searching…",
    "Đang thay thế…": "Replacing…",
    "Không tìm thấy kết quả nào.": "No matches found.",
    "Nhấn Enter (hoặc nút Tìm) để quét tài liệu.": "Press Enter (or the Tìm button) to scan the document.",
    "Đang hiện kết quả cũ — nhấn Enter để tìm lại.":
      "Showing the previous results — press Enter to search again.",
    "Tài liệu vừa thay đổi — nhấn Enter để tìm lại.":
      "The document just changed — press Enter to search again.",
    "PDF quá lớn để tìm (giới hạn ~1GB).": "This PDF is too large to search (~1GB limit).",
    "{i}/{n} kết quả · tài liệu quá lớn để thay tự động — dùng Nén trước":
      "{i}/{n} matches · this document is too large to replace in — shrink it with Nén (Compress) first",
    "Quá nhiều kết quả — chỉ hiện {n} vị trí đầu tiên, dừng quét ở trang {p}.":
      "Too many matches — showing the first {n}; the scan stopped on page {p}.",
    "PDF này không có chữ thật (bản scan) — chạy \"OCR văn bản\" trong Công cụ trước.":
      "This PDF has no real text (it is a scan) — run \"OCR văn bản\" under Công cụ first.",
    "Thoát \"Chú thích\" trước khi dùng Tìm & Thay thế.": "Leave \"Chú thích\" before using Find & Replace.",
    "Thoát \"Sửa nội dung\" trước khi dùng Tìm & Thay thế.": "Leave \"Sửa nội dung\" before using Find & Replace.",
    // --- Dịch PDF (AI) — the result toast, in three pieces so the two warning
    // clauses only appear when they apply. "Đè" is deliberate in the last one:
    // the user is about to hand this file to somebody and needs to know the
    // original is still readable underneath the translation on those blocks.
    "Đã dịch {b} đoạn trên {p} trang → {f}": "Translated {b} blocks on {p} pages → {f}",
    "{n} trang KHÔNG dịch được (AI không trả kết quả) — giữ nguyên bản gốc":
      "{n} pages could NOT be translated (the model returned nothing) — left as the original",
    "{n} đoạn chữ gốc là nét vẽ trên nền không phẳng nên không xoá được — bản dịch nằm đè lên":
      "{n} blocks whose original words are vector artwork on a non-flat background could not be cleared — the translation sits on top of them",
    "{i}/{n} kết quả": "{i}/{n} matches",
    "{i}/{n} kết quả · {k} vị trí không thay tự động được":
      "{i}/{n} matches · {k} cannot be replaced automatically",
    "Quá nhiều kết quả — chỉ hiện {n} vị trí đầu tiên.":
      "Too many matches — showing only the first {n}.",
    "Thay {n} vị trí trong toàn bộ tài liệu?": "Replace {n} matches throughout the document?",
    // The truncated variant of the same question. "throughout the document" is a
    // promise the app cannot keep once the scan stopped at max_hits, so it says what
    // it actually covered instead.
    "Thay {n} vị trí trong phần tài liệu đã quét?":
      "Replace {n} matches in the part of the document that was scanned?",
    "Lượt quét dừng ở trang {p} vì chạm trần {m} kết quả — phần sau CHƯA được quét. Thay xong hãy bấm Tìm lại để xử lý nốt.":
      "The scan stopped on page {p} after hitting the {m}-match ceiling — everything past it was NOT scanned. Replace, then press Tìm again to handle the rest.",
    "Lượt quét dừng sớm vì chạm trần {m} kết quả — phần sau CHƯA được quét. Thay xong hãy bấm Tìm lại để xử lý nốt.":
      "The scan stopped early after hitting the {m}-match ceiling — everything past it was NOT scanned. Replace, then press Tìm again to handle the rest.",
    "{k} vị trí bị chia làm nhiều đoạn định dạng sẽ được GIỮ NGUYÊN.":
      "{k} matches are split across formatting runs and will be LEFT UNCHANGED.",
    "Đã thay 1 vị trí.": "Replaced 1 match.",
    "Đã thay {n} vị trí.": "Replaced {n} matches.",
    // Pre-existing gap, surfaced by the find-replace grid: app.js already toasts
    // these 11 times (Nén, Dịch, Tách, Ký số…) and they had no English at all.
    "Mở PDF trước.": "Open a PDF first.",
    "Engine chưa sẵn sàng.": "The engine is not ready yet.",
    "Lỗi tìm: {msg}": "Search failed: {msg}",
    "Thay thế lỗi: {msg}": "Replace failed: {msg}",
    "Lỗi thay thế: {msg}": "Replace failed: {msg}",
    "không rõ": "unknown",
    "Trạng thái engine OCR": "OCR engine status",
    "Trạng thái cập nhật": "Update status",
    "Hoàn tác (Ctrl+Z)": "Undo (Ctrl+Z)",
    "Làm lại (Ctrl+Y)": "Redo (Ctrl+Y)",
    "Ghép": "Merge",
    "Ghép PDF khác vào — chọn vị trí (đầu/cuối/sau trang)":
      "Merge another PDF in — pick position (start/end/after a page)",
    "Chèn": "Insert",
    "Chèn trang từ PDF khác — chọn vị trí (đầu/cuối/sau trang)":
      "Insert pages from another PDF — pick position (start/end/after a page)",
    "Trang trắng": "Blank page",
    "Thêm một trang trắng — chọn vị trí (đầu/cuối/sau trang)":
      "Add a blank page — pick position (start/end/after a page)",
    "Tách": "Extract",
    "Tách các trang đang chọn ra PDF mới": "Extract the selected pages into a new PDF",
    "Xoay trái 90°": "Rotate left 90°",
    "Xoay phải 90°": "Rotate right 90°",
    "Xóa trang đang chọn": "Delete selected pages",
    "Chỉnh sửa": "Edit",
    "Chỉnh sửa: chú thích, watermark, redact, điền form":
      "Edit: annotate, watermark, redact, fill forms",
    "Sửa chữ": "Edit text",
    "Sửa trực tiếp chữ gốc của PDF (chỉ PDF có text thật, không phải scan)":
      "Edit the PDF's original text directly (real-text PDFs only, not scans)",
    "Searchable": "Searchable",
    "Tạo PDF tìm-kiếm-được (OCR thêm lớp text vô hình)":
      "Make a searchable PDF (OCR adds an invisible text layer)",
    "Dịch": "Translate",
    "Dịch PDF (AI) — giữ layout, xuất file mới. Chỉ PDF có text thật.":
      "Translate PDF (AI) — keep layout, export a new file. Text-based PDFs only.",
    "Nén": "Compress",
    "Nén PDF (giảm dung lượng ảnh)": "Compress PDF (shrink image size)",
    "So sánh": "Compare",
    "So sánh 2 file PDF — chỉ ra trang & dòng khác nhau":
      "Compare 2 PDFs — highlight changed pages & lines",
    "Copy ảnh": "Copy image",
    "Sao chép ảnh": "Copy image",
    "Sao chép vùng…": "Copy region…",
    "Dán ảnh vào trang": "Paste image onto page",
    // Object context menu while annotating (editor.js) — distinct from the image menu
    // above: these act on overlay OBJECTS (cloud / box / text box / arrow…).
    "Sao chép": "Copy",
    "Dán vào trang này": "Paste onto this page",
    "Không có ảnh ở vị trí này": "No image at this spot",
    "Copy ảnh trong trang — bấm vào ảnh để copy, hoặc kéo chọn một vùng. Dán (Ctrl+V) sang app khác hoặc ngược lại vào trang.":
      "Copy an image from the page — click an image, or drag to select a region. Paste (Ctrl+V) into another app, or back onto a page.",
    "Tách file, xuất/chuyển ảnh ↔ PDF, khoá file":
      "Split file, export/convert images ↔ PDF, lock file",
    "Chuyển đổi": "Convert",
    "Trang": "Pages",
    "Tách thành nhiều file…": "Split into multiple files…",
    "Đánh số trang…": "Add page numbers…",
    "Ảnh": "Images",
    "Trang PDF → ảnh…": "PDF pages → images…",
    "Ảnh → PDF…": "Images → PDF…",
    "Xuất ảnh trong PDF…": "Export images in PDF…",
    "Xuất ra Office (Word/Excel/CSV)…": "Export to Office (Word/Excel/CSV)…",
    "Chuyển nội dung PDF (chữ + bảng) sang Word/Excel/CSV có thể chỉnh sửa. Chỉ PDF có text thật.":
      "Convert the PDF's content (text + tables) into editable Word/Excel/CSV. Text-based PDFs only.",
    "Xuất PDF ra Office": "Export PDF to Office",
    "Chuyển nội dung PDF (chữ + bảng) sang file có thể chỉnh sửa. Excel/CSV giữ bảng theo đúng hàng/cột; Word giữ toàn văn kèm bảng. Chỉ hỗ trợ PDF có text thật (không phải bản scan — nếu là scan hãy chạy \"OCR văn bản\" trước).":
      "Convert the PDF's content (text + tables) into an editable file. Excel/CSV keep tables as real rows × columns; Word keeps the full text with tables. Text-based PDFs only (not scans — run \"OCR text\" first if it's a scan).",
    "Excel (.xlsx) — bảng theo hàng/cột": "Excel (.xlsx) — tables as rows/columns",
    "Word (.docx) — toàn văn + bảng": "Word (.docx) — full text + tables",
    "CSV (.csv) — bảng dạng văn bản": "CSV (.csv) — tables as text",
    "Bảo mật": "Security",
    "Khoá file (đặt mật khẩu)…": "Lock file (set password)…",
    "Bóc tách": "Extract fields",
    "Xuất": "Export",
    "Ký số": "Sign",
    "OCR + bóc tách field bằng AI": "OCR + AI field extraction",

    // --- overlay editor toolbar ---
    "Chọn / di chuyển / đổi kích thước": "Select / move / resize",
    "Hộp văn bản": "Text box",
    "Tô sáng": "Highlight",
    "Vẽ tay": "Freehand draw",
    "Khoanh vùng — khung chữ nhật": "Region — rectangle",
    "Khoanh vùng — elip / tròn": "Region — ellipse / circle",
    "Khoanh mây (revision cloud) — chuẩn kỹ thuật / xây dựng":
      "Revision cloud — engineering / construction standard",
    "Mũi tên chỉ dẫn": "Callout arrow",
    // NOTE these two carry the "(phím …)" suffix while their neighbours above do
    // not. buildRegistry matches the WHOLE title attribute, so a key without the
    // suffix never fires — which is why the older tool tooltips are in fact still
    // untranslated. Keep new keys verbatim-identical to the markup.
    "Dấu tích ✓ — đúng / đã kiểm (phím K)": "Tick ✓ — correct / checked (key K)",
    "Dấu chéo ✗ — sai / loại bỏ (phím J)": "Cross ✗ — wrong / rejected (key J)",
    "Ghi chú (comment) gắn vào một điểm": "Note (comment) pinned to a point",
    "Chèn ảnh / chữ ký": "Insert image / signature",
    "Che thông tin (an toàn — xoá nội dung gốc)":
      "Redact (safe — removes the original content)",
    "Màu (tô sáng / chữ / nét vẽ)": "Color (highlight / text / stroke)",
    "Màu": "Color",
    "Màu che thông tin": "Redaction color",
    "Màu che": "Redact color",
    "Font chữ": "Font",
    "Sans (mặc định)": "Sans (default)",
    "Serif (Times)": "Serif (Times)",
    "Mono (Courier)": "Mono (Courier)",
    "Font máy": "System fonts",
    "Cỡ chữ (điểm)": "Font size (pt)",
    "Cỡ chữ": "Font size",
    "Cỡ": "Size",
    "In đậm": "Bold",
    "In nghiêng": "Italic",
    "Gạch chân": "Underline",
    // Text-box rotation (v0.2.63). "Xoay" is already the page-rotation verb elsewhere
    // in the app, and reusing it here is deliberate — it is the same gesture on a
    // different object, and the control only appears while a text box is in play.
    "Xoay": "Rotate",
    "Xoay chữ trong hộp văn bản (độ, ngược chiều kim đồng hồ). Xoay được cả hộp đã gõ xong và hộp mở lại từ file đã lưu.":
      "Rotate the text in a text box (degrees, anti-clockwise). Works on a box you have finished typing and on one reopened from a saved file.",
    "Xoay thêm 90° ngược chiều kim đồng hồ": "Turn a further 90° anti-clockwise",
    "Độ dày nét vẽ / nét viền": "Stroke / outline width",
    "Nét": "Line",
    "Màu nền bên trong (khi khoanh vùng)": "Inner fill color (for regions)",
    "Nền": "Fill",
    "Không tô nền — để trong suốt": "No fill — transparent",
    "Trong suốt": "Transparent",
    "Đóng dấu mờ lên mọi trang": "Stamp a watermark on every page",
    "Điền form": "Fill form",
    "Điền các trường biểu mẫu PDF": "Fill PDF form fields",
    "Đảo chiều": "Reverse",
    "Đảo chiều mũi tên đang chọn — mũi nhọn sang đầu kia (nhãn đi theo mũi nhọn)":
      "Reverse the selected arrow — the head swaps ends (the label follows the head)",
    "Sao chép mục đang chọn (Ctrl+C) — giữ Ctrl bấm để chọn nhiều mục; dán được sang trang khác, kể cả sau khi Áp dụng":
      "Copy the selected item (Ctrl+C) — Ctrl+click to select several; can be pasted on another page, even after Apply",
    "Dán mục đã sao chép vào trang đang xem (Ctrl+V)":
      "Paste the copied item onto the page you are viewing (Ctrl+V)",
    "Xoá mục": "Delete item",
    "Xoá mục đang chọn (Delete)": "Delete the selected item (Delete)",
    "Ghi mọi thay đổi vào tài liệu và thoát": "Bake all changes into the document and exit",
    "Xong": "Done",
    "Bỏ mọi thay đổi chưa ghi và thoát (Ctrl+Z để hoàn tác từng bước)":
      "Discard unbaked changes and exit (Ctrl+Z to undo step by step)",
    "Hủy bỏ": "Cancel",

    // --- native text-edit toolbar ---
    "Sửa chữ gốc": "Edit original text",
    "Giữ nguyên (font gốc)": "Keep original font",
    "Mặc định (Việt)": "Default (Vietnamese)",
    "Màu chữ": "Text color",
    "Chữ": "Text",
    "Màu nền (tô sau chữ)": "Background color (behind text)",
    "Ghi các sửa đổi vào tài liệu (Ctrl+Enter khi đang sửa 1 đoạn cũng lưu ngay)":
      "Write edits into the document (Ctrl+Enter also applies the current span)",
    "Áp dụng": "Apply",
    "Thoát chế độ sửa chữ": "Exit text-edit mode",
    "Thoát": "Exit",

    // --- sidebar / empty state ---
    "Chọn tất cả": "Select all",
    "Mở một file PDF để bắt đầu": "Open a PDF file to get started",
    "Kéo–thả file vào đây, hoặc bấm": "Drag & drop a file here, or click",
    "Gộp nhiều PDF thành một file…": "Combine several PDFs into one file…",
    "Xem · gộp nhiều file · ghép · tách · chèn · xoay · xóa · sắp xếp · chú thích · khoanh vùng · ghi chú · watermark · redact · sửa chữ · OCR — chạy hoàn toàn trên máy.":
      "View · combine · merge · split · insert · rotate · delete · reorder · annotate · region · note · watermark · redact · edit text · OCR — all fully on your machine.",

    // --- extraction panel ---
    "Bóc tách hợp đồng": "Contract extraction",
    "Đóng": "Close",
    "Mẫu trường": "Field template",
    "Phạm vi": "Scope",
    "Tất cả trang": "All pages",
    "Trang đang chọn": "Selected pages",
    "Bóc tách (OCR + AI)": "Extract (OCR + AI)",
    "Trường tùy chỉnh": "Custom fields",
    "Nhập tên trường muốn bóc tách (mỗi dòng một trường).":
      "Enter the field names to extract (one per line).",
    "+ Thêm trường": "+ Add field",
    "Xuất:": "Export:",
    "Văn bản OCR thô": "Raw OCR text",

    // --- edit toolbar: cloud-pen / fill-opacity / image multi-page ---
    "Khoanh mây tự do — vẽ bút (giữ chuột kéo) hoặc bấm từng điểm":
      "Freehand revision cloud — draw with the pen (drag) or click point by point",
    "Độ mờ nền: 0% = trong suốt hoàn toàn, 100% = đặc kín":
      "Fill opacity: 0% = fully transparent, 100% = fully opaque",
    "Mờ nền": "Fill opacity",
    "Sao chép ảnh/chữ ký đang chọn sang nhiều trang (cùng vị trí)":
      "Copy the selected image/signature to multiple pages (same position)",
    "Áp nhiều trang": "Apply to pages",
    "Áp ảnh / chữ ký cho nhiều trang": "Apply image / signature to multiple pages",
    "Sao chép ảnh đang chọn (giữ nguyên vị trí và kích thước) sang các trang bạn nhập.":
      "Copy the selected image (keeping its position and size) to the pages you enter.",
    "Khoảng trang": "Page range",
    "vd: 1-3, 5, 8-10": "e.g. 1-3, 5, 8-10",
    "Áp dụng": "Apply",

    // --- watermark dialog ---
    "Watermark (đóng dấu mờ)": "Watermark",
    "Nội dung": "Text",
    "Góc (°)": "Angle (°)",
    "Độ mờ": "Opacity",
    "Hủy": "Cancel",
    "Thêm vào mọi trang": "Add to every page",

    // --- insert/merge position picker ---
    "Chọn vị trí": "Choose position",
    "Vị trí": "Position",
    "Cuối tài liệu": "End of document",
    "Đầu tài liệu": "Start of document",
    "Sau một trang cụ thể…": "After a specific page…",
    "Sau trang số": "After page number",
    "Tiếp tục": "Continue",

    // --- form-fill dialog ---
    "Điền biểu mẫu PDF": "Fill PDF form",
    "Khóa giá trị sau khi điền (flatten)": "Lock values after filling (flatten)",

    // --- password prompt ---
    "PDF có mật khẩu": "Password-protected PDF",
    "File này được bảo vệ bằng mật khẩu. Nhập mật khẩu để mở.":
      "This file is password-protected. Enter the password to open it.",
    "Mật khẩu": "Password",
    "Nhập mật khẩu mở file…": "Enter the open password…",
    "Hiện / ẩn mật khẩu": "Show / hide password",
    "Mở khoá": "Unlock",

    // --- compress dialog ---
    "Nén PDF": "Compress PDF",
    "Mức nén": "Compression level",
    "Mạnh — màn hình (~96 DPI)": "Strong — screen (~96 DPI)",
    "Vừa — ebook (~150 DPI)": "Medium — ebook (~150 DPI)",
    "Nhẹ — in ấn (~300 DPI)": "Light — print (~300 DPI)",
    "Không giảm chất lượng (chỉ dọn rác)": "No quality loss (cleanup only)",
    "Chỉ ảnh độ phân giải cao bị hạ xuống mức đã chọn; văn bản và vector giữ nguyên.":
      "Only high-resolution images are downscaled; text and vectors are untouched.",
    "Nén & lưu": "Compress & save",
    // Live readout + the heads-up for documents big enough to hurt (see
    // updateCompressEta / runCompress in app.js).
    "{n} giây": "{n} sec",
    "{n} phút": "{n} min",
    "Tài liệu {size} · ước tính khoảng {time}": "Document {size} · roughly {time}",
    "tài liệu rất lớn, máy sẽ cần nhiều RAM": "very large document, this needs a lot of RAM",
    "Đang nén PDF… (khoảng {time})": "Compressing PDF… (about {time})",
    "Tài liệu {size} — nén có thể mất khoảng {time} và dùng nhiều bộ nhớ. Trong lúc chạy không dừng lại được. Tiếp tục?":
      "This document is {size} — compressing may take about {time} and use a lot of memory, and it cannot be stopped once started. Continue?",

    // --- translate dialog ---
    "Dịch PDF (AI)": "Translate PDF (AI)",
    "Dịch giữ nguyên bố cục — xuất ra file PDF mới. Chỉ hỗ trợ PDF có text thật (không phải scan). Cần Gemini API key.":
      "Translate while keeping the layout — exports a new PDF. Text-based PDFs only (not scans). Requires a Gemini API key.",
    "Ngôn ngữ nguồn": "Source language",
    "Tự nhận diện": "Auto-detect",
    "Tiếng Việt": "Vietnamese",
    "Tiếng Anh": "English",
    "Tiếng Nhật": "Japanese",
    "Tiếng Hàn": "Korean",
    "Tiếng Trung": "Chinese",
    "Tiếng Pháp": "French",
    "Tiếng Đức": "German",
    "Dịch sang": "Translate to",
    "Toàn bộ tài liệu": "Whole document",
    "Chỉ các trang đang chọn": "Selected pages only",
    "Giữ nguyên số / ngày / email / mã (không dịch)":
      "Keep numbers / dates / emails / codes (don't translate)",
    "Dịch (AI)": "Translate (AI)",

    // --- lock PDF dialog ---
    "Khoá file PDF": "Lock PDF file",
    "Đặt mật khẩu để mở file. Người không có mật khẩu sẽ không xem được nội dung.":
      "Set an open password. Anyone without it cannot view the contents.",
    "Mật khẩu mở file": "Open password",
    "Nhập mật khẩu…": "Enter a password…",
    "Nhập lại mật khẩu": "Confirm password",
    "Nhập lại để xác nhận…": "Re-enter to confirm…",
    "Quyền hạn (tuỳ chọn)": "Permissions (optional)",
    "Cho phép in": "Allow printing",
    "Cho phép sao chép nội dung": "Allow copying content",
    "Cho phép chỉnh sửa": "Allow editing",
    "Cho phép chú thích": "Allow annotations",
    "Khoá & lưu": "Lock & save",

    // --- PDF → images dialog ---
    "Trang PDF → ảnh": "PDF pages → images",
    "Mỗi trang được xuất thành một ảnh; tất cả gói trong một file .zip.":
      "Each page is exported as one image; all bundled in a single .zip.",
    "Định dạng": "Format",
    "PNG (nét, file lớn hơn)": "PNG (sharp, larger file)",
    "JPG (nhẹ hơn)": "JPG (smaller)",
    "Độ phân giải": "Resolution",
    "96 DPI — màn hình": "96 DPI — screen",
    "150 DPI — vừa": "150 DPI — medium",
    "300 DPI — in ấn": "300 DPI — print",
    "Xuất & lưu": "Export & save",

    // --- split dialog ---
    "Tách PDF thành nhiều file": "Split PDF into multiple files",
    "Chia tài liệu thành nhiều PDF nhỏ; tất cả gói trong một file .zip.":
      "Split the document into several smaller PDFs; all bundled in a single .zip.",
    "Cách tách": "Split method",
    "Mỗi N trang thành 1 file": "Every N pages into 1 file",
    "Theo khoảng trang tùy chọn": "By custom page ranges",
    "Số trang mỗi file": "Pages per file",
    "Khoảng trang (vd: 1-3,5,8-10)": "Page ranges (e.g. 1-3,5,8-10)",
    "Tách & lưu": "Split & save",

    // --- readiness badges (OCR engine vs AI API key) ---
    "OCR: sẵn sàng": "OCR: ready",
    "OCR: đang tải…": "OCR: loading…",
    "OCR: lỗi": "OCR: error",
    "API: đã có key": "API: key set",
    "API: chưa có key": "API: no key",
    "Engine xử lý trên máy": "On-device processing engine",
    "Engine xử lý trên máy: OCR, nén, tách, so sánh, sửa chữ. KHÔNG gồm tính năng AI — xem badge API bên cạnh.":
      "On-device engine: OCR, compress, split, compare, edit text. Does NOT cover the AI features — see the API badge next to it.",
    "Engine xử lý trên máy gặp lỗi.": "The on-device engine failed.",
    "API key cho tính năng AI — bấm để nhập": "API key for the AI features — click to enter one",
    "Đã có API key — Bóc tách và Dịch (AI) dùng được. Bấm để đổi key.":
      "API key set — Extract and Translate (AI) are available. Click to change it.",
    "Chưa có API key — Bóc tách và Dịch (AI) sẽ không chạy. Bấm để nhập key.":
      "No API key — Extract and Translate (AI) will not run. Click to enter one.",
    "Chưa đọc được trạng thái API key — cần engine chạy trước. Bấm để mở Cài đặt.":
      "API key status unknown — the engine must be running first. Click to open Settings.",

    // --- delete page range dialog ---
    "Xoá nhiều trang theo khoảng": "Delete a range of pages",
    "Xoá nhiều trang theo khoảng…": "Delete a range of pages…",
    "Nhập từ trang X đến trang Y, trừ ra vài trang — không cần tick chọn":
      "Enter from page X to page Y, minus a few exceptions — no ticking required",
    "Nhập khoảng trang cần xoá, rồi liệt kê những trang muốn GIỮ LẠI trong khoảng đó.":
      "Enter the range of pages to delete, then list the pages to KEEP within that range.",
    "Từ trang": "From page",
    "Đến trang": "To page",
    "Trừ các trang (giữ lại) — vd: 3, 5-7": "Except (keep) these pages — e.g. 3, 5-7",
    "Xoá trang": "Delete pages",
    // Live summary + refusals (dynamic, via t()).
    "Sẽ xoá {n} trang: {list} · còn lại {kept} trang.":
      "Will delete {n} pages: {list} · {kept} pages left.",
    "Không thể xoá tất cả trang — phải giữ lại ít nhất 1 trang.":
      "Can't delete every page — at least 1 page must remain.",
    "Không có trang nào để xoá — kiểm tra lại khoảng trang.":
      "No pages to delete — check the range.",

    // --- thumbnail page menu (right-click) + toolbar page shortcuts ---
    "Trang {n}": "Page {n}",
    "{n} trang đang chọn": "{n} pages selected",
    "Thêm trang trắng phía trên": "Add a blank page above",
    "Thêm trang trắng phía dưới": "Add a blank page below",
    "Chèn PDF khác phía dưới…": "Insert another PDF below…",
    "Tách trang này ra file mới…": "Extract this page into a new file…",
    "Tách các trang đang chọn ra file mới…": "Extract the selected pages into a new file…",
    "Xoá trang này": "Delete this page",
    "Xoá các trang đang chọn": "Delete the selected pages",
    "Xoay trái 90° (trang đang chọn)": "Rotate left 90° (selected pages)",
    "Xoay phải 90° (trang đang chọn)": "Rotate right 90° (selected pages)",

    // --- moving pages between two open documents (renderer/page-move.js) ---
    "Chuyển trang này sang tài liệu khác…": "Move this page to another document…",
    "Chuyển các trang đang chọn sang tài liệu khác…": "Move the selected pages to another document…",
    "Copy {n} trang tới (nối vào cuối)": "Copy {n} page(s) to (appended at the end)",
    "Không có tài liệu nào khác đang mở": "No other document is open",
    "Cửa sổ {w} · ": "Window {w} · ",
    "Đang chuẩn bị trang…": "Preparing pages…",
    "Đã copy {n} trang{where}.": "Copied {n} page(s){where}.",
    "Đã chuyển {n} trang{where}.": "Moved {n} page(s){where}.",
    "Đã nhận {n} trang từ {from}.": "Received {n} page(s) from {from}.",
    "Xoá khỏi bản gốc": "Remove from the original",
    "Tài liệu đã thay đổi — không xoá trang gốc nữa.":
      "The document changed — the original pages were kept.",
    // Refusals. Worded from the SOURCE window's point of view, because that is where
    // the hand that started the transfer is looking (SPEC-page-drag.md §4.1b).
    "Tài liệu đích chưa mở file nào.": "The destination has no document open.",
    "Tài liệu đích đang chú thích dở.": "The destination is in the middle of annotating.",
    "Tài liệu đích đang sửa chữ dở.": "The destination is in the middle of editing text.",
    "Thả vào cột trang (danh sách trang bên trái) của cửa sổ đích.":
      "Drop onto the destination's page column (the page list on the left).",
    "Tài liệu đích đang bận — thử lại sau.": "The destination is busy — try again.",
    "Không tìm thấy tài liệu đích.": "Destination document not found.",
    "Đó chính là tài liệu này.": "That is this document.",
    "Không có trang nào để chuyển.": "No pages to move.",
    "Đang chú thích / sửa chữ dở — bấm Xong trước khi chuyển trang.":
      "An annotation / text edit is still open — press Xong before moving pages.",
    "Không bóc được trang ra khỏi tài liệu này.": "Could not lift the pages out of this document.",
    "Tài liệu đích không chèn được trang.": "The destination could not insert the pages.",
    "Không chuyển được trang sang tài liệu đích.": "Could not move the pages to the destination.",
    // Short forms — these sit inside a menu label, where a sentence does not fit.
    "chưa mở file": "no document",
    "đang chú thích": "annotating",
    "đang sửa chữ": "editing text",
    "cần bản quyền": "licence needed",
    "đang bận": "busy",
    "không nhận được": "cannot accept",
    // These five are the CURRENT Trang ▾ labels. The dictionary still carried the
    // pre-overhaul wording (and "Xóa" where the markup says "Xoá"), so the menu was
    // silently untranslated; the new toolbar tooltips reuse the same strings.
    "Ghép PDF khác vào…": "Merge another PDF in…",
    "Chèn trang từ PDF khác…": "Insert pages from another PDF…",
    "Thêm trang trắng…": "Add a blank page…",
    "Tách trang đang chọn ra file mới": "Extract the selected pages into a new file",
    "Xoá trang đang chọn": "Delete the selected pages",
    "Chọn vị trí (đầu/cuối/sau trang)": "Pick a position (start / end / after a page)",

    // --- combine dialog ---
    "Gộp nhiều PDF thành một file": "Combine several PDFs into one file",
    "Chọn nhiều file rồi kéo–thả (hoặc nút ↑/↓) để sắp xếp thứ tự. Không cần mở file nào trước.":
      "Pick several files, then drag & drop (or ↑/↓) to reorder. No need to open a file first.",
    "Thêm file PDF…": "Add PDF files…",
    "Gộp & lưu": "Combine & save",

    // --- page numbers dialog ---
    "Đánh số trang": "Add page numbers",
    "Thêm số trang vào tài liệu đang mở. Xem trước ngay trên trang — có thể Hoàn tác (Ctrl+Z) trước khi Lưu.":
      "Add page numbers to the open document. Preview on the page — Undo (Ctrl+Z) before saving.",
    "Kiểu số": "Number style",
    "1 / N (kèm tổng số trang)": "1 / N (with total pages)",
    "Trang 1": "Page 1",
    "Trang 1 / N": "Page 1 / N",
    "Dưới — giữa": "Bottom — center",
    "Dưới — phải": "Bottom — right",
    "Dưới — trái": "Bottom — left",
    "Trên — giữa": "Top — center",
    "Trên — phải": "Top — right",
    "Trên — trái": "Top — left",
    "Bắt đầu từ số": "Start from number",
    "Bỏ qua trang đầu": "Skip first pages",
    "Đánh số & áp dụng": "Number & apply",

    // --- images → PDF dialog ---
    "Ảnh → PDF": "Images → PDF",
    "Chọn các ảnh để gộp thành một PDF (theo đúng thứ tự chọn).":
      "Pick images to combine into one PDF (in the order selected).",
    "Chọn ảnh…": "Choose images…",
    "Khổ trang": "Page size",
    "Vừa khít ảnh (không lề)": "Fit the image (no margin)",
    "A4 dọc (căn giữa)": "A4 portrait (centered)",
    "Tạo PDF & lưu": "Create PDF & save",

    // --- settings dialog ---
    "Cài đặt": "Settings",
    "Bản quyền": "License",
    "Đang kiểm tra…": "Checking…",
    "Dán license key (NABU1…)": "Paste a license key (NABU1…)",
    "Kích hoạt": "Activate",
    "Gỡ bản quyền": "Remove license",
    "Mã máy (HWID)": "Machine ID (HWID)",
    "Gửi mã này cho nhà phát hành để được cấp key khóa theo máy.":
      "Send this ID to the publisher to be issued a machine-locked key.",
    "Mã định danh máy này": "This machine's identifier",
    "Sao chép mã máy": "Copy machine ID",
    "Gemini API key": "Gemini API key",
    "Model Gemini": "Gemini model",
    "Chọn hoặc gõ tên model Gemini dùng cho Bóc tách / Dịch":
      "Pick or type the Gemini model used for extraction / translation",
    "Dán API key vào đây…": "Paste your API key here…",
    "Hiện / ẩn key": "Show / hide key",
    "Giao diện": "Appearance",
    "Chế độ sáng / tối": "Light / dark mode",
    "Tối": "Dark",
    "Sáng": "Light",
    "Ngôn ngữ": "Language",
    "Ngôn ngữ giao diện": "Interface language",
    "Màu chú thích mặc định": "Default annotation colour",
    "Màu của vật thể mới khi Chú thích: hộp văn bản, mũi tên, mây, chữ nhật, tròn, bút vẽ, ghi chú, đo · dấu ✓ ✗, Tô sáng và Màu che giữ màu riêng · vật thể đã vẽ không đổi":
      "The colour new annotation objects get: text box, arrow, cloud, rectangle, ellipse, pen, note, measure · the ✓ ✗ stamps, Highlight and Redact keep their own colours · objects already drawn are left alone",
    "Màu mặc định cho chú thích mới": "Default colour for new annotations",
    "Hiện đường dẫn file": "Show file path",
    "Dải đường dẫn ngay dưới thanh công cụ — tắt đi để trang rộng thêm":
      "The path strip under the toolbar — turn it off to give the page more room",
    "Kéo để đổi bề rộng · bấm đúp để về mặc định": "Drag to resize · double-click to reset",
    "Mở file mới trong": "Open new files in",
    "Áp dụng khi tab hiện tại đã có tài liệu · chọn nhiều file cùng lúc thì cả loạt vào chung một cửa sổ mới":
      "Applies when the current tab already holds a document · picking several files at once puts the whole batch in one new window",
    "Tab mới": "New tab",
    "Cửa sổ mới": "New window",
    "Mở lại phiên trước": "Reopen last session",
    "Khởi động lại app thì mở lại đúng các tab lần trước": "Reopen the same tabs the next time the app starts",
    // ("Tiếng Việt" / "Tiếng Anh" defined once in the translate-dialog block.)
    "Cập nhật phần mềm": "Software update",
    "Kiểm tra cập nhật": "Check for updates",
    "Giới thiệu": "About",
    "Phát triển bởi": "Developed by",
    "Giấy phép thư viện bên thứ ba": "Third-party library licenses",
    "Toàn văn giấy phép AGPL-3.0": "Full AGPL-3.0 license text",

    // --- compare dialog + view ---
    "So sánh hai file PDF": "Compare two PDFs",
    "Chọn 2 file. Ứng dụng chỉ ra các trang và dòng khác nhau. PDF scan sẽ được OCR để so sánh (chậm hơn). Với bản vẽ CAD/Revit, chọn chế độ \"Bản vẽ\" để so sánh hình ảnh.":
      "Pick 2 files. The app highlights changed pages and lines. Scanned PDFs are OCR'd to compare (slower). For CAD/Revit drawings, choose \"Drawing\" mode for a visual comparison.",
    "Chọn file A…": "Choose file A…",
    "Chọn file B…": "Choose file B…",
    "Chưa chọn": "Not selected",
    "Chế độ": "Mode",
    "Tự động (text, OCR khi là scan)": "Auto (text, OCR when scanned)",
    "Chỉ văn bản (nhanh, không OCR)": "Text only (fast, no OCR)",
    "Bắt buộc OCR mọi trang": "Force OCR on every page",
    "Bản vẽ (so sánh hình ảnh — CAD/Revit)": "Drawing (visual compare — CAD/Revit)",
    "Độ nhạy": "Sensitivity",
    "Thấp (bỏ qua khác biệt nhỏ)": "Low (ignore small differences)",
    "Chuẩn": "Normal",
    "Cao (bắt cả nét mảnh)": "High (catch thin strokes)",
    "So sánh PDF": "Compare PDF",
    "Thay đổi trước": "Previous change",
    "‹ Thay đổi trước": "‹ Previous change",
    "Thay đổi sau": "Next change",
    "Thay đổi sau ›": "Next change ›",
    "Thu nhỏ (−)": "Zoom out (−)",
    "Mức phóng to": "Zoom level",
    "Phóng to (+)": "Zoom in (+)",
    "Vừa bề ngang (0)": "Fit width (0)",
    "Vừa màn hình": "Fit screen",
    "Lưu bản B với đám mây revision quanh các vùng thay đổi":
      "Save file B with revision clouds around the changes",
    "Tải B đã đánh dấu": "Download marked-up B",

    // --- print options dialog ---
    "In tài liệu": "Print document",
    "Máy in": "Printer",
    "Máy in mặc định": "Default printer",
    "Khổ giấy": "Paper size",
    "Hướng giấy": "Orientation",
    "Dọc": "Portrait",
    "Ngang": "Landscape",
    "Kiểu in": "Sides",
    "Một mặt": "One-sided",
    "Hai mặt — lật cạnh dài": "Two-sided — long edge",
    "Hai mặt — lật cạnh ngắn": "Two-sided — short edge",
    "Số bản": "Copies",
    "Trang cần in — để trống là in tất cả": "Pages to print — blank prints them all",
    "vd: 1-2, 5, 8-10": "e.g. 1-2, 5, 8-10",
    "Mở hộp thoại máy in của hệ thống": "Open the system printer dialog",
    "Máy in không hỗ trợ 2 mặt sẽ tự in 1 mặt. Khoảng trang gõ ở đây đếm theo trang tài liệu; hộp thoại của hệ thống đếm theo TỜ in ra.":
      "Printers without duplex support print one-sided. The range typed here counts document pages; the system dialog counts printed SHEETS.",

    // --- print (dynamic, app.js) ---
    "Đang chuẩn bị in…": "Preparing to print…",
    "Đang chuẩn bị in… (trang {n}/{total})": "Preparing to print… (page {n}/{total})",
    "Sẽ in tất cả {n} trang.": "Will print all {n} pages.",
    "Sẽ in {n} trang: {list}.": "Will print {n} pages: {list}.",
    "Chưa nhận ra trang nào — vd: 1-2, 5, 8-10.": "No pages recognised — e.g. 1-2, 5, 8-10.",
    "Đã gửi lệnh in.": "Sent to printer.",
    "In lỗi:": "Print error:",
    // --- text-box Format panel ---
    "Định dạng văn bản": "Text formatting",
    "Đoạn văn": "Paragraph",
    "Giãn dòng": "Line spacing",
    "Giãn đoạn": "Paragraph spacing",
    "Giãn ký tự": "Character spacing",
    "Giãn từ": "Word spacing",
    "Co giãn ngang": "Horizontal scale",
    "Gạch ngang": "Strikethrough",
    "Sắp xếp theo trang": "Arrange on page",
    "Áp dụng cho hộp văn bản đang chọn.": "Applies to the selected text box.",
    "Căn trái": "Align left",
    "Căn giữa": "Align center",
    "Căn phải": "Align right",
    "Căn đều": "Justify",
    "Giảm thụt lề": "Decrease indent",
    "Tăng thụt lề": "Increase indent",
    "Dấu đầu dòng": "Bullet list",
    "Đánh số": "Numbered list",
    "Căn giữa theo chiều ngang": "Center horizontally",
    "Căn giữa theo chiều dọc": "Center vertically",
    "Căn giữa trang": "Center on page",
    "Sát mép trái trang": "Align to left edge",
    "Sát mép phải trang": "Align to right edge",
    "Sát mép trên trang": "Align to top edge",
    "Sát mép dưới trang": "Align to bottom edge",
  };

  // Elements whose text/attrs change at runtime — never register these, or a
  // language switch would overwrite their live value with stale static text.
  const SKIP_IDS = new Set([
    "page-count", "sidecar-badge", "api-badge", "update-badge", "find-count",
    "pos-title", "pos-hint", "i2p-count", "combine-summary",
    "cmp2-a-name", "cmp2-b-name",
    // Live "Tài liệu 82 MB · ước tính khoảng 16 giây" line in the Nén dialog: rewritten
    // by updateCompressEta() on open and on every preset change (BI-10).
    "cmp-eta",
    "set-version", "set-status", "set-update-status",
    "lic-status", "lic-badge", "lic-hwid",
    "compare-summary", "compare-pagenum", "compare-zoom",
    "compare-a-h", "compare-b-h", "compare-changes", "compare-a", "compare-b",
    "thumbs", "breadcrumb", "ext-fields", "ext-class", "ext-custom-rows",
    "ext-raw-out", "form-fields", "toast", "overlay-msg",
    "ed-hint", "te-hint",
    // Live "will delete N pages: …" summary, rewritten on every keystroke (BI-10).
    "delrange-preview",
    // Same, for "Áp ảnh / chữ ký cho nhiều trang" (BI-10).
    "imgpages-hint",
    // Same, for the print dialog's page-range box (BI-10, BI-27).
    "print-pages-hint",
    // Live page counter shown in full-screen reading mode (BI-10).
    "present-page",
    // Live "N/M kết quả · K vị trí không thay tự động được", rewritten on every
    // keystroke and after every replacement (BI-10).
    "fr-status",
    // uiConfirm's optional third button: label AND visibility are set per call (e.g.
    // "Xoá cả 3 bản, không hỏi lại" — the count comes from the caller), so it must never
    // be captured into the registry (BI-10).
    "confirm-third",
  ]);

  let lang = "vi";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "vi") lang = saved;
  } catch (_) {}

  // Registry of { node, kind: "text"|"attr", attr?, vi }.
  const registry = [];
  let built = false;

  function inSkip(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute("data-no-i18n")) return true;
      if (n.id && SKIP_IDS.has(n.id)) return true;
    }
    return false;
  }

  // Split "  core  " → { pre, core, post } preserving surrounding whitespace.
  function splitWs(s) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    return m ? { pre: m[1], core: m[2], post: m[3] } : { pre: "", core: s, post: "" };
  }

  function buildRegistry() {
    if (built) return;
    built = true;
    // Text nodes.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el || inSkip(el)) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
        const core = splitWs(node.nodeValue).core;
        return Object.prototype.hasOwnProperty.call(EN, core)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let tn;
    while ((tn = walker.nextNode())) {
      registry.push({ node: tn, kind: "text", vi: splitWs(tn.nodeValue).core });
    }
    // title / placeholder / aria-label attributes.
    // aria-label matters for the icon-only controls: a <button aria-label="Đóng">✕</button>
    // announces "Đóng" to a screen reader, and without this it would keep announcing
    // Vietnamese in English mode. Registration is still opt-in by exact dictionary
    // match, so an aria-label with no EN entry is simply left alone.
    document.body.querySelectorAll("[title],[placeholder],[aria-label]").forEach((el) => {
      if (inSkip(el)) return;
      for (const attr of ["title", "placeholder", "aria-label"]) {
        const v = el.getAttribute(attr);
        if (v && Object.prototype.hasOwnProperty.call(EN, v.trim())) {
          registry.push({ node: el, kind: "attr", attr, vi: v.trim() });
        }
      }
    });
  }

  function render() {
    for (const e of registry) {
      const out = lang === "en" ? EN[e.vi] || e.vi : e.vi;
      if (e.kind === "text") {
        const w = splitWs(e.node.nodeValue);
        e.node.nodeValue = w.pre + out + w.post;
      } else {
        e.node.setAttribute(e.attr, out);
      }
    }
    document.documentElement.setAttribute("lang", lang);
  }

  // Translate a dynamic Vietnamese source string. Optional {name} params are
  // substituted into "{name}" placeholders.
  function t(vi, params) {
    let s = lang === "en" ? EN[vi] || vi : vi;
    if (params) {
      for (const k in params) s = s.replace(new RegExp("\\{" + k + "\\}", "g"), params[k]);
    }
    return s;
  }

  function setLang(next) {
    next = next === "en" ? "en" : "vi";
    if (next === lang) return lang;
    lang = next;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (_) {}
    render();
    // Keep the native menu in sync.
    try {
      if (window.desktop && window.desktop.setMenuLang) window.desktop.setMenuLang(lang);
    } catch (_) {}
    // Let the app re-localize any dynamic bits it wants to.
    try {
      window.dispatchEvent(new CustomEvent("i18n:changed", { detail: { lang } }));
    } catch (_) {}
    return lang;
  }

  window.I18N = {
    t,
    getLang: () => lang,
    setLang,
    // Re-apply current language (e.g. after building registry).
    apply: render,
  };
  // Convenience global used throughout the renderer.
  window.t = t;

  function init() {
    buildRegistry();
    if (lang !== "vi") render();
    // Tell main the current language so the native menu matches on first paint.
    try {
      if (window.desktop && window.desktop.setMenuLang) window.desktop.setMenuLang(lang);
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
