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
  ScanSearch,
  BrainCircuit,
  ShieldAlert,
  RefreshCw,
  ScanLine,
  Layers,
  Info,
  Database,
  Zap,
  Trash2,
  Pencil,
  Save,
} from "lucide-react";
import type {
  ExtractionResult,
  PartyInfo,
  ContractValue,
  PaymentMilestone,
  PageImage,
  PhaseStatus,
  ExtractResponse,
  ScanMode,
  OCRMode,
  AppError,
} from "@/lib/types";
import { classifyError } from "@/lib/types";
import type { ReconResult } from "@/lib/gemini";
import { selectPagesForExtraction } from "@/lib/gemini";
import {
  generateFingerprint,
  getCachedResult,
  setCachedResult,
  getAllCacheEntries,
  clearAllCache,
  deleteCacheEntry,
  buildCacheLabel,
  type CacheEntry,
} from "@/lib/cache";

// ─── PDF Renderer (only renders requested page range) ───────────────────────

async function renderPdfPages(
  file: File,
  pageRange?: { from: number; to: number },
  onProgress?: (current: number, total: number) => void
): Promise<{ pages: PageImage[]; totalPdfPages: number }> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPdfPages = pdf.numPages;

  // Determine which pages to render
  const startPage = pageRange ? Math.max(1, pageRange.from) : 1;
  const endPage = pageRange
    ? Math.min(totalPdfPages, pageRange.to)
    : totalPdfPages;
  const pageCount = endPage - startPage + 1;

  const pages: PageImage[] = [];
  let rendered = 0;

  for (let i = startPage; i <= endPage; i++) {
    rendered++;
    onProgress?.(rendered, pageCount);
    const page = await pdf.getPage(i);

    // High quality for extraction (scale 2.0 for crisp text)
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = dataUrl.split(",")[1];

    // Low quality for recon
    const lowViewport = page.getViewport({ scale: 0.5 });
    const lowCanvas = document.createElement("canvas");
    lowCanvas.width = lowViewport.width;
    lowCanvas.height = lowViewport.height;
    const lowCtx = lowCanvas.getContext("2d")!;
    await page.render({ canvasContext: lowCtx, viewport: lowViewport }).promise;

    const base64Low = lowCanvas.toDataURL("image/jpeg", 0.4).split(",")[1];

    // pageNumber = original PDF page number
    pages.push({ pageNumber: i, dataUrl, base64, base64Low });
  }

  return { pages, totalPdfPages };
}

async function imageFileToPageImage(file: File): Promise<PageImage> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ pageNumber: 1, dataUrl, base64, base64Low: base64 });
    };
    reader.readAsDataURL(file);
  });
}

// ─── Excel Export ───────────────────────────────────────────────────────────

async function exportToExcel(result: ExtractionResult, fileName: string) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

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

// ─── Constants ──────────────────────────────────────────────────────────────

const DIRECT_EXTRACT_THRESHOLD = 5;

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

// ─── Main Component ─────────────────────────────────────────────────────────

