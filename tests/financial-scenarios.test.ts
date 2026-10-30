import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import {
  createExpense, decideClaim, getClaim, recordClaimPayment, verifyClaim,
} from "@/server/expenses";
import { createAdvance, disburseAdvance, getAdvance, returnAdvanceFunds } from "@/server/advances";
import { createSponsorship, recordSponsorReceipt, sponsorshipSummary } from "@/server/sponsors";
import { recordTransfer } from "@/server/accounts";
import { importStatement } from "@/server/accounts";
import { cashflow, currentFiscalPeriod, getDashboard, spendByEvent } from "@/server/reports";
import { reversePayment } from "@/server/corrections";
import { createBatch, uploadOne } from "@/server/documents";
import { accountCodeBalance, createPerson, createTestDb, journalTotals, statementCsv } from "./helpers/fixtures";

let db: Db;
let member: CurrentUser;
let finance: CurrentUser;
let executive: CurrentUser;
let cashId: string;
let bankId: string;
let eventA: string;
let eventB: string;

const PERIOD_DATE = "2026-10-20";

async function createAccount(name: string, type: "CASH" | "BANK", openingPaisa: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa) VALUES ($1,$2,$3,$4)`,
    [id, name, type, openingPaisa],
  );
  return id;
}

async function createEvent(name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO events (id, name, code, starts_on, ends_on, status) VALUES ($1,$2,$3,$4,$4,'ACTIVE')`,
    [id, name, `SCN-${id.slice(0, 8)}`, PERIOD_DATE],
  );
  return id;
}

async function approve(id: string, amountPaisa: number): Promise<void> {
  await decideClaim(db, finance, id, "APPROVE", "Scenario approval");
  if (amountPaisa > 200_000) await decideClaim(db, executive, id, "APPROVE", "Scenario approval");
}

async function claim(input: {
  amount: string; date: string; categoryId?: string; advanceId?: string; allocations?: Array<{ eventId: string; amount: string }>;
  documentIds?: string[];
}) {
  return createExpense(db, member, {
    date: input.date,
    vendorName: "Scenario Vendor",
    description: `Financial scenario on ${input.date}`,
    amount: input.amount,
    categoryId: input.categoryId ?? "cat_printing",
    fundingSource: input.advanceId ? "LOCUS_CASH" : "PERSONAL",
    advanceId: input.advanceId,
    allocations: input.allocations,
    missingReceiptDeclaration: input.documentIds?.length ? null : "Synthetic test declaration; no real receipt is used.",
    submitNow: true,
  }, input.documentIds ?? []);
}

async function period() {
  return currentFiscalPeriod(db);
}

async function cashflowTotals() {
  const p = await period();
  const rows = await cashflow(db, p);
  return rows.reduce(
    (sum, row) => ({ income: sum.income + row.income, expenditure: sum.expenditure + row.expenditure, advances: sum.advances + row.advances }),
    { income: 0, expenditure: 0, advances: 0 },
  );
}

beforeAll(async () => {
  db = await createTestDb();
  member = await createPerson(db, { role: "MEMBER", name: "Scenario Member" });
  finance = await createPerson(db, { role: "FINANCE", name: "Scenario Finance" });
  executive = await createPerson(db, { role: "EXECUTIVE", name: "Scenario Executive" });
  cashId = await createAccount("Scenario cash", "CASH", 10_000_000);
  bankId = await createAccount("Scenario bank", "BANK", 1_000_000);
  eventA = await createEvent("Scenario Event A");
  eventB = await createEvent("Scenario Event B");
});

afterAll(async () => {
  await db.close();
});

