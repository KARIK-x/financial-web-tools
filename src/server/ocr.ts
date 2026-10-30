import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { normalizeDigits, parseMoney } from "@/lib/money";
import { bsToAd, isValidISODate } from "@/lib/nepali-date";

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
  pages?: Array<{ page: number; method: "text" | "ocr"; text: string }>;
};

export type OcrCapability = {
  available: boolean;
  engine: string;
  engineVersion: string;
  languages: string[];
  nepaliSupported: boolean;
  pdfTextSupported: boolean;
  scannedPdfSupported: boolean;
  note: string;
};

let cachedCapability: OcrCapability | null = null;
let cachedRasterizer = false;

async function rasterizerAvailable(): Promise<boolean> {
  if (cachedRasterizer) return true;
  try {
    await import("mupdf");
    cachedRasterizer = true;
  } catch {
    cachedRasterizer = false;
  }
  return cachedRasterizer;
}

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
  const nepaliSupported = languages.includes("nep");
  const scannedPdfSupported = available && (await rasterizerAvailable());
  cachedCapability = {
    available,
    engine: "tesseract",
    engineVersion: version,
    languages,
    nepaliSupported,
    pdfTextSupported: true,
    scannedPdfSupported,
    note: available
      ? nepaliSupported
        ? "Local Tesseract with Nepali + English data. Scanned PDFs are rasterised locally. OCR output is candidate data and must be reviewed."
        : "Local Tesseract is installed but the Nepali/Devanagari language pack is not. English text only; Nepali OCR is blocked until `tessdata` includes `nep`."
      : "No local OCR engine is installed. Upload and manual review still work; OCR execution is blocked.",
  };
  return cachedCapability;
}

function ocrLanguages(cap: OcrCapability): string {
  const langs: string[] = [];
  if (cap.languages.includes("nep")) langs.push("nep");
  if (cap.languages.includes("eng")) langs.push("eng");
  return langs.length ? langs.join("+") : "osd";
}

async function prepareImage(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes)
      .rotate() // honour EXIF orientation from phone photographs
      .grayscale()
      .normalize()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return bytes;
  }
}

