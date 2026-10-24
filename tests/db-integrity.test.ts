import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { ACCOUNTS, postJournal } from "@/server/journal";
import { createPerson, createTestDb, journalTotals } from "./helpers/fixtures";
import type { CurrentUser } from "@/server/auth";

let db: Db;
let claimant: CurrentUser;
let approver: CurrentUser;

async function insertClaim(amountPaisa: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO expense_claims
      (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, category_id, amount_paisa, description, funding_source, status)
     VALUES ($1,$2,$3,$4,'2026-10-10','cat_travel',$5,'Integrity fixture','PERSONAL','DRAFT')`,
    [id, `T-${id.slice(0, 8)}`, claimant.id, claimant.memberId, amountPaisa],
  );
  await db.query(
    `INSERT INTO expense_allocations (id, claim_id, amount_paisa) VALUES ($1,$2,$3)`,
    [randomUUID(), id, amountPaisa],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  claimant = await createPerson(db, { role: "MEMBER", name: "Claimant" });
  approver = await createPerson(db, { role: "FINANCE", name: "Approver" });
});

afterAll(async () => {
  await db.close();
});

describe("audit trail is append-only", () => {
  it("blocks updates and deletes", async () => {
    await recordAudit(db, { actorUserId: approver.id, actorName: "Approver", action: "TEST", entityType: "test", summary: "immutable" });
    await expect(db.query(`UPDATE audit_events SET summary='tampered'`)).rejects.toThrow(/append-only/i);
    await expect(db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/i);
  });
});

describe("claim integrity", () => {
  it("blocks self-approval at the database level", async () => {
    const claimId = await insertClaim(100_000);
    await expect(
      db.query(
        `INSERT INTO approvals (id, claim_id, approver_user_id, decision) VALUES ($1,$2,$3,'APPROVE')`,
        [randomUUID(), claimId, claimant.id],
      ),
    ).rejects.toThrow(/cannot approve/i);
  });

  it("blocks deleting claims", async () => {
    const claimId = await insertClaim(100_000);
    await expect(db.query(`DELETE FROM expense_claims WHERE id=$1`, [claimId])).rejects.toThrow(/cannot be deleted/i);
  });

  it("rejects a partial allocation at commit time", async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO expense_claims
        (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, category_id, amount_paisa, description, funding_source, status)
       VALUES ($1,$2,$3,$4,'2026-10-11','cat_travel',100000,'Allocation fixture','PERSONAL','DRAFT')`,
      [id, `T-${id.slice(0, 8)}`, claimant.id, claimant.memberId],
    );
    await expect(
      db.query(`INSERT INTO expense_allocations (id, claim_id, amount_paisa) VALUES ($1,$2,40000)`, [randomUUID(), id]),
    ).rejects.toThrow(/must equal/i);
  });

  it("refuses to submit a claim with no allocation lines", async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO expense_claims
        (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, category_id, amount_paisa, description, funding_source, status)
       VALUES ($1,$2,$3,$4,'2026-10-11','cat_travel',100000,'No allocation','PERSONAL','DRAFT')`,
      [id, `T-${id.slice(0, 8)}`, claimant.id, claimant.memberId],
    );
    await expect(db.query(`UPDATE expense_claims SET status='SUBMITTED' WHERE id=$1`, [id])).rejects.toThrow(/at least one allocation/i);
  });

  it("freezes financial fields once approved", async () => {
    const claimId = await insertClaim(120_000);
    await db.query(`UPDATE expense_claims SET status='APPROVED' WHERE id=$1`, [claimId]);
    await expect(db.query(`UPDATE expense_claims SET amount_paisa=999999 WHERE id=$1`, [claimId])).rejects.toThrow(/cannot be edited/i);
  });

  it("blocks transitions out of terminal states", async () => {
    const claimId = await insertClaim(120_000);
    await db.query(`UPDATE expense_claims SET status='REJECTED', rejected_reason='fixture' WHERE id=$1`, [claimId]);
    await expect(db.query(`UPDATE expense_claims SET status='PAYMENT_PENDING' WHERE id=$1`, [claimId])).rejects.toThrow(/terminal state/i);
  });
});

describe("payment integrity", () => {
  it("blocks editing or deleting recorded payments", async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO payments (id, ref, type, direction, amount_paisa, date_ad, status)
       VALUES ($1,$2,'OTHER_INCOME','IN',50000,'2026-10-12','RECORDED')`,
      [id, `T-${id.slice(0, 8)}`],
    );
    await expect(db.query(`UPDATE payments SET amount_paisa=1 WHERE id=$1`, [id])).rejects.toThrow(/cannot be changed/i);
    await expect(db.query(`DELETE FROM payments WHERE id=$1`, [id])).rejects.toThrow(/cannot be deleted/i);
  });
});

describe("journal integrity", () => {
  it("posts balanced entries and reports balanced totals", async () => {
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        date: "2026-10-13",
        memo: "Integrity test",
        sourceType: "TEST",
        createdBy: approver.id,
        lines: [
          { accountCode: ACCOUNTS.CASH.code, accountName: ACCOUNTS.CASH.name, debit: 75_000 },
          { accountCode: ACCOUNTS.MEMBER_PAYABLE.code, accountName: ACCOUNTS.MEMBER_PAYABLE.name, credit: 75_000 },
        ],
      });
    });
    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.debit).toBeGreaterThanOrEqual(75_000);
  });

  it("rejects unbalanced and single-line entries before writing", async () => {
    await expect(
      db.transaction(async (tx) =>
        postJournal(tx, {
          date: "2026-10-13", memo: "Unbalanced", sourceType: "TEST", createdBy: approver.id,
          lines: [
            { accountCode: "1000", accountName: "Cash", debit: 100 },
            { accountCode: "2000", accountName: "Payable", credit: 90 },
          ],
        }),
      ),
    ).rejects.toThrow(/unbalanced/i);

    await expect(
      db.transaction(async (tx) =>
        postJournal(tx, {
          date: "2026-10-13", memo: "Single", sourceType: "TEST", createdBy: approver.id,
          lines: [{ accountCode: "1000", accountName: "Cash", debit: 100 }],
        }),
      ),
    ).rejects.toThrow(/two lines/i);
  });

  it("enforces balance in the database even when the service layer is bypassed", async () => {
    await expect(
      db.transaction(async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO journal_entries (id, entry_no, entry_date, memo, source_type, status)
           VALUES ($1,'JE-BYPASS-1','2026-10-14','Bypass','TEST','DRAFT')`,
          [id],
        );
        await tx.query(
          `INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit_paisa, credit_paisa)
           VALUES ($1,$2,'1000','Cash',100,0)`,
          [randomUUID(), id],
        );
        await tx.query(
          `INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit_paisa, credit_paisa)
           VALUES ($1,$2,'2000','Payable',0,60)`,
          [randomUUID(), id],
        );
        await tx.query(`UPDATE journal_entries SET status='POSTED' WHERE id=$1`, [id]);
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it("makes posted journal lines immutable", async () => {
    const entry = await db.query<{ id: string }>(`SELECT id FROM journal_entries WHERE status='POSTED' LIMIT 1`);
    const entryId = entry.rows[0]!.id;
    await expect(
      db.query(
        `INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit_paisa, credit_paisa)
         VALUES ($1,$2,'1000','Cash',5,0)`,
        [randomUUID(), entryId],
      ),
    ).rejects.toThrow(/immutable/i);
  });
});
