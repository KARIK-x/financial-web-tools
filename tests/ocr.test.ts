import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { extractDocumentText, ocrCapability, runExtraction } from "@/server/ocr";

async function receiptPng(): Promise<Buffer> {
  const svg = `<svg width="760" height="320" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="30" y="80" font-family="Arial" font-size="40" fill="black">FINANCE TRACKER TEST RECEIPT</text>
    <text x="30" y="160" font-family="Arial" font-size="36" fill="black">TOTAL NPR 5,000.00</text>
    <text x="30" y="235" font-family="Arial" font-size="32" fill="black">DATE 2026-10-20</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("OCR execution", () => {
  it("actually runs Tesseract on a synthetic English receipt and extracts candidates without inventing an invoice number", async () => {
    const capability = await ocrCapability();
    expect(capability.available).toBe(true);
    expect(capability.languages).toContain("eng");

    const outcome = await runExtraction(await receiptPng(), "image/png", "synthetic-receipt.png");
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.engine).toBe("tesseract");
    expect(outcome.rawText).toContain("TOTAL");
    expect(outcome.fields.totalPaisa).toBe(500_000);
    expect(outcome.fields.date).toBe("2026-10-20");
    expect(outcome.fields.dateCalendar).toBe("AD");
    expect(outcome.fields.invoiceNo).toBeUndefined();
  });

  it("reports unsupported input instead of fabricating fields", async () => {
    const result = await extractDocumentText(Buffer.from("not an image"), "text/plain", "notes.txt");
    expect(result).toHaveProperty("error");
  });
});
