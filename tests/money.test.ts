import { describe, expect, it } from "vitest";
import {
  decimalToPaisa, formatNPR, groupLakh, groupWestern, MAX_PAISA, normalizeDigits,
  paisaToDecimal, parseMoney, parseStrictMoney,
} from "@/lib/money";

describe("decimalToPaisa", () => {
  it("converts decimal NPR without floating point drift", () => {
    expect(decimalToPaisa("3500.50")).toBe(350_050);
    expect(decimalToPaisa("0.01")).toBe(1);
    expect(decimalToPaisa("0.10")).toBe(10);
    expect(decimalToPaisa("99999999.99")).toBe(9_999_999_999);
    expect(decimalToPaisa("1,50,000.75")).toBe(15_000_075);
  });

  it("rounds half-up at the third decimal", () => {
    expect(decimalToPaisa("0.004")).toBe(0);
    expect(decimalToPaisa("0.005")).toBe(1);
    expect(decimalToPaisa("3500.555")).toBe(350_056);
  });

  it("rejects malformed input instead of guessing", () => {
    expect(decimalToPaisa("1.2.3")).toBeNull();
    expect(decimalToPaisa("abc")).toBeNull();
    expect(decimalToPaisa("1e5")).toBeNull();
  });
});

describe("parseMoney", () => {
  it("accepts the formats found on Nepali receipts", () => {
    expect(parseMoney("Rs. 3,500")).toEqual({ ok: true, paisa: 350_000 });
    expect(parseMoney("NPR 3500.50")).toEqual({ ok: true, paisa: 350_050 });
    expect(parseMoney("रु ५००")).toEqual({ ok: true, paisa: 50_000 });
    expect(parseMoney("1,50,000/-")).toEqual({ ok: true, paisa: 15_000_000 });
    expect(parseMoney(" 5000 only ")).toEqual({ ok: true, paisa: 500_000 });
  });

  it("expands lakh / crore shorthand exactly", () => {
    expect(parseMoney("2.5 lakh")).toEqual({ ok: true, paisa: 25_000_000 });
    expect(parseMoney("1 lakh 50 thousand")).toEqual({ ok: true, paisa: 15_000_000 });
    expect(parseMoney("1 crore 50 lakh")).toEqual({ ok: true, paisa: 1_500_000_000 });
    expect(parseMoney("3 crore")).toEqual({ ok: true, paisa: 3_000_000_000 });
  });

  it("does not silently drop unrecognised trailing text", () => {
    const result = parseMoney("1 lakh fifty thousand");
    expect(result.ok).toBe(false);
  });

  it("rejects zero, negatives and oversized values", () => {
    expect(parseMoney("0").ok).toBe(false);
    expect(parseMoney("-500").ok).toBe(false);
    expect(parseMoney(String(MAX_PAISA)).ok).toBe(false);
  });

  it("flags rounding when more than two decimals are supplied", () => {
    const result = parseMoney("3500.555");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paisa).toBe(350_056);
      expect(result.note).toMatch(/rounded/i);
    }
  });

  it("strips Nepali digit input", () => {
    expect(normalizeDigits("१२३")).toBe("123");
    expect(parseMoney("रु १,२५०")).toEqual({ ok: true, paisa: 125_000 });
  });

  it("strict parser keeps the same safety guarantees", () => {
    expect(parseStrictMoney("2.5 lakh").ok).toBe(true);
    expect(parseStrictMoney("").ok).toBe(false);
  });
});

describe("formatting", () => {
  it("renders paisa as decimal NPR", () => {
    expect(paisaToDecimal(350_050)).toBe("3500.50");
    expect(paisaToDecimal(-1_205)).toBe("-12.05");
    expect(paisaToDecimal(0)).toBe("0.00");
  });

  it("groups in the Nepali lakh/crore style", () => {
    expect(groupLakh("150000")).toBe("1,50,000");
    expect(groupLakh("12345678")).toBe("1,23,45,678");
    expect(groupLakh("999")).toBe("999");
    expect(groupWestern("1234567")).toBe("1,234,567");
  });

  it("formats full currency strings", () => {
    expect(formatNPR(15_000_000)).toBe("NPR 1,50,000.00");
    expect(formatNPR(15_000_000, { grouping: "western", symbol: false, decimals: false })).toBe("150,000");
  });
});
