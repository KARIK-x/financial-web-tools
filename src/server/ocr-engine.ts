import { Buffer } from "node:buffer";
import type { ExtractionOutcome } from "./ocr";

export type OcrEngineName = "tesseract" | "unlimited-ocr" | "auto";

export type OcrHttpResult = {
  text?: string;
  fields?: Record<string, unknown>;
  confidence?: Record<string, number>;
  engine?: string;
  version?: string;
  status?: "SUCCEEDED" | "FAILED" | "SKIPPED";
  error?: string;
  durationMs?: number;
  pages?: Array<{ page: number; method: "text" | "ocr"; text: string }>;
};

export function requestedOcrEngine(): OcrEngineName {
  const value = (process.env.OCR_ENGINE ?? "tesseract").toLowerCase();
  if (value === "unlimited" || value === "unlimited-ocr") return "unlimited-ocr";
  if (value === "auto") return "auto";
  return "tesseract";
}

export function unlimitedOcrUrl(): string | null {
  const url = process.env.UNLIMITED_OCR_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

export function unlimitedOcrTimeoutMs(): number {
  const n = Number(process.env.UNLIMITED_OCR_TIMEOUT_MS ?? 30000);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120000) : 30000;
}

export async function unlimitedOcrHealth(): Promise<{ ok: boolean; detail?: string }> {
  const base = unlimitedOcrUrl();
  if (!base) return { ok: false, detail: "UNLIMITED_OCR_URL is not configured." };
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function unlimitedOcrExtract(
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<OcrHttpResult> {
  const base = unlimitedOcrUrl();
  if (!base) throw new Error("UNLIMITED_OCR_URL is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), unlimitedOcrTimeoutMs());
  try {
    const response = await fetch(`${base}/ocr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename,
        mime,
        image_base64: bytes.toString("base64"),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Unlimited OCR HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as OcrHttpResult;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeUnlimitedResult(result: OcrHttpResult): ExtractionOutcome {
  const text = result.text ?? "";
  const status =
    result.status === "FAILED" ? "FAILED" :
    result.status === "SKIPPED" ? "SKIPPED" :
    text.trim() ? "SUCCEEDED" : "FAILED";
  return {
    engine: result.engine ?? "unlimited-ocr",
    engineVersion: result.version ?? "unknown",
    rawText: text,
    fields: result.fields ?? {},
    confidence: result.confidence ?? {},
    status,
    error: result.error,
    durationMs: result.durationMs ?? 0,
    pages: result.pages,
  };
}
