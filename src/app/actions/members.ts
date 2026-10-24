"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { hashPassword, passwordIssues } from "@/server/password";
import { recordAudit } from "@/server/audit";
import { fail, optional, str } from "@/server/action-utils";
import { ROLES, type Role } from "@/lib/permissions";
import type { ActionResult } from "@/lib/action-result";

export async function createMemberAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("member.manage");
    const db = await getDb();
    const name = str(fd, "name");
    if (name.length < 2) return { ok: false, error: "Member name is required." };
    const id = randomUUID();
    await db.query(
      `INSERT INTO members (id, name, email, phone, program, batch, role_title, notes, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, name, optional(fd, "email"), optional(fd, "phone"), optional(fd, "program"), optional(fd, "batch"), optional(fd, "roleTitle"), optional(fd, "notes"), user.isSynthetic],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "MEMBER_CREATED",
      entityType: "member", entityId: id, summary: `Member ${name} added`,
    });
    revalidatePath("/members");
    return { ok: true, message: `${name} added.` };
  } catch (err) {
    return fail(err);
  }
}

export async function createUserAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const actor = await requirePermission("member.manage");
    const db = await getDb();
    const name = str(fd, "name");
    const email = str(fd, "email").toLowerCase();
    const password = String(fd.get("password") ?? "");
    const role = str(fd, "role") as Role;
    const memberId = optional(fd, "memberId");

    if (!name) return { ok: false, error: "Name is required." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (!ROLES.includes(role)) return { ok: false, error: "Choose a valid role." };
    const issues = passwordIssues(password);
    if (issues.length) return { ok: false, error: issues.join(" ") };

    const duplicate = await one<{ id: string }>(db, `SELECT id FROM users WHERE lower(email) = $1`, [email]);
    if (duplicate) return { ok: false, error: "An account with this email already exists." };
    if (memberId) {
      const member = await one<{ id: string; user_id: string | null }>(db, `SELECT id, user_id FROM members WHERE id = $1`, [memberId]);
      if (!member) return { ok: false, error: "Selected member not found." };
      if (member.user_id) return { ok: false, error: "That member already has a login." };
    }

    const id = randomUUID();
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, email, name, password_hash, role, member_id, is_active, must_change_password, is_synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,true,true,$7)`,
        [id, email, name, passwordHash, role, memberId, actor.isSynthetic],
      );
      if (memberId) await tx.query(`UPDATE members SET user_id = $2 WHERE id = $1`, [memberId, id]);
    });
    await recordAudit(db, {
      actorUserId: actor.id, actorName: actor.name, action: "USER_CREATED",
      entityType: "user", entityId: id,
      summary: `Account created for ${email} (${role})${memberId ? " linked to a member" : ""}`,
      after: { role, memberId },
    });
    revalidatePath("/members");
    return { ok: true, message: `Account created for ${email}. Share the password through a secure channel; it must be changed at first sign-in.` };
  } catch (err) {
    return fail(err);
  }
}

export async function resetPasswordAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const actor = await requirePermission("settings.manage");
    const db = await getDb();
    const userId = str(fd, "userId");
    const password = String(fd.get("password") ?? "");
    const issues = passwordIssues(password);
    if (issues.length) return { ok: false, error: issues.join(" ") };
    const target = await one<{ id: string; email: string }>(db, `SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (!target) return { ok: false, error: "User not found." };
    const hash = await hashPassword(password);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1`, [userId, hash]);
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
    await recordAudit(db, {
      actorUserId: actor.id, actorName: actor.name, action: "PASSWORD_RESET",
      entityType: "user", entityId: userId, summary: `Password reset for ${target.email}; existing sessions revoked`,
    });
    revalidatePath("/members");
    return { ok: true, message: `Password reset for ${target.email}. All their sessions were signed out.` };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleUserActiveAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const actor = await requirePermission("settings.manage");
    const db = await getDb();
    const userId = str(fd, "userId");
    if (userId === actor.id) return { ok: false, error: "You cannot deactivate your own account." };
    const target = await one<{ id: string; email: string; is_active: boolean }>(db, `SELECT id, email, is_active FROM users WHERE id = $1`, [userId]);
    if (!target) return { ok: false, error: "User not found." };
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE users SET is_active = $2 WHERE id = $1`, [userId, !target.is_active]);
      if (target.is_active) await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
    await recordAudit(db, {
      actorUserId: actor.id, actorName: actor.name, action: target.is_active ? "USER_DEACTIVATED" : "USER_REACTIVATED",
      entityType: "user", entityId: userId, summary: `${target.email} ${target.is_active ? "deactivated" : "reactivated"}`,
    });
    revalidatePath("/members");
    return { ok: true, message: `${target.email} ${target.is_active ? "deactivated" : "reactivated"}.` };
  } catch (err) {
    return fail(err);
  }
}
