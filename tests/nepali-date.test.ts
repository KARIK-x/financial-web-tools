import { describe, expect, it } from "vitest";
import {
  adToBs, bsToAd, daysBetween, fiscalYearBsFor, formatBsLong, formatDateLong,
  isValidISODate, todayISO,
} from "@/lib/nepali-date";

describe("AD ↔ BS conversion", () => {
  it("maps the start of fiscal year 2083/84", () => {
    expect(adToBs("2026-07-17")).toBe("2083-04-01");
    expect(bsToAd("2083-04-01")).toBe("2026-07-17");
  });

  it("round-trips arbitrary business dates", () => {
    for (const iso of ["2026-10-24", "2025-12-31", "2026-04-13", "2027-01-15"]) {
      const bs = adToBs(iso);
      expect(bs).not.toBeNull();
      expect(bsToAd(bs!)).toBe(iso);
    }
  });

  it("returns null instead of inventing dates", () => {
    expect(adToBs("2026-02-30")).toBeNull();
    expect(bsToAd("2083-13-01")).toBeNull();
    expect(bsToAd("not-a-date")).toBeNull();
  });

  it("validates strict ISO dates", () => {
    expect(isValidISODate("2026-10-24")).toBe(true);
    expect(isValidISODate("2026-2-4")).toBe(false);
    expect(isValidISODate("2026-02-30")).toBe(false);
  });

  it("computes the Nepali fiscal year label around Shrawan 1", () => {
    expect(fiscalYearBsFor("2026-07-16")).toBe("2082/83");
    expect(fiscalYearBsFor("2026-07-17")).toBe("2083/84");
    expect(fiscalYearBsFor("2027-07-16")).toBe("2083/84");
    expect(fiscalYearBsFor("2027-07-17")).toBe("2084/85");
  });

  it("produces a Kathmandu-local today", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("date display helpers", () => {
  it("formats BS dates with Nepali month names", () => {
    expect(formatBsLong("2083-07-08")).toBe("Kartik 8, 2083 BS");
    expect(formatBsLong(null)).toBe("—");
  });

  it("formats AD dates without timezone drift", () => {
    expect(formatDateLong("2026-10-24")).toBe("24 Oct 2026");
    expect(formatDateLong(null)).toBe("—");
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(daysBetween("2026-10-31", "2026-10-01")).toBe(-30);
    expect(daysBetween("bad", "2026-10-01")).toBe(0);
  });
});
