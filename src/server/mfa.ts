import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { one, type Db, type Executor } from "./db";
import { can } from "@/lib/permissions";
import type { CurrentUser } from "./auth";
import { recordAudit } from "./audit";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Verify a 6-digit code in a ±1 step window. Returns the accepted step. */
export function verifyTotp(secret: string, token: string): number | null {
  const clean = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (const step of [current, current - 1, current + 1]) {
    const expected = totpCode(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUri(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer ?? "LOCUS Finance";
  const label = encodeURIComponent(`${issuer}:${input.email}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

/** Consume one recovery code atomically; a code can never be reused. */
export async function consumeRecoveryCode(db: Executor, userId: string, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const row = await one<{ id: string }>(
    db,
    `UPDATE users
        SET mfa_recovery_codes = mfa_recovery_codes - $2
      WHERE id = $1 AND mfa_enabled = true AND mfa_recovery_codes ? $2
      RETURNING id`,
    [userId, hash],
  );
  return Boolean(row);
}

export type MfaVerification = {
  ok: boolean;
  method?: "TOTP" | "RECOVERY";
  error?: string;
  step?: number;
};

export async function verifyMfaForUser(
  db: Executor,
  user: { id: string; mfa_secret: string | null; mfa_enabled: boolean; mfa_last_used_step: string | number | bigint | null },
  code: string,
): Promise<MfaVerification> {
  if (!user.mfa_enabled) return { ok: false, error: "MFA is not enabled for this account." };
  if (!user.mfa_secret) return { ok: false, error: "MFA is misconfigured. Ask the Finance Manager to reset it." };

  const totpStep = verifyTotp(user.mfa_secret, code);
  if (totpStep != null) {
    const last = Number(user.mfa_last_used_step ?? 0);
    if (totpStep <= last) return { ok: false, error: "That authentication code has already been used. Wait for the next code." };
    const updated = await one<{ id: string }>(
      db,
      `UPDATE users SET mfa_last_used_step = $2 WHERE id = $1 AND COALESCE(mfa_last_used_step, 0) < $2 RETURNING id`,
      [user.id, totpStep],
    );
    if (!updated) return { ok: false, error: "That authentication code has already been used. Wait for the next code." };
    return { ok: true, method: "TOTP", step: totpStep };
  }

  if (await consumeRecoveryCode(db, user.id, code)) return { ok: true, method: "RECOVERY" };
  return { ok: false, error: "The authentication code is invalid." };
}

/** Reset another user's MFA and revoke their sessions. Administrator-only. */
export async function resetMfaForUser(
  db: Db,
  actor: CurrentUser,
  userId: string,
): Promise<{ id: string; name: string; mfaEnabled: boolean }> {
  if (!can(actor.role, "settings.manage", actor.permissions)) {
    throw new Error("Only an administrator can reset MFA.");
  }
  if (userId === actor.id) {
    throw new Error("Use the break-glass procedure for your own account; another administrator must reset it.");
  }
  const target = await one<{ id: string; name: string; mfa_enabled: boolean }>(
    db,
    `SELECT id, name, mfa_enabled FROM users WHERE id=$1`,
    [userId],
  );
  if (!target) throw new Error("User not found.");
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET mfa_enabled=false, mfa_secret=NULL, mfa_recovery_codes='[]'::jsonb,
              mfa_enrolled_at=NULL, mfa_last_used_step=NULL WHERE id=$1`,
      [userId],
    );
    await tx.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  });
  await recordAudit(db, {
    actorUserId: actor.id,
    actorName: actor.name,
    action: "MFA_RESET",
    entityType: "user",
    entityId: userId,
    summary: `MFA reset for ${target.name}; their sessions were revoked.`,
    before: { mfa_enabled: target.mfa_enabled },
  });
  return { id: target.id, name: target.name, mfaEnabled: false };
}

/**
 * Offline break-glass for the only remaining administrator. The token is
 * never accepted from a browser route; an operator supplies it to a local CLI
 * after proving they control the deployment. If a second active administrator
 * exists, that person must use the normal reset path instead.
 */
export async function breakGlassResetSoleAdminMfa(
  db: Db,
  input: { targetEmail: string; token: string; env?: NodeJS.ProcessEnv },
): Promise<{ id: string; name: string; email: string }> {
  const env = input.env ?? process.env;
  const expected = (env.MFA_BREAK_GLASS_TOKEN_HASH ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("MFA_BREAK_GLASS_TOKEN_HASH is not configured with a SHA-256 hex digest.");
  }
  const actual = createHash("sha256").update(input.token).digest("hex");
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new Error("Break-glass token rejected.");
  }
  const target = await one<{ id: string; name: string; email: string; role: string; mfa_enabled: boolean }>(
    db,
    `SELECT id, name, email, role, mfa_enabled FROM users WHERE lower(email)=lower($1) AND is_active=true`,
    [input.targetEmail],
  );
  if (!target) throw new Error("Active user not found.");
  if (target.role !== "ADMIN") throw new Error("Break-glass MFA reset is restricted to an administrator account.");
  const admins = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE role='ADMIN' AND is_active=true`, []);
  if (Number(admins?.n ?? 0) !== 1) {
    throw new Error("Another active administrator exists. Use the normal MFA reset from that account.");
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET mfa_enabled=false, mfa_secret=NULL, mfa_recovery_codes='[]'::jsonb,
              mfa_enrolled_at=NULL, mfa_last_used_step=NULL WHERE id=$1`,
      [target.id],
    );
    await tx.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [target.id]);
  });
  await recordAudit(db, {
    actorUserId: null,
    actorName: "break-glass-cli",
    action: "MFA_BREAK_GLASS_RESET",
    entityType: "user",
    entityId: target.id,
    summary: `Sole administrator ${target.email} had MFA reset through the offline break-glass procedure; all sessions were revoked.`,
    after: { mfa_enabled: false },
  });
  return { id: target.id, name: target.name, email: target.email };
}
