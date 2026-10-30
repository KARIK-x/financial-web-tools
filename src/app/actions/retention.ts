"use server";

import { requirePermission } from "@/server/auth";
import { getDb } from "@/server/db";
import { setDocumentLegalHold } from "@/server/retention";
import { fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function setDocumentLegalHoldAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const documentId = str(fd, "documentId");
    const hold = fd.get("hold") === "on";
    await setDocumentLegalHold(db, user, {
      documentId,
      hold,
      reason: optional(fd, "reason"),
      retentionUntil: optional(fd, "retentionUntil"),
      policy: optional(fd, "policy"),
    });
    return { ok: true, message: hold ? "Legal hold set." : "Legal hold released." };
  } catch (err) {
    return fail(err);
  }
}
