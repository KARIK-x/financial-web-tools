import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb, createPerson, createBankAccount } from "./helpers/fixtures";
import { createExpense, decideClaim, recordClaimPayment } from "@/server/expenses";
import { resolvePeriod } from "@/server/reports";
import { buildExport } from "@/server/exports";

describe("report and export verification", () => {
  it("keeps export totals aligned with underlying records", async () => {
    const db = await createTestDb();
    try {
      const member = await createPerson(db, { role: "MEMBER", name: "Report Member", synthetic: true });
      const finance = await createPerson(db, { role: "FINANCE", name: "Report Finance", synthetic: true });
      const account = await createBankAccount(db, 200000);
      const claim = await createExpense(db, member, {
        date: "2026-10-10", vendorName: "Report Vendor", description: "Report test expense",
        amount: "1200", categoryId: "cat_printing", fundingSource: "PERSONAL",
        missingReceiptDeclaration: "Synthetic report test", submitNow: true,
      });
      await decideClaim(db, finance, claim.id, "APPROVE", "Report approval");
      await recordClaimPayment(db, finance, { claimId: claim.id, accountId: account, amount: "1200", date: "2026-10-11" });

      const period = await resolvePeriod(db, "2026-10-01", "2026-10-31");
      const claims = await buildExport(db, "claims", period, {});
      const payments = await buildExport(db, "payments", period, {});
      const journal = await buildExport(db, "journal", period, {});
      const trial = await buildExport(db, "trial-balance", period, {});

      expect(claims.records.length).toBe(1);
      expect(Number(claims.records[0]!.amount_paisa)).toBe(120000);
      expect(payments.records.length).toBe(1);
      expect(Number(payments.records[0]!.amount_paisa)).toBe(120000);
      expect(journal.records.length).toBeGreaterThan(0);
      expect(trial.records.length).toBeGreaterThan(0);
      const totalDebit = trial.records.reduce((s, r) => s + Number(r.debit_paisa), 0);
      const totalCredit = trial.records.reduce((s, r) => s + Number(r.credit_paisa), 0);
      expect(totalDebit).toBe(totalCredit);
    } finally { await db.close(); }
  });
});
