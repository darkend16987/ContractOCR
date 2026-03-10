"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  Copy,
  Check,
  Settings,
  ChevronDown,
  ChevronUp,
  Building2,
  Banknote,
  CalendarClock,
  Sparkles,
  X,
  Eye,
} from "lucide-react";
import type {
  ExtractionResult,
  PartyInfo,
  ContractValue,
  PaymentMilestone,
  PageImage,
  PhaseStatus,
  ExtractResponse,
} from "@/lib/types";

// ─── PDF Renderer ───────────────────────────────────────────────────────────

async function renderPdfToImages(file: File): Promise<PageImage[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages: PageImage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 }); // Good balance quality/size
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const base64 = dataUrl.split(",")[1];
    pages.push({ pageNumber: i, dataUrl, base64 });
  }

  return pages;
}

async function imageFileToPageImage(file: File): Promise<PageImage> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ pageNumber: 1, dataUrl, base64 });
    };
    reader.readAsDataURL(file);
  });
}

// ─── Excel Export ───────────────────────────────────────────────────────────

async function exportToExcel(result: ExtractionResult, fileName: string) {
  const XLSX = await import("xlsx");

  const wb = XLSX.utils.book_new();

  // Sheet 1: Thông tin chung
  const infoData = [
    ["Trường", "Giá trị"],
    ["Số hợp đồng", result.so_hop_dong || ""],
    ["Ngày ký", result.ngay_ky || ""],
    [""],
    ["--- CHỦ ĐẦU TƯ / BÊN A ---"],
    ["Tên", result.chu_dau_tu?.ten || ""],
    ["Địa chỉ", result.chu_dau_tu?.dia_chi || ""],
    ["Người đại diện", result.chu_dau_tu?.dai_dien || ""],
    ["Chức vụ", result.chu_dau_tu?.chuc_vu || ""],
    ["MST", result.chu_dau_tu?.mst || ""],
    ["SĐT", result.chu_dau_tu?.so_dien_thoai || ""],
    [""],
    ["--- NHÀ THẦU / BÊN B ---"],
    ["Tên", result.nha_thau?.ten || ""],
    ["Địa chỉ", result.nha_thau?.dia_chi || ""],
    ["Người đại diện", result.nha_thau?.dai_dien || ""],
    ["Chức vụ", result.nha_thau?.chuc_vu || ""],
    ["MST", result.nha_thau?.mst || ""],
    ["SĐT", result.nha_thau?.so_dien_thoai || ""],
    [""],
    ["--- GIÁ TRỊ HỢP ĐỒNG ---"],
    ["Số tiền", result.gia_tri_hop_dong?.so_tien || ""],
    [
      "VAT",
      result.gia_tri_hop_dong?.bao_gom_vat
        ? "Đã bao gồm VAT"
        : "Chưa bao gồm VAT",
    ],
    ["Thuế VAT", result.gia_tri_hop_dong?.thue_vat || ""],
    ["Tổng sau VAT", result.gia_tri_hop_dong?.tong_sau_vat || ""],
    ["Bằng chữ", result.gia_tri_hop_dong?.bang_chu || ""],
  ];

  const ws1 = XLSX.utils.aoa_to_sheet(infoData);
  ws1["!cols"] = [{ wch: 20 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Thông tin chung");

  // Sheet 2: Tiến độ thanh toán
  if (result.tien_do_thanh_toan?.length) {
    const paymentData = [
      ["Đợt", "Nội dung", "Tỷ lệ", "Số tiền", "Trước/Sau thuế"],
      ...result.tien_do_thanh_toan.map((p) => [
        p.dot,
        p.noi_dung,
        p.ty_le || "",
        p.so_tien || "",
        p.truoc_sau_thue || "",
      ]),
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(paymentData);
    ws2["!cols"] = [
      { wch: 8 },
      { wch: 50 },
      { wch: 10 },
      { wch: 25 },
      { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, "Tiến độ thanh toán");
  }

  XLSX.writeFile(wb, fileName);
}

// ─── Main Component ─────────────────────────────────────────────────────────

type AppState = "idle" | "uploading" | "processing" | "results";

const DEFAULT_RESULT: ExtractionResult = {
  chu_dau_tu: {
    ten: null,
    dia_chi: null,
    dai_dien: null,
    chuc_vu: null,
    mst: null,
    so_dien_thoai: null,
  },
  nha_thau: {
    ten: null,
    dia_chi: null,
    dai_dien: null,
    chuc_vu: null,
    mst: null,
    so_dien_thoai: null,
  },
  gia_tri_hop_dong: {
    so_tien: null,
    bao_gom_vat: null,
    thue_vat: null,
    tong_sau_vat: null,
    bang_chu: null,
  },
  tien_do_thanh_toan: [],
  so_hop_dong: null,
  ngay_ky: null,
};

export default function HomePage() {
  // State
  const [appState, setAppState] = useState<AppState>("idle");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [result, setResult] = useState<ExtractionResult>(DEFAULT_RESULT);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  // Phase statuses
  const [phase1, setPhase1] = useState<PhaseStatus>("idle");
  const [phase2, setPhase2] = useState<PhaseStatus>("idle");
  const [phase3, setPhase3] = useState<PhaseStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Load API key from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("contractocr_apikey");
    if (saved) setApiKey(saved);
    const savedModel = localStorage.getItem("contractocr_model");
    if (savedModel) setModel(savedModel);
  }, []);

  // Save API key
  useEffect(() => {
    if (apiKey) localStorage.setItem("contractocr_apikey", apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (model) localStorage.setItem("contractocr_model", model);
  }, [model]);

  // ─── File handling ──────────────────────────────────────────────────

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setError(null);
    setResult(DEFAULT_RESULT);
    setTotalTokens(0);
    setPhase1("idle");
    setPhase2("idle");
    setPhase3("idle");

    setAppState("uploading");
    setStatusMessage("Đang đọc file...");

    try {
      let pageImages: PageImage[];
      if (f.type === "application/pdf") {
        pageImages = await renderPdfToImages(f);
      } else {
        const img = await imageFileToPageImage(f);
        pageImages = [img];
      }
      setPages(pageImages);
      setAppState("idle");
      setStatusMessage(`${pageImages.length} trang`);
    } catch (err) {
      setError(`Lỗi đọc file: ${err instanceof Error ? err.message : err}`);
      setAppState("idle");
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  // ─── Smart extraction ──────────────────────────────────────────────

  const callExtract = async (
    images: string[],
    phase: "basic_info" | "payment_schedule" | "supplement"
  ): Promise<ExtractResponse> => {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images, phase, apiKey, model }),
    });
    return res.json();
  };

  const startExtraction = useCallback(async () => {
    if (!apiKey || pages.length === 0) return;

    setAppState("processing");
    setError(null);
    setResult(DEFAULT_RESULT);
    setTotalTokens(0);
    let tokens = 0;
    let mergedResult: ExtractionResult = { ...DEFAULT_RESULT };

    // Phase 1: Basic info (pages 1-3)
    setPhase1("processing");
    setStatusMessage("Đang trích xuất thông tin Bên A, Bên B, giá trị HĐ...");
    try {
      const phase1Pages = pages.slice(0, Math.min(3, pages.length));
      const res1 = await callExtract(
        phase1Pages.map((p) => p.base64),
        "basic_info"
      );

      if (!res1.success) {
        setPhase1("error");
        setError(res1.error || "Lỗi Phase 1");
        setAppState("results");
        return;
      }

      tokens += res1.tokensUsed || 0;
      setTotalTokens(tokens);

      // Merge phase 1 data
      const d = res1.data as Record<string, unknown>;
      mergedResult = {
        ...mergedResult,
        chu_dau_tu: (d.chu_dau_tu as PartyInfo) || mergedResult.chu_dau_tu,
        nha_thau: (d.nha_thau as PartyInfo) || mergedResult.nha_thau,
        gia_tri_hop_dong:
          (d.gia_tri_hop_dong as ContractValue) ||
          mergedResult.gia_tri_hop_dong,
        so_hop_dong: (d.so_hop_dong as string) || mergedResult.so_hop_dong,
        ngay_ky: (d.ngay_ky as string) || mergedResult.ngay_ky,
      };
      setResult({ ...mergedResult });
      setPhase1("done");
    } catch (err) {
      setPhase1("error");
      setError(`Phase 1 error: ${err instanceof Error ? err.message : err}`);
      setAppState("results");
      return;
    }

    // Phase 2: Payment schedule (pages 3-8)
    if (pages.length > 1) {
      setPhase2("processing");
      setStatusMessage("Đang trích xuất tiến độ thanh toán...");
      try {
        const startPage = Math.max(0, Math.min(2, pages.length - 1));
        const endPage = Math.min(8, pages.length);
        const phase2Pages = pages.slice(startPage, endPage);
        const res2 = await callExtract(
          phase2Pages.map((p) => p.base64),
          "payment_schedule"
        );

        if (res2.success && res2.data) {
          tokens += res2.tokensUsed || 0;
          setTotalTokens(tokens);

          const d2 = res2.data as Record<string, unknown>;
          mergedResult = {
            ...mergedResult,
            tien_do_thanh_toan:
              (d2.tien_do_thanh_toan as PaymentMilestone[]) ||
              mergedResult.tien_do_thanh_toan,
          };
          setResult({ ...mergedResult });
        }
        setPhase2("done");
      } catch (err) {
        setPhase2("error");
        console.error("Phase 2 error:", err);
        // Non-critical, continue
      }

      // Phase 3: Supplement if payment not found and more pages available
      if (
        mergedResult.tien_do_thanh_toan.length === 0 &&
        pages.length > 8
      ) {
        setPhase3("processing");
        setStatusMessage("Đang quét thêm trang bổ sung...");
        try {
          const phase3Pages = pages.slice(8);
          const res3 = await callExtract(
            phase3Pages.map((p) => p.base64),
            "supplement"
          );

          if (res3.success && res3.data) {
            tokens += res3.tokensUsed || 0;
            setTotalTokens(tokens);

            const d3 = res3.data as Record<string, unknown>;
            if (d3.tien_do_thanh_toan) {
              mergedResult.tien_do_thanh_toan =
                d3.tien_do_thanh_toan as PaymentMilestone[];
            }
            setResult({ ...mergedResult });
          }
          setPhase3("done");
        } catch {
          setPhase3("error");
        }
      } else {
        setPhase3("done");
      }
    } else {
      setPhase2("done");
      setPhase3("done");
    }

    setStatusMessage("Hoàn thành!");
    setAppState("results");
  }, [apiKey, model, pages]);

  // ─── Exports ────────────────────────────────────────────────────────

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file?.name?.replace(/\.[^.]+$/, "")}_extracted.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = () => {
    exportToExcel(
      result,
      `${file?.name?.replace(/\.[^.]+$/, "")}_extracted.xlsx`
    );
  };

  const handleCopyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setAppState("idle");
    setFile(null);
    setPages([]);
    setResult(DEFAULT_RESULT);
    setError(null);
    setPhase1("idle");
    setPhase2("idle");
    setPhase3("idle");
    setTotalTokens(0);
    setStatusMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ─── Render helpers ─────────────────────────────────────────────────

  const PhaseIndicator = ({
    label,
    status,
  }: {
    label: string;
    status: PhaseStatus;
  }) => (
    <div className="flex items-center gap-2.5">
      {status === "idle" && (
        <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
      )}
      {status === "processing" && (
        <Loader2 className="w-5 h-5 text-blue-500 spinner" />
      )}
      {status === "done" && (
        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
      )}
      {status === "error" && (
        <AlertCircle className="w-5 h-5 text-red-500" />
      )}
      <span
        className={`text-sm font-medium ${
          status === "processing"
            ? "text-blue-700"
            : status === "done"
            ? "text-emerald-700"
            : status === "error"
            ? "text-red-600"
            : "text-gray-400"
        }`}
      >
        {label}
      </span>
    </div>
  );

  const InfoRow = ({
    label,
    value,
  }: {
    label: string;
    value: string | null | undefined;
  }) => (
    <div className="flex justify-between items-start py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide min-w-[100px]">
        {label}
      </span>
      <span className="text-sm text-gray-900 text-right font-medium">
        {value || <span className="text-gray-300 italic font-normal">Không tìm thấy</span>}
      </span>
    </div>
  );

  // ─── JSX ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold gradient-text leading-tight">
                ContractOCR
              </h1>
              <p className="text-[10px] text-gray-400 -mt-0.5 hidden sm:block">
                AI Contract Extraction
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {totalTokens > 0 && (
              <span className="text-xs text-gray-400 hidden sm:block">
                {totalTokens.toLocaleString()} tokens
              </span>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="btn-secondary !px-3 !py-2"
              title="Cài đặt"
            >
              <Settings className="w-4 h-4" />
              {showSettings ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>

        {/* Settings dropdown */}
        {showSettings && (
          <div className="border-t border-gray-100 bg-white/95 backdrop-blur-xl animate-fade-in">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  Gemini API Key
                </label>
                <input
                  type="password"
                  className="input-field text-sm"
                  placeholder="AIza..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  Model
                </label>
                <select
                  className="input-field text-sm"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="gemini-2.5-flash">
                    Gemini 2.5 Flash (Recommended)
                  </option>
                  <option value="gemini-2.5-pro">
                    Gemini 2.5 Pro (Best accuracy)
                  </option>
                  <option value="gemini-2.5-flash-lite">
                    Gemini 2.5 Flash Lite (Fastest)
                  </option>
                </select>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* API Key warning */}
        {!apiKey && (
          <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 animate-fade-in">
            <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">
                Cần nhập Gemini API Key
              </p>
              <p className="text-xs text-amber-600 mt-0.5">
                Mở Settings (icon gear) ở góc phải trên, nhập API key từ{" "}
                Google AI Studio.
              </p>
            </div>
          </div>
        )}

        {/* Upload Zone (visible when no results) */}
        {appState !== "results" && (
          <div className="mb-8">
            <div
              className={`upload-zone ${dragOver ? "drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
                className="hidden"
                onChange={onFileSelect}
              />

              {appState === "uploading" ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-10 h-10 text-blue-500 spinner" />
                  <p className="text-sm text-gray-500">{statusMessage}</p>
                </div>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
                    <Upload className="w-8 h-8 text-blue-500" />
                  </div>
                  <p className="text-base font-semibold text-gray-700 mb-1">
                    {file
                      ? file.name
                      : "Kéo thả hoặc bấm để chọn file"}
                  </p>
                  <p className="text-sm text-gray-400">
                    {file
                      ? `${pages.length} trang | ${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : "PDF, JPG, PNG, TIFF"}
                  </p>
                  {file && pages.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2 justify-center">
                      {pages.slice(0, 6).map((p) => (
                        <div
                          key={p.pageNumber}
                          className="relative w-12 h-16 rounded-lg overflow-hidden border border-gray-200 shadow-sm cursor-pointer hover:border-blue-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewPage(p.pageNumber - 1);
                            setShowPreview(true);
                          }}
                        >
                          <img
                            src={p.dataUrl}
                            alt={`Trang ${p.pageNumber}`}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[8px] text-center py-0.5">
                            {p.pageNumber}
                          </div>
                        </div>
                      ))}
                      {pages.length > 6 && (
                        <div className="w-12 h-16 rounded-lg border border-gray-200 flex items-center justify-center text-xs text-gray-400">
                          +{pages.length - 6}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Action buttons */}
            {file && pages.length > 0 && appState !== "processing" && (
              <div className="mt-4 flex justify-center gap-3 animate-fade-in">
                <button
                  onClick={startExtraction}
                  disabled={!apiKey}
                  className="btn-primary"
                >
                  <Sparkles className="w-4 h-4" />
                  Trích xuất hợp đồng
                </button>
                <button onClick={handleReset} className="btn-secondary">
                  <X className="w-4 h-4" />
                  Hủy
                </button>
              </div>
            )}
          </div>
        )}

        {/* Processing Status */}
        {appState === "processing" && (
          <div className="card p-6 mb-8 animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-5 h-5 text-blue-500 spinner" />
              <span className="text-sm font-medium text-gray-700">
                {statusMessage}
              </span>
            </div>
            <div className="space-y-3">
              <PhaseIndicator
                label="Thông tin Bên A, Bên B & Giá trị HĐ"
                status={phase1}
              />
              <PhaseIndicator
                label="Tiến độ thanh toán"
                status={phase2}
              />
              {pages.length > 8 && (
                <PhaseIndicator
                  label="Quét bổ sung"
                  status={phase3}
                />
              )}
            </div>
            {totalTokens > 0 && (
              <p className="text-xs text-gray-400 mt-4">
                Tokens sử dụng: {totalTokens.toLocaleString()}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 flex items-start gap-3 animate-fade-in">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">Lỗi xử lý</p>
              <p className="text-xs text-red-600 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Results */}
        {appState === "results" && (
          <div className="space-y-6 animate-fade-in">
            {/* Top bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700">
                  Kết quả trích xuất
                </span>
                {file && (
                  <span className="text-xs text-gray-400">
                    {file.name}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={handleCopyJSON} className="btn-secondary text-xs">
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copied ? "Đã copy" : "Copy JSON"}
                </button>
                <button onClick={handleExportJSON} className="btn-secondary text-xs">
                  <Download className="w-3.5 h-3.5" />
                  JSON
                </button>
                <button onClick={handleExportExcel} className="btn-secondary text-xs">
                  <Download className="w-3.5 h-3.5" />
                  Excel
                </button>
                <button onClick={handleReset} className="btn-secondary text-xs">
                  <Upload className="w-3.5 h-3.5" />
                  File mới
                </button>
              </div>
            </div>

            {/* Contract header info */}
            {(result.so_hop_dong || result.ngay_ky) && (
              <div className="card p-4 flex flex-wrap gap-6">
                {result.so_hop_dong && (
                  <div>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                      Số hợp đồng
                    </span>
                    <p className="text-base font-bold text-gray-900 mt-0.5">
                      {result.so_hop_dong}
                    </p>
                  </div>
                )}
                {result.ngay_ky && (
                  <div>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                      Ngày ký
                    </span>
                    <p className="text-base font-bold text-gray-900 mt-0.5">
                      {result.ngay_ky}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Parties */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Party A */}
              <div className="result-card">
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Chủ đầu tư / Bên A
                    </h3>
                    <p className="text-sm font-bold text-gray-900 leading-tight">
                      {result.chu_dau_tu?.ten || "—"}
                    </p>
                  </div>
                </div>
                <div className="space-y-0.5">
                  <InfoRow label="Địa chỉ" value={result.chu_dau_tu?.dia_chi} />
                  <InfoRow
                    label="Đại diện"
                    value={result.chu_dau_tu?.dai_dien}
                  />
                  <InfoRow label="Chức vụ" value={result.chu_dau_tu?.chuc_vu} />
                  <InfoRow label="MST" value={result.chu_dau_tu?.mst} />
                  <InfoRow label="SĐT" value={result.chu_dau_tu?.so_dien_thoai} />
                </div>
              </div>

              {/* Party B */}
              <div className="result-card">
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-violet-600" />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Nhà thầu / Bên B
                    </h3>
                    <p className="text-sm font-bold text-gray-900 leading-tight">
                      {result.nha_thau?.ten || "—"}
                    </p>
                  </div>
                </div>
                <div className="space-y-0.5">
                  <InfoRow label="Địa chỉ" value={result.nha_thau?.dia_chi} />
                  <InfoRow label="Đại diện" value={result.nha_thau?.dai_dien} />
                  <InfoRow label="Chức vụ" value={result.nha_thau?.chuc_vu} />
                  <InfoRow label="MST" value={result.nha_thau?.mst} />
                  <InfoRow label="SĐT" value={result.nha_thau?.so_dien_thoai} />
                </div>
              </div>
            </div>

            {/* Contract Value */}
            <div className="result-card">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <Banknote className="w-4 h-4 text-emerald-600" />
                </div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Giá trị hợp đồng
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <p className="text-2xl font-bold text-gray-900 mb-1">
                    {result.gia_tri_hop_dong?.so_tien || "—"}
                    <span className="text-sm font-normal text-gray-400 ml-2">
                      VNĐ
                    </span>
                  </p>
                  {result.gia_tri_hop_dong?.bao_gom_vat !== null && (
                    <span
                      className={`status-badge ${
                        result.gia_tri_hop_dong?.bao_gom_vat
                          ? "done"
                          : "processing"
                      }`}
                    >
                      {result.gia_tri_hop_dong?.bao_gom_vat
                        ? "Đã bao gồm VAT"
                        : "Chưa bao gồm VAT"}
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  <InfoRow
                    label="Thuế VAT"
                    value={result.gia_tri_hop_dong?.thue_vat}
                  />
                  <InfoRow
                    label="Sau VAT"
                    value={result.gia_tri_hop_dong?.tong_sau_vat}
                  />
                  <InfoRow
                    label="Bằng chữ"
                    value={result.gia_tri_hop_dong?.bang_chu}
                  />
                </div>
              </div>
            </div>

            {/* Payment Schedule */}
            <div className="result-card">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                  <CalendarClock className="w-4 h-4 text-amber-600" />
                </div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Tiến độ thanh toán
                </h3>
                {result.tien_do_thanh_toan?.length > 0 && (
                  <span className="status-badge done">
                    {result.tien_do_thanh_toan.length} đợt
                  </span>
                )}
              </div>

              {result.tien_do_thanh_toan?.length > 0 ? (
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th className="w-16">Đợt</th>
                        <th>Nội dung</th>
                        <th className="w-20">Tỷ lệ</th>
                        <th className="w-40">Số tiền (VNĐ)</th>
                        <th className="w-32">Thuế</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.tien_do_thanh_toan.map((p, i) => (
                        <tr key={i}>
                          <td className="font-semibold text-center">
                            {p.dot}
                          </td>
                          <td>{p.noi_dung}</td>
                          <td className="text-center font-medium">
                            {p.ty_le || "—"}
                          </td>
                          <td className="font-mono font-medium text-right">
                            {p.so_tien || "—"}
                          </td>
                          <td>
                            {p.truoc_sau_thue ? (
                              <span
                                className={`status-badge text-[10px] ${
                                  p.truoc_sau_thue.includes("sau") ||
                                  p.truoc_sau_thue.includes("bao gồm")
                                    ? "done"
                                    : "processing"
                                }`}
                              >
                                {p.truoc_sau_thue}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">
                  Không tìm thấy thông tin tiến độ thanh toán
                </p>
              )}
            </div>

            {/* Token usage */}
            {totalTokens > 0 && (
              <p className="text-center text-xs text-gray-400">
                Tổng tokens: {totalTokens.toLocaleString()} | Model: {model}
              </p>
            )}
          </div>
        )}

        {/* Idle state - info */}
        {appState === "idle" && !file && (
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                icon: Upload,
                color: "blue",
                title: "Upload",
                desc: "Kéo thả PDF hoặc ảnh hợp đồng tiếng Việt",
              },
              {
                icon: Sparkles,
                color: "violet",
                title: "AI Extraction",
                desc: "Gemini Vision AI tự động trích xuất dữ liệu quan trọng",
              },
              {
                icon: Download,
                color: "emerald",
                title: "Export",
                desc: "Xuất kết quả ra JSON hoặc Excel để sử dụng",
              },
            ].map((item, i) => (
              <div key={i} className="card-hover p-5 text-center">
                <div
                  className={`w-10 h-10 rounded-xl bg-${item.color}-50 flex items-center justify-center mx-auto mb-3`}
                >
                  <item.icon className={`w-5 h-5 text-${item.color}-500`} />
                </div>
                <h3 className="text-sm font-semibold text-gray-800 mb-1">
                  {item.title}
                </h3>
                <p className="text-xs text-gray-500">{item.desc}</p>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Page Preview Modal */}
      {showPreview && pages.length > 0 && (
        <div
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowPreview(false)}
        >
          <div
            className="relative max-w-3xl w-full max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">
                  Trang {previewPage + 1} / {pages.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn-secondary !px-3 !py-1.5 text-xs"
                  disabled={previewPage === 0}
                  onClick={() => setPreviewPage((p) => p - 1)}
                >
                  Trước
                </button>
                <button
                  className="btn-secondary !px-3 !py-1.5 text-xs"
                  disabled={previewPage === pages.length - 1}
                  onClick={() => setPreviewPage((p) => p + 1)}
                >
                  Sau
                </button>
                <button
                  className="btn-secondary !px-2 !py-1.5"
                  onClick={() => setShowPreview(false)}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-auto max-h-[calc(90vh-60px)] scrollbar-thin bg-gray-100 flex justify-center p-4">
              <img
                src={pages[previewPage]?.dataUrl}
                alt={`Trang ${previewPage + 1}`}
                className="max-w-full h-auto rounded-lg shadow-lg"
              />
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center py-6 text-xs text-gray-400">
        ContractOCR &mdash; Powered by Google Gemini Vision AI
      </footer>
    </div>
  );
}
