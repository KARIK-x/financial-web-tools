import { createHash, randomBytes, randomUUID } from "node:crypto";
import { one, type Db } from "./db";
import { enqueueNotification, getEmailConfig } from "./email";
import { consumeRateLimit } from "./rate-limit";
import { hashPassword, passwordIssues } from "./password";
import { recordAudit } from "./audit";

const RESET_TTL_MINUTES = 30;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Always returns a generic success result. This prevents account enumeration.
 * A token is only created and emailed when the account exists and is active.
 */
export async function requestPasswordReset(
  db: Db,
  email: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ ok: true }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { ok: true };

  const emailLimit = await consumeRateLimit(db, `password-reset:email:${normalized}`, 5, 15 * 60, 30 * 60);
  const ipLimit = await consumeRateLimit(db, `password-reset:ip:${ctx.ip ?? "unknown"}`, 20, 15 * 60, 30 * 60);
  if (!emailLimit.allowed || !ipLimit.allowed) return { ok: true };

  const user = await one<{ id: string; email: string; name: string; is_active: boolean }>(
    db,
    `SELECT id, email, name, is_active FROM users WHERE lower(email)=$1`,
    [normalized],
  );
  if (!user || !user.is_active) return { ok: true };

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(token);
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  await db.transaction(async (tx) => {
    // A new request invalidates all earlier unused links for this account.
    await tx.query(`UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
    await tx.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, requested_ip)
       VALUES ($1,$2,$3,$4,$5)`,
      [tokenId, user.id, tokenHash, expiresAt, ctx.ip ?? null],
    );
  });

  const config = getEmailConfig();
  const link = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await enqueueNotification(db, {
    kind: "PASSWORD_RESET",
    recipient: user.email,
    subject: "LOCUS password reset",
    bodyText: [
      `Hello ${user.name},`,
      "",
      `A password reset was requested for your LOCUS account. This link expires in ${RESET_TTL_MINUTES} minutes and can be used once:`,
      link,
      "",
      "If you did not request this, ignore the message. Your current password remains unchanged.",
      "",
      "LOCUS Finance · IOE Pulchowk Campus",
    ].join("\n"),
    dedupeKey: `password-reset:${tokenId}`,
    metadata: { user_id: user.id, expires_at: expiresAt.toISOString() },
  });

  await recordAudit(db, {
    actorUserId: user.id,
    actorName: user.name,
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "user",
    entityId: user.id,
    summary: `Password reset requested for ${user.email}; a one-time link was queued.`,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return { ok: true };
}

export async function completePasswordReset(
  db: Db,
  token: string,
  newPassword: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ ok: true; email: string }> {
  if (!token || token.length < 20) throw new Error("This reset link is invalid or has expired.");
  const issues = passwordIssues(newPassword);
  if (issues.length) throw new Error(issues.join(" "));

  const row = await one<{
    id: string; user_id: string; email: string; name: string; expires_at: Date; used_at: Date | null;
  }>(
    db,
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.name
       FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1`,
    [hashResetToken(token)],
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
    throw new Error("This reset link is invalid or has expired.");
  }

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET password_hash=$2, must_change_password=false, failed_logins=0, locked_until=NULL,
              mfa_last_used_step=NULL
        WHERE id=$1`,
      [row.user_id, passwordHash],
    );
    await tx.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [row.user_id]);
    await tx.query(`UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [row.user_id]);
  });

  await recordAudit(db, {
    actorUserId: row.user_id,
    actorName: row.name,
    action: "PASSWORD_RESET_COMPLETED",
    entityType: "user",
    entityId: row.user_id,
    summary: `Password reset completed for ${row.email}; all sessions revoked.`,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { ok: true, email: row.email };
}
