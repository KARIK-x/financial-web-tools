import { one, type Db } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { ExpenseError } from "./expenses";

export async function setDocumentLegalHold(db: Db, user: CurrentUser, input: { documentId: string; hold: boolean; reason?: string | null; retentionUntil?: string | null; policy?: string | null }) {
  if (!can(user.role, "settings.manage", user.permissions)) throw new ExpenseError("You cannot manage document retention.");
  const doc = await one<{ id: string; legal_hold: boolean }>(db, `SELECT id, legal_hold FROM documents WHERE id=$1`, [input.documentId]);
  if (!doc) throw new ExpenseError("Document not found.");
  if (input.hold) {
    if (!input.reason?.trim()) throw new ExpenseError("A legal-hold reason is required.");
    await db.query(
      `UPDATE documents SET legal_hold=true, legal_hold_reason=$2, legal_hold_by=$3, legal_hold_at=now(),
              retention_until=COALESCE($4::date, retention_until), retention_policy=COALESCE($5, retention_policy)
        WHERE id=$1`,
      [input.documentId, input.reason.trim(), user.id, input.retentionUntil ?? null, input.policy ?? null],
    );
  } else {
    await db.query(
      `UPDATE documents SET legal_hold=false, legal_hold_reason=NULL, legal_hold_by=NULL, legal_hold_at=NULL WHERE id=$1`,
      [input.documentId],
    );
  }
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name,
    action: input.hold ? "DOCUMENT_LEGAL_HOLD_SET" : "DOCUMENT_LEGAL_HOLD_RELEASED",
    entityType: "document", entityId: input.documentId,
    summary: input.hold ? `Legal hold set: ${input.reason}` : "Legal hold released.",
    after: { legal_hold: input.hold, retention_until: input.retentionUntil ?? null, policy: input.policy ?? null },
  });
}


export type ExpiredRetentionDocument = {
  id: string;
  filename: string;
  retention_until: string;
  legal_hold: boolean;
  retention_policy: string | null;
};

/** Read-only enforcement report: expired records that are not on legal hold. */
export async function expiredRetentionDocuments(db: Db, now = new Date()): Promise<ExpiredRetentionDocument[]> {
  const rows = await db.query<ExpiredRetentionDocument>(
    `SELECT id, filename, to_char(retention_until, 'YYYY-MM-DD') AS retention_until, legal_hold, retention_policy
       FROM documents
      WHERE retention_until IS NOT NULL
        AND retention_until < $1::date
        AND legal_hold = false
      ORDER BY retention_until, id`,
    [now.toISOString().slice(0, 10)],
  );
  return rows.rows;
}

export async function retentionEnforcementReport(db: Db, now = new Date()) {
  const expired = await expiredRetentionDocuments(db, now);
  const held = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents WHERE legal_hold = true AND retention_until IS NOT NULL AND retention_until < $1::date`, [now.toISOString().slice(0, 10)]);
  return { expired, heldCount: held.rows[0]?.n ?? 0, checkedAt: now.toISOString() };
}
