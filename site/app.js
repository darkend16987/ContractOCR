// Nabu PDF landing — feature grid + live download links.
document.getElementById("year").textContent = new Date().getFullYear();

const I = {
  ai: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4"/><path d="M3 5h4"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  pages: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pen: '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  convert: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  combine: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  compare: '<circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/>',
  translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/>',
  signature: '<path d="M3 17c2.5 0 3-9 4.5-9S9 15 10.5 15 12 9 13.5 9 15 13 17 13"/><path d="M3 21h18"/><path d="M17 13c1.5 0 2-2 3-2"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
};

const FEATURES = [
  { i: "ai", t: "Bóc tách dữ liệu bằng AI", d: "OCR tiếng Việt + AI đọc mọi loại văn bản (hợp đồng, hóa đơn, biểu mẫu…), bóc tách các trường rồi xuất Excel/JSON. Tự khai báo trường tùy chỉnh cần bóc tách." },
  { i: "translate", t: "Dịch PDF bằng AI (giữ layout)", d: "Dịch tài liệu sang ngôn ngữ khác mà giữ nguyên bố cục, xuất ra PDF mới. Giữ nguyên số/ngày/email/mã không dịch. Dành cho PDF có text thật (cần Gemini API key)." },
  { i: "combine", t: "Gộp nhiều PDF thành một", d: "Chọn nhiều file cùng lúc, kéo–thả sắp xếp thứ tự rồi gộp thành một PDF — không cần mở file nào trước." },
  { i: "type", t: "Sửa nội dung gốc của PDF", d: "Chỉnh trực tiếp văn bản thật trong PDF — không phải vẽ đè. Giữ nguyên font gốc, đúng cỡ chữ và nền ô bảng: chữ sửa xong đứng đúng chỗ, không dài ra đè chữ bên cạnh, không để lại vệt trắng. Tự OCR lấy lại chữ tiếng Việt bị lỗi font (font .Vn cổ, bản vẽ CAD/Revit mã hóa hỏng)." },
  { i: "pages", t: "Ghép · Tách · Chèn · Số trang", d: "Quản lý trang linh hoạt: kéo-thả sắp xếp, ghép/chèn từ file khác, tách trang chọn hoặc tách thành nhiều file (theo N trang / khoảng trang), thêm trang trắng, đánh số trang." },
  { i: "compare", t: "So sánh & chồng lớp bản vẽ", d: "So sánh 2 file PDF theo từng dòng/từ; so sánh bản vẽ CAD/Revit bằng diff hình ảnh (chỉ ra vùng thêm/xóa/sửa, tick chọn từng vùng để khoanh mây rồi xuất bản đánh dấu); và chồng lớp (overlay) 2 bản vẽ lên nhau — tự căn chỉnh + tô màu khác biệt để soi thay đổi giữa 2 phiên bản." },
  { i: "pen", t: "Chú thích & đánh dấu", d: "Hộp văn bản (font, cỡ, đậm/nghiêng/gạch chân), ghi chú và mũi tên đều sửa & di chuyển lại được cả sau khi đã áp dụng; mũi tên chọn đặt nhãn ở đầu (mũi nhọn) hoặc ở cuối (gốc), tô sáng, khoanh mây revision (chữ nhật hoặc vẽ tự do, cỡ vòng tùy chỉnh), che thông tin (redact an toàn, chọn màu), watermark, điền form, đóng dấu ảnh/chữ ký lên nhiều trang, ghi chú dạng chuỗi bình luận kèm bảng danh sách ghi chú toàn tài liệu (bấm để nhảy tới)." },
  { i: "history", t: "Tự lưu & khôi phục khi sự cố", d: "Tự động lưu nền trong lúc bạn làm việc; nếu máy tắt đột ngột, app đóng bất ngờ hay lỡ quên lưu, mở lại sẽ mời khôi phục bản mới nhất — không mất công sức đang dở. Đóng cửa sổ khi còn thay đổi chưa lưu sẽ hỏi Lưu / Không lưu / Huỷ." },
  { i: "ruler", t: "Đo & ghi kích thước", d: "Công cụ đo cho bản vẽ CAD/Revit: hiệu chuẩn theo một đoạn đã biết kích thước, các đoạn còn lại kéo ra là tự ghi số theo đúng tỷ lệ." },
  { i: "print", t: "In tài liệu", d: "In trực tiếp từ app (Ctrl+P): chọn khổ giấy, in một mặt hoặc hai mặt (lật cạnh dài/ngắn), kèm cả in trang trắng." },
  { i: "search", t: "Tạo PDF tìm-kiếm-được", d: "OCR thêm lớp text vô hình để PDF scan có thể tìm kiếm và bôi chọn chữ." },
  { i: "archive", t: "Nén PDF", d: "Giảm dung lượng file (tối ưu ảnh) với nhiều mức nén, giữ chất lượng đọc tốt." },
  { i: "shield", t: "Khóa & mã hóa", d: "Đặt mật khẩu, mã hóa, trích xuất ảnh — bảo vệ tài liệu nhạy cảm." },
  { i: "signature", t: "Ký số bằng USB token", d: "Ký số PKI bằng chứng thư trên token USB (VNPT-CA, Viettel-CA, FPT-CA, BKAV…) qua kho chứng thư Windows — như Foxit/Acrobat. Chữ ký nhìn thấy (khung + tên/ngày/lý do + ảnh con dấu) kèm dấu thời gian (TSA). Khoá bí mật không rời token." },
  { i: "convert", t: "Chuyển đổi PDF ↔ ảnh", d: "Tạo PDF từ ảnh, xuất từng trang ra ảnh, gộp ảnh thành tài liệu theo thứ tự." },
  { i: "combine", t: "Tab đa tài liệu & khôi phục phiên", d: "Mở nhiều tài liệu bằng tab trong một cửa sổ: kéo sắp xếp, kéo tách tab ra cửa sổ riêng hoặc thả sang cửa sổ khác, Ctrl+T/Ctrl+W/Ctrl+Tab/Ctrl+1–9. Bật app lại là có đúng bộ tab lần trước. Kèm \"Open with Nabu PDF\" từ Explorer, copy/paste & chèn ảnh, menu chuột phải." },
  { i: "fullscreen", t: "Đọc toàn màn hình (F11)", d: "Trọn trang nằm gọn trong màn hình, ẩn hết thanh công cụ và danh sách trang — để trình bày hoặc đọc kỹ. Kèm \"vừa cả trang\" chạy được với cả khổ lớn A0–A1." },
];

document.getElementById("feature-grid").innerHTML = FEATURES.map((f) => `
  <div class="group rounded-2xl border border-slate-200 bg-white p-6 shadow-card transition-colors hover:border-brand-300">
    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-600 group-hover:text-white">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[f.i]}</svg>
    </div>
    <h3 class="mt-5 text-lg font-bold">${f.t}</h3>
    <p class="mt-2 text-sm leading-relaxed text-ink-muted">${f.d}</p>
  </div>`).join("");

// Live download links from the latest GitHub release (falls back to the
// releases page hrefs already in the HTML).
fetch("https://api.github.com/repos/darkend16987/NabuPDF/releases/latest")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((rel) => {
    const v = document.getElementById("dl-version");
    if (v && rel.tag_name) v.textContent = rel.tag_name;
    const assets = rel.assets || [];
    const nsis = assets.find((a) => /-x64\.exe$/.test(a.name));
    const port = assets.find((a) => /portable\.exe$/.test(a.name));
    if (nsis) document.getElementById("dl-installer").href = nsis.browser_download_url;
    if (port) document.getElementById("dl-portable").href = port.browser_download_url;
  })
  .catch(() => {});
