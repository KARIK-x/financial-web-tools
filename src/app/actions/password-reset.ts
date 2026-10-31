"use server";

import { getDb } from "@/server/db";
import { requestContext } from "@/server/auth";
import { completePasswordReset, requestPasswordReset } from "@/server/password-reset";
import { fail, ok, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function requestPasswordResetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const email = str(fd, "email");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter the email address for your FINANCE TRACKER account." };
  }
  try {
    const db = await getDb();
    const ctx = await requestContext();
    await requestPasswordReset(db, email, ctx);
    return ok("If an account exists for that address, a one-time reset link has been queued. It expires in 30 minutes.");
  } catch (err) {
    return fail(err);
  }
}

export async function completePasswordResetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const token = str(fd, "token");
  const password = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirmPassword") ?? "");
  if (!token) return { ok: false, error: "This reset link is invalid or has expired." };
  if (password !== confirm) return { ok: false, error: "The new passwords do not match." };
  try {
    const db = await getDb();
    const ctx = await requestContext();
    const result = await completePasswordReset(db, token, password, ctx);
    return ok(`Password updated for ${result.email}. Sign in with your new password.`, "/login");
  } catch (err) {
    return fail(err);
  }
}
