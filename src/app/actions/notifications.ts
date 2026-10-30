"use server";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { markAllNotificationsRead } from "@/server/notifications-center";
import type { ActionResult } from "@/lib/action-result";

export async function markAllNotificationsReadAction(_prev: ActionResult): Promise<ActionResult> {
  const user = await requireUser();
  const db = await getDb();
  await markAllNotificationsRead(db, user);
  return { ok: true, message: "All notifications marked as read." };
}
