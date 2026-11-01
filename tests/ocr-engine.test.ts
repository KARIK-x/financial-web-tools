import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { requestedOcrEngine, unlimitedOcrHealth, unlimitedOcrExtract, normalizeUnlimitedResult, unlimitedOcrUrl } from "@/server/ocr-engine";
import { runExtraction } from "@/server/ocr";

describe("OCR engine adapter", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("defaults to Tesseract", () => {
    delete process.env.OCR_ENGINE;
    delete process.env.UNLIMITED_OCR_URL;
    expect(requestedOcrEngine()).toBe("tesseract");
  });

  it("reports Unlimited-OCR as unavailable when no URL is configured", async () => {
    delete process.env.UNLIMITED_OCR_URL;
    expect(unlimitedOcrUrl()).toBeNull();
    await expect(unlimitedOcrHealth()).resolves.toMatchObject({ ok: false });
    await expect(unlimitedOcrExtract(Buffer.from("x"), "image/png", "x.png")).rejects.toThrow(/not configured/);
  });

  it("normalizes a successful Unlimited-OCR response", () => {
    const outcome = normalizeUnlimitedResult({
      text: "Hotel Everest\nTotal NPR 2,500.00",
      fields: { merchant: "Hotel Everest", totalRaw: "2,500.00" },
      confidence: { merchant: 0.9 },
      engine: "unlimited-ocr",
      version: "2",
      status: "SUCCEEDED",
      durationMs: 42,
    });
    expect(outcome).toMatchObject({
      engine: "unlimited-ocr",
      engineVersion: "2",
      status: "SUCCEEDED",
      fields: { merchant: "Hotel Everest", totalRaw: "2,500.00" },
      durationMs: 42,
    });
    expect(outcome.rawText).toContain("Hotel Everest");
  });

  it("runs Tesseract when the engine is explicitly tesseract", async () => {
    process.env.OCR_ENGINE = "tesseract";
    delete process.env.UNLIMITED_OCR_URL;
    const image = await (async () => {
      const sharp = (await import("sharp")).default;
      return sharp(Buffer.from(`<svg width="320" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="20" y="70" font-size="32" fill="black">OCR TEST 2500</text></svg>`)).png().toBuffer();
    })();
    const outcome = await runExtraction(image, "image/png", "blank.png", "tesseract");
    expect(["SUCCEEDED", "SKIPPED", "FAILED"]).toContain(outcome.status);
    expect(outcome.engine).toBe("tesseract");
  });

  it("falls back to Tesseract in auto mode when Unlimited-OCR is unavailable", async () => {
    process.env.OCR_ENGINE = "auto";
    delete process.env.UNLIMITED_OCR_URL;
    const image = await (async () => {
      const sharp = (await import("sharp")).default;
      return sharp(Buffer.from(`<svg width="320" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="20" y="70" font-size="32" fill="black">OCR TEST 2500</text></svg>`)).png().toBuffer();
    })();
    const outcome = await runExtraction(image, "image/png", "blank.png", "auto");
    expect(["SUCCEEDED", "SKIPPED", "FAILED"]).toContain(outcome.status);
    expect(outcome.engine).toBe("tesseract");
  });
});
