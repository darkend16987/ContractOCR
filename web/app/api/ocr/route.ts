import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

interface OCRRequestBody {
  images: string[];
  pageNumbers?: number[];
}

interface OCRPageResult {
  page_number: number;
  text: string;
}

interface OCRResponseBody {
  success: boolean;
  pages: OCRPageResult[];
  full_text: string;
  error?: string;
}

/**
 * Proxy OCR requests to the Python backend.
 * If OCR_API_URL is not set, returns an error indicating Docker setup is needed.
 */
export async function POST(
  req: NextRequest
): Promise<NextResponse<OCRResponseBody>> {
  const ocrApiUrl = process.env.OCR_API_URL;

  if (!ocrApiUrl) {
    return NextResponse.json(
      {
        success: false,
        pages: [],
        full_text: "",
        error:
          "OCR server không được cấu hình. Cần chạy docker-compose để sử dụng tính năng OCR chính xác (PaddleOCR + VietOCR).",
      },
      { status: 503 }
    );
  }

  try {
    const body: OCRRequestBody = await req.json();

    if (!body.images || body.images.length === 0) {
      return NextResponse.json(
        {
          success: false,
          pages: [],
          full_text: "",
          error: "Không có ảnh để xử lý",
        },
        { status: 400 }
      );
    }

    const response = await fetch(`${ocrApiUrl}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: body.images,
        page_numbers: body.pageNumbers,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        {
          success: false,
          pages: [],
          full_text: "",
          error: `OCR server error (${response.status}): ${errText}`,
        },
        { status: 502 }
      );
    }

    const data: OCRResponseBody = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Lỗi không xác định";
    console.error("OCR proxy error:", message);
    return NextResponse.json(
      {
        success: false,
        pages: [],
        full_text: "",
        error: `Không thể kết nối OCR server: ${message}`,
      },
      { status: 502 }
    );
  }
}
