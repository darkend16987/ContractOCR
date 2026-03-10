/**
 * Gemini API integration — Agent-based smart extraction for Vietnamese contracts.
 *
 * Strategy (2 phases):
 *
 * 1. RECON (all pages in scope, low quality):
 *    Agent reads pages and classifies which ones contain relevant data.
 *    Uses "skills" to reason about document structure, not keyword matching.
 *
 * 2. EXTRACT (relevant pages only, high quality):
 *    Agent extracts structured data from only the pages identified in recon.
 *    Comprehensive prompt covers all fields in one pass.
 *
 * For short documents (≤5 pages): skip recon, send all pages directly.
 *
 * Security note:
 * - API key is sent per-request, never stored server-side
 * - Images are sent to Gemini API and subject to Google's data policies
 * - No document data is persisted on our servers
 */

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Agent Skill Prompts ────────────────────────────────────────────────────

const PROMPTS: Record<string, string> = {
  recon: `Bạn là AI Agent chuyên phân tích bố cục hợp đồng tiếng Việt.

NHIỆM VỤ: Đọc lướt TẤT CẢ các trang và xác định trang nào chứa thông tin quan trọng.

BỘ KỸ NĂNG:
1. NHẬN DIỆN CẤU TRÚC: Hiểu cách bố trí hợp đồng VN — phần đầu thường có thông tin các bên, nhưng KHÔNG PHẢI LÚC NÀO CŨNG VẬY
2. PHÁT HIỆN DỮ LIỆU TÀI CHÍNH: Nhận diện trang có chứa số tiền, giá trị, bảng giá — dù nằm trong bất kỳ phần nào (kể cả điều khoản, phụ lục)
3. PHÁT HIỆN LỊCH THANH TOÁN: Nhận diện trang chứa thông tin về đợt/giai đoạn/tiến độ thanh toán — có thể nằm trong:
   - Điều khoản thanh toán
   - Phương thức thanh toán
   - Nghĩa vụ tài chính
   - Phụ lục thanh toán
   - Bảng tiến độ
   - Hoặc BẤT KỲ phần nào đề cập đến việc chia thanh toán thành nhiều đợt/lần

LƯU Ý QUAN TRỌNG:
- ĐỪNG giả định dữ liệu chỉ nằm ở những trang đầu
- Giá trị hợp đồng có thể nằm trong điều khoản giữa hoặc cuối
- Các đợt thanh toán thường nằm trong phần điều khoản, KHÔNG PHẢI phần đầu
- Trang chứa nhiều text pháp lý thuần túy (quyền, nghĩa vụ chung chung, giải quyết tranh chấp) → đánh dấu "low"
- Trang có chữ ký, con dấu → "low"
- SỐ TRANG HIỂN THỊ LÀ SỐ TRANG GỐC CỦA TÀI LIỆU — hãy giữ nguyên số trang này trong kết quả

Trả về JSON:
{
  "total_pages": <số trang đã quét>,
  "page_analysis": [
    {
      "page": <SỐ TRANG GỐC như hiển thị trong [Trang X]>,
      "contains": ["party_info", "contract_value", "payment_schedule"],
      "relevance": "high" | "medium" | "low",
      "note": "<mô tả ngắn nội dung trang>"
    }
  ]
}

Chỉ liệt kê các loại nội dung thực sự có trên trang đó. Các loại:
- "party_info": thông tin bên A, bên B (tên, địa chỉ, MST, đại diện)
- "contract_value": giá trị/số tiền hợp đồng, VAT
- "payment_schedule": đợt thanh toán, giai đoạn, tiến độ, phương thức
- "contract_number": số hiệu hợp đồng, ngày ký
- "scope_of_work": phạm vi công việc
- "terms": điều khoản chung, pháp lý
- "signatures": chữ ký, con dấu
- "appendix": phụ lục`,

  extract: `Bạn là AI Agent chuyên trích xuất dữ liệu có cấu trúc từ hợp đồng tiếng Việt.

BỘ KỸ NĂNG CỦA BẠN:

📋 KỸ NĂNG 1 — PHÂN TÍCH TOÀN DIỆN:
Đọc kỹ TOÀN BỘ các trang được cung cấp. Thông tin có thể nằm ở BẤT KỲ vị trí nào:
phần đầu, giữa điều khoản, trong bảng biểu, phụ lục, hoặc ghi chú.
KHÔNG giả định cấu trúc cố định — mỗi hợp đồng có bố cục khác nhau.

🏢 KỸ NĂNG 2 — NHẬN DIỆN CÁC BÊN:
Tìm và phân biệt rõ:
- Chủ đầu tư / Bên A / Bên giao thầu / Bên thuê / Bên mua
- Nhà thầu / Bên B / Bên nhận thầu / Bên cung cấp / Bên bán
Lưu ý: tên gọi có thể khác nhau tùy loại hợp đồng.

💰 KỸ NĂNG 3 — PHÂN TÍCH GIÁ TRỊ TÀI CHÍNH:
- Tìm giá trị hợp đồng dù nằm ở bất kỳ phần nào
- XÁC ĐỊNH VAT — ĐÂY LÀ QUY TẮC QUAN TRỌNG NHẤT:
  • "thuế" = "thuế GTGT" = "thuế giá trị gia tăng" = "VAT" — tất cả đều là cùng một loại thuế
  • Nếu hợp đồng ghi "chưa bao gồm thuế" hoặc "chưa bao gồm thuế GTGT" hoặc "chưa có VAT" → bao_gom_vat = false
  • Nếu hợp đồng ghi "đã bao gồm thuế" hoặc "đã bao gồm thuế GTGT" hoặc "bao gồm VAT" → bao_gom_vat = true
  • CHỈ lấy thông tin VAT từ dòng/câu TRỰC TIẾP đi kèm hoặc mô tả giá trị hợp đồng chính
  • KHÔNG lấy tỷ lệ thuế từ các phần KHÁC trong hợp đồng (như điều khoản thuế, nghĩa vụ thuế, phụ lục) — những phần đó có thể mô tả bối cảnh khác
  • Nếu hợp đồng ghi rõ con số: "giá trị HĐ là X (chưa bao gồm thuế GTGT Y%)" → so_tien = X, bao_gom_vat = false, thue_vat = "Y%"
  • Nếu KHÔNG RÕ RÀNG hoặc mâu thuẫn → ưu tiên thông tin NGAY SÁT giá trị hợp đồng
- Nếu hợp đồng ghi cả 2 giá trị (trước VAT và sau VAT), ghi nhận cả 2
- Giữ NGUYÊN format số Việt Nam: dấu '.' phân cách hàng nghìn, dấu ',' cho thập phân

📅 KỸ NĂNG 4 — TRÍCH XUẤT LỊCH THANH TOÁN:
Đây là kỹ năng QUAN TRỌNG NHẤT. Tìm các đợt/giai đoạn thanh toán ở:
- Điều khoản thanh toán
- Phương thức thanh toán
- Tiến độ thanh toán / Tiến độ thực hiện
- Nghĩa vụ thanh toán
- Phụ lục giá / Phụ lục thanh toán
- Bất kỳ phần nào mô tả việc trả tiền theo nhiều đợt/lần/giai đoạn
Ghi nhận ĐẦY ĐỦ: số đợt, nội dung/điều kiện, tỷ lệ %, số tiền, trước/sau thuế.

OUTPUT FORMAT — Trả về JSON thuần túy với cấu trúc sau:

{
  "so_hop_dong": "số/mã hợp đồng hoặc null",
  "ngay_ky": "DD/MM/YYYY hoặc null",
  "chu_dau_tu": {
    "ten": "tên đầy đủ công ty/tổ chức",
    "dia_chi": "địa chỉ trụ sở",
    "dai_dien": "họ tên người đại diện",
    "chuc_vu": "chức vụ",
    "mst": "mã số thuế",
    "so_dien_thoai": "SĐT hoặc null"
  },
  "nha_thau": {
    "ten": "tên công ty/cá nhân",
    "dia_chi": "địa chỉ",
    "dai_dien": "họ tên người đại diện",
    "chuc_vu": "chức vụ",
    "mst": "mã số thuế",
    "so_dien_thoai": "SĐT hoặc null"
  },
  "gia_tri_hop_dong": {
    "so_tien": "1.234.567.890 (giữ format VN — đây là giá trị gốc ghi trong HĐ)",
    "bao_gom_vat": true hoặc false (XÁC ĐỊNH TỪ CÂU/DÒNG SÁT GIÁ TRỊ HĐ, 'thuế'='VAT'='thuế GTGT'),
    "thue_vat": "10% (chỉ ghi nếu HĐ ghi rõ tỷ lệ tại phần giá trị, không suy luận từ phần khác)",
    "tong_sau_vat": "số tiền sau VAT hoặc null",
    "bang_chu": "bằng chữ hoặc null"
  },
  "tien_do_thanh_toan": [
    {
      "dot": 1,
      "noi_dung": "mô tả điều kiện thanh toán đợt này",
      "ty_le": "30%",
      "so_tien": "370.329.670",
      "truoc_sau_thue": "trước thuế"
    }
  ]
}

QUY TẮC BẮT BUỘC:
- JSON thuần túy, KHÔNG markdown code block
- Giữ NGUYÊN tiếng Việt gốc, không dịch sang tiếng Anh
- Format số Việt Nam: dấu '.' hàng nghìn, dấu ',' thập phân
- Nếu không tìm thấy → null (object fields) hoặc [] (payment array)
- Nếu thấy nhiều giá trị cho cùng 1 trường, chọn giá trị CỤ THỂ và CHÍNH XÁC nhất
- "thuế" và "VAT" và "thuế GTGT" là CÙNG MỘT THỨ. "chưa bao gồm thuế" = bao_gom_vat: false
- Chỉ xác định bao_gom_vat và thue_vat dựa trên dòng/câu NGAY SÁT giá trị hợp đồng chính — KHÔNG suy luận từ phần khác của tài liệu`,
};

