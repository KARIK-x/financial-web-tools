import { cookies, headers } from "next/headers";
import { cache } from "react";
import { createHash } from "node:crypto";
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
  const row = await one<UserRow & { session_id: string; expires_at: Date }>(
    db,
    `SELECT u.id, u.name, u.email, u.role, u.member_id, u.is_synthetic, u.must_change_password,
            s.id AS session_id, s.expires_at
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
    sessionId: row.session_id,
    permissions,
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
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

const loginAttempts = new Map<string, { count: number; firstAt: number }>();

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > 15 * 60 * 1000) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= 12;
}

export type LoginResult = { ok: true; role: Role; mustChangePassword: boolean } | { ok: false; error: string };

export async function signIn(email: string, password: string, ip: string | null, userAgent: string | null): Promise<LoginResult> {
  const db = await getDb();
  const normalized = email.trim().toLowerCase();
  if (!checkRateLimit(`login:${normalized}:${ip ?? "local"}`)) {
    return { ok: false, error: "Too many sign-in attempts. Try again in 15 minutes." };
  }
  const user = await one<{ id: string; role: Role; password_hash: string; is_active: boolean; locked_until: Date | null; must_change_password: boolean }>(
    db,
    `SELECT id, role, password_hash, is_active, locked_until, must_change_password FROM users WHERE lower(email) = $1`,
    [normalized],
  );
  // Constant-ish work factor even for unknown emails.
  const hash = user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
  const valid = await verifyPassword(password, hash);
  if (!user || !valid || !user.is_active) {
    if (user) await db.query(`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = $1`, [user.id]);
    return { ok: false, error: "Email or password is incorrect." };
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, error: "Account temporarily locked. Contact the Finance Manager." };
  }
  if (!user.password_hash.startsWith("scrypt$")) {
    return { ok: false, error: "Account password must be reset by an administrator." };
  }

  const token = generateSessionToken();
  const expires = new Date(Date.now() + sessionDurationMs(user.role));
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO sessions (id, token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), hashToken(token), user.id, expires, ip, userAgent?.slice(0, 300) ?? null],
    );
    await tx.query(`UPDATE users SET last_login_at = now(), failed_logins = 0 WHERE id = $1`, [user.id]);
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return { ok: true, role: user.role, mustChangePassword: user.must_change_password };
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
