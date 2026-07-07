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
};

const FEATURES = [
  { i: "ai", t: "Bóc tách dữ liệu bằng AI", d: "OCR tiếng Việt + AI đọc mọi loại văn bản (hợp đồng, hóa đơn, biểu mẫu…), bóc tách các trường rồi xuất Excel/JSON. Tự khai báo trường tùy chỉnh cần bóc tách." },
  { i: "combine", t: "Gộp nhiều PDF thành một", d: "Chọn nhiều file cùng lúc, kéo–thả sắp xếp thứ tự rồi gộp thành một PDF — không cần mở file nào trước." },
  { i: "type", t: "Sửa chữ gốc của PDF", d: "Chỉnh trực tiếp văn bản thật trong PDF, dùng cả font hệ thống của máy — không phải vẽ đè." },
  { i: "pages", t: "Ghép · Tách · Chèn · Trang trắng", d: "Quản lý trang linh hoạt: kéo-thả sắp xếp, ghép/chèn từ file khác, tách trang chọn hoặc tách thành nhiều file (theo N trang / khoảng trang), thêm trang trắng." },
  { i: "compare", t: "So sánh PDF & bản vẽ", d: "So sánh 2 file PDF theo từng dòng/từ; và so sánh bản vẽ kỹ thuật CAD/Revit bằng diff hình ảnh — chỉ ra vùng thêm/xóa/sửa, xuất bản đánh dấu." },
  { i: "pen", t: "Chỉnh sửa & chú thích", d: "Hộp văn bản (chọn font, cỡ, đậm/nghiêng/gạch chân), che thông tin (redact chọn màu, an toàn), watermark, điền form, tô sáng, vẽ, chèn ảnh/chữ ký, ghi chú." },
  { i: "search", t: "Tạo PDF tìm-kiếm-được", d: "OCR thêm lớp text vô hình để PDF scan có thể tìm kiếm và bôi chọn chữ." },
  { i: "archive", t: "Nén PDF", d: "Giảm dung lượng file (tối ưu ảnh) với nhiều mức nén, giữ chất lượng đọc tốt." },
  { i: "shield", t: "Khóa & mã hóa", d: "Đặt mật khẩu, mã hóa, trích xuất ảnh — bảo vệ tài liệu nhạy cảm." },
  { i: "convert", t: "Chuyển đổi PDF ↔ ảnh", d: "Tạo PDF từ ảnh, xuất từng trang ra ảnh, gộp ảnh thành tài liệu theo thứ tự." },
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