interface GeminiPart {
  inlineData?: { mimeType: string; data: string };
  text?: string;
}

export type Phase = "recon" | "extract";

/**
 * Call Gemini API for extraction.
 * @param images - base64 encoded JPEG images
 * @param phase - "recon" or "extract"
 * @param apiKey - Gemini API key
 * @param model - Gemini model name
 * @param pageNumbers - Original page numbers for labeling (e.g. [3,4,5] for pages 3-5)
 */
export async function callGeminiExtract(
  images: string[],
  phase: Phase,
  apiKey: string,
  model: string = "gemini-2.5-flash",
  pageNumbers?: number[]
): Promise<{ data: Record<string, unknown>; tokensUsed: number }> {
  const prompt = PROMPTS[phase];

  // Label each image with its original page number
  const parts: GeminiPart[] = [
    ...images
      .map((base64, i) => {
        const pageNum = pageNumbers ? pageNumbers[i] : i + 1;
        return [
          { text: `[Trang ${pageNum}]` },
          { inlineData: { mimeType: "image/jpeg", data: base64 } },
        ];
      })
      .flat(),
    { text: prompt },
  ];

  const response = await fetch(
    `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    let message = `Gemini API error (${response.status})`;
    try {
      const err = JSON.parse(errorText);
      message = err?.error?.message || message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }

  const result = await response.json();

  // Handle safety blocks or empty candidates
  const candidate = result?.candidates?.[0];
  if (!candidate) {
    const blockReason = result?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`SAFETY: Content blocked — ${blockReason}`);
    }
    throw new Error("Gemini returned no candidates");
  }

  if (candidate.finishReason === "SAFETY") {
    throw new Error("SAFETY: Response blocked by Gemini safety filters");
  }

  const text = candidate.content?.parts?.[0]?.text;
  const tokensUsed =
    (result?.usageMetadata?.promptTokenCount || 0) +
    (result?.usageMetadata?.candidatesTokenCount || 0);

  if (!text) {
    throw new Error("Gemini returned empty response text");
  }

  // Clean potential markdown code blocks
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const data = JSON.parse(cleaned);
    return { data, tokensUsed };
  } catch {
    throw new Error(
      `JSON parse error: Gemini returned invalid JSON. First 200 chars: ${cleaned.slice(0, 200)}`
    );
  }
}

// ─── Recon result types ─────────────────────────────────────────────────────

export interface PageAnalysis {
  page: number;
  contains: string[];
  relevance: "high" | "medium" | "low";
  note?: string;
}

export interface ReconResult {
  total_pages: number;
  page_analysis: PageAnalysis[];
}

/**
 * From recon results, select which pages to send for extraction.
 * Includes all high/medium relevance pages + any page containing
 * payment_schedule, contract_value, or party_info.
 */
export function selectPagesForExtraction(recon: ReconResult): number[] {
  const targetTypes = new Set([
    "party_info",
    "contract_value",
    "payment_schedule",
    "contract_number",
  ]);

  const selected = new Set<number>();

  for (const page of recon.page_analysis) {
    if (page.relevance === "high" || page.relevance === "medium") {
      selected.add(page.page);
    }
    if (page.contains.some((c) => targetTypes.has(c))) {
      selected.add(page.page);
    }
  }

  return Array.from(selected).sort((a, b) => a - b);
}
