"""Gemini AI Agent for extracting structured data from OCR text."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Default contract fields for Vietnamese formal contracts
DEFAULT_CONTRACT_FIELDS = {
    "so_hop_dong": "Số hợp đồng",
    "ngay_ky": "Ngày ký hợp đồng",
    "ben_a_ten": "Tên bên A",
    "ben_a_dia_chi": "Địa chỉ bên A",
    "ben_a_dai_dien": "Người đại diện bên A",
    "ben_a_chuc_vu": "Chức vụ người đại diện bên A",
    "ben_a_mst": "Mã số thuế bên A",
    "ben_b_ten": "Tên bên B",
    "ben_b_dia_chi": "Địa chỉ bên B",
    "ben_b_dai_dien": "Người đại diện bên B",
    "ben_b_chuc_vu": "Chức vụ người đại diện bên B",
    "ben_b_mst": "Mã số thuế bên B",
    "noi_dung": "Nội dung/mục đích hợp đồng (tóm tắt)",
    "gia_tri": "Giá trị hợp đồng",
    "don_vi_tien": "Đơn vị tiền tệ",
    "thoi_han": "Thời hạn hợp đồng",
    "dieu_khoan_thanh_toan": "Điều khoản thanh toán (tóm tắt)",
}


class GeminiAgent:
    """AI Agent using Google Gemini to extract structured data from contract text.

    Uses the new google-genai SDK with structured JSON output support.
    """

    def __init__(
        self,
        api_key: str,
        model_name: str = "gemini-2.5-flash",
        fields: dict[str, str] | None = None,
    ):
        self.api_key = api_key
        self.model_name = model_name
        self.fields = fields or DEFAULT_CONTRACT_FIELDS
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self.api_key)
            logger.info("Gemini client initialized: %s", self.model_name)
        return self._client

    def _build_extraction_prompt(self, ocr_text: str, custom_fields: dict[str, str] | None = None) -> str:
        """Build the prompt for contract field extraction."""
        fields = custom_fields or self.fields
        fields_description = "\n".join(
            f'  - "{key}": {desc}' for key, desc in fields.items()
        )

        return f"""Bạn là một chuyên gia phân tích hợp đồng tiếng Việt.
Nhiệm vụ: Trích xuất thông tin từ văn bản hợp đồng dưới đây vào các trường đã cho.

QUY TẮC:
1. Trả về KẾT QUẢ DẠNG JSON THUẦN TÚY, không có markdown code block, không có giải thích.
2. Nếu không tìm thấy thông tin cho một trường, để giá trị là null.
3. Giữ nguyên nội dung gốc tiếng Việt, không dịch.
4. Với các trường số (giá trị, mã số thuế), giữ nguyên format gốc.
5. Với ngày tháng, chuẩn hóa về dạng DD/MM/YYYY nếu có thể.

CÁC TRƯỜNG CẦN TRÍCH XUẤT:
{fields_description}

VĂN BẢN HỢP ĐỒNG (từ OCR):
---
{ocr_text}
---

Trả về JSON với đúng các key đã liệt kê ở trên."""

    def _generate(self, prompt: str, system_instruction: str | None = None) -> str:
        """Call Gemini API and return response text."""
        from google.genai import types

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1,
        )
        if system_instruction:
            config.system_instruction = system_instruction

        response = self.client.models.generate_content(
            model=self.model_name,
            contents=prompt,
            config=config,
        )
        return response.text.strip()

    def extract_fields(
        self,
        ocr_text: str,
        custom_fields: dict[str, str] | None = None,
        max_retries: int = 2,
    ) -> dict[str, Any]:
        """Extract structured fields from OCR text using Gemini.

        Args:
            ocr_text: Raw text from OCR
            custom_fields: Optional custom fields to extract (overrides defaults)
            max_retries: Number of retries if JSON parsing fails

        Returns:
            Dictionary with extracted field values
        """
        if not ocr_text.strip():
            logger.warning("Empty OCR text provided")
            return {key: None for key in (custom_fields or self.fields)}

        prompt = self._build_extraction_prompt(ocr_text, custom_fields)

        for attempt in range(max_retries + 1):
            try:
                text = self._generate(
                    prompt,
                    system_instruction="Bạn là chuyên gia trích xuất dữ liệu hợp đồng tiếng Việt. Luôn trả về JSON hợp lệ.",
                )

                result = json.loads(text)
                logger.info("Successfully extracted %d fields", len(result))
                return result

            except json.JSONDecodeError as e:
                logger.warning(
                    "JSON parse error (attempt %d/%d): %s",
                    attempt + 1, max_retries + 1, e,
                )
                if attempt < max_retries:
                    prompt = (
                        f"Lần trước bạn trả về JSON không hợp lệ. "
                        f"Hãy CHỈ trả về JSON thuần túy, không có text nào khác.\n\n"
                        f"{prompt}"
                    )
                else:
                    logger.error("Failed to parse Gemini response after %d attempts", max_retries + 1)
                    return {key: None for key in (custom_fields or self.fields)}

            except Exception as e:
                logger.error("Gemini API error: %s", e)
                raise

    def classify_document(self, ocr_text: str) -> dict[str, str]:
        """Classify the type of document from OCR text.

        Returns dict with 'loai_van_ban' (type) and 'do_tin_cay' (confidence).
        """
        prompt = f"""Phân loại văn bản sau thuộc loại nào. Trả về JSON với 2 trường:
- "loai_van_ban": loại văn bản (vd: "Hợp đồng mua bán", "Hợp đồng dịch vụ", "Hợp đồng lao động", "Phụ lục hợp đồng", "Biên bản", "Khác")
- "do_tin_cay": "cao", "trung_binh", hoặc "thap"

VĂN BẢN:
{ocr_text[:2000]}"""

        try:
            text = self._generate(prompt)
            return json.loads(text)
        except Exception as e:
            logger.error("Classification failed: %s", e)
            return {"loai_van_ban": "Không xác định", "do_tin_cay": "thap"}
