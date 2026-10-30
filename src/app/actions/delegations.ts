"use server";

import { requirePermission } from "@/server/auth";
import { getDb } from "@/server/db";
import { createDelegation, revokeDelegation } from "@/server/delegations";
import { fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function createDelegationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const id = await createDelegation(db, user, {
      delegateeId: str(fd, "delegateeId"),
      expiresAt: str(fd, "expiresAt"),
      reason: str(fd, "reason"),
      scope: optional(fd, "scope") ?? "ALL",
    });
    return { ok: true, message: `Delegation ${id} created.` };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeDelegationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    await revokeDelegation(db, user, str(fd, "delegationId"));
    return { ok: true, message: "Delegation revoked." };
  } catch (err) {
    return fail(err);
  }
}