export default function HomePage() {
  // Core state
  const [appState, setAppState] = useState<AppState>("idle");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-3-flash-preview");
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [totalPdfPages, setTotalPdfPages] = useState(0);
  const [result, setResult] = useState<ExtractionResult>(DEFAULT_RESULT);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [showSecurity, setShowSecurity] = useState(false);

  // Scan mode
  const [scanMode, setScanMode] = useState<ScanMode>("all");
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(10);

  // OCR mode
  const [ocrMode, setOcrMode] = useState<OCRMode>("gemini-vision");
  const [ocrAvailable, setOcrAvailable] = useState<boolean | null>(null);

  // Phase statuses
  const [reconStatus, setReconStatus] = useState<PhaseStatus>("idle");
  const [extractStatus, setExtractStatus] = useState<PhaseStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [reconInfo, setReconInfo] = useState("");

  // Error handling
  const [appError, setAppError] = useState<AppError | null>(null);

  // Cache
  const [cacheHit, setCacheHit] = useState<CacheEntry | null>(null);
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([]);
  const [showCachePanel, setShowCachePanel] = useState(false);
  const [currentFingerprint, setCurrentFingerprint] = useState<string>("");
  const [resultEdited, setResultEdited] = useState(false);
  const [cacheSaved, setCacheSaved] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Load settings from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("contractocr_apikey");
    if (saved) setApiKey(saved);
    const savedModel = localStorage.getItem("contractocr_model");
    if (savedModel) setModel(savedModel);
    const savedOcrMode = localStorage.getItem("contractocr_ocrmode");
    if (savedOcrMode) setOcrMode(savedOcrMode as OCRMode);
  }, []);

  // Check if VietOCR backend is available
  useEffect(() => {
    fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images: [] }) })
      .then((r) => {
        // 400 = server reachable but bad request; 503 = no OCR_API_URL
        setOcrAvailable(r.status !== 503);
        if (r.status !== 503 && ocrMode === "gemini-vision") {
          setOcrMode("vietocr");
          localStorage.setItem("contractocr_ocrmode", "vietocr");
        }
      })
      .catch(() => setOcrAvailable(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (apiKey) localStorage.setItem("contractocr_apikey", apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (model) localStorage.setItem("contractocr_model", model);
  }, [model]);

  // ─── File handling ──────────────────────────────────────────────────

  const handleFile = useCallback(
    async (f: File) => {
      setFile(f);
      setAppError(null);
      setResult(DEFAULT_RESULT);
      setTotalTokens(0);
      setReconStatus("idle");
      setExtractStatus("idle");
      setReconInfo("");

      setAppState("uploading");
      setStatusMessage("Đang đọc file...");

      try {
        if (f.type === "application/pdf") {
          const range =
            scanMode === "range"
              ? { from: rangeFrom, to: rangeTo }
              : undefined;
          const { pages: pageImages, totalPdfPages: total } =
            await renderPdfPages(f, range, (current, count) => {
              setStatusMessage(`Đang render trang ${current}/${count}...`);
            });
          setPages(pageImages);
          setTotalPdfPages(total);

          // Auto-adjust rangeTo if it exceeds total
          if (rangeTo > total) setRangeTo(total);

          setStatusMessage(
            range
              ? `${pageImages.length} trang (${range.from}-${range.to} / ${total} trang)`
              : `${total} trang`
          );

          // Check cache
          const fp = await generateFingerprint(
            pageImages[0].base64,
            f.name,
            f.size,
            pageImages.length
          );
          setCurrentFingerprint(fp);
          const cached = await getCachedResult(fp);
          setCacheHit(cached);
        } else {
          const img = await imageFileToPageImage(f);
          setPages([img]);
          setTotalPdfPages(1);
          setStatusMessage("1 trang");

          // Check cache for images too
          const fp = await generateFingerprint(
            img.base64,
            f.name,
            f.size,
            1
          );
          setCurrentFingerprint(fp);
          const cached = await getCachedResult(fp);
          setCacheHit(cached);
        }
        setAppState("idle");
      } catch (err) {
        setAppError({
          code: "UNKNOWN",
          message: "Lỗi đọc file",
          detail: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
        setAppState("idle");
      }
    },
    [scanMode, rangeFrom, rangeTo]
  );

  const reloadWithRange = useCallback(() => {
    if (file) handleFile(file);
  }, [file, handleFile]);

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

  // ─── API call helpers ──────────────────────────────────────────────

  const callExtract = async (
    images: string[],
    phase: "recon" | "extract",
    pageNumbers?: number[]
  ): Promise<ExtractResponse> => {
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, phase, apiKey, model, pageNumbers }),
      });

      if (!res.ok && res.status === 413) {
        return {
          success: false,
          error: "Dữ liệu quá lớn",
          errorCode: "PAYLOAD_TOO_LARGE",
        };
      }

      return await res.json();
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Lỗi kết nối",
        errorCode: "NETWORK_ERROR",
      };
    }
  };

  const callExtractWithText = async (
    ocrText: string
  ): Promise<ExtractResponse> => {
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ocrText, apiKey, model }),
      });
      return await res.json();
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Lỗi kết nối",
        errorCode: "NETWORK_ERROR",
      };
    }
  };

  const callOCR = async (
    images: string[],
    pageNumbers?: number[]
  ): Promise<{ success: boolean; full_text: string; error?: string }> => {
    try {
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, pageNumbers }),
      });
      return await res.json();
    } catch (err) {
      return {
        success: false,
        full_text: "",
        error: err instanceof Error ? err.message : "Lỗi kết nối OCR server",
      };
    }
  };

  // ─── Smart extraction with agent ───────────────────────────────────

  const startExtraction = useCallback(async () => {
    if (!apiKey || !file) return;

    setAppState("processing");
    setAppError(null);
    setResult(DEFAULT_RESULT);
    setTotalTokens(0);
    setReconInfo("");
    let tokens = 0;

    // Auto-reload pages if scan mode/range changed since last render
    let currentPages = pages;
    if (file.type === "application/pdf") {
      const range =
        scanMode === "range"
          ? { from: rangeFrom, to: rangeTo }
          : undefined;

      // Check if current pages match the expected range
      const expectedStart = range ? range.from : 1;
      const firstPage = currentPages[0]?.pageNumber;
      const needsReload =
        currentPages.length === 0 ||
        firstPage !== expectedStart ||
        (range && currentPages.length !== range.to - range.from + 1) ||
        (!range && currentPages.length !== totalPdfPages);

      if (needsReload) {
        setStatusMessage("Đang tải lại trang theo phân vùng...");
        try {
          const { pages: reloaded } = await renderPdfPages(
            file,
            range,
            (current, count) => {
              setStatusMessage(`Đang render trang ${current}/${count}...`);
            }
          );
          currentPages = reloaded;
          setPages(reloaded);
        } catch (err) {
          setAppError({
            code: "UNKNOWN",
            message: "Lỗi render PDF",
            detail: err instanceof Error ? err.message : String(err),
            retryable: true,
          });
          setAppState("idle");
          return;
        }
      }
    }

    if (currentPages.length === 0) return;

    const allPageNumbers = currentPages.map((p) => p.pageNumber);

    // ── VietOCR mode: OCR → text → Gemini structuring ──
    if (ocrMode === "vietocr") {
      setReconStatus("done");
      setReconInfo("VietOCR mode — skipping visual recon");

      setExtractStatus("processing");
      setStatusMessage(
        `VietOCR đang nhận dạng chữ từ ${currentPages.length} trang...`
      );

      const ocrRes = await callOCR(
        currentPages.map((p) => p.base64),
        allPageNumbers
      );

      if (!ocrRes.success || !ocrRes.full_text) {
        // Fallback to Gemini Vision if OCR fails
        setStatusMessage("VietOCR lỗi — chuyển sang Gemini Vision...");
        setOcrMode("gemini-vision");
        // Continue below with Gemini Vision flow
      } else {
        setStatusMessage("Gemini đang trích xuất dữ liệu từ OCR text...");

        const extractRes = await callExtractWithText(ocrRes.full_text);

        if (!extractRes.success) {
          setExtractStatus("error");
          const classified = classifyError(500, extractRes.error || "");
          setAppError(classified);
          setAppState("results");
          return;
        }

        tokens += extractRes.tokensUsed || 0;
        setTotalTokens(tokens);

        const d = extractRes.data as Record<string, unknown>;
        setResult({
          chu_dau_tu:
            (d.chu_dau_tu as PartyInfo) || DEFAULT_RESULT.chu_dau_tu,
          nha_thau: (d.nha_thau as PartyInfo) || DEFAULT_RESULT.nha_thau,
          gia_tri_hop_dong:
            (d.gia_tri_hop_dong as ContractValue) ||
            DEFAULT_RESULT.gia_tri_hop_dong,
          tien_do_thanh_toan:
            (d.tien_do_thanh_toan as PaymentMilestone[]) || [],
          so_hop_dong: (d.so_hop_dong as string) || null,
          ngay_ky: (d.ngay_ky as string) || null,
        });

        setExtractStatus("done");
        setAppError(null);
        setResultEdited(false);
        setCacheSaved(false);
        setStatusMessage("Hoàn thành!");
        setAppState("results");
        return;
      }
    }

    // ── Gemini Vision mode: image-based extraction ──
    const isShortDoc = currentPages.length <= DIRECT_EXTRACT_THRESHOLD;

    let extractPageNumbers: number[];

    if (isShortDoc) {
      setReconStatus("done");
      setReconInfo(
        `${pages.length} trang → quét trực tiếp tất cả`
      );
      extractPageNumbers = allPageNumbers;
    } else {
      // Recon phase with low-res images
      setReconStatus("processing");
      setStatusMessage(
        `Agent đang phân tích bố cục ${pages.length} trang...`
      );

      try {
        const lowResImages = currentPages.map((p) => p.base64Low || p.base64);
        const reconRes = await callExtract(
          lowResImages,
          "recon",
          allPageNumbers
        );

        if (!reconRes.success) {
          setReconStatus("error");
          const classified = classifyError(500, reconRes.error || "");
          setAppError(classified);

          // Fallback: extract all pages
          extractPageNumbers = allPageNumbers;
          setReconInfo(
            `Recon lỗi → fallback quét tất cả ${pages.length} trang`
          );
          setReconStatus("done");
        } else {
          tokens += reconRes.tokensUsed || 0;
          setTotalTokens(tokens);

          const reconData = reconRes.data as unknown as ReconResult;
          extractPageNumbers = selectPagesForExtraction(reconData);

          // Ensure at least the first page in scope
          if (extractPageNumbers.length === 0) {
            extractPageNumbers = [allPageNumbers[0]];
          }

          setReconInfo(
            `${pages.length} trang → Agent chọn ${extractPageNumbers.length} trang: [${extractPageNumbers.join(", ")}]`
          );
          setReconStatus("done");
        }
      } catch (err) {
        setReconStatus("error");
        // Fallback
        extractPageNumbers = allPageNumbers;
        setReconInfo(
          `Recon lỗi → fallback quét tất cả ${pages.length} trang`
        );
        setReconStatus("done");
        console.error("Recon error:", err);
      }
    }

    // Extract phase
    setExtractStatus("processing");
    setStatusMessage(
      `Agent đang trích xuất dữ liệu từ ${extractPageNumbers.length} trang...`
    );

    try {
      const extractImages = extractPageNumbers.map((pn) => {
        const page = currentPages.find((p) => p.pageNumber === pn);
        return page!.base64;
      });

      const extractRes = await callExtract(
        extractImages,
        "extract",
        extractPageNumbers
      );

      if (!extractRes.success) {
        setExtractStatus("error");
        const classified = classifyError(500, extractRes.error || "");
        setAppError(classified);
        setAppState("results");
        return;
      }

      tokens += extractRes.tokensUsed || 0;
      setTotalTokens(tokens);

      const d = extractRes.data as Record<string, unknown>;
      setResult({
        chu_dau_tu:
          (d.chu_dau_tu as PartyInfo) || DEFAULT_RESULT.chu_dau_tu,
        nha_thau: (d.nha_thau as PartyInfo) || DEFAULT_RESULT.nha_thau,
        gia_tri_hop_dong:
          (d.gia_tri_hop_dong as ContractValue) ||
          DEFAULT_RESULT.gia_tri_hop_dong,
        tien_do_thanh_toan:
          (d.tien_do_thanh_toan as PaymentMilestone[]) || [],
        so_hop_dong: (d.so_hop_dong as string) || null,
        ngay_ky: (d.ngay_ky as string) || null,
      });

      setExtractStatus("done");
      setAppError(null); // Clear any previous recon error
      setResultEdited(false);
      setCacheSaved(false);
    } catch (err) {
      setExtractStatus("error");
      const classified = classifyError(
        500,
        err instanceof Error ? err.message : String(err)
      );
      setAppError(classified);
    }

    setStatusMessage("Hoàn thành!");
    setAppState("results");
  }, [apiKey, model, pages, file, scanMode, rangeFrom, rangeTo, totalPdfPages, currentFingerprint, ocrMode]);

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
    setTotalPdfPages(0);
    setResult(DEFAULT_RESULT);
    setAppError(null);
    setReconStatus("idle");
    setExtractStatus("idle");
    setTotalTokens(0);
    setStatusMessage("");
    setReconInfo("");
    setCacheHit(null);
    setCurrentFingerprint("");
    setResultEdited(false);
    setCacheSaved(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ─── Cache actions ─────────────────────────────────────────────────

  const useCachedResultAction = useCallback(() => {
    if (!cacheHit) return;
    setResult(cacheHit.result);
    setTotalTokens(0);
    setReconStatus("done");
    setExtractStatus("done");
    setReconInfo(`Cache hit — kết quả từ phiên trước (${cacheHit.scannedPages} trang, ${cacheHit.tokensUsed.toLocaleString()} tokens)`);
    setAppState("results");
  }, [cacheHit]);

  const loadCacheEntries = useCallback(async () => {
    const entries = await getAllCacheEntries();
    setCacheEntries(entries);
  }, []);

  const handleClearCache = useCallback(async () => {
    await clearAllCache();
    setCacheEntries([]);
    setCacheHit(null);
  }, []);

  const handleSaveToCache = useCallback(async () => {
    if (!currentFingerprint || !file) return;
    await setCachedResult({
      fingerprint: currentFingerprint,
      fileName: file.name,
      result,
      tokensUsed: totalTokens,
      scannedPages: pages.length,
      createdAt: Date.now(),
      label: buildCacheLabel(result),
    });
    setCacheSaved(true);
  }, [currentFingerprint, file, result, totalTokens, pages.length]);

  const handleDeleteCacheEntry = useCallback(async (fp: string) => {
    await deleteCacheEntry(fp);
    setCacheEntries((prev) => prev.filter((e) => e.fingerprint !== fp));
    if (cacheHit?.fingerprint === fp) setCacheHit(null);
  }, [cacheHit]);

  // ─── Render helpers ─────────────────────────────────────────────────

  const PhaseIndicator = ({
    icon: Icon,
    label,
    status,
    detail,
  }: {
    icon: React.ElementType;
    label: string;
    status: PhaseStatus;
    detail?: string;
  }) => (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5">
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
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
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
        {detail && (
          <p className="text-xs text-gray-400 mt-0.5 ml-5 break-words">
            {detail}
          </p>
        )}
      </div>
    </div>
  );

  // Editable state
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (fieldPath: string, currentValue: string | null | undefined) => {
    setEditingField(fieldPath);
    setEditValue(currentValue || "");
  };

  const saveEdit = (fieldPath: string) => {
    const newResult = { ...result };
    const parts = fieldPath.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any = newResult;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = editValue || null;
    setResult(newResult);
    setEditingField(null);
    setResultEdited(true);
  };

  const InfoRow = ({
    label,
    value,
    fieldPath,
  }: {
    label: string;
    value: string | null | undefined;
    fieldPath?: string;
  }) => (
    <div className="flex justify-between items-start py-2 border-b border-gray-50 last:border-0 group">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide min-w-[100px]">
        {label}
      </span>
      {editingField === fieldPath ? (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && fieldPath) saveEdit(fieldPath);
              if (e.key === "Escape") setEditingField(null);
            }}
            className="text-sm text-gray-900 font-medium text-right border border-blue-300 rounded px-2 py-0.5 outline-none focus:ring-2 focus:ring-blue-200 w-48"
            autoFocus
          />
          <button
            onClick={() => fieldPath && saveEdit(fieldPath)}
            className="p-0.5 text-blue-500 hover:text-blue-700"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-900 text-right font-medium">
            {value || (
              <span className="text-gray-300 italic font-normal">
                Không tìm thấy
              </span>
            )}
          </span>
          {fieldPath && appState === "results" && (
            <button
              onClick={() => startEdit(fieldPath, value)}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-300 hover:text-blue-500 transition-all"
              title="Sửa"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );

  // ─── Error Banner Component ─────────────────────────────────────────

  const ErrorBanner = ({ error, onRetry }: { error: AppError; onRetry?: () => void }) => (
    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 animate-fade-in">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-red-800">
              {error.message}
            </p>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-mono">
              {error.code}
            </span>
          </div>
          {error.detail && (
            <p className="text-xs text-red-600 mt-1">{error.detail}</p>
          )}
          {error.retryable && onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-red-700 hover:text-red-900 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Thử lại
            </button>
          )}
        </div>
        <button
          onClick={() => setAppError(null)}
          className="text-red-400 hover:text-red-600 flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
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
                Nabu PDF
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
              onClick={() => {
                setShowCachePanel(!showCachePanel);
                if (!showCachePanel) loadCacheEntries();
              }}
              className="btn-secondary !px-2 !py-2"
              title="Cache"
            >
              <Database className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSecurity(!showSecurity)}
              className="btn-secondary !px-2 !py-2"
              title="Bảo mật"
            >
              <ShieldAlert className="w-4 h-4" />
            </button>
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

        {/* Security info panel */}
        {showSecurity && (
          <div className="border-t border-gray-100 bg-amber-50/80 backdrop-blur-xl animate-fade-in">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800 space-y-1.5">
                  <p className="font-semibold text-sm">Chính sách bảo mật dữ liệu</p>
                  <ul className="space-y-1 list-disc list-inside text-amber-700">
                    <li>
                      Ảnh tài liệu được gửi đến <strong>Google Gemini API</strong> để phân tích.
                      Google xử lý dữ liệu theo{" "}
                      <a
                        href="https://ai.google.dev/gemini-api/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline font-medium"
                      >
                        Điều khoản Gemini API
                      </a>
                      . Với API key trả phí, Google <strong>không</strong> sử dụng dữ liệu để huấn luyện model.
                    </li>
                    <li>
                      API Key lưu trong <strong>localStorage trình duyệt</strong> của bạn — không gửi đến server nào ngoài Gemini.
                    </li>
                    <li>
                      <strong>Không có dữ liệu nào</strong> (ảnh, kết quả, API key) được lưu trữ trên server Nabu PDF.
                    </li>
                    <li>
                      Toàn bộ xử lý PDF → ảnh diễn ra <strong>trong trình duyệt</strong> (client-side).
                    </li>
                  </ul>
                  <p className="text-amber-600 italic">
                    Khuyến nghị: với tài liệu mật cấp cao, nên cân nhắc sử dụng Gemini API plan trả phí
                    (đảm bảo data không dùng để train) hoặc tự host model riêng.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Cache panel */}
        {showCachePanel && (
          <div className="border-t border-gray-100 bg-white/95 backdrop-blur-xl animate-fade-in">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-gray-500" />
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Semantic Cache
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">
                    {cacheEntries.length} mục
                  </span>
                </div>
                {cacheEntries.length > 0 && (
                  <button
                    onClick={handleClearCache}
                    className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    Xóa tất cả
                  </button>
                )}
              </div>
              {cacheEntries.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  Chưa có kết quả nào được cache. Sau khi quét và kiểm tra kết quả, bấm &quot;Lưu vào cache&quot; để lưu.
                </p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-thin">
                  {cacheEntries.map((entry) => (
                    <div
                      key={entry.fingerprint}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-gray-50 border border-gray-100"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-700 truncate">
                          {entry.fileName}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {entry.label} &mdash; {entry.scannedPages} trang &mdash;{" "}
                          {new Date(entry.createdAt).toLocaleDateString("vi-VN", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteCacheEntry(entry.fingerprint)}
                        className="ml-2 p-1.5 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
                        title="Xóa"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings dropdown */}
        {showSettings && (
          <div className="border-t border-gray-100 bg-white/95 backdrop-blur-xl animate-fade-in">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                  <option value="gemini-3-flash-preview">
                    Gemini 3 Flash (Recommended)
                  </option>
                  <option value="gemini-3.1-pro-preview">
                    Gemini 3.1 Pro (Best accuracy)
                  </option>
                  <option value="gemini-3.1-flash-lite-preview">
                    Gemini 3.1 Flash Lite (Fastest)
                  </option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  OCR Mode
                </label>
                <select
                  className="input-field text-sm"
                  value={ocrMode}
                  onChange={(e) => {
                    const v = e.target.value as OCRMode;
                    setOcrMode(v);
                    localStorage.setItem("contractocr_ocrmode", v);
                  }}
                >
                  <option value="vietocr" disabled={!ocrAvailable}>
                    VietOCR + PaddleOCR (Docker){!ocrAvailable ? " — unavailable" : ""}
                  </option>
                  <option value="gemini-vision">
                    Gemini Vision (Cloud)
                  </option>
                </select>
                <p className="text-[10px] text-gray-400 mt-1">
                  {ocrAvailable
                    ? "VietOCR server detected — text-based mode active"
                    : ocrAvailable === null
                      ? "Checking OCR server..."
                      : "OCR server offline — using Gemini Vision"}
                </p>
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
                Mở Settings (icon gear) ở góc phải trên, nhập API key từ Google
                AI Studio.
              </p>
            </div>
          </div>
        )}

        {/* Error banner */}
        {appError && (
          <ErrorBanner
            error={appError}
            onRetry={
              appError.retryable
                ? () => {
                    setAppError(null);
                    startExtraction();
                  }
                : undefined
            }
          />
        )}

        {/* Upload Zone */}
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
                      ? statusMessage ||
                        `${pages.length} trang | ${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : "PDF, JPG, PNG, TIFF"}
                  </p>
                  {file && pages.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2 justify-center">
                      {pages.slice(0, 8).map((p) => (
                        <div
                          key={p.pageNumber}
                          className="relative w-12 h-16 rounded-lg overflow-hidden border border-gray-200 shadow-sm cursor-pointer hover:border-blue-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            const idx = pages.findIndex(
                              (pg) => pg.pageNumber === p.pageNumber
                            );
                            setPreviewPage(idx);
                            setShowPreview(true);
                          }}
                        >
                          <img
                            src={p.dataUrl}
                            alt={`Trang ${p.pageNumber}`}
                            className="w-full h-full object-contain"
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[8px] text-center py-0.5">
                            {p.pageNumber}
                          </div>
                        </div>
                      ))}
                      {pages.length > 8 && (
                        <div className="w-12 h-16 rounded-lg border border-gray-200 flex items-center justify-center text-xs text-gray-400">
                          +{pages.length - 8}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Scan Mode selector — shown after file upload */}
            {file && pages.length > 0 && appState === "idle" && (
              <div className="mt-4 card p-4 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-3">
                  <ScanLine className="w-4 h-4 text-gray-500" />
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Chế độ quét
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 mb-3">
                  <button
                    onClick={() => {
                      setScanMode("all");
                      if (file && scanMode !== "all") {
                        // Will re-render when extraction starts
                      }
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                      scanMode === "all"
                        ? "bg-blue-50 border-blue-300 text-blue-700"
                        : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Quét tất cả ({totalPdfPages} trang)
                  </button>
                  <button
                    onClick={() => setScanMode("range")}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                      scanMode === "range"
                        ? "bg-blue-50 border-blue-300 text-blue-700"
                        : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <ScanSearch className="w-3.5 h-3.5" />
                    Quét phân vùng
                  </button>
                </div>

                {scanMode === "range" && (
                  <div className="animate-fade-in">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Từ trang</span>
                      <input
                        type="number"
                        min={1}
                        max={totalPdfPages}
                        value={rangeFrom}
                        onChange={(e) =>
                          setRangeFrom(
                            Math.max(1, Math.min(totalPdfPages, Number(e.target.value) || 1))
                          )
                        }
                        className="input-field !w-20 text-sm text-center"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="text-xs text-gray-500">đến trang</span>
                      <input
                        type="number"
                        min={rangeFrom}
                        max={totalPdfPages}
                        value={rangeTo}
                        onChange={(e) =>
                          setRangeTo(
                            Math.max(
                              rangeFrom,
                              Math.min(totalPdfPages, Number(e.target.value) || rangeFrom)
                            )
                          )
                        }
                        className="input-field !w-20 text-sm text-center"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="text-xs text-gray-400">
                        / {totalPdfPages} trang
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          reloadWithRange();
                        }}
                        className="btn-secondary text-xs !py-1.5"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Tải lại
                      </button>
                    </div>
                    <div className="flex items-start gap-1.5 mt-2">
                      <Info className="w-3 h-3 text-blue-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-blue-500">
                        Chỉ render và gửi trang trong phạm vi. Tiết kiệm thời gian render
                        và token cho tài liệu lớn (100+ trang).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Cache hit banner */}
            {file && pages.length > 0 && appState === "idle" && cacheHit && (
              <div className="mt-4 card p-4 animate-fade-in border-emerald-200 bg-emerald-50/50">
                <div className="flex items-start gap-3">
                  <Zap className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-emerald-800">
                      Tài liệu đã được quét trước đó
                    </p>
                    <p className="text-xs text-emerald-600 mt-0.5">
                      {cacheHit.label} &mdash; {cacheHit.scannedPages} trang,{" "}
                      {cacheHit.tokensUsed.toLocaleString()} tokens &mdash;{" "}
                      {new Date(cacheHit.createdAt).toLocaleDateString("vi-VN", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={useCachedResultAction}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                      >
                        <Zap className="w-3.5 h-3.5" />
                        Dùng kết quả cache (0 token)
                      </button>
                      <button
                        onClick={() => setCacheHit(null)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition-colors"
                      >
                        Quét lại
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Action buttons */}
            {file && pages.length > 0 && appState === "idle" && (
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
            <div className="flex items-center gap-3 mb-5">
              <Loader2 className="w-5 h-5 text-blue-500 spinner" />
              <span className="text-sm font-medium text-gray-700">
                {statusMessage}
              </span>
            </div>
            <div className="space-y-4">
              <PhaseIndicator
                icon={ScanSearch}
                label={
                  pages.length > DIRECT_EXTRACT_THRESHOLD
                    ? "Phân tích bố cục tài liệu"
                    : "Phân tích tài liệu"
                }
                status={reconStatus}
                detail={reconInfo || undefined}
              />
              <PhaseIndicator
                icon={BrainCircuit}
                label="Trích xuất dữ liệu hợp đồng"
                status={extractStatus}
              />
            </div>
            {totalTokens > 0 && (
              <p className="text-xs text-gray-400 mt-4">
                Tokens: {totalTokens.toLocaleString()}
              </p>
            )}
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
                  <span className="text-xs text-gray-400">{file.name}</span>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={handleCopyJSON}
                  className="btn-secondary text-xs"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copied ? "Đã copy" : "Copy JSON"}
                </button>
                <button
                  onClick={handleExportJSON}
                  className="btn-secondary text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  JSON
                </button>
                <button
                  onClick={handleExportExcel}
                  className="btn-secondary text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  Excel
                </button>
                <button onClick={handleReset} className="btn-secondary text-xs">
                  <Upload className="w-3.5 h-3.5" />
                  File mới
                </button>
              </div>
            </div>

            {/* Editable hint + save to cache */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-[11px] text-gray-400 flex items-center gap-1">
                <Pencil className="w-3 h-3" />
                Hover vào giá trị để chỉnh sửa
                {resultEdited && (
                  <span className="text-amber-500 font-medium ml-1">
                    (đã chỉnh sửa)
                  </span>
                )}
              </p>
              {currentFingerprint && (
                <button
                  onClick={handleSaveToCache}
                  disabled={cacheSaved}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    cacheSaved
                      ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                      : "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                  }`}
                >
                  {cacheSaved ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Đã lưu cache
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      Lưu vào cache
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Recon summary badge */}
            {reconInfo && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50/50 border border-blue-100">
                <ScanSearch className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                <span className="text-xs text-blue-600">{reconInfo}</span>
              </div>
            )}

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
                  <InfoRow label="Địa chỉ" value={result.chu_dau_tu?.dia_chi} fieldPath="chu_dau_tu.dia_chi" />
                  <InfoRow label="Đại diện" value={result.chu_dau_tu?.dai_dien} fieldPath="chu_dau_tu.dai_dien" />
                  <InfoRow label="Chức vụ" value={result.chu_dau_tu?.chuc_vu} fieldPath="chu_dau_tu.chuc_vu" />
                  <InfoRow label="MST" value={result.chu_dau_tu?.mst} fieldPath="chu_dau_tu.mst" />
                  <InfoRow label="SĐT" value={result.chu_dau_tu?.so_dien_thoai} fieldPath="chu_dau_tu.so_dien_thoai" />
                </div>
              </div>

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
                  <InfoRow label="Địa chỉ" value={result.nha_thau?.dia_chi} fieldPath="nha_thau.dia_chi" />
                  <InfoRow label="Đại diện" value={result.nha_thau?.dai_dien} fieldPath="nha_thau.dai_dien" />
                  <InfoRow label="Chức vụ" value={result.nha_thau?.chuc_vu} fieldPath="nha_thau.chuc_vu" />
                  <InfoRow label="MST" value={result.nha_thau?.mst} fieldPath="nha_thau.mst" />
                  <InfoRow label="SĐT" value={result.nha_thau?.so_dien_thoai} fieldPath="nha_thau.so_dien_thoai" />
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
                  <InfoRow label="Thuế VAT" value={result.gia_tri_hop_dong?.thue_vat} fieldPath="gia_tri_hop_dong.thue_vat" />
                  <InfoRow label="Sau VAT" value={result.gia_tri_hop_dong?.tong_sau_vat} fieldPath="gia_tri_hop_dong.tong_sau_vat" />
                  <InfoRow label="Bằng chữ" value={result.gia_tri_hop_dong?.bang_chu} fieldPath="gia_tri_hop_dong.bang_chu" />
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
                          <td className="font-semibold text-center">{p.dot}</td>
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

            {/* Token usage / cache indicator */}
            <p className="text-center text-xs text-gray-400">
              {totalTokens > 0 ? (
                <>Tổng tokens: {totalTokens.toLocaleString()} | Model: {model}</>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-500">
                  <Zap className="w-3 h-3" />
                  Kết quả từ cache — 0 token
                </span>
              )}
            </p>
          </div>
        )}

        {/* Idle state - info cards */}
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
                title: "AI Agent",
                desc: "Agent thông minh phân tích bố cục & trích xuất chính xác",
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
                  Trang {pages[previewPage]?.pageNumber} / {totalPdfPages}
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
                alt={`Trang ${pages[previewPage]?.pageNumber}`}
                className="max-w-full h-auto rounded-lg shadow-lg"
              />
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center py-6 text-xs text-gray-400">
        Nabu PDF &mdash; Powered by Google Gemini Vision AI
      </footer>
    </div>
  );
}
