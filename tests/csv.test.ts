import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/csv";

describe("CSV export safety", () => {
  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@import")).toBe("'@import");
    expect(csvCell("\tpayload")).toBe("'\tpayload");
  });

  it("does not mangle numeric amounts", () => {
    expect(csvCell(-500)).toBe("-500");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(1234.56)).toBe("1234.56");
  });

  it("quotes separators, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("renders empty cells for null/undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("builds CRLF rows in header order", () => {
    const csv = toCsv(["ref", "amount_npr"], [
      { ref: "PAY-1", amount_npr: "1500.00" },
      { ref: "=bad", amount_npr: "20.00" },
    ]);
    expect(csv).toBe("ref,amount_npr\r\nPAY-1,1500.00\r\n'=bad,20.00\r\n");
  });
});
