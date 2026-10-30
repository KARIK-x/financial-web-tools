import { cookies, headers } from "next/headers";
import { cache } from "react";
import { createHash } from "node:crypto";
import { consumeRateLimit, clearRateLimit } from "./rate-limit";
import { verifyMfaForUser } from "./mfa";
import { getDb, one, type Db } from "./db";
import { generateSessionToken, hashToken, verifyPassword } from "./password";
import { can, ROLE_LABELS, type Permission, type Role } from "@/lib/permissions";

export const SESSION_COOKIE = "locus_session";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleLabel: string;
  memberId: string | null;
  isSynthetic: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaPending: boolean;
  sessionId: string;
  permissions: Permission[];
};

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  member_id: string | null;
  is_synthetic: boolean;
  must_change_password: boolean;
  mfa_enabled: boolean;
};

const ELEVATED: Role[] = ["ADMIN", "FINANCE", "EXECUTIVE"];

export async function getPermissionsForRole(db: Db, role: Role): Promise<Permission[]> {
  const rows = await db.query<{ permission: string }>(
    `SELECT permission FROM role_permissions WHERE role = $1 ORDER BY permission`,
    [role],
  );
  if (rows.rows.length === 0) return [];
  return rows.rows.map((r) => r.permission as Permission);
}

export function sessionDurationMs(role: Role): number {
  return ELEVATED.includes(role) ? 12 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

/** Resolve the signed-in user from the session cookie. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const row = await one<UserRow & { session_id: string; expires_at: Date; mfa_pending: boolean }>(
    db,
    `SELECT u.id, u.name, u.email, u.role, u.member_id, u.is_synthetic, u.must_change_password, u.mfa_enabled,
            s.id AS session_id, s.expires_at, s.mfa_pending
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.is_active = true`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [row.session_id]);
    return null;
  }
  const permissions = await getPermissionsForRole(db, row.role);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role],
    memberId: row.member_id,
    isSynthetic: row.is_synthetic,
    mustChangePassword: row.must_change_password,
    mfaEnabled: row.mfa_enabled,
    mfaPending: Boolean(row.mfa_pending),
    sessionId: row.session_id,
    permissions,
  };
});

export function mfaRequiredForRole(role: Role): boolean {
  if (process.env.MFA_ENFORCE !== "true") return false;
  return ELEVATED.includes(role);
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  if (user.mfaPending) throw new Error("MFA_PENDING");
  if (mfaRequiredForRole(user.role) && !user.mfaEnabled && !user.mustChangePassword) {
    throw new Error("MFA_ENROLLMENT_REQUIRED");
  }
  return user;
}

export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, permission, user.permissions)) {
    throw new Error(`FORBIDDEN: ${permission}`);
  }
  return user;
}

export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return {
    ip: forwarded ? forwarded.split(",")[0]!.trim() : h.get("x-real-ip"),
    userAgent: h.get("user-agent"),
  };
}

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

function loginKey(email: string, ip: string | null): string {
  return `login:${createHash("sha256").update(`${email}|${ip ?? "local"}`).digest("hex").slice(0, 32)}`;
}

export type LoginResult =
  | { ok: true; role: Role; mustChangePassword: boolean; mfaPending: boolean }
  | { ok: false; error: string; mfaRequired?: boolean };

async function recordFailedLogin(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE users
        SET failed_logins = failed_logins + 1,
            locked_until = CASE
              WHEN failed_logins + 1 >= $2 THEN now() + ($3::text || ' minutes')::interval
              ELSE locked_until
            END
      WHERE id = $1`,
    [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
  );
}

export async function signIn(
  email: string,
  password: string,
  ip: string | null,
  userAgent: string | null,
  mfaCode: string | null = null,
): Promise<LoginResult> {
  const db = await getDb();
  const normalized = email.trim().toLowerCase();
  const key = loginKey(normalized, ip);
  const limit = await consumeRateLimit(db, key, 12, 15 * 60, 15 * 60);
  if (!limit.allowed) {
    return { ok: false, error: `Too many sign-in attempts. Try again in ${limit.retryAfterSeconds} seconds.` };
  }
  const user = await one<{
    id: string; role: Role; password_hash: string; is_active: boolean; locked_until: Date | null;
    must_change_password: boolean; mfa_enabled: boolean; mfa_secret: string | null; mfa_last_used_step: string | number | bigint | null;
  }>(
    db,
    `SELECT id, role, password_hash, is_active, locked_until, must_change_password,
            mfa_enabled, mfa_secret, mfa_last_used_step
       FROM users WHERE lower(email) = $1`,
    [normalized],
  );
  if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, error: "Account temporarily locked after repeated failed sign-ins. Try again later or ask the Finance Manager." };
  }
  // Constant-ish work factor even for unknown emails.
  const hash = user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
  const valid = await verifyPassword(password, hash);
  if (!user || !valid || !user.is_active) {
    if (user) await recordFailedLogin(db, user.id);
    return { ok: false, error: "Email or password is incorrect." };
  }
  if (!user.password_hash.startsWith("scrypt$")) {
    return { ok: false, error: "Account password must be reset by an administrator." };
  }

  if (user.mfa_enabled) {
    if (!mfaCode?.trim()) return { ok: false, error: "Enter the six-digit authenticator code.", mfaRequired: true };
    const mfa = await verifyMfaForUser(db, user, mfaCode);
    if (!mfa.ok) {
      await recordFailedLogin(db, user.id);
      return { ok: false, error: mfa.error ?? "The authentication code is invalid.", mfaRequired: true };
    }
  }

  const enforceEnrollment = mfaRequiredForRole(user.role) && !user.mfa_enabled && !user.must_change_password;
  const token = generateSessionToken();
  const expires = new Date(Date.now() + sessionDurationMs(user.role));
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO sessions (id, token_hash, user_id, expires_at, ip, user_agent, mfa_pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), hashToken(token), user.id, expires, ip, userAgent?.slice(0, 300) ?? null, enforceEnrollment],
    );
    await tx.query(`UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
  });
  await clearRateLimit(db, key);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return { ok: true, role: user.role, mustChangePassword: user.must_change_password, mfaPending: enforceEnrollment };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [hashToken(token)]);
  }
  store.delete(SESSION_COOKIE);
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}
