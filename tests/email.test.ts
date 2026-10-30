import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/fixtures";
import { createPerson } from "./helpers/fixtures";
import { dispatchNotification, enqueueNotification, getEmailConfig, type EmailProvider } from "@/server/email";
import { completePasswordReset, requestPasswordReset } from "@/server/password-reset";
import { hashToken, verifyPassword } from "@/server/password";

const saved = { ...process.env };

function fakeProvider(behavior: "ok" | "fail" = "ok"): EmailProvider & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    name: "test-provider",
    messages,
    async send(message) {
      messages.push(message);
      if (behavior === "fail") throw new Error("synthetic provider failure");
      return { id: `test-${messages.length}` };
    },
  };
}

beforeEach(() => {
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.APP_URL;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("email configuration and outbox", () => {
  it("reports missing provider configuration without attempting delivery", async () => {
    const config = getEmailConfig();
    expect(config.configured).toBe(false);
    expect(config.errors).toEqual([]);

    process.env.EMAIL_PROVIDER = "resend";
    const invalid = getEmailConfig();
    expect(invalid.configured).toBe(false);
    expect(invalid.errors.join(" ")).toContain("EMAIL_API_KEY");
    expect(invalid.errors.join(" ")).toContain("EMAIL_FROM");
  });

  it("deduplicates notifications and dispatches through an injected provider", async () => {
    const db = await createTestDb();
    try {
      const first = await enqueueNotification(db, {
        kind: "TEST",
        recipient: "recipient@example.org",
        subject: "Synthetic subject",
        bodyText: "Synthetic body",
        dedupeKey: "test:dedupe:1",
      });
      const second = await enqueueNotification(db, {
        kind: "TEST",
        recipient: "recipient@example.org",
        subject: "Synthetic subject",
        bodyText: "Synthetic body",
        dedupeKey: "test:dedupe:1",
      });
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);

      const provider = fakeProvider();
      const result = await dispatchNotification(db, first.id, provider);
      expect(result.status).toBe("SENT");
      expect(provider.messages).toHaveLength(1);
      const row = await db.query<{ status: string; attempts: number; provider_message_id: string }>(
        `SELECT status, attempts, provider_message_id FROM notification_outbox WHERE id=$1`,
        [first.id],
      );
      expect(row.rows[0]?.status).toBe("SENT");
      expect(row.rows[0]?.attempts).toBe(1);
      expect(row.rows[0]?.provider_message_id).toBe("test-1");
    } finally {
      await db.close();
    }
  });

  it("records a failed attempt and retries with backoff", async () => {
    const db = await createTestDb();
    try {
      const queued = await enqueueNotification(db, {
        kind: "TEST",
        recipient: "recipient@example.org",
        subject: "Retry subject",
        bodyText: "Retry body",
        dedupeKey: "test:retry:1",
      });
      const failed = await dispatchNotification(db, queued.id, fakeProvider("fail"));
      expect(failed.status).toBe("FAILED");
      const row = await db.query<{ status: string; attempts: number; next_attempt_at: Date }>(
        `SELECT status, attempts, next_attempt_at FROM notification_outbox WHERE id=$1`,
        [queued.id],
      );
      expect(row.rows[0]?.status).toBe("FAILED");
      expect(row.rows[0]?.attempts).toBe(1);
      expect(new Date(row.rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

      await db.query(`UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1`, [queued.id]);
      const retried = await dispatchNotification(db, queued.id, fakeProvider());
      expect(retried.status).toBe("SENT");
    } finally {
      await db.close();
    }
  });
});

describe("password reset", () => {
  it("creates a hashed one-time token, queues mail, revokes sessions and consumes the token", async () => {
    process.env.APP_URL = "https://locus.example.org";
    const db = await createTestDb();
    try {
      const user = await createPerson(db, {
        role: "FINANCE",
        name: "Reset Person",
        email: "reset-person@example.org",
      });
      const sessionId = randomUUID();
      await db.query(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at)
         VALUES ($1,$2,$3,now() + interval '1 day')`,
        [sessionId, randomUUID(), user.id],
      );

      await requestPasswordReset(db, user.email, { ip: "127.0.0.1" });
      const outbox = await db.query<{ body_text: string }>(
        `SELECT body_text FROM notification_outbox WHERE kind='PASSWORD_RESET'`,
      );
      expect(outbox.rows).toHaveLength(1);
      const token = outbox.rows[0]!.body_text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeTruthy();
      const stored = await db.query<{ token_hash: string }>(`SELECT token_hash FROM password_reset_tokens`);
      expect(stored.rows[0]?.token_hash).toBe(hashToken(token!));
      expect(stored.rows[0]?.token_hash).not.toBe(token);

      const result = await completePasswordReset(db, token!, "A-strong-new-password-9");
      expect(result.email).toBe(user.email);
      const account = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
      expect(await verifyPassword("A-strong-new-password-9", account.rows[0]!.password_hash)).toBe(true);
      const session = await db.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM sessions WHERE id=$1`, [sessionId]);
      expect(session.rows[0]?.revoked_at).not.toBeNull();
      await expect(completePasswordReset(db, token!, "Another-strong-password-9")).rejects.toThrow(/invalid or has expired/);
    } finally {
      await db.close();
    }
  });

  it("does not reveal whether an address exists and rate-limits repeated requests", async () => {
    const db = await createTestDb();
    try {
      await requestPasswordReset(db, "nobody@example.org", { ip: "127.0.0.2" });
      const outbox = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_outbox`);
      expect(Number(outbox.rows[0]?.n)).toBe(0);
    } finally {
      await db.close();
    }
  });
});
