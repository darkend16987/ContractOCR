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

export interface ProcessingState {
  phase1: PhaseStatus; // Basic info (Party A, B, contract value)
  phase2: PhaseStatus; // Payment schedule
  phase3: PhaseStatus; // Supplement (if needed)
  currentMessage: string;
  totalPages: number;
  pagesProcessed: number;
}

/** Page image data */
export interface PageImage {
  pageNumber: number;
  dataUrl: string; // base64 data URL
  base64: string; // raw base64 without prefix
}

/** API request/response */
export interface ExtractRequest {
  images: string[]; // base64 strings
  phase: "basic_info" | "payment_schedule" | "supplement";
  apiKey: string;
  model?: string;
  existingData?: Partial<ExtractionResult>;
}

export interface ExtractResponse {
  success: boolean;
  data?: Partial<ExtractionResult>;
  error?: string;
  tokensUsed?: number;
}
