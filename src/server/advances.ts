import { randomUUID } from "node:crypto";
import { z } from "zod";
import { many, money, one, type Db } from "./db";
import { recordAudit } from "./audit";
import { ACCOUNTS, accountLedger, advanceNumber, postJournal } from "./journal";
import { parseMoney } from "@/lib/money";
import { isValidISODate } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { ExpenseError, refreshAdvanceStatus } from "./expenses";
import { lockAndAssertFunds } from "./funds";

export type AdvanceRow = {
  id: string;
  ref: string;
  member_id: string;
  member_name: string;
  event_id: string | null;
  event_name: string | null;
  purpose: string;
  amount_paisa: number;
  disbursed_on: string | null;
  due_on: string | null;
  status: string;
  used_paisa: number;
  returned_paisa: number;
  outstanding_paisa: number;
  days_outstanding: number;
  created_at: Date;
};

export async function listAdvances(db: Db, filters: { memberId?: string; status?: string } = {}): Promise<AdvanceRow[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (filters.memberId) { params.push(filters.memberId); clauses.push(`a.member_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); clauses.push(`a.status = $${params.length}`); }
  const rows = await many<AdvanceRow>(
    db,
    `SELECT a.id, a.ref, a.member_id, m.name AS member_name, a.event_id, e.name AS event_name, a.purpose,
            a.amount_paisa, to_char(a.disbursed_on,'YYYY-MM-DD') AS disbursed_on,
            to_char(a.due_on,'YYYY-MM-DD') AS due_on, a.status, a.created_at,
            COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.advance_id=a.id
              AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0) AS used_paisa,
            COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0) AS returned_paisa,
            GREATEST(0, a.amount_paisa
              - COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.advance_id=a.id
                  AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0)
              - COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0)) AS outstanding_paisa,
            CASE WHEN a.disbursed_on IS NULL THEN 0
                 ELSE GREATEST(0, CURRENT_DATE - a.disbursed_on) END AS days_outstanding
       FROM advances a JOIN members m ON m.id=a.member_id LEFT JOIN events e ON e.id=a.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY (a.status IN ('OUTSTANDING','PARTIALLY_SETTLED')) DESC, a.created_at DESC`,
    params,
  );
  return rows.map(normaliseAdvance);
}

/** Postgres returns SUM()/bigint columns as strings; normalise to integer paisa. */
function normaliseAdvance<T extends { amount_paisa: unknown; used_paisa: unknown; returned_paisa: unknown; outstanding_paisa: unknown; days_outstanding: unknown }>(row: T): T {
  return {
    ...row,
    amount_paisa: money(row.amount_paisa),
    used_paisa: money(row.used_paisa),
    returned_paisa: money(row.returned_paisa),
    outstanding_paisa: money(row.outstanding_paisa),
    days_outstanding: Number(row.days_outstanding),
  };
}

export async function getAdvance(db: Db, id: string) {
  const adv = await one<AdvanceRow & { notes: string | null; requester_name: string | null }>(
    db,
    `SELECT a.id, a.ref, a.member_id, m.name AS member_name, a.event_id, e.name AS event_name, a.purpose,
            a.amount_paisa, to_char(a.disbursed_on,'YYYY-MM-DD') AS disbursed_on,
            to_char(a.due_on,'YYYY-MM-DD') AS due_on, a.status, a.created_at, a.notes,
            u.name AS requester_name,
            COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.advance_id=a.id
              AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0) AS used_paisa,
            COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0) AS returned_paisa,
            GREATEST(0, a.amount_paisa
              - COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.advance_id=a.id
                  AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0)
              - COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0)) AS outstanding_paisa,
            CASE WHEN a.disbursed_on IS NULL THEN 0 ELSE GREATEST(0, CURRENT_DATE - a.disbursed_on) END AS days_outstanding
       FROM advances a JOIN members m ON m.id=a.member_id
       LEFT JOIN events e ON e.id=a.event_id LEFT JOIN users u ON u.id=a.requester_user_id
      WHERE a.id = $1`,
    [id],
  );
  if (!adv) return null;
  const claims = await many<{ id: string; claim_no: string; amount_paisa: number; status: string; date_ad: string }>(
    db,
    `SELECT id, claim_no, amount_paisa, status, to_char(date_ad,'YYYY-MM-DD') AS date_ad
       FROM expense_claims WHERE advance_id=$1 ORDER BY date_ad`,
    [id],
  );
  const payments = await many<{ id: string; ref: string; type: string; amount_paisa: number; date_ad: string; account_name: string | null; status: string }>(
    db,
    `SELECT p.id, p.ref, p.type, p.amount_paisa, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad, fa.name AS account_name, p.status
       FROM payments p LEFT JOIN financial_accounts fa ON fa.id=p.account_id WHERE p.advance_id=$1 ORDER BY p.created_at`,
    [id],
  );
  const settlements = await many<{ id: string; returned_paisa: number; settled_paisa: number; settled_on: string; notes: string | null }>(
    db,
    `SELECT id, returned_paisa, settled_paisa, to_char(settled_on,'YYYY-MM-DD') AS settled_on, notes
       FROM advance_settlements WHERE advance_id=$1 ORDER BY settled_on`,
    [id],
  );
  return {
    ...normaliseAdvance(adv),
    claims: claims.map((c) => ({ ...c, amount_paisa: money(c.amount_paisa) })),
    payments: payments.map((p) => ({ ...p, amount_paisa: money(p.amount_paisa) })),
    settlements: settlements.map((s) => ({
      ...s,
      returned_paisa: money(s.returned_paisa),
      settled_paisa: money(s.settled_paisa),
    })),
  };
}

const advanceSchema = z.object({
  memberId: z.string().min(1),
  purpose: z.string().trim().min(3).max(300),
  amount: z.string().min(1),
  eventId: z.string().optional().nullable(),
  dueOn: z.string().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function createAdvance(db: Db, user: CurrentUser, raw: z.input<typeof advanceSchema>) {
  const parsed = advanceSchema.safeParse(raw);
  if (!parsed.success) throw new ExpenseError(parsed.error.issues.map((i) => i.message).join(" "));
  const input = parsed.data;
  if (!can(user.role, "advance.manage", user.permissions) && input.memberId !== user.memberId) {
    throw new ExpenseError("You can only request an advance for yourself.");
  }
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  if (input.dueOn && !isValidISODate(input.dueOn)) throw new ExpenseError("Due date is invalid.");
  const id = randomUUID();
  const ref = await advanceNumber(db);
  await db.query(
    `INSERT INTO advances (id, ref, member_id, requester_user_id, event_id, purpose, amount_paisa, due_on, notes, created_by, status, is_synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,'REQUESTED',$10)`,
    [id, ref, input.memberId, user.id, input.eventId ?? null, input.purpose, amount.paisa, input.dueOn ?? null, input.notes ?? null, user.isSynthetic],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "ADVANCE_REQUESTED",
    entityType: "advance", entityId: id, summary: `${ref} requested: NPR ${(amount.paisa / 100).toFixed(2)}`,
    after: { amount_paisa: amount.paisa },
  });
  return { id, ref };
}

export async function disburseAdvance(
  db: Db,
  user: CurrentUser,
  input: { advanceId: string; accountId: string; date: string; method?: string; reference?: string },
) {
  if (!can(user.role, "advance.manage", user.permissions)) throw new ExpenseError("You cannot disburse advances.");
  if (!isValidISODate(input.date)) throw new ExpenseError("Disbursement date is invalid.");
  const adv = await one<{ id: string; ref: string; amount_paisa: number; status: string; member_id: string }>(
    db, `SELECT id, ref, amount_paisa, status, member_id FROM advances WHERE id=$1`, [input.advanceId],
  );
  if (!adv) throw new ExpenseError("Advance not found.");
  if (!["REQUESTED", "APPROVED"].includes(adv.status)) throw new ExpenseError("This advance has already been disbursed or closed.");
  const account = await one<{ id: string; name: string; type: string }>(db, `SELECT id, name, type FROM financial_accounts WHERE id=$1`, [input.accountId]);
  if (!account) throw new ExpenseError("Select a valid account.");

  const paymentId = randomUUID();
  await db.transaction(async (tx) => {
    await lockAndAssertFunds(tx, account.id, input.date, adv.amount_paisa, account.name);
    await tx.query(
      `INSERT INTO payments (id, ref, type, direction, advance_id, account_id, counterparty_member_id, amount_paisa,
                             date_ad, method, reference, created_by, status, is_synthetic)
       VALUES ($1,$2,'ADVANCE_DISBURSEMENT','OUT',$3,$4,$5,$6,$7,$8,$9,$10,'RECORDED',$11)`,
      [
        paymentId, `ADVPAY-${adv.ref}`, adv.id, account.id, adv.member_id, adv.amount_paisa,
        input.date, input.method ?? null, input.reference ?? null, user.id, user.isSynthetic,
      ],
    );
    const ledger = accountLedger(account.type);
    await postJournal(tx, {
      date: input.date,
      memo: `Advance ${adv.ref} disbursed from ${account.name}`,
      sourceType: "ADVANCE_DISBURSEMENT",
      sourceId: paymentId,
      createdBy: user.id,
      lines: [
        { accountCode: ACCOUNTS.ADVANCE.code, accountName: ACCOUNTS.ADVANCE.name, debit: adv.amount_paisa },
        { accountCode: ledger.code, accountName: `${ledger.name} — ${account.name}`, credit: adv.amount_paisa },
      ],
    });
    await tx.query(`UPDATE advances SET status='OUTSTANDING', disbursed_on=$2 WHERE id=$1`, [adv.id, input.date]);
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "ADVANCE_DISBURSED",
    entityType: "advance", entityId: adv.id,
    summary: `${adv.ref}: NPR ${(adv.amount_paisa / 100).toFixed(2)} disbursed from ${account.name}`,
  });
}

export async function returnAdvanceFunds(
  db: Db,
  user: CurrentUser,
  input: { advanceId: string; accountId: string; amount: string; date: string; notes?: string },
) {
  if (!can(user.role, "advance.manage", user.permissions)) throw new ExpenseError("You cannot record advance returns.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  if (!isValidISODate(input.date)) throw new ExpenseError("Return date is invalid.");
  const adv = await one<{ id: string; ref: string; status: string; member_id: string }>(
    db, `SELECT id, ref, status, member_id FROM advances WHERE id=$1`, [input.advanceId],
  );
  if (!adv || !["OUTSTANDING", "PARTIALLY_SETTLED"].includes(adv.status)) throw new ExpenseError("This advance is not open.");
  const outstandingRow = await one<{ outstanding: number }>(
    db,
    `SELECT GREATEST(0, a.amount_paisa
        - COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.advance_id=a.id
            AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0)
        - COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0)) AS outstanding
       FROM advances a WHERE a.id=$1`,
    [adv.id],
  );
  const outstanding = money(outstandingRow?.outstanding);
  if (amount.paisa > outstanding) {
    throw new ExpenseError(`Return exceeds the outstanding advance balance of NPR ${(outstanding / 100).toFixed(2)}.`);
  }
  const account = await one<{ id: string; name: string; type: string }>(db, `SELECT id, name, type FROM financial_accounts WHERE id=$1`, [input.accountId]);
  if (!account) throw new ExpenseError("Select a valid account.");
  const paymentId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (id, ref, type, direction, advance_id, account_id, counterparty_member_id, amount_paisa,
                             date_ad, notes, created_by, status, is_synthetic)
       VALUES ($1,$2,'ADVANCE_RETURN','IN',$3,$4,$5,$6,$7,$8,$9,'RECORDED',$10)`,
      [paymentId, `ADVRET-${adv.ref}-${Date.now().toString().slice(-5)}`, adv.id, account.id, adv.member_id, amount.paisa, input.date, input.notes ?? null, user.id, user.isSynthetic],
    );
    await tx.query(
      `INSERT INTO advance_settlements (id, advance_id, returned_paisa, settled_paisa, settled_on, notes, created_by)
       VALUES ($1,$2,$3,0,$4,$5,$6)`,
      [randomUUID(), adv.id, amount.paisa, input.date, input.notes ?? null, user.id],
    );
    const ledger = accountLedger(account.type);
    await postJournal(tx, {
      date: input.date,
      memo: `Unused advance ${adv.ref} returned to ${account.name}`,
      sourceType: "ADVANCE_RETURN",
      sourceId: paymentId,
      createdBy: user.id,
      lines: [
        { accountCode: ledger.code, accountName: `${ledger.name} — ${account.name}`, debit: amount.paisa },
        { accountCode: ACCOUNTS.ADVANCE.code, accountName: ACCOUNTS.ADVANCE.name, credit: amount.paisa },
      ],
    });
  });
  await refreshAdvanceStatus(db, adv.id);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "ADVANCE_RETURNED",
    entityType: "advance", entityId: adv.id, summary: `${adv.ref}: NPR ${(amount.paisa / 100).toFixed(2)} returned`,
  });
}

