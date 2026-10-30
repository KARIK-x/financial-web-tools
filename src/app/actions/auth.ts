"use server";

import { randomUUID } from "node:crypto";
import { getDb, one } from "@/server/db";
import { hashPassword, passwordIssues, verifyPassword } from "@/server/password";
import { getCurrentUser, requestContext, requireUser, signIn, signOut } from "@/server/auth";
import { generateRecoveryCodes, hashRecoveryCode, resetMfaForUser, verifyTotp } from "@/server/mfa";
import { can } from "@/lib/permissions";
import { recordAudit } from "@/server/audit";
import { fail, ok, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function loginAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const email = str(fd, "email");
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Email and password are required." };
  try {
    const ctx = await requestContext();
    const result = await signIn(email, password, ctx.ip, ctx.userAgent, str(fd, "mfaCode") || null);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.mfaPending) return ok("Authenticator setup is required for privileged roles.", "/mfa-setup");
    return ok("Signed in.", result.mustChangePassword ? "/change-password" : "/overview");
  } catch (err) {
    return fail(err);
  }
}

export async function setupAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  const confirmPassword = String(fd.get("confirmPassword") ?? "");
  const memberName = str(fd, "memberName") || name;
  const role = str(fd, "role") || "ADMIN";

  try {
    if (!name) return { ok: false, error: "Your name is required." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (password !== confirmPassword) return { ok: false, error: "Passwords do not match." };
    const issues = passwordIssues(password);
    if (issues.length) return { ok: false, error: issues.join(" ") };

    const db = await getDb();
    const existing = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM users`);
    const firstRun = (existing?.n ?? 0) === 0;

    if (!firstRun) {
      const current = await getCurrentUser();
      if (!current || !can(current.role, "settings.manage", current.permissions)) {
        return { ok: false, error: "Setup is already complete. Ask your Finance Manager for an account." };
      }
    }

    const duplicate = await one<{ id: string }>(db, `SELECT id FROM users WHERE lower(email) = $1`, [email]);
    if (duplicate) return { ok: false, error: "An account with this email already exists." };

    const allowedRoles = ["ADMIN", "FINANCE", "EXECUTIVE", "EVENT_HEAD", "MEMBER", "AUDITOR"];
    const safeRole = firstRun ? "ADMIN" : allowedRoles.includes(role) ? role : "MEMBER";

    const memberId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO members (id, name, email, role_title, is_active) VALUES ($1,$2,$3,$4,true)`,
        [memberId, memberName, email, safeRole === "ADMIN" ? "Finance Manager" : null],
      );
      await tx.query(
        `INSERT INTO users (id, email, name, password_hash, role, member_id, is_active, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
        [userId, email, name, passwordHash, safeRole, memberId, !firstRun],
      );
      await tx.query(`UPDATE members SET user_id = $2 WHERE id = $1`, [memberId, userId]);
    });

    await recordAudit(db, {
      actorUserId: userId,
      actorName: name,
      action: firstRun ? "SYSTEM_INITIALISED" : "USER_CREATED",
      entityType: "user",
      entityId: userId,
      summary: firstRun
        ? `First administrator account created for ${email}. No financial records exist yet.`
        : `Account created for ${email} with role ${safeRole}.`,
      after: { role: safeRole, email },
    });

    const ctx = await requestContext();
    const signed = await signIn(email, password, ctx.ip, ctx.userAgent);
    if (!signed.ok) return ok("Account created. Sign in with your new password.", "/login");
    return ok("Account created.", "/overview");
  } catch (err) {
    return fail(err);
  }
}

export async function changePasswordAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const currentPassword = String(fd.get("currentPassword") ?? "");
  const newPassword = String(fd.get("newPassword") ?? "");
  const confirmPassword = String(fd.get("confirmPassword") ?? "");
  try {
    const user = await requireUser();
    if (!currentPassword) return { ok: false, error: "Enter your current password." };
    if (newPassword !== confirmPassword) return { ok: false, error: "The new passwords do not match." };
    const issues = passwordIssues(newPassword);
    if (issues.length) return { ok: false, error: issues.join(" ") };

    const db = await getDb();
    const row = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = $1`, [user.id]);
    if (!row) return { ok: false, error: "Account not found." };
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      return { ok: false, error: "Your current password is incorrect." };
    }
    if (await verifyPassword(newPassword, row.password_hash)) {
      return { ok: false, error: "Choose a password different from your current one." };
    }

    const hash = await hashPassword(newPassword);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [user.id, hash],
      );
      // Keep this session, revoke every other one.
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [
        user.id, user.sessionId,
      ]);
    });
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "PASSWORD_CHANGED",
      entityType: "user", entityId: user.id,
      summary: `${user.email} changed their password; other sessions were revoked.`,
    });
    return ok("Password changed. Other sessions have been signed out.", "/overview");
  } catch (err) {
    return fail(err);
  }
}

export async function enableMfaAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Your session expired. Sign in again." };
    const code = str(fd, "code");
    if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the six-digit code from your authenticator app." };
    const db = await getDb();
    const row = await one<{ mfa_secret: string | null; mfa_enabled: boolean }>(
      db, `SELECT mfa_secret, mfa_enabled FROM users WHERE id=$1`, [user.id],
    );
    if (!row) return { ok: false, error: "Account not found." };
    if (row.mfa_enabled) return { ok: false, error: "Two-factor authentication is already enabled." };
    if (!row.mfa_secret) return { ok: false, error: "Refresh this page to generate a new enrollment secret." };
    const step = verifyTotp(row.mfa_secret, code);
    if (step == null) return { ok: false, error: "That code is not valid. Check your device clock and try the current code." };
    const recoveryCodes = generateRecoveryCodes();
    const hashes = recoveryCodes.map(hashRecoveryCode);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET mfa_enabled=true, mfa_enrolled_at=now(), mfa_recovery_codes=$2::jsonb,
                mfa_last_used_step=$3 WHERE id=$1`,
        [user.id, JSON.stringify(hashes), step],
      );
      await tx.query(`UPDATE sessions SET mfa_pending=false WHERE id=$1`, [user.sessionId]);
    });
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "MFA_ENABLED",
      entityType: "user", entityId: user.id,
      summary: "Two-factor authentication enabled; ten single-use recovery codes generated.",
    });
    return {
      ok: true,
      message: `Two-factor authentication is enabled. Save these single-use recovery codes now; they will not be shown again: ${recoveryCodes.join("  ")}`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function disableMfaAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const actor = await requireUser();
    if (!can(actor.role, "settings.manage", actor.permissions)) {
      return { ok: false, error: "Only the Finance Manager can reset another user's MFA." };
    }
    const userId = str(fd, "userId");
    if (!userId) return { ok: false, error: "Select a user." };
    if (userId === actor.id) return { ok: false, error: "Use the authenticator reset procedure for your own account; another administrator must reset it." };
    const db = await getDb();
    const target = await resetMfaForUser(db, actor, userId);
    return { ok: true, message: `MFA reset for ${target.name}. They must enroll again at next sign-in.` };
  } catch (err) {
    return fail(err);
  }
}

export async function logoutAction(): Promise<void> {
  await signOut();
  const { redirect } = await import("next/navigation");
  redirect("/login");
}
