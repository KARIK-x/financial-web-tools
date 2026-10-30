import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { createNotification, listNotifications, markAllNotificationsRead, unreadNotificationCount } from "@/server/notifications-center";

describe("notification centre", () => {
  it("creates, counts, lists, and marks notifications read", async () => {
    const db = await createTestDb();
    try {
      const user = await createPerson(db, { role: "MEMBER", name: "Notify Member", member: false });
      const id = await createNotification(db, { userId: user.id, title: "Test notice", body: "Body", link: "/overview" });
      expect(await unreadNotificationCount(db, user.id)).toBe(1);
      const listed = await listNotifications(db, user.id);
      expect(listed.some((n) => n.id === id)).toBe(true);
      await markAllNotificationsRead(db, user);
      expect(await unreadNotificationCount(db, user.id)).toBe(0);
    } finally { await db.close(); }
  });
});