async function tesseractBuffer(bytes: Buffer, languages: string): Promise<{ text: string } | { error: string }> {
  const tmp = path.join(os.tmpdir(), `locus-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  try {
    await fs.writeFile(tmp, await prepareImage(bytes));
    const attempt = async (psm: string) => {
      const { stdout } = await run(
        "tesseract",
        [tmp, "stdout", "-l", languages, "--psm", psm],
        { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    };
    let text = await attempt("6");
    // PSM 1 enables orientation/script detection, which helps rotated phone
    // photos. Only retry when the normal receipt segmentation found nothing.
    if (text.replace(/\s/g, "").length < 8) {
      const fallback = await attempt("1");
      if (fallback.replace(/\s/g, "").length > text.replace(/\s/g, "").length) text = fallback;
    }
    return { text };
  } catch (err) {
    return { error: `Tesseract failed: ${(err as Error).message}` };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function pdfExtract(
  bytes: Buffer,
  cap: OcrCapability,
): Promise<{ text: string; engine: string; version: string; pages: Array<{ page: number; method: "text" | "ocr"; text: string }> } | { error: string }> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise;
    const pages: Array<{ page: number; method: "text" | "ocr"; text: string }> = [];
    const limit = Math.min(doc.numPages, 12);
    let usedOcr = false;
    try {
      for (let i = 1; i <= limit; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const embedded = content.items.map((it) => ("str" in it ? it.str : "")).join(" ").trim();
        if (embedded.replace(/\s/g, "").length > 20) {
          pages.push({ page: i, method: "text", text: embedded });
          continue;
        }

        if (!cap.available) {
          return { error: `Page ${i} has no embedded text and Tesseract is not installed. Scanned-PDF OCR is unavailable.` };
        }
        if (!(await rasterizerAvailable())) {
          return { error: `Page ${i} has no embedded text and no local PDF rasteriser is installed. Scanned-PDF OCR is unavailable.` };
        }
        // MuPDF.js renders locally through WebAssembly. It avoids native canvas
        // modules and keeps scanned receipts inside this process.
        const mupdf = await import("mupdf");
        const mupdfDoc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
        try {
          const mupdfPage = mupdfDoc.loadPage(i - 1);
          try {
            const pixmap = mupdfPage.toPixmap(
              mupdf.Matrix.scale(2, 2),
              mupdf.ColorSpace.DeviceRGB,
              false,
              true,
            );
            try {
              const image = Buffer.from(pixmap.asPNG());
              const ocr = await tesseractBuffer(image, ocrLanguages(cap));
              if ("error" in ocr) return { error: `Page ${i}: ${ocr.error}` };
              pages.push({ page: i, method: "ocr", text: ocr.text });
              usedOcr = true;
            } finally {
              pixmap.destroy();
            }
          } finally {
            mupdfPage.destroy();
          }
        } finally {
          mupdfDoc.destroy();
        }
      }
    } finally {
      await doc.destroy();
    }
    const text = pages.map((p) => p.text).join("\n");
    if (!text.trim()) {
      return { error: "PDF contained no extractable text and local OCR produced no text. Review the original manually." };
    }
    return { text, engine: usedOcr ? "pdfjs-text+tesseract" : "pdfjs-text", version: "5.x", pages };
  } catch (err) {
    return { error: `PDF extraction failed: ${(err as Error).message}` };
  }
}

/** Extract text only. Never invents amounts: absent fields stay undefined. */
export async function extractDocumentText(
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<{ text: string; engine: string; version: string; pages?: Array<{ page: number; method: "text" | "ocr"; text: string }> } | { error: string }> {
  const cap = await ocrCapability();
  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    return pdfExtract(bytes, cap);
  }
  if (!mime.startsWith("image/")) return { error: `Unsupported OCR input type: ${mime}` };
  if (!cap.available) return { error: "Tesseract is not installed. Manual entry and review are still available." };
  const result = await tesseractBuffer(bytes, ocrLanguages(cap));
  if ("error" in result) return result;
  return { text: result.text, engine: "tesseract", version: cap.engineVersion };
}

function findAmounts(text: string): Array<{ raw: string; paisa: number; score: number }> {
  const results: Array<{ raw: string; paisa: number; score: number }> = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const normalized = normalizeDigits(line);
    const lower = normalized.toLowerCase();
    let score = 0;
    if (/grand\s*total|total\s*amount|total|amount\s*payable|net\s*payable|जम्मा|कुल|कुल\s*रकम/.test(lower)) score += 3;
    if (/sub\s*total|vat|tax|discount|change|भ्याट|कर|छुट/.test(lower)) score -= 2;
    const matches = normalized.match(/(?:npr|rs\.?|रु\.?|रू\.?)?\s*\d[\d,]*(?:\.\d{1,2})?/gi);
    if (!matches) continue;
    for (const m of matches) {
      const parsed = parseMoney(m);
      if (parsed.ok && parsed.paisa > 100) results.push({ raw: m.trim(), paisa: parsed.paisa, score });
    }
  }
  return results.sort((a, b) => b.score - a.score || b.paisa - a.paisa);
}

const ENGLISH_MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const NEPALI_MONTHS: Record<string, number> = {
  "बैशाख": 1, "वैशाख": 1, "baishakh": 1,
  "जेठ": 2, "jestha": 2,
  "असार": 3, "ashadh": 3, "asar": 3,
  "साउन": 4, "shrawan": 4, "sawan": 4,
  "भदौ": 5, "bhadra": 5, "bhadau": 5,
  "असोज": 6, "ashwin": 6, "asoj": 6,
  "कार्तिक": 7, "kartik": 7,
  "मंसिर": 8, "mangsir": 8, "mansir": 8,
  "पुष": 9, "पौष": 9, "poush": 9, "push": 9,
  "माघ": 10, "magh": 10,
  "फाल्गुन": 11, "फागुन": 11, "falgun": 11, "fagun": 11,
  "चैत": 12, "चैत्र": 12, "chaitra": 12,
};

function findDate(text: string): { iso: string; calendar: "AD" | "BS"; raw: string; ambiguous: boolean } | null {
  const normalized = normalizeDigits(text);
  const candidates: Array<{ iso: string; calendar: "AD" | "BS"; raw: string; ambiguous: boolean }> = [];

  const numericPatterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g,
    /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g,
  ];
  for (const p of numericPatterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(normalized))) {
      const raw = m[0];
      let y: string, mo: string, d: string;
      if (m[1]!.length === 4) [y, mo, d] = [m[1]!, m[2]!, m[3]!];
      else [d, mo, y] = [m[1]!, m[2]!, m[3]!];
      const year = Number(y);
      const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
      const ambiguous = m[1]!.length !== 4 && Number(mo) <= 12 && Number(d) <= 12;
      if (year >= 2070 && year <= 2090 && bsToAd(iso)) {
        candidates.push({ iso, calendar: "BS", raw, ambiguous });
      } else if (year >= 2015 && year <= 2035 && isValidISODate(iso)) {
        candidates.push({ iso, calendar: "AD", raw, ambiguous });
      }
    }
  }

  const monthName = (name: string): number | undefined => {
    const key = name.toLowerCase().replace(/\.$/, "");
    return ENGLISH_MONTHS[key] ?? NEPALI_MONTHS[name] ?? NEPALI_MONTHS[key];
  };
  const yearFirstMonthPattern = /(\d{4})\s+([A-Za-z\u0900-\u097F.]+)\s+(\d{1,2})/g;
  let yf: RegExpExecArray | null;
  while ((yf = yearFirstMonthPattern.exec(normalized))) {
    const year = Number(yf[1]);
    const month = monthName(yf[2]!);
    const day = Number(yf[3]);
    if (!month || day < 1 || day > 32) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (year >= 2070 && year <= 2090 && bsToAd(iso)) candidates.push({ iso, calendar: "BS", raw: yf[0], ambiguous: false });
    else if (year >= 2015 && year <= 2035 && isValidISODate(iso)) candidates.push({ iso, calendar: "AD", raw: yf[0], ambiguous: false });
  }

  const monthPattern = /(\d{1,2})\s+([A-Za-z\u0900-\u097F.]+)\s+(\d{4})/g;
  let mm: RegExpExecArray | null;
  while ((mm = monthPattern.exec(normalized))) {
    const day = Number(mm[1]);
    const month = monthName(mm[2]!);
    const year = Number(mm[3]);
    if (!month || day < 1 || day > 32) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (year >= 2070 && year <= 2090 && bsToAd(iso)) candidates.push({ iso, calendar: "BS", raw: mm[0], ambiguous: false });
    else if (year >= 2015 && year <= 2035 && isValidISODate(iso)) candidates.push({ iso, calendar: "AD", raw: mm[0], ambiguous: false });
  }
  const monthFirstPattern = /([A-Za-z\u0900-\u097F.]+)\s+(\d{1,2}),?\s+(\d{4})/g;
  let mf: RegExpExecArray | null;
  while ((mf = monthFirstPattern.exec(normalized))) {
    const month = monthName(mf[1]!);
    const day = Number(mf[2]);
    const year = Number(mf[3]);
    if (!month || day < 1 || day > 32) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (year >= 2070 && year <= 2090 && bsToAd(iso)) candidates.push({ iso, calendar: "BS", raw: mf[0], ambiguous: false });
    else if (year >= 2015 && year <= 2035 && isValidISODate(iso)) candidates.push({ iso, calendar: "AD", raw: mf[0], ambiguous: false });
  }

  return candidates[0] ?? null;
}

export function extractReceiptFields(text: string): { fields: ExtractedFields; confidence: Record<string, number> } {
  const fields: ExtractedFields = {};
  const confidence: Record<string, number> = {};
  const compact = text.replace(/\s+/g, " ").trim();
  const normalized = normalizeDigits(text);

  const amounts = findAmounts(normalized);
  const best = amounts[0];
  if (best) {
    fields.totalPaisa = best.paisa;
    fields.totalRaw = best.raw;
    confidence.totalPaisa = best.score >= 3 ? 0.72 : 0.42;
  }

  const date = findDate(normalized);
  if (date) {
    fields.date = date.iso;
    fields.dateCalendar = date.calendar;
    confidence.date = date.ambiguous ? 0.5 : 0.7;
  }

  const pan = normalized.match(/\b(\d{9})\b/);
  if (pan?.[1]) {
    fields.sellerPan = pan[1];
    confidence.sellerPan = 0.6;
  }

  const invoice = normalized.match(
    /(?:invoice|bill|receipt|voucher|बीजक|रसिद|चलान|भर्चर)\s*(?:no\.?|number|#|नं\.?|नम्बर)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{2,20})/i,
  );
  const invoiceCandidate = invoice?.[1];
  if (
    invoiceCandidate &&
    /\d/.test(invoiceCandidate) &&
    !/^(TOTAL|DATE|AMOUNT|NPR|RECEIPT|INVOICE|BILL|VOUCHER|जम्मा|कुल|मिति|रकम)$/i.test(invoiceCandidate)
  ) {
    fields.invoiceNo = invoiceCandidate;
    confidence.invoiceNo = 0.55;
  }

  const taxLine = normalized.split(/\r?\n/).find((l) => /vat|tax|भ्याट|मूल्य\s*अभिवृद्धि\s*कर|कर/i.test(l));
  if (taxLine) {
    const m = taxLine.match(/(?:npr|rs\.?|रु\.?|रू\.?)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (m?.[1]) {
      const parsed = parseMoney(m[1]);
      if (parsed.ok) {
        fields.taxPaisa = parsed.paisa;
        confidence.taxPaisa = 0.5;
      }
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 2);
  const merchant = lines.find(
    (l) => !/^\d+$/.test(l) && !/invoice|receipt|bill|vat|pan|date|total|बीजक|रसिद|भ्याट|मिति|जम्मा|कुल/i.test(l),
  );
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
    pages: text.pages,
  };
}
