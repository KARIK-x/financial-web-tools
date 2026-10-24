import { randomUUID } from "node:crypto";
import type { Db } from "./db";

export type AuditInput = {
  actorUserId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
      (id, actor_user_id, actor_name, action, entity_type, entity_id, summary, before, after, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
    [
      randomUUID(),
      input.actorUserId,
      input.actorName,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.summary,
      input.before == null ? null : JSON.stringify(input.before),
      input.after == null ? null : JSON.stringify(input.after),
      input.ip ?? null,
      input.userAgent?.slice(0, 300) ?? null,
    ],
  );
}

export async function listAudit(db: Db, filters: { entityType?: string; actorId?: string; limit?: number } = {}) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.entityType) {
    params.push(filters.entityType);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (filters.actorId) {
    params.push(filters.actorId);
    clauses.push(`actor_user_id = $${params.length}`);
  }
  params.push(Math.min(filters.limit ?? 100, 500));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (
    await db.query<{
      id: string; actor_name: string; action: string; entity_type: string; entity_id: string | null;
      summary: string; created_at: Date; before: unknown; after: unknown;
    }>(
      `SELECT id, actor_name, action, entity_type, entity_id, summary, created_at, before, after
         FROM audit_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params as never[],
    )
  ).rows;
}
