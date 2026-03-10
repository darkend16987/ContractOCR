import { NextRequest, NextResponse } from "next/server";
import { callGeminiExtract } from "@/lib/gemini";
import type { ExtractRequest, ExtractResponse } from "@/lib/types";

export const maxDuration = 120; // Allow up to 120s for large documents

export async function POST(req: NextRequest): Promise<NextResponse<ExtractResponse>> {
  try {
    const body: ExtractRequest = await req.json();

    const apiKey = body.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "Thiếu Gemini API Key" },
        { status: 400 }
      );
    }

    if (!body.images || body.images.length === 0) {
      return NextResponse.json(
        { success: false, error: "Không có ảnh để xử lý" },
        { status: 400 }
      );
    }

    const model = body.model || "gemini-2.5-flash";

    const { data, tokensUsed } = await callGeminiExtract(
      body.images,
      body.phase,
      apiKey,
      model
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
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
