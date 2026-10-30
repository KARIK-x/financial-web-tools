import { randomUUID } from "node:crypto";
import { many, one, type Db } from "./db";
import { can } from "@/lib/permissions";
import type { CurrentUser } from "./auth";
import { recordAudit } from "./audit";

export type NotificationRow = {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
};

export async function createNotification(
  db: Db,
  input: { userId: string; title: string; body?: string | null; link?: string | null; synthetic?: boolean },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO notifications (id, user_id, title, body, link, is_synthetic) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.userId, input.title, input.body ?? null, input.link ?? null, input.synthetic ?? false],
  );
  return id;
}

export async function listNotifications(db: Db, userId: string, limit = 50): Promise<NotificationRow[]> {
  return many<NotificationRow>(
    db,
    `SELECT id, user_id, title, body, link, read_at, created_at
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 200)],
  );
}

export async function unreadNotificationCount(db: Db, userId: string): Promise<number> {
  const row = await one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [userId]);
  return row?.n ?? 0;
}

export async function markNotificationRead(db: Db, user: CurrentUser, id: string): Promise<void> {
  await db.query(`UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL`, [id, user.id]);
}

export async function markAllNotificationsRead(db: Db, user: CurrentUser): Promise<void> {
  await db.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [user.id]);
}

export async function notifyClaimSubmittedInApp(db: Db, claim: { id: string; claim_no: string; amount_paisa: number }, recipients: string[]) {
  for (const userId of recipients) {
    await createNotification(db, {
      userId,
      title: `Claim ${claim.claim_no} submitted`,
      body: `NPR ${(claim.amount_paisa / 100).toFixed(2)} is awaiting review.`,
      link: `/expenses/${claim.id}`,
    });
  }
  await recordAudit(db, { actorUserId: null, actorName: "system", action: "NOTIFICATIONS_CREATED", entityType: "claim", entityId: claim.id, summary: `In-app notifications created for ${recipients.length} recipient(s).` });
}
