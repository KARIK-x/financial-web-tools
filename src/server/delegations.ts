import { randomUUID } from "node:crypto";
import { many, one, type Db } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { ExpenseError } from "./expenses";

export type DelegationRow = {
  id: string;
  delegator_user_id: string;
  delegator_name: string;
  delegatee_user_id: string;
  delegatee_name: string;
  scope: string;
  scope_id: string | null;
  reason: string;
  starts_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
};

export async function hasActiveDelegation(db: Db, delegateeId: string): Promise<boolean> {
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM approval_delegations
      WHERE delegatee_user_id=$1 AND starts_at <= now() AND expires_at > now() AND revoked_at IS NULL`,
    [delegateeId],
  );
  return (row?.n ?? 0) > 0;
}

export async function listDelegations(db: Db): Promise<DelegationRow[]> {
  return many<DelegationRow>(
    db,
    `SELECT d.id, d.delegator_user_id, du.name AS delegator_name, d.delegatee_user_id, ue.name AS delegatee_name,
            d.scope, d.scope_id, d.reason, d.starts_at, d.expires_at, d.revoked_at, d.created_at
       FROM approval_delegations d
       JOIN users du ON du.id=d.delegator_user_id
       JOIN users ue ON ue.id=d.delegatee_user_id
      ORDER BY d.created_at DESC`,
  );
}

export async function createDelegation(db: Db, user: CurrentUser, input: { delegateeId: string; expiresAt: string; reason: string; scope?: string; scopeId?: string | null }) {
  if (!can(user.role, "settings.manage", user.permissions)) throw new ExpenseError("You cannot manage approval delegations.");
  if (!input.reason.trim()) throw new ExpenseError("A delegation reason is required.");
  if (!input.expiresAt) throw new ExpenseError("An expiry date is required.");
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) throw new ExpenseError("Delegation expiry must be in the future.");
  const delegatee = await one<{ id: string; name: string; role: string }>(db, `SELECT id, name, role FROM users WHERE id=$1 AND is_active=true`, [input.delegateeId]);
  if (!delegatee) throw new ExpenseError("Delegatee not found.");
  const delegateePermissions = await (await import("./auth")).getPermissionsForRole(db, delegatee.role as any);
  if (!delegateePermissions.includes("expense.approve")) throw new ExpenseError("The delegatee must already hold expense.approve permission.");
  const id = randomUUID();
  await db.query(
    `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, scope_id, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, user.id, delegatee.id, input.scope ?? "ALL", input.scopeId ?? null, input.reason.trim(), expires],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "APPROVAL_DELEGATION_CREATED",
    entityType: "approval_delegation", entityId: id,
    summary: `Approval authority delegated to ${delegatee.name} until ${expires.toISOString()}.`,
    after: { delegatee: delegatee.id, expires_at: expires.toISOString(), scope: input.scope ?? "ALL" },
  });
  return id;
}

export async function revokeDelegation(db: Db, user: CurrentUser, id: string) {
  if (!can(user.role, "settings.manage", user.permissions)) throw new ExpenseError("You cannot manage approval delegations.");
  const row = await one<{ id: string; delegatee_user_id: string }>(db, `SELECT id, delegatee_user_id FROM approval_delegations WHERE id=$1`, [id]);
  if (!row) throw new ExpenseError("Delegation not found.");
  await db.query(`UPDATE approval_delegations SET revoked_at=now() WHERE id=$1`, [id]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "APPROVAL_DELEGATION_REVOKED",
    entityType: "approval_delegation", entityId: id,
    summary: "Approval delegation revoked.",
  });
}
