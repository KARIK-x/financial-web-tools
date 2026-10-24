import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import {
  createExpense, decideClaim, getClaim, recordClaimPayment, verifyClaim,
} from "@/server/expenses";
import {
  confirmStatementMatch, createReconciliation, importStatement, paymentCandidatesForImport, unreconciledSummary,
} from "@/server/accounts";
import { buildExport } from "@/server/exports";
import { currentFiscalPeriod } from "@/server/reports";
import { accountCodeBalance, createPerson, createTestDb, journalTotals, statementCsv } from "./helpers/fixtures";

let db: Db;
let member: CurrentUser;
let finance: CurrentUser;
let auditor: CurrentUser;
let cashId: string;
let bankId: string;

async function createAccount(name: string, type: "CASH" | "BANK", openingPaisa: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa) VALUES ($1,$2,$3,$4)`,
    [id, name, type, openingPaisa],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  member = await createPerson(db, { role: "MEMBER", name: "Sita Member" });
  finance = await createPerson(db, { role: "FINANCE", name: "Ramesh Finance" });
  auditor = await createPerson(db, { role: "AUDITOR", name: "Auditor", member: false });
  cashId = await createAccount("Test cash", "CASH", 10_000_000);
  bankId = await createAccount("Test bank", "BANK", 500_000);
});

afterAll(async () => {
  await db.close();
});

describe("claim lifecycle", () => {
  let claimId: string;
  let paymentId: string;

  it("creates a submitted personal claim with an allocation and BS date", async () => {
    const created = await createExpense(db, member, {
      date: "2026-10-20",
      vendorName: "Sajha Stationery",
      description: "Printing 200 event posters",
      amount: "1,500",
      categoryId: "cat_printing",
      fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Receipt lost while travelling; declaration recorded per policy.",
      submitNow: true,
    });
    claimId = created.id;
    expect(created.status).toBe("SUBMITTED");

    const claim = await getClaim(db, member, claimId);
    expect(claim?.amount_paisa).toBe(150_000);
    expect(claim?.date_bs).toBe("2083-07-03");
    expect(claim?.allocations).toHaveLength(1);
    expect(claim?.allocations[0]?.amount_paisa).toBe(150_000);
  });

  it("refuses approval by the claimant and by roles without the permission", async () => {
    await expect(decideClaim(db, member, claimId, "APPROVE", null)).rejects.toThrow(/cannot approve/i);
    await expect(decideClaim(db, auditor, claimId, "APPROVE", null)).rejects.toThrow(/cannot approve/i);
  });

  it("requires a reason to reject", async () => {
    await expect(decideClaim(db, finance, claimId, "REJECT", "  ")).rejects.toThrow(/reason is required/i);
  });

  it("approves at the standard tier and accrues a member payable", async () => {
    const result = await decideClaim(db, finance, claimId, "APPROVE", "Checked against event budget.");
    expect(result.status).toBe("PAYMENT_PENDING");
    expect(await accountCodeBalance(db, "5002")).toBe(150_000);
    expect(await accountCodeBalance(db, "2000")).toBe(-150_000);
  });

  it("blocks payment beyond the outstanding balance and by unauthorised roles", async () => {
    await expect(
      recordClaimPayment(db, auditor, { claimId, accountId: cashId, amount: "1500", date: "2026-10-21" }),
    ).rejects.toThrow(/cannot record payments/i);
    await expect(
      recordClaimPayment(db, finance, { claimId, accountId: cashId, amount: "1600", date: "2026-10-21" }),
    ).rejects.toThrow(/exceeds/i);
  });

  it("records reimbursement, clears the payable and marks the claim reimbursed", async () => {
    const result = await recordClaimPayment(db, finance, {
      claimId, accountId: cashId, amount: "1500", date: "2026-10-21", method: "Cash",
    });
    paymentId = result.paymentId;
    expect(result.status).toBe("REIMBURSED");
    expect(await accountCodeBalance(db, "2000")).toBe(0);
    expect(await accountCodeBalance(db, "1000")).toBe(-150_000);

    const claim = await getClaim(db, finance, claimId);
    expect(claim?.payments).toHaveLength(1);
    expect(claim?.payments[0]?.amount_paisa).toBe(150_000);
  });

  it("prevents the claimant from verifying their own claim", async () => {
    await expect(verifyClaim(db, member, claimId)).rejects.toThrow(/cannot verify/i);
  });

  it("verifies evidence and records the verification approval", async () => {
    await verifyClaim(db, finance, claimId, "Declaration accepted.");
    const claim = await getClaim(db, finance, claimId);
    expect(claim?.status).toBe("VERIFIED");
    expect(claim?.verification_state).toBe("VERIFIED");
    expect(claim?.approvals.some((a) => a.decision === "VERIFY")).toBe(true);
  });

  it("keeps the journal balanced through the full lifecycle", async () => {
    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.entries).toBeGreaterThan(0);
  });

  it("exports integer paisa and decimal NPR for the same values", async () => {
    const period = await currentFiscalPeriod(db);
    const exported = await buildExport(db, "claims", period);
    const row = exported.records.find((r) => r.id === claimId);
    expect(row?.amount_paisa).toBe(150_000);
    expect(row?.amount_npr).toBe("1500.00");
    expect(row?.is_synthetic).toBe(false);

    const trial = await buildExport(db, "trial-balance", period);
    const debit = trial.records.reduce((s, r) => s + Number(r.debit_paisa), 0);
    const credit = trial.records.reduce((s, r) => s + Number(r.credit_paisa), 0);
    expect(debit).toBe(credit);
  });

  it("makes the payment immutable after recording", async () => {
    await expect(
      db.query(`UPDATE payments SET amount_paisa=1 WHERE id=$1`, [paymentId]),
    ).rejects.toThrow(/cannot be changed/i);
  });
});

describe("bank reconciliation closes the loop", () => {
  let claimId: string;
  let paymentId: string;
  let importId: string;

  it("pays a second claim from the bank and verifies it", async () => {
    const created = await createExpense(db, member, {
      date: "2026-10-20",
      vendorName: "Himalayan Printers",
      description: "Banner printing",
      amount: "2,000",
      categoryId: "cat_printing",
      fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Vendor did not issue a receipt; declaration recorded.",
      submitNow: true,
    });
    claimId = created.id;
    await decideClaim(db, finance, claimId, "APPROVE", null);
    const payment = await recordClaimPayment(db, finance, {
      claimId, accountId: bankId, amount: "2000", date: "2026-10-21", method: "Bank transfer",
    });
    paymentId = payment.paymentId;
    await verifyClaim(db, finance, claimId);
    const claim = await getClaim(db, finance, claimId);
    expect(claim?.status).toBe("VERIFIED");
  });

  it("imports the statement, suggests the payment and leaves unrelated lines open", async () => {
    const result = await importStatement(db, finance, {
      accountId: bankId,
      filename: "october.csv",
      bytes: statementCsv([
        { date: "2026-10-21", description: "Transfer to member", debit: "2000.00", balance: "3000.00" },
        { date: "2026-10-22", description: "Cash deposit not yet recorded", credit: "5000.00", balance: "8000.00" },
      ]),
    });
    importId = result.importId;
    expect(result.lines).toBe(2);
    expect(result.duplicate).toBe(0);

    const lines = await db.query<{ id: string; description: string; match_status: string; matched_payment_id: string | null }>(
      `SELECT id, description, match_status, matched_payment_id FROM bank_statement_lines ORDER BY txn_date`,
    );
    const transfer = lines.rows.find((l) => l.description === "Transfer to member");
    expect(transfer?.match_status).toBe("SUGGESTED");
    expect(transfer?.matched_payment_id).toBe(paymentId);
    expect(lines.rows.find((l) => l.description.includes("Cash deposit"))?.match_status).toBe("UNMATCHED");

    // The review screen loads candidate payments for the import period.
    const candidates = await paymentCandidatesForImport(db, importId);
    expect(candidates.some((c) => c.id === paymentId)).toBe(true);
  });

  it("re-importing the same file is idempotent", async () => {
    const again = await importStatement(db, finance, {
      accountId: bankId,
      filename: "october.csv",
      bytes: statementCsv([
        { date: "2026-10-21", description: "Transfer to member", debit: "2000.00", balance: "3000.00" },
        { date: "2026-10-22", description: "Cash deposit not yet recorded", credit: "5000.00", balance: "8000.00" },
      ]),
    });
    expect(again.duplicate).toBe(2);
    const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM bank_statement_lines`);
    expect(count.rows[0]?.n).toBe(2);
  });

  it("confirms the match and moves the verified claim to reconciled", async () => {
    const line = await db.query<{ id: string }>(
      `SELECT id FROM bank_statement_lines WHERE description='Transfer to member'`,
    );
    await confirmStatementMatch(db, finance, line.rows[0]!.id, paymentId);
    const claim = await getClaim(db, finance, claimId);
    expect(claim?.status).toBe("RECONCILED");

    await expect(confirmStatementMatch(db, finance, line.rows[0]!.id, paymentId)).rejects.toThrow(/already matched/i);
  });

  it("reconciles the account when the statement balance agrees", async () => {
    const result = await createReconciliation(db, finance, {
      accountId: bankId, importId, periodStart: "2026-10-01", periodEnd: "2026-10-31", statementBalance: "3,000",
    });
    expect(result.computed).toBe(300_000);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("RECONCILED");
  });

  it("leaves the unmatched deposit visible for follow-up", async () => {
    const summary = await unreconciledSummary(db);
    expect(summary.unmatched).toBe(1);
  });
});
