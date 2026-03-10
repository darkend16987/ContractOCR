import { NextRequest, NextResponse } from "next/server";
import { callGeminiExtract, callGeminiWithText } from "@/lib/gemini";
import type { ExtractRequest, ExtractResponse } from "@/lib/types";
import { classifyError } from "@/lib/types";

export const maxDuration = 120;

export async function POST(
  req: NextRequest
): Promise<NextResponse<ExtractResponse>> {
  try {
    // Validate content type
    const contentType = req.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return NextResponse.json(
        {
          success: false,
          error: "Content-Type phải là application/json",
          errorCode: "UNKNOWN" as const,
        },
        { status: 415 }
      );
    }

    const body = await req.json();

    // Validate API key
    const apiKey = body.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: "Thiếu Gemini API Key",
          errorCode: "MISSING_API_KEY" as const,
        },
        { status: 400 }
      );
    }

    if (typeof apiKey !== "string" || apiKey.length < 10) {
      return NextResponse.json(
        {
          success: false,
          error: "API Key không hợp lệ",
          errorCode: "INVALID_API_KEY" as const,
        },
        { status: 400 }
      );
    }

    const model = body.model || "gemini-3-flash-preview";

    // Text-based extraction (from OCR server)
    if (body.ocrText && typeof body.ocrText === "string") {
      const { data, tokensUsed } = await callGeminiWithText(
        body.ocrText,
        apiKey,
        model
      );
      return NextResponse.json({ success: true, data, tokensUsed });
    }

    // Image-based extraction (fallback / Vercel-only mode)
    const extractBody = body as ExtractRequest;

    if (
      !extractBody.images ||
      !Array.isArray(extractBody.images) ||
      extractBody.images.length === 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Không có ảnh hoặc text OCR để xử lý",
          errorCode: "UNKNOWN" as const,
        },
        { status: 400 }
      );
    }

    if (!["recon", "extract"].includes(extractBody.phase)) {
      return NextResponse.json(
        {
          success: false,
          error: "Phase không hợp lệ",
          errorCode: "UNKNOWN" as const,
        },
        { status: 400 }
      );
    }

    const { data, tokensUsed } = await callGeminiExtract(
      extractBody.images,
      extractBody.phase,
      apiKey,
      model,
      extractBody.pageNumbers
    );

    return NextResponse.json({ success: true, data, tokensUsed });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Lỗi không xác định";
    console.error("Extract API error:", message);

    const appError = classifyError(500, message);

    return NextResponse.json(
      {
        success: false,
        error: appError.message,
        errorCode: appError.code,
      },
      { status: 500 }
    );
  }
}
