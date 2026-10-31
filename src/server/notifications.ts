import { one, type Db } from "./db";
import { enqueueNotification, getEmailConfig } from "./email";

type ClaimNotificationEvent = "SUBMITTED" | "DECISION" | "PAID" | "VERIFIED";

function claimLink(id: string): string {
  return `${getEmailConfig().appUrl}/expenses/${encodeURIComponent(id)}`;
}

/**
 * Queues a minimal, authenticated-link notification. It deliberately does not
 * include receipt images, document URLs, bank details or PAN information.
 * Failures are logged without recipient addresses and never roll back finance.
 */
export async function notifyClaimEvent(
  db: Db,
  claimId: string,
  event: ClaimNotificationEvent,
  opts: { paymentId?: string; actorName?: string } = {},
): Promise<void> {
  try {
    const claim = await one<{
      id: string; claim_no: string; status: string; claimant_user_id: string;
      claimant_name: string; claimant_email: string; claimant_synthetic: boolean;
      amount_paisa: number;
    }>(
      db,
      `SELECT c.id, c.claim_no, c.status, c.claimant_user_id, u.name AS claimant_name,
              u.email AS claimant_email, u.is_synthetic AS claimant_synthetic, c.amount_paisa
         FROM expense_claims c JOIN users u ON u.id=c.claimant_user_id
        WHERE c.id=$1`,
      [claimId],
    );
    if (!claim) return;

    const link = claimLink(claim.id);
    if (event === "SUBMITTED") {
      const recipients = await db.query<{ id: string; name: string; email: string }>(
        `SELECT id, name, email FROM users
          WHERE is_active=true AND is_synthetic=false AND role IN ('FINANCE','EXECUTIVE','ADMIN')
            AND id <> $1
          ORDER BY role, name`,
        [claim.claimant_user_id],
      );
      for (const recipient of recipients.rows) {
        await enqueueNotification(db, {
          kind: "APPROVAL_REQUEST",
          recipient: recipient.email,
          subject: `Approval requested: ${claim.claim_no}`,
          bodyText: [
            `Hello ${recipient.name},`,
            "",
            `${claim.claimant_name} submitted expense claim ${claim.claim_no} for review.`,
            `Open the authenticated claim record: ${link}`,
            "",
            "Finance Tracker · IOE Pulchowk Campus",
          ].join("\n"),
          dedupeKey: `claim:${claim.id}:submitted:${recipient.id}`,
          metadata: { claim_id: claim.id },
        });
      }
      return;
    }

    if (claim.claimant_synthetic) return; // demo identities never receive mail
    const statusLine =
      event === "DECISION"
        ? claim.status === "APPROVED"
          ? "was approved"
          : claim.status === "REJECTED"
            ? "was rejected"
            : "needs another approval"
        : event === "PAID"
          ? "has a payment recorded"
          : "evidence was verified";
    const subject =
      event === "DECISION"
        ? `Expense claim ${claim.claim_no}: ${claim.status.toLowerCase().replace(/_/g, " ")}`
        : event === "PAID"
          ? `Payment recorded: ${claim.claim_no}`
          : `Evidence verified: ${claim.claim_no}`;
    await enqueueNotification(db, {
      kind: event === "DECISION" ? "EXPENSE_DECISION" : event === "PAID" ? "PAYMENT_RECORDED" : "EXPENSE_VERIFIED",
      recipient: claim.claimant_email,
      subject,
      bodyText: [
        `Hello ${claim.claimant_name},`,
        "",
        `Your expense claim ${claim.claim_no} ${statusLine}.`,
        `Open the authenticated claim record: ${link}`,
        "",
        "If this does not look right, contact the Finance Manager. Do not reply with receipt images or bank details.",
        "",
        "Finance Tracker · IOE Pulchowk Campus",
      ].join("\n"),
      dedupeKey:
        event === "PAID"
          ? `claim:${claim.id}:paid:${opts.paymentId ?? "unknown"}`
          : event === "DECISION"
            ? `claim:${claim.id}:decision:${claim.status}`
            : `claim:${claim.id}:verified`,
      metadata: { claim_id: claim.id, status: claim.status, ...(opts.paymentId ? { payment_id: opts.paymentId } : {}) },
    });
  } catch (err) {
    // Never expose recipient addresses in logs.
    console.error("Notification enqueue failed:", err instanceof Error ? err.message : "unknown error");
  }
}

