import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseMoney } from "@/lib/money";
import { isValidISODate } from "@/lib/nepali-date";

const run = promisify(execFile);

export type ExtractedFields = {
  merchant?: string;
  date?: string;
  dateCalendar?: "AD" | "BS";
  totalPaisa?: number;
  totalRaw?: string;
  taxPaisa?: number;
  invoiceNo?: string;
  sellerPan?: string;
};

export type ExtractionOutcome = {
  engine: string;
  engineVersion: string;
  rawText: string;
  fields: ExtractedFields;
  confidence: Record<string, number>;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  error?: string;
  durationMs: number;
};

export type OcrCapability = {
  available: boolean;
  engine: string;
  engineVersion: string;
  languages: string[];
  nepaliSupported: boolean;
  pdfTextSupported: boolean;
  note: string;
};

let cachedCapability: OcrCapability | null = null;

export async function ocrCapability(): Promise<OcrCapability> {
  if (cachedCapability) return cachedCapability;
  const languages: string[] = [];
  let available = false;
  let version = "unavailable";
  try {
    const { stdout } = await run("tesseract", ["--version"], { timeout: 5000 });
    version = stdout.split("\n")[0] ?? "tesseract";
    available = true;
    const langs = await run("tesseract", ["--list-langs"], { timeout: 5000 });
    for (const line of langs.stdout.split("\n").slice(1)) {
      const l = line.trim();
      if (l) languages.push(l);
    }
  } catch {
    available = false;
  }
  cachedCapability = {
    available,
    engine: "tesseract",
    engineVersion: version,
    languages,
    nepaliSupported: languages.includes("nep") || languages.includes("nep+eng") || languages.includes("devanagari"),
    pdfTextSupported: true,
    note: available
      ? languages.includes("nep")
        ? "Local Tesseract with Nepali + English data. OCR output is candidate data and must be reviewed."
        : "Local Tesseract is installed but the Nepali/Devanagari language pack is not. English text only; Nepali OCR is blocked until `tessdata` includes `nep`."
      : "No local OCR engine is installed. Upload and manual review still work; OCR execution is blocked.",
  };
  return cachedCapability;
}

async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages: string[] = [];
  const limit = Math.min(doc.numPages, 12);
  for (let i = 1; i <= limit; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  await doc.destroy();
  return pages.join("\n");
}

/** Extract text only. Never invents amounts: absent fields stay undefined. */
export async function extractDocumentText(bytes: Buffer, mime: string, filename: string): Promise<{ text: string; engine: string; version: string } | { error: string }> {
  const cap = await ocrCapability();
  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    try {
      const text = await pdfText(bytes);
      if (text.replace(/\s/g, "").length > 40) {
        return { text, engine: "pdfjs-text", version: "5.x" };
      }
      return { error: "PDF has no embedded text layer (scanned). Rasterisation/OCR for scanned PDFs is not available in this environment." };
    } catch (err) {
      return { error: `PDF text extraction failed: ${(err as Error).message}` };
    }
  }
  if (!mime.startsWith("image/")) return { error: `Unsupported OCR input type: ${mime}` };
  if (!cap.available) return { error: "Tesseract is not installed. Manual entry and review are still available." };
  const tmp = path.join(os.tmpdir(), `locus-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.${filename.split(".").pop() ?? "png"}`);
  try {
    await fs.writeFile(tmp, bytes);
    const { stdout } = await run("tesseract", [tmp, "stdout", "-l", cap.languages.includes("eng") ? "eng" : "osd", "--psm", "6"], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { text: stdout, engine: "tesseract", version: cap.engineVersion };
  } catch (err) {
    return { error: `Tesseract failed: ${(err as Error).message}` };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function findAmounts(text: string): Array<{ raw: string; paisa: number; score: number }> {
  const results: Array<{ raw: string; paisa: number; score: number }> = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    let score = 0;
    if (/grand\s*total|total\s*amount|total|amount\s*payable|net\s*payable|जम्मा|कुल/.test(lower)) score += 3;
    if (/sub\s*total|vat|tax|discount|change/.test(lower)) score -= 2;
    const matches = line.match(/(?:npr|rs\.?|रु\.?)?\s*\d[\d,]*(?:\.\d{1,2})?/gi);
    if (!matches) continue;
    for (const m of matches) {
      const parsed = parseMoney(m);
      if (parsed.ok && parsed.paisa > 100) results.push({ raw: m.trim(), paisa: parsed.paisa, score });
    }
  }
  return results.sort((a, b) => b.score - a.score || b.paisa - a.paisa);
}

function findDate(text: string): { iso: string; calendar: "AD" | "BS"; raw: string } | null {
  const patterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g,
    /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g,
  ];
  const candidates: Array<{ iso: string; calendar: "AD" | "BS"; raw: string }> = [];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(text))) {
      const raw = m[0];
      let y: string, mo: string, d: string;
      if (m[1]!.length === 4) [y, mo, d] = [m[1]!, m[2]!, m[3]!];
      else [d, mo, y] = [m[1]!, m[2]!, m[3]!];
      const year = Number(y);
      if (year >= 2070 && year <= 2090) {
        candidates.push({ iso: `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`, calendar: "BS", raw });
      } else if (year >= 2015 && year <= 2035) {
        const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
        if (isValidISODate(iso)) candidates.push({ iso, calendar: "AD", raw });
      }
    }
  }
  return candidates[0] ?? null;
}

