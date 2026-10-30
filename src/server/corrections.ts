import { randomUUID } from "node:crypto";
import { many, money, one, type Db } from "./db";
import { recordAudit } from "./audit";
import { paymentNumber, postJournal } from "./journal";
import { can, type Permission } from "@/lib/permissions";
import { isValidISODate } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";

export class CorrectionError extends Error {}

type PaymentRow = {
  id: string; ref: string; type: string; direction: "IN" | "OUT"; claim_id: string | null;
  advance_id: string | null; agreement_id: string | null; account_id: string | null;
  from_account_id: string | null; to_account_id: string | null; counterparty_member_id: string | null;
  payee_name: string | null; amount_paisa: number; date_ad: string; method: string | null;
  reference: string | null; notes: string | null; status: string; reverses_payment_id: string | null;
  journal_entry_id: string | null; is_synthetic: boolean;
};

/**
 * Void a recorded payment by posting an equal and opposite journal entry and a
 * linked reversal payment. The original rows and journal lines are never edited
 * or deleted. A corrected payment can then be recorded normally.
 *
 * This is a payment correction, not a rewrite of an approved expense amount.
 * Amount corrections require a separate adjustment/replacement claim and remain
 * visible in the audit trail.
 */
export async function reversePayment(
  db: Db,
  user: CurrentUser,
  input: { paymentId: string; date: string; reason: string },
): Promise<{ reversalPaymentId: string; journalEntryId: string; originalPaymentId: string }> {
  if (!isValidISODate(input.date)) throw new CorrectionError("Correction date is invalid.");
  if (!input.reason.trim()) throw new CorrectionError("Explain why this payment is being reversed.");
  const payment = await one<PaymentRow>(
    db,
    `SELECT id, ref, type, direction, claim_id, advance_id, agreement_id, account_id,
            from_account_id, to_account_id, counterparty_member_id, payee_name, amount_paisa,
            to_char(date_ad,'YYYY-MM-DD') AS date_ad, method, reference, notes, status,
            reverses_payment_id, journal_entry_id, is_synthetic
       FROM payments WHERE id=$1`,
    [input.paymentId],
  );
  if (!payment) throw new CorrectionError("Payment not found.");
  if (payment.status !== "RECORDED") throw new CorrectionError("Only a recorded payment can be reversed.");
  if (payment.reverses_payment_id) throw new CorrectionError("A reversal payment cannot itself be reversed; record a new corrected payment.");
  if (!payment.journal_entry_id) throw new CorrectionError("This payment has no journal entry to reverse.");

  const permission = payment.type === "SPONSOR_RECEIPT"
    ? "sponsor.manage"
    : payment.type === "TRANSFER"
      ? "account.manage"
      : payment.type.startsWith("ADVANCE_")
        ? "advance.manage"
        : "expense.pay";
  if (!can(user.role, permission as Permission, user.permissions)) {
    throw new CorrectionError("You do not have permission to reverse this payment.");
  }
  if (payment.type.startsWith("ADVANCE_")) {
    throw new CorrectionError("Advance payments must be corrected through an advance settlement adjustment; this reversal path is limited to expense, sponsor and transfer payments.");
  }

  const lines = await many<{ account_code: string; account_name: string; debit_paisa: number; credit_paisa: number; memo: string | null }>(
    db, `SELECT account_code, account_name, debit_paisa, credit_paisa, memo FROM journal_lines WHERE entry_id=$1 ORDER BY id`,
    [payment.journal_entry_id],
  );
  if (lines.length < 2) throw new CorrectionError("The original journal entry has no lines.");

  const reversalPaymentId = randomUUID();
  const ref = await paymentNumber(db);
  const direction = payment.direction === "OUT" ? "IN" : "OUT";
  const from = payment.type === "TRANSFER" ? payment.to_account_id : payment.from_account_id;
  const to = payment.type === "TRANSFER" ? payment.from_account_id : payment.to_account_id;

  const journalEntryId = await db.transaction(async (tx) => {
    const entryId = await postJournal(tx, {
      date: input.date,
      memo: `Reversal of ${payment.ref}: ${input.reason.trim()}`,
      sourceType: "PAYMENT_REVERSAL",
      sourceId: reversalPaymentId,
      reversesId: payment.journal_entry_id,
      createdBy: user.id,
      lines: lines.map((line) => ({
        accountCode: line.account_code,
        accountName: line.account_name,
        debit: money(line.credit_paisa),
        credit: money(line.debit_paisa),
        memo: `Reversal of ${payment.ref}`,
      })),
    });

    await tx.query(
      `INSERT INTO payments
        (id, ref, type, direction, claim_id, advance_id, agreement_id, account_id, from_account_id,
         to_account_id, counterparty_member_id, payee_name, amount_paisa, date_ad, method, reference,
         notes, status, reverses_payment_id, journal_entry_id, created_by, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'RECORDED',$18,$19,$20,$21)`,
      [
        reversalPaymentId, ref, payment.type, direction, payment.claim_id, payment.advance_id,
        payment.agreement_id, payment.account_id, from, to, payment.counterparty_member_id,
        payment.payee_name, payment.amount_paisa, input.date, payment.method,
        `REV-${payment.ref}`, `Reversal: ${input.reason.trim()}`, payment.id, entryId, user.id, payment.is_synthetic,
      ],
    );
    await tx.query(`UPDATE payments SET status='VOID' WHERE id=$1 AND status='RECORDED'`, [payment.id]);
    await tx.query(`UPDATE journal_entries SET status='REVERSED' WHERE id=$1`, [payment.journal_entry_id]);

    if (payment.claim_id) {
      const claim = await one<{ amount_paisa: number; status: string }>(
        tx, `SELECT amount_paisa, status FROM expense_claims WHERE id=$1`, [payment.claim_id],
      );
      const paid = await one<{ total: number }>(
        tx,
        `SELECT COALESCE(SUM(amount_paisa),0) AS total FROM payments
          WHERE claim_id=$1 AND status='RECORDED' AND reverses_payment_id IS NULL
            AND type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')`,
        [payment.claim_id],
      );
      if (claim) {
        const total = money(paid?.total);
        const next = total <= 0 ? "PAYMENT_PENDING" : total >= money(claim.amount_paisa) ? "REIMBURSED" : "PAYMENT_PENDING";
        if (claim.status !== "RECONCILED") {
          await tx.query(`UPDATE expense_claims SET status=$2 WHERE id=$1`, [payment.claim_id, next]);
        }
      }
    }
    return entryId;
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "PAYMENT_REVERSED",
    entityType: "payment", entityId: payment.id,
    summary: `${payment.ref}: NPR ${(money(payment.amount_paisa) / 100).toFixed(2)} reversed — ${input.reason.trim()}`,
    before: {
      status: payment.status, amount_paisa: payment.amount_paisa, journal_entry_id: payment.journal_entry_id,
      claim_id: payment.claim_id,
    },
    after: {
      status: "VOID", reversal_payment_id: reversalPaymentId, reversal_journal_entry_id: journalEntryId,
      reason: input.reason.trim(),
    },
  });
  return { reversalPaymentId, journalEntryId, originalPaymentId: payment.id };
}
