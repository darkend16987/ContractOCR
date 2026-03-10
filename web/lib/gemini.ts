/**
 * Gemini API integration with smart prompting for Vietnamese contract extraction.
 *
 * Strategy:
 * - Phase 1 (pages 1-3): Extract Party A, Party B, contract value, contract number, date
 * - Phase 2 (pages 3-8): Extract payment schedule/milestones
 * - Phase 3 (remaining): Only if needed, scan for missing data
 */

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const PHASE_PROMPTS = {
  basic_info: `Bạn là chuyên gia phân tích hợp đồng xây dựng/thương mại tiếng Việt.

Từ các trang hợp đồng dưới đây, trích xuất CHÍNH XÁC các thông tin sau:

1. SỐ HỢP ĐỒNG (so_hop_dong): Mã số hoặc số hiệu hợp đồng
2. NGÀY KÝ (ngay_ky): Ngày ký hợp đồng, chuẩn hóa DD/MM/YYYY

3. CHỦ ĐẦU TƯ / BÊN A (chu_dau_tu):
   - ten: Tên đầy đủ công ty/tổ chức
   - dia_chi: Địa chỉ trụ sở
   - dai_dien: Họ tên người đại diện
   - chuc_vu: Chức vụ người đại diện
   - mst: Mã số thuế
   - so_dien_thoai: Số điện thoại (nếu có)

4. NHÀ THẦU / BÊN B (nha_thau):
   - ten: Tên đầy đủ công ty/cá nhân
   - dia_chi: Địa chỉ
   - dai_dien: Họ tên người đại diện
   - chuc_vu: Chức vụ người đại diện
   - mst: Mã số thuế
   - so_dien_thoai: Số điện thoại (nếu có)

5. GIÁ TRỊ HỢP ĐỒNG (gia_tri_hop_dong):
   - so_tien: Số tiền (giữ NGUYÊN format Việt Nam, ví dụ: "1.234.567.890")
   - bao_gom_vat: true nếu đã bao gồm VAT, false nếu chưa
   - thue_vat: Phần trăm thuế VAT (ví dụ: "10%", "8%")
   - tong_sau_vat: Tổng sau VAT nếu ghi rõ (giữ format VN)
   - bang_chu: Số tiền bằng chữ nếu có

QUY TẮC QUAN TRỌNG:
- Trả về JSON thuần túy, KHÔNG có markdown code block
- Giữ NGUYÊN tiếng Việt gốc, không dịch
- Số tiền giữ format Việt Nam: dấu '.' phân cách hàng nghìn, dấu ',' cho thập phân
- Nếu không tìm thấy thông tin, để giá trị null
- Phân biệt rõ "đã bao gồm VAT" vs "chưa bao gồm VAT"`,

  payment_schedule: `Bạn là chuyên gia phân tích hợp đồng tiếng Việt.

Từ các trang hợp đồng dưới đây, trích xuất TIẾN ĐỘ THANH TOÁN / CÁC ĐỢT THANH TOÁN / PHƯƠNG THỨC THANH TOÁN.

Trả về JSON với key "tien_do_thanh_toan" là một mảng, mỗi phần tử gồm:
- dot: Số đợt (1, 2, 3, ...)
- noi_dung: Mô tả nội dung/điều kiện thanh toán đợt đó (ví dụ: "Tạm ứng sau khi ký hợp đồng", "Sau khi nghiệm thu hoàn thành 50% khối lượng")
- ty_le: Tỷ lệ phần trăm nếu có (ví dụ: "30%")
- so_tien: Số tiền cụ thể nếu có (giữ format Việt Nam, ví dụ: "370.329.670")
- truoc_sau_thue: "trước thuế" hoặc "sau thuế" hoặc "đã bao gồm VAT"

QUY TẮC:
- Trả về JSON thuần túy, KHÔNG có markdown code block
- Giữ NGUYÊN tiếng Việt gốc
- Giữ format số Việt Nam (dấu '.' phân cách hàng nghìn)
- Nếu không tìm thấy đợt thanh toán nào, trả về: {"tien_do_thanh_toan": []}
- Lưu ý: phần thanh toán có thể nằm trong điều khoản "Phương thức thanh toán", "Tiến độ thanh toán", "Điều kiện thanh toán", hoặc tương tự`,

  supplement: `Bạn là chuyên gia phân tích hợp đồng tiếng Việt.

Các trang trước đã được quét nhưng CÒN THIẾU một số thông tin. Hãy quét các trang bổ sung dưới đây để tìm thông tin còn thiếu.

Trích xuất BẤT KỲ thông tin nào bạn tìm thấy liên quan đến:
- Thông tin bên A (chủ đầu tư) và bên B (nhà thầu)
- Giá trị hợp đồng
- Các đợt thanh toán

QUY TẮC:
- Trả về JSON thuần túy
- Chỉ trả về các trường bạn TÌM THẤY, không trả về trường null
- Giữ format số Việt Nam`,
};

interface GeminiPart {
  inlineData?: { mimeType: string; data: string };
  text?: string;
}

export async function callGeminiExtract(
  images: string[],
  phase: keyof typeof PHASE_PROMPTS,
  apiKey: string,
  model: string = "gemini-2.5-flash"
): Promise<{ data: Record<string, unknown>; tokensUsed: number }> {
  const prompt = PHASE_PROMPTS[phase];

  const parts: GeminiPart[] = [
    ...images.map((base64) => ({
      inlineData: { mimeType: "image/jpeg", data: base64 },
    })),
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
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  const tokensUsed =
    (result?.usageMetadata?.promptTokenCount || 0) +
    (result?.usageMetadata?.candidatesTokenCount || 0);

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  // Clean potential markdown code blocks
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const data = JSON.parse(cleaned);
  return { data, tokensUsed };
}