export async function writeOffAdvance(db: Db, user: CurrentUser, advanceId: string, reason: string) {
  if (!can(user.role, "settings.manage", user.permissions)) throw new ExpenseError("Only the Finance Manager can write off an advance.");
  if (!reason.trim()) throw new ExpenseError("A write-off reason is required.");
  await db.query(`UPDATE advances SET status='WRITTEN_OFF', notes=COALESCE(notes,'') || $2 WHERE id=$1`, [advanceId, `\n[Written off] ${reason}`]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "ADVANCE_WRITTEN_OFF",
    entityType: "advance", entityId: advanceId, summary: `Advance written off: ${reason}`,
  });
}

export async function memberAccountability(db: Db) {
  return many<{
    member_id: string; name: string; submitted_count: number; submitted_paisa: number;
    approved_paisa: number; awaiting_paisa: number; missing_docs_paisa: number;
    advances_outstanding_paisa: number; reimbursements_owed_paisa: number; reimbursed_paisa: number;
  }>(
    db,
    `SELECT m.id AS member_id, m.name,
      (SELECT COUNT(*)::int FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.status NOT IN ('DRAFT','WITHDRAWN')) AS submitted_count,
      COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.status NOT IN ('DRAFT','WITHDRAWN')),0) AS submitted_paisa,
      COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.status IN ('APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED')),0) AS approved_paisa,
      COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.status IN ('SUBMITTED','UNDER_REVIEW')),0) AS awaiting_paisa,
      COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.documentation_state <> 'COMPLETE' AND c.status NOT IN ('DRAFT','WITHDRAWN','REJECTED')),0) AS missing_docs_paisa,
      COALESCE((SELECT SUM(GREATEST(0, a.amount_paisa
        - COALESCE((SELECT SUM(cc.amount_paisa) FROM expense_claims cc WHERE cc.advance_id=a.id AND cc.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0)
        - COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0)))
        FROM advances a WHERE a.member_id=m.id AND a.status IN ('OUTSTANDING','PARTIALLY_SETTLED')),0) AS advances_outstanding_paisa,
      COALESCE((SELECT SUM(c.amount_paisa - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.claim_id=c.id AND p.status='RECORDED' AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')),0))
        FROM expense_claims c WHERE c.paid_by_member_id=m.id AND c.reimbursement_required=true AND c.status IN ('APPROVED','PAYMENT_PENDING','VERIFIED')),0) AS reimbursements_owed_paisa,
      COALESCE((SELECT SUM(p.amount_paisa) FROM payments p JOIN expense_claims c ON c.id=p.claim_id
        WHERE c.paid_by_member_id=m.id AND p.type='REIMBURSEMENT' AND p.status='RECORDED'),0) AS reimbursed_paisa
     FROM members m
     WHERE m.is_active = true
     ORDER BY reimbursements_owed_paisa DESC, advances_outstanding_paisa DESC, m.name`,
  );
}

export function advanceAging(advances: AdvanceRow[]) {
  const open = advances.filter((a) => ["OUTSTANDING", "PARTIALLY_SETTLED"].includes(a.status) && a.outstanding_paisa > 0);
  return {
    count: open.length,
    outstanding: open.reduce((s, a) => s + money(a.outstanding_paisa), 0),
    over30: open.filter((a) => a.days_outstanding > 30),
  };
}
