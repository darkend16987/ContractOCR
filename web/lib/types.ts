/** Thông tin một bên trong hợp đồng */
export interface PartyInfo {
  ten: string | null;
  dia_chi: string | null;
  dai_dien: string | null;
  chuc_vu: string | null;
  mst: string | null;
  so_dien_thoai: string | null;
}

/** Giá trị hợp đồng */
export interface ContractValue {
  so_tien: string | null;
  bao_gom_vat: boolean | null;
  thue_vat: string | null;
  tong_sau_vat: string | null;
  bang_chu: string | null;
}

/** Một đợt thanh toán */
export interface PaymentMilestone {
  dot: number | string;
  noi_dung: string;
  ty_le: string | null;
  so_tien: string | null;
  truoc_sau_thue: string | null;
}

/** Kết quả trích xuất đầy đủ */
export interface ExtractionResult {
  chu_dau_tu: PartyInfo;
  nha_thau: PartyInfo;
  gia_tri_hop_dong: ContractValue;
  tien_do_thanh_toan: PaymentMilestone[];
  so_hop_dong: string | null;
  ngay_ky: string | null;
}

/** Trạng thái xử lý từng phase */
export type PhaseStatus = "idle" | "processing" | "done" | "error";

/** Chế độ quét */
export type ScanMode = "all" | "range";

/** Chế độ OCR */
export type OCRMode = "gemini-vision" | "vietocr";

/** Page image data */
export interface PageImage {
  pageNumber: number;
  dataUrl: string; // base64 data URL for preview
  base64: string; // raw base64 without data URL prefix
  base64Low?: string; // low-quality base64 for recon phase
}

/** API request/response */
export interface ExtractRequest {
  images: string[]; // base64 strings
  phase: "recon" | "extract";
  apiKey: string;
  model?: string;
  /** Original page numbers for labeling (e.g. [3,4,5,6]) */
  pageNumbers?: number[];
}

export interface ExtractResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: ErrorCode;
  tokensUsed?: number;
}

/** Categorized error codes for better UX */
export type ErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "QUOTA_EXCEEDED"
  | "MODEL_NOT_FOUND"
  | "CONTENT_FILTERED"
  | "PAYLOAD_TOO_LARGE"
  | "PARSE_ERROR"
  | "NETWORK_ERROR"
  | "GEMINI_ERROR"
  | "UNKNOWN";

export interface AppError {
  code: ErrorCode;
  message: string;
  detail?: string;
  retryable: boolean;
}

/** Map HTTP status / error message to AppError */
export function classifyError(
  status: number,
  message: string
): AppError {
  if (message.includes("API key not valid") || message.includes("API_KEY_INVALID")) {
    return {
      code: "INVALID_API_KEY",
      message: "API Key không hợp lệ",
      detail: "Kiểm tra lại API key tại Google AI Studio. Key phải bắt đầu bằng 'AIza...'",
      retryable: false,
    };
  }
  if (status === 429 || message.includes("quota") || message.includes("RATE_LIMIT")) {
    return {
      code: "QUOTA_EXCEEDED",
      message: "Hết quota hoặc bị giới hạn tốc độ",
      detail: "Gemini API có giới hạn request/phút. Đợi 1 phút rồi thử lại, hoặc nâng cấp plan.",
      retryable: true,
    };
  }
  if (status === 404 || message.includes("not found") || message.includes("NOT_FOUND")) {
    return {
      code: "MODEL_NOT_FOUND",
      message: "Model không tồn tại",
      detail: "Model đã chọn không khả dụng. Thử đổi sang model khác trong Settings.",
      retryable: false,
    };
  }
  if (message.includes("SAFETY") || message.includes("blocked") || message.includes("RECITATION")) {
    return {
      code: "CONTENT_FILTERED",
      message: "Nội dung bị lọc bởi Gemini Safety",
      detail: "Gemini từ chối xử lý nội dung này. Thử lại hoặc dùng model khác.",
      retryable: true,
    };
  }
  if (status === 413 || message.includes("too large") || message.includes("payload")) {
    return {
      code: "PAYLOAD_TOO_LARGE",
      message: "Dữ liệu quá lớn",
      detail: "Giảm số trang quét bằng tính năng 'Quét phân vùng' hoặc giảm chất lượng ảnh.",
      retryable: false,
    };
  }
  if (message.includes("JSON") || message.includes("parse") || message.includes("Unexpected token")) {
    return {
      code: "PARSE_ERROR",
      message: "Lỗi phân tích kết quả từ AI",
      detail: "Gemini trả về dữ liệu không hợp lệ. Thử lại — kết quả có thể khác.",
      retryable: true,
    };
  }
  if (message.includes("fetch") || message.includes("network") || message.includes("ECONNREFUSED")) {
    return {
      code: "NETWORK_ERROR",
      message: "Lỗi kết nối mạng",
      detail: "Không thể kết nối đến Gemini API. Kiểm tra kết nối internet.",
      retryable: true,
    };
  }
  return {
    code: "GEMINI_ERROR",
    message: "Lỗi từ Gemini API",
    detail: message,
    retryable: true,
  };
}
