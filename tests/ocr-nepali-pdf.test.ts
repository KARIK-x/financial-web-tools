import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractReceiptFields, ocrCapability, runExtraction } from "@/server/ocr";

async function devanagariReceiptPng(): Promise<Buffer> {
  const svg = `<svg width="900" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="30" y="80" font-family="Devanagari Sangam MN" font-size="42" fill="black">लोकस परीक्षण रसिद</text>
    <text x="30" y="170" font-family="Devanagari Sangam MN" font-size="38" fill="black">कुल रकम रु ५,०००.००</text>
    <text x="30" y="260" font-family="Devanagari Sangam MN" font-size="34" fill="black">मिति २०८२/०७/०८</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function scannedPdf(): Promise<Buffer> {
  const svg = `<svg width="760" height="320" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="30" y="80" font-family="Arial" font-size="40" fill="black">LOCUS SCANNED PDF</text>
    <text x="30" y="160" font-family="Arial" font-size="36" fill="black">TOTAL NPR 5,000.00</text>
    <text x="30" y="235" font-family="Arial" font-size="32" fill="black">DATE 2026-10-20</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await pdf.save());
}

describe("Nepali OCR and scanned PDFs", () => {
  it("runs Nepali/Devanagari OCR and normalises Devanagari numerals and BS dates", async () => {
    const capability = await ocrCapability();
    if (!capability.nepaliSupported) return; // documented blocker on hosts without nep.traineddata

    const outcome = await runExtraction(await devanagariReceiptPng(), "image/png", "nepali-receipt.png");
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.engine).toBe("tesseract");
    expect(outcome.rawText).toContain("५,०००");
    expect(outcome.fields.totalPaisa).toBe(500_000);
    expect(outcome.fields.date).toBe("2082-07-08");
    expect(outcome.fields.dateCalendar).toBe("BS");
  }, 60_000);

  it("rasterises an image-only scanned PDF locally and OCRs the page", async () => {
    const capability = await ocrCapability();
    expect(capability.pdfTextSupported).toBe(true);
    expect(capability.scannedPdfSupported).toBe(true);

    const outcome = await runExtraction(await scannedPdf(), "application/pdf", "scanned-receipt.pdf");
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.engine).toBe("pdfjs-text+tesseract");
    expect(outcome.pages?.[0]?.method).toBe("ocr");
    expect(outcome.fields.totalPaisa).toBe(500_000);
    expect(outcome.fields.date).toBe("2026-10-20");
  }, 60_000);

  it("parses Devanagari amounts, BS month names and ambiguous numeric dates without inventing fields", () => {
    const nepali = extractReceiptFields("कुल रकम रु ५,०००.००\nमिति २०८२ साउन ८");
    expect(nepali.fields.totalPaisa).toBe(500_000);
    expect(nepali.fields.date).toBe("2082-04-08");
    expect(nepali.fields.dateCalendar).toBe("BS");

    const ambiguous = extractReceiptFields("TOTAL NPR 1,200.00\nDATE 05/06/2026");
    expect(ambiguous.fields.date).toBe("2026-06-05");
    expect(ambiguous.confidence.date).toBeLessThan(0.7);

    const invalid = extractReceiptFields("TOTAL NPR 1,200.00\nDATE 31/02/2026");
    expect(invalid.fields.totalPaisa).toBe(120_000);
    expect(invalid.fields.date).toBeUndefined();
    expect(invalid.fields.invoiceNo).toBeUndefined();
  });
});
