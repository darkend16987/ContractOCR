/**
 * Semantic Cache for Nabu PDF
 *
 * Fingerprint = SHA-256(first page image + fileName + fileSize + pageCount)
 * Storage = IndexedDB (much larger than localStorage)
 * TTL = 30 days
 */

import type { ExtractionResult } from "./types";

const DB_NAME = "contractocr_cache";
const DB_VERSION = 1;
const STORE_NAME = "results";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CacheEntry {
  fingerprint: string;
  fileName: string;
  result: ExtractionResult;
  tokensUsed: number;
  scannedPages: number;
  createdAt: number;
  /** Short label for display, e.g. "HĐ-001 | 12/01/2025" */
  label: string;
}

// ─── Fingerprint Generation ──────────────────────────────────────────────

/**
 * Generate a SHA-256 fingerprint from the first page image + file metadata.
 * Uses only a portion of the base64 to keep hashing fast for large images.
 */
export async function generateFingerprint(
  firstPageBase64: string,
  fileName: string,
  fileSize: number,
  pageCount: number
): Promise<string> {
  // Use first 8KB of base64 data — enough to uniquely identify a page
  // without being slow on very large images
  const sample = firstPageBase64.slice(0, 8192);
  const raw = `${fileName}|${fileSize}|${pageCount}|${sample}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── IndexedDB Operations ────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "fingerprint" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedResult(
  fingerprint: string
): Promise<CacheEntry | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fingerprint);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (!entry) return resolve(null);

        // Check TTL
        if (Date.now() - entry.createdAt > TTL_MS) {
          // Expired — delete in background
          deleteCacheEntry(fingerprint).catch(() => {});
          return resolve(null);
        }
        resolve(entry);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedResult(entry: CacheEntry): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache write failure is non-critical
  }
}

export async function deleteCacheEntry(fingerprint: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(fingerprint);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

export async function getAllCacheEntries(): Promise<CacheEntry[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const entries = (req.result as CacheEntry[]).filter(
          (e) => Date.now() - e.createdAt <= TTL_MS
        );
        // Sort by most recent first
        entries.sort((a, b) => b.createdAt - a.createdAt);
        resolve(entries);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function clearAllCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

/**
 * Build a short human-readable label from extraction results.
 * e.g. "HĐ-001/2025 | 15/03/2025"
 */
export function buildCacheLabel(result: ExtractionResult): string {
  const parts: string[] = [];
  if (result.so_hop_dong) parts.push(result.so_hop_dong);
  if (result.ngay_ky) parts.push(result.ngay_ky);
  if (parts.length === 0 && result.chu_dau_tu?.ten) {
    parts.push(result.chu_dau_tu.ten);
  }
  return parts.join(" | ") || "Hợp đồng";
}
