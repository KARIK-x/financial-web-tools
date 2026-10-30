import { one, type Executor } from "./db";

export class RateLimitError extends Error {}

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
};

/**
 * Durable fixed-window limiter. Counters live in Postgres, so a restart or a
 * second app process does not reset the window. It is deliberately simple:
 * LOCUS scale does not need a distributed token-bucket service.
 */
export async function consumeRateLimit(
  db: Executor,
  key: string,
  limit: number,
  windowSeconds: number,
  blockSeconds = windowSeconds,
): Promise<RateLimitResult> {
  const row = await one<{ count: number; blocked_until: Date | null; window_start: Date }>(
    db,
    `INSERT INTO rate_limits (key, window_start, count, updated_at)
     VALUES ($1, now(), 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start < now() - ($2::text || ' seconds')::interval THEN 1
         ELSE rate_limits.count + 1
       END,
       window_start = CASE
         WHEN rate_limits.window_start < now() - ($2::text || ' seconds')::interval THEN now()
         ELSE rate_limits.window_start
       END,
       updated_at = now()
     RETURNING count, blocked_until, window_start`,
    [key, windowSeconds],
  );
  const count = Number(row?.count ?? 0);
  const blockedUntil = row?.blocked_until ? new Date(row.blocked_until).getTime() : 0;
  if (blockedUntil > Date.now()) {
    return { allowed: false, count, limit, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)) };
  }
  if (count > limit) {
    const until = new Date(Date.now() + blockSeconds * 1000);
    await db.query(`UPDATE rate_limits SET blocked_until = $2, updated_at = now() WHERE key = $1`, [key, until]);
    return { allowed: false, count, limit, retryAfterSeconds: blockSeconds };
  }
  return { allowed: true, count, limit, retryAfterSeconds: 0 };
}

export async function clearRateLimit(db: Executor, key: string): Promise<void> {
  await db.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
}

export async function enforceRateLimit(
  db: Executor,
  key: string,
  limit: number,
  windowSeconds: number,
  message = "Too many requests. Try again later.",
): Promise<void> {
  const result = await consumeRateLimit(db, key, limit, windowSeconds);
  if (!result.allowed) {
    throw new RateLimitError(`${message} Retry after ${result.retryAfterSeconds} seconds.`);
  }
}