/** Daily operational reminders. Dedupe keys include the date, so one per day. */
export async function queueOutstandingReminders(db: Db, today = new Date().toISOString().slice(0, 10)): Promise<{ queued: number }> {
  let queued = 0;
  try {
    const missing = await db.query<{ id: string; claim_no: string; email: string; name: string }>(
      `SELECT c.id, c.claim_no, u.email, u.name
         FROM expense_claims c JOIN users u ON u.id=c.claimant_user_id
        WHERE u.is_active=true AND u.is_synthetic=false
          AND c.documentation_state='MISSING_UNDECLARED'
          AND c.status NOT IN ('DRAFT','REJECTED','WITHDRAWN','RECONCILED')`,
    );
    for (const row of missing.rows) {
      await enqueueNotification(db, {
        kind: "MISSING_DOCUMENT",
        recipient: row.email,
        subject: `Missing receipt: ${row.claim_no}`,
        bodyText: [
          `Hello ${row.name},`,
          "",
          `Claim ${row.claim_no} still has no receipt or missing-receipt declaration.`,
          `Open the authenticated claim record: ${claimLink(row.id)}`,
          "",
          "Finance Tracker · IOE Pulchowk Campus",
        ].join("\n"),
        dedupeKey: `missing-doc:${row.id}:${today}`,
        metadata: { claim_id: row.id, date: today },
      });
      queued++;
    }

    const advances = await db.query<{ id: string; ref: string; email: string; name: string }>(
      `SELECT a.id, a.ref, u.email, u.name
         FROM advances a
         JOIN members m ON m.id=a.member_id
         JOIN users u ON u.member_id=m.id
        WHERE u.is_active=true AND u.is_synthetic=false
          AND a.status IN ('OUTSTANDING','PARTIALLY_SETTLED')
          AND a.due_on IS NOT NULL AND a.due_on < $1::date`,
      [today],
    );
    for (const row of advances.rows) {
      await enqueueNotification(db, {
        kind: "OVERDUE_ADVANCE",
        recipient: row.email,
        subject: `Overdue advance: ${row.ref}`,
        bodyText: [
          `Hello ${row.name},`,
          "",
          `Advance ${row.ref} is past its due date and is not fully settled.`,
          `Open the authenticated advances page: ${getEmailConfig().appUrl}/advances`,
          "",
          "Finance Tracker · IOE Pulchowk Campus",
        ].join("\n"),
        dedupeKey: `overdue-advance:${row.id}:${today}`,
        metadata: { advance_id: row.id, date: today },
      });
      queued++;
    }

    const reimbursements = await db.query<{ id: string; claim_no: string; email: string; name: string }>(
      `SELECT c.id, c.claim_no, u.email, u.name
         FROM expense_claims c JOIN users u ON u.id=c.claimant_user_id
        WHERE u.is_active=true AND u.is_synthetic=false
          AND c.reimbursement_required=true
          AND c.status IN ('APPROVED','PAYMENT_PENDING')`,
    );
    for (const row of reimbursements.rows) {
      await enqueueNotification(db, {
        kind: "OUTSTANDING_REIMBURSEMENT",
        recipient: row.email,
        subject: `Reimbursement outstanding: ${row.claim_no}`,
        bodyText: [
          `Hello ${row.name},`,
          "",
          `Claim ${row.claim_no} is approved but not fully reimbursed.`,
          `Open the authenticated claim record: ${claimLink(row.id)}`,
          "",
          "Finance Tracker · IOE Pulchowk Campus",
        ].join("\n"),
        dedupeKey: `outstanding-reimbursement:${row.id}:${today}`,
        metadata: { claim_id: row.id, date: today },
      });
      queued++;
    }
  } catch (err) {
    console.error("Outstanding notification scan failed:", err instanceof Error ? err.message : "unknown error");
  }
  return { queued };
}