export function extractReceiptFields(text: string): { fields: ExtractedFields; confidence: Record<string, number> } {
  const fields: ExtractedFields = {};
  const confidence: Record<string, number> = {};
  const compact = text.replace(/\s+/g, " ").trim();

  const amounts = findAmounts(text);
  const best = amounts[0];
  if (best) {
    fields.totalPaisa = best.paisa;
    fields.totalRaw = best.raw;
    confidence.totalPaisa = best.score >= 3 ? 0.72 : 0.42;
  }

  const date = findDate(text);
  if (date) {
    fields.date = date.iso;
    fields.dateCalendar = date.calendar;
    confidence.date = 0.7;
  }

  const pan = text.match(/\b(\d{9})\b/);
  if (pan?.[1]) {
    fields.sellerPan = pan[1];
    confidence.sellerPan = 0.6;
  }

  const invoice = text.match(/(?:invoice|bill|receipt|voucher)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{2,20})/i);
  if (invoice?.[1]) {
    fields.invoiceNo = invoice[1];
    confidence.invoiceNo = 0.55;
  }

  const taxLine = text.split(/\r?\n/).find((l) => /vat|tax/i.test(l));
  if (taxLine) {
    const m = taxLine.match(/(?:npr|rs\.?)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (m?.[1]) {
      const parsed = parseMoney(m[1]);
      if (parsed.ok) {
        fields.taxPaisa = parsed.paisa;
        confidence.taxPaisa = 0.5;
      }
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 2);
  const merchant = lines.find((l) => !/^\d+$/.test(l) && !/invoice|receipt|bill|vat|pan|date|total/i.test(l));
  if (merchant) {
    fields.merchant = merchant.slice(0, 80);
    confidence.merchant = 0.4;
  }
  if (compact.length === 0) confidence.overall = 0;
  else {
    const set = Object.values(confidence);
    confidence.overall = set.length ? Math.round((set.reduce((a, b) => a + b, 0) / set.length) * 100) / 100 : 0.1;
  }
  return { fields, confidence };
}

export async function runExtraction(bytes: Buffer, mime: string, filename: string): Promise<ExtractionOutcome> {
  const started = Date.now();
  const text = await extractDocumentText(bytes, mime, filename);
  const durationMs = Date.now() - started;
  if ("error" in text) {
    return {
      engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {},
      status: "FAILED", error: text.error, durationMs,
    };
  }
  const { fields, confidence } = extractReceiptFields(text.text);
  return {
    engine: text.engine,
    engineVersion: text.version,
    rawText: text.text.slice(0, 50_000),
    fields,
    confidence,
    status: Object.keys(fields).length ? "SUCCEEDED" : "SKIPPED",
    durationMs,
  };
}
