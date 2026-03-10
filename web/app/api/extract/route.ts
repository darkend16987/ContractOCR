import { NextRequest, NextResponse } from "next/server";
import { callGeminiExtract } from "@/lib/gemini";
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

    const body: ExtractRequest = await req.json();

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

    // Basic API key format check
    if (
      typeof apiKey !== "string" ||
      apiKey.length < 10
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "API Key không hợp lệ",
          errorCode: "INVALID_API_KEY" as const,
        },
        { status: 400 }
      );
    }

    // Validate images
    if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Không có ảnh để xử lý",
          errorCode: "UNKNOWN" as const,
        },
        { status: 400 }
      );
    }

    // Validate phase
    if (!["recon", "extract"].includes(body.phase)) {
      return NextResponse.json(
        {
          success: false,
          error: "Phase không hợp lệ",
          errorCode: "UNKNOWN" as const,
        },
        { status: 400 }
      );
    }

    const model = body.model || "gemini-3-flash-preview";

    const { data, tokensUsed } = await callGeminiExtract(
      body.images,
      body.phase,
      apiKey,
      model,
      body.pageNumbers
    );

    return NextResponse.json({
      success: true,
      data,
      tokensUsed,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Lỗi không xác định";
    console.error("Extract API error:", message);

    // Classify the error for frontend
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
