import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normaliseDate, parseStatement, statementFingerprint } from "@/server/accounts";

function csv(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("statement parsing", () => {
  it("reads debit and credit columns without confusing the description", async () => {
    // Regression: "Description" used to match the two-letter "cr" credit header.
    const parsed = await parseStatement(
      csv(
        [
          "Transaction Date,Description,Debit,Credit,Balance,Reference",
          "2026-10-01,Venue deposit,1500.00,,98500.00,TXN-1",
          "2026-10-02,Sponsor transfer,,4000.00,102500.00,TXN-2",
        ].join("\n"),
      ),
      "statement.csv",
    );
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({ date: "2026-10-01", debitPaisa: 150_000, creditPaisa: 0 });
    expect(parsed.lines[1]).toMatchObject({ date: "2026-10-02", debitPaisa: 0, creditPaisa: 400_000 });
    expect(parsed.lines[0]?.balancePaisa).toBe(9_850_000);
    expect(parsed.detectedColumns).toMatchObject({ date: "column 1", description: "column 2", debit: "column 3", credit: "column 4" });
  });

  it("parses Nepali amounts, lakh shorthand and trailing minus signs", async () => {
    const parsed = await parseStatement(
      csv(
        [
          "Date,Narration,Withdrawal,Deposit,Balance",
          "2026-10-03,Cheque clearing,\"1,500.50\",,84000",
          "2026-10-04,Interest,,2 thousand,86000",
          "2026-10-05,Charge,50-,,85950",
        ].join("\n"),
      ),
      "nepali.csv",
    );
    expect(parsed.lines[0]?.debitPaisa).toBe(150_050);
    expect(parsed.lines[1]?.creditPaisa).toBe(200_000);
    expect(parsed.lines[2]?.debitPaisa).toBe(5_000);
  });

  it("accepts Excel workbooks as well as CSV", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Statement");
    sheet.addRow(["Date", "Description", "Debit", "Credit", "Balance"]);
    sheet.addRow(["2026-10-06", "Printer purchase", 2500, null, 83500]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseStatement(bytes, "statement.xlsx");
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({ date: "2026-10-06", description: "Printer purchase", debitPaisa: 250_000 });
  });

  it("rejects ambiguous day/month order instead of guessing", () => {
    expect(normaliseDate("13/10/2026")).toBe("2026-10-13");
    expect(normaliseDate("05/10/2026")).toBeNull();
    expect(normaliseDate("10/13/2026")).toBeNull();
    expect(normaliseDate("2026-10-24")).toBe("2026-10-24");
  });

  it("skips rows without a usable date or amount and reports them", async () => {
    const parsed = await parseStatement(
      csv(
        [
          "Date,Description,Debit,Credit",
          "2026-10-07,No amount,,",
          "not-a-date,Unreadable date,100,",
          "2026-10-08,Valid line,100,",
        ].join("\n"),
      ),
      "messy.csv",
    );
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
    expect(parsed.warnings.join(" ")).toMatch(/no debit or credit/i);
  });

  it("fails loudly when there is no statement header", async () => {
    await expect(parseStatement(csv("hello,world\n1,2\n"), "bad.csv")).rejects.toThrow(/header/i);
  });

  it("fingerprints identical lines distinctly by occurrence", () => {
    const line = { date: "2026-10-09", description: "Cash deposit", debitPaisa: 0, creditPaisa: 50_000, balancePaisa: null, reference: null };
    const first = statementFingerprint("acct", line, 0);
    const second = statementFingerprint("acct", line, 1);
    expect(first).not.toBe(second);
    expect(statementFingerprint("other", line, 0)).not.toBe(first);
  });
});