describe("financial scenarios A–J", () => {
  it("A: personal NPR 5,000 expense plus NPR 5,000 reimbursement counts as NPR 5,000 expenditure, not NPR 10,000", async () => {
    const before = await getDashboard(db, await period());
    const created = await claim({ amount: "5000", date: "2026-10-01" });
    await approve(created.id, 500_000);
    await recordClaimPayment(db, finance, { claimId: created.id, accountId: cashId, amount: "5000", date: "2026-10-02" });

    const after = await getDashboard(db, await period());
    expect(after.recorded - before.recorded).toBe(500_000);
    expect((await cashflowTotals()).expenditure).toBe(500_000);
    expect((await getClaim(db, finance, created.id))?.status).toBe("REIMBURSED");
  });

  it("B: an NPR 8,000 expense with NPR 3,000 reimbursed leaves NPR 5,000 outstanding", async () => {
    const before = await getDashboard(db, await period());
    const created = await claim({ amount: "8000", date: "2026-10-03" });
    await approve(created.id, 800_000);
    await recordClaimPayment(db, finance, { claimId: created.id, accountId: cashId, amount: "3000", date: "2026-10-04" });

    const after = await getDashboard(db, await period());
    expect(after.recorded - before.recorded).toBe(800_000);
    expect(after.reimbursementOwed - before.reimbursementOwed).toBe(500_000);
    const current = await getClaim(db, finance, created.id);
    expect(current?.paid_paisa).toBe(300_000);
    expect(current?.status).toBe("PAYMENT_PENDING");
  });

  it("C: a NPR 10,000 advance settled by NPR 7,000 approved expense and NPR 3,000 return has no double count", async () => {
    const before = await getDashboard(db, await period());
    const advance = await createAdvance(db, member, {
      memberId: member.memberId!, purpose: "Scenario advance", amount: "10000", dueOn: "2026-11-30",
    });
    await disburseAdvance(db, finance, { advanceId: advance.id, accountId: cashId, date: "2026-10-05" });
    const created = await claim({ amount: "7000", date: "2026-10-06", advanceId: advance.id });
    await approve(created.id, 700_000);

    expect((await getAdvance(db, advance.id))?.outstanding_paisa).toBe(300_000);
    await returnAdvanceFunds(db, finance, { advanceId: advance.id, accountId: cashId, amount: "3000", date: "2026-10-07" });

    expect((await getAdvance(db, advance.id))?.status).toBe("SETTLED");
    expect((await getAdvance(db, advance.id))?.outstanding_paisa).toBe(0);
    expect(await accountCodeBalance(db, "1100")).toBe(0);
    const after = await getDashboard(db, await period());
    expect(after.recorded - before.recorded).toBe(700_000);
    await expect(
      recordClaimPayment(db, finance, { claimId: created.id, accountId: cashId, amount: "7000", date: "2026-10-08" }),
    ).rejects.toThrow(/cash advance/i);
  });

  it("D: a NPR 100,000 sponsor commitment and NPR 40,000 receipt remain distinct", async () => {
    const before = await sponsorshipSummary(db);
    const agreement = await createSponsorship(db, finance, {
      sponsorName: "Scenario Sponsor", title: "Scenario sponsorship", state: "COMMITTED",
      promised: "100000", inKind: false,
    });
    await recordSponsorReceipt(db, finance, {
      agreementId: agreement.id, accountId: cashId, amount: "40000", date: "2026-10-09",
    });
    const after = await sponsorshipSummary(db);
    expect(after.committed - before.committed).toBe(10_000_000);
    expect(after.received - before.received).toBe(4_000_000);
    expect(after.outstanding - before.outstanding).toBe(6_000_000);
    expect((await cashflowTotals()).income).toBe(4_000_000);
  });

  it("E: a NPR 20,000 transfer between LOCUS accounts is not income or expenditure", async () => {
    const before = await cashflowTotals();
    const accountsBefore = await db.query<{ id: string; balance: string }>(
      `SELECT id, (opening_balance_paisa
        + COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.account_id=financial_accounts.id AND p.type<>'TRANSFER' AND p.direction='IN' AND p.status='RECORDED'),0)
        - COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.account_id=financial_accounts.id AND p.type<>'TRANSFER' AND p.direction='OUT' AND p.status='RECORDED'),0)
        + COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.to_account_id=financial_accounts.id AND p.type='TRANSFER' AND p.status='RECORDED'),0)
        - COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.from_account_id=financial_accounts.id AND p.type='TRANSFER' AND p.status='RECORDED'),0))::text AS balance
       FROM financial_accounts WHERE id IN ($1,$2)`, [cashId, bankId],
    );
    await recordTransfer(db, finance, {
      fromAccountId: cashId, toAccountId: bankId, amount: "20000", date: "2026-10-10", reference: "Scenario transfer",
    });
    const after = await cashflowTotals();
    expect(after.income).toBe(before.income);
    expect(after.expenditure).toBe(before.expenditure);
    const accountsAfter = await db.query<{ id: string; balance: string }>(
      `SELECT id, (opening_balance_paisa
        + COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.account_id=financial_accounts.id AND p.type<>'TRANSFER' AND p.direction='IN' AND p.status='RECORDED'),0)
        - COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.account_id=financial_accounts.id AND p.type<>'TRANSFER' AND p.direction='OUT' AND p.status='RECORDED'),0)
        + COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.to_account_id=financial_accounts.id AND p.type='TRANSFER' AND p.status='RECORDED'),0)
        - COALESCE((SELECT SUM(amount_paisa) FROM payments p WHERE p.from_account_id=financial_accounts.id AND p.type='TRANSFER' AND p.status='RECORDED'),0))::text AS balance
       FROM financial_accounts WHERE id IN ($1,$2)`, [cashId, bankId],
    );
    const beforeMap = new Map(accountsBefore.rows.map((r) => [r.id, Number(r.balance)]));
    const afterMap = new Map(accountsAfter.rows.map((r) => [r.id, Number(r.balance)]));
    expect(afterMap.get(cashId)! - beforeMap.get(cashId)!).toBe(-2_000_000);
    expect(afterMap.get(bankId)! - beforeMap.get(bankId)!).toBe(2_000_000);
  });

  it("F: re-importing the same statement creates no duplicate financial recognition", async () => {
    const beforePayments = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments`);
    const beforeJournal = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM journal_entries`);
    const bytes = statementCsv([
      { date: "2026-10-11", description: "Scenario statement line one", debit: "100.00", balance: "1000.00" },
      { date: "2026-10-12", description: "Scenario statement line two", credit: "200.00", balance: "1200.00" },
    ]);
    const first = await importStatement(db, finance, { accountId: bankId, filename: "scenario.csv", bytes });
    const second = await importStatement(db, finance, { accountId: bankId, filename: "scenario.csv", bytes });
    expect(first.lines).toBe(2);
    expect(second.duplicate).toBe(2);
    const lines = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM bank_statement_lines WHERE description LIKE 'Scenario statement%'`);
    expect(lines.rows[0]?.n).toBe(2);
    const afterPayments = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments`);
    const afterJournal = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM journal_entries`);
    expect(afterPayments.rows[0]?.n).toBe(beforePayments.rows[0]?.n);
    expect(afterJournal.rows[0]?.n).toBe(beforeJournal.rows[0]?.n);
  });

  it("G: splitting one NPR 5,000 expense across two events does not inflate organisation-wide expenditure", async () => {
    const before = await getDashboard(db, await period());
    const created = await claim({
      amount: "5000", date: "2026-10-13",
      allocations: [{ eventId: eventA, amount: "3000" }, { eventId: eventB, amount: "2000" }],
    });
    await approve(created.id, 500_000);
    const after = await getDashboard(db, await period());
    expect(after.recorded - before.recorded).toBe(500_000);
    const p = await period();
    const byEvent = await spendByEvent(db, p);
    const a = byEvent.find((row) => row.event_id === eventA);
    const b = byEvent.find((row) => row.event_id === eventB);
    expect(Number(a?.amount_paisa ?? 0)).toBe(300_000);
    expect(Number(b?.amount_paisa ?? 0)).toBe(200_000);
    expect(Number(a?.amount_paisa ?? 0) + Number(b?.amount_paisa ?? 0)).toBe(500_000);
  });

  it("H: reversing a finalized payment preserves the original, links the reversal, and audits before/after", async () => {
    const before = await getDashboard(db, await period());
    const created = await claim({ amount: "5000", date: "2026-10-14" });
    await approve(created.id, 500_000);
    const payment = await recordClaimPayment(db, finance, {
      claimId: created.id, accountId: cashId, amount: "5000", date: "2026-10-15", reference: "wrong account",
    });
    await verifyClaim(db, finance, created.id);
    const reversal = await reversePayment(db, finance, {
      paymentId: payment.paymentId, date: "2026-10-16", reason: "Wrong account; correcting to bank",
    });

    const original = await db.query<{ status: string; amount_paisa: string }>(`SELECT status, amount_paisa FROM payments WHERE id=$1`, [payment.paymentId]);
    const linked = await db.query<{ status: string; reverses_payment_id: string | null; amount_paisa: string }>(
      `SELECT status, reverses_payment_id, amount_paisa FROM payments WHERE id=$1`, [reversal.reversalPaymentId],
    );
    expect(original.rows[0]?.status).toBe("VOID");
    expect(linked.rows[0]?.status).toBe("RECORDED");
    expect(linked.rows[0]?.reverses_payment_id).toBe(payment.paymentId);
    expect(linked.rows[0]?.amount_paisa).toBe(original.rows[0]?.amount_paisa);
    expect((await getClaim(db, finance, created.id))?.status).toBe("PAYMENT_PENDING");

    const journal = await db.query<{ status: string; reverses_id: string | null }>(
      `SELECT status, reverses_id FROM journal_entries WHERE id=$1`, [reversal.journalEntryId],
    );
    expect(journal.rows[0]?.status).toBe("POSTED");
    expect(journal.rows[0]?.reverses_id).not.toBeNull();
    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);

    const audit = await db.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_events WHERE action='PAYMENT_REVERSED' AND entity_id=$1`, [payment.paymentId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.before).toMatchObject({ status: "RECORDED", amount_paisa: 500_000 });
    expect(audit.rows[0]?.after).toMatchObject({ status: "VOID", reversal_payment_id: reversal.reversalPaymentId });

    await recordClaimPayment(db, finance, {
      claimId: created.id, accountId: bankId, amount: "5000", date: "2026-10-17", reference: "corrected",
    });
    expect((await getClaim(db, finance, created.id))?.status).toBe("REIMBURSED");
    const after = await getDashboard(db, await period());
    expect(after.recorded - before.recorded).toBe(500_000);
    expect((await cashflowTotals()).expenditure).toBeGreaterThanOrEqual(500_000);
  });

  it("I: an unverified claim remains unverified and is not presented as verified expenditure", async () => {
    const before = await getDashboard(db, await period());
    const created = await claim({ amount: "1000", date: "2026-10-18" });
    await approve(created.id, 100_000);
    await recordClaimPayment(db, finance, { claimId: created.id, accountId: cashId, amount: "1000", date: "2026-10-19" });

    const after = await getDashboard(db, await period());
    expect(after.verified).toBe(before.verified);
    expect(after.unverified - before.unverified).toBe(100_000);
    const current = await getClaim(db, finance, created.id);
    expect(current?.verification_state).toBe("UNVERIFIED");
    expect(current?.status).not.toBe("VERIFIED");
  });

  it("J: uploading the same receipt twice and reusing it on another claim does not merge or erase evidence", async () => {
    const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
    const batchId = await createBatch(db, member, "Scenario duplicate batch", "UPLOAD");
    const firstUpload = await uploadOne(db, member, {
      filename: "scenario-receipt.png", mime: "image/png", bytes, batchId,
    });
    expect(firstUpload.duplicate).toBe(false);

    const firstClaim = await claim({ amount: "1200", date: "2026-10-20", documentIds: [firstUpload.documentId] });
    const beforeDoc = await db.query<{ claim_id: string | null; sha256: string }>(
      `SELECT claim_id, sha256 FROM documents WHERE id=$1`, [firstUpload.documentId],
    );
    expect(beforeDoc.rows[0]?.claim_id).toBe(firstClaim.id);

    await expect(claim({ amount: "1300", date: "2026-10-21", documentIds: [firstUpload.documentId] }))
      .rejects.toThrow(/already attached to claim/i);

    const secondUpload = await uploadOne(db, member, {
      filename: "scenario-receipt-copy.png", mime: "image/png", bytes, batchId,
    });
    expect(secondUpload.duplicate).toBe(true);
    expect(secondUpload.duplicateOf).toBe(firstUpload.documentId);
    const docCount = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents WHERE sha256=$1`, [beforeDoc.rows[0]!.sha256]);
    expect(docCount.rows[0]?.n).toBe(1);
    const afterDoc = await db.query<{ claim_id: string | null; sha256: string }>(
      `SELECT claim_id, sha256 FROM documents WHERE id=$1`, [firstUpload.documentId],
    );
    expect(afterDoc.rows[0]).toEqual(beforeDoc.rows[0]);
  });
});
