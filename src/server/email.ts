import { randomUUID } from "node:crypto";
import { one, type Db } from "./db";

export type EmailConfig = {
  configured: boolean;
  provider: "resend" | null;
  from: string | null;
  appUrl: string;
  errors: string[];
  warnings: string[];
};

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
};

export type EmailProvider = {
  name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
};

export type NotificationStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "DELIVERED" | "BLOCKED";

export function getEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawProvider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const provider = rawProvider === "resend" ? "resend" : null;
  const from = (env.EMAIL_FROM ?? "").trim() || null;
  const appUrl = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  if (rawProvider && rawProvider !== "resend") {
    errors.push(`Unsupported EMAIL_PROVIDER "${rawProvider}". Supported: resend.`);
  }
  if (provider && !env.EMAIL_API_KEY) errors.push("EMAIL_API_KEY is required when EMAIL_PROVIDER=resend.");
  if (provider && !from) errors.push("EMAIL_FROM is required when EMAIL_PROVIDER=resend.");
  if (from && /[\r\n]/.test(from)) errors.push("EMAIL_FROM must not contain line breaks.");
  if (from && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(from)) {
    errors.push("EMAIL_FROM must be a valid email address.");
  }
  if (!/^https?:\/\/[^/\s]+/.test(appUrl)) errors.push("APP_URL must be an absolute http(s) URL.");
  if (appUrl === "http://localhost:3000") {
    warnings.push("APP_URL is not set; email links will point at http://localhost:3000.");
  }

  return {
    configured: provider !== null && errors.length === 0,
    provider,
    from,
    appUrl,
    errors,
    warnings,
  };
}

class ResendProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async send(message: EmailMessage): Promise<{ id: string }> {
    const response = await fetch(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok || !payload.id) {
      throw new Error(`Resend rejected the message (${response.status}): ${payload.message ?? "no provider id"}`);
    }
    return { id: payload.id };
  }
}

export function configuredProvider(config = getEmailConfig()): EmailProvider | null {
  if (!config.configured || config.provider !== "resend") return null;
  return new ResendProvider(
    process.env.EMAIL_API_KEY ?? "",
    (process.env.EMAIL_API_BASE_URL ?? "https://api.resend.com").replace(/\/+$/, ""),
  );
}

function validRecipient(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);
}

export async function enqueueNotification(
  db: Db,
  input: {
    kind: string;
    recipient: string;
    subject: string;
    bodyText: string;
    dedupeKey?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  if (!validRecipient(input.recipient)) throw new Error("Notification recipient is not a valid email address.");
  if (!input.subject.trim() || !input.bodyText.trim()) throw new Error("Notification subject and body are required.");
  const id = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO notification_outbox (id, dedupe_key, kind, recipient, subject, body_text, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.dedupeKey ?? null,
      input.kind,
      input.recipient.toLowerCase(),
      input.subject.slice(0, 200),
      input.bodyText.slice(0, 10_000),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await one<{ id: string }>(db, `SELECT id FROM notification_outbox WHERE dedupe_key=$1`, [input.dedupeKey]);
  if (!existing) throw new Error("Notification could not be enqueued.");
  return { id: existing.id, created: false };
}

type OutboxRow = {
  id: string;
  status: NotificationStatus;
  recipient: string;
  subject: string;
  body_text: string;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
};

export async function dispatchNotification(
  db: Db,
  id: string,
  providerOverride?: EmailProvider | null,
): Promise<{ status: NotificationStatus; providerMessageId?: string; error?: string }> {
  const row = await one<OutboxRow>(
    db,
    `SELECT id, status, recipient, subject, body_text, dedupe_key, attempts, max_attempts, next_attempt_at
       FROM notification_outbox WHERE id=$1`,
    [id],
  );
  if (!row) throw new Error("Notification not found.");
  if (["SENT", "DELIVERED"].includes(row.status)) return { status: row.status };
  if (row.attempts >= row.max_attempts) return { status: row.status, error: "Maximum attempts reached." };
  if (new Date(row.next_attempt_at).getTime() > Date.now()) return { status: row.status };

  const provider = providerOverride ?? configuredProvider();
  if (!provider) {
    const config = getEmailConfig();
    const error = config.errors.length
      ? `Email provider is not configured: ${config.errors.join(" ")}`
      : "Email provider is not configured. Set EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM.";
    await db.query(
      `UPDATE notification_outbox SET status='BLOCKED', last_error=$2, provider=NULL WHERE id=$1`,
      [id, error.slice(0, 1000)],
    );
    return { status: "BLOCKED", error };
  }

  await db.query(`UPDATE notification_outbox SET status='SENDING', provider=$2 WHERE id=$1`, [id, provider.name]);
  try {
    const sent = await provider.send({
      to: row.recipient,
      subject: row.subject,
      text: row.body_text,
      idempotencyKey: row.dedupe_key ?? row.id,
    });
    await db.query(
      `UPDATE notification_outbox
          SET status='SENT', provider=$2, provider_message_id=$3, attempts=attempts+1,
              last_error=NULL, sent_at=now()
        WHERE id=$1`,
      [id, provider.name, sent.id],
    );
    return { status: "SENT", providerMessageId: sent.id };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await db.query(
      `UPDATE notification_outbox
          SET status='FAILED', attempts=attempts+1, last_error=$2,
              next_attempt_at = now() + (power(2, LEAST(attempts + 1, 8))::text || ' minutes')::interval
        WHERE id=$1`,
      [id, message],
    );
    return { status: "FAILED", error: message };
  }
}

export async function dispatchQueuedNotifications(
  db: Db,
  opts: { limit?: number; provider?: EmailProvider | null } = {},
): Promise<{ attempted: number; sent: number; failed: number; blocked: number }> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM notification_outbox
      WHERE status IN ('QUEUED','FAILED','BLOCKED')
        AND attempts < max_attempts
        AND next_attempt_at <= now()
      ORDER BY created_at
      LIMIT $1`,
    [Math.min(Math.max(opts.limit ?? 25, 1), 200)],
  );
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  for (const row of rows.rows) {
    const result = await dispatchNotification(db, row.id, opts.provider);
    if (result.status === "SENT") sent++;
    else if (result.status === "BLOCKED") blocked++;
    else if (result.status === "FAILED") failed++;
  }
  return { attempted: rows.rows.length, sent, failed, blocked };
}
