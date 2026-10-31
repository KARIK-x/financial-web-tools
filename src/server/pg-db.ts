import { Pool, types, type PoolConfig, type PoolClient, type QueryResultRow } from "pg";
import type { Db, Executor, TransactionExecutor } from "./db";

// The application represents money as a JS number of paisa throughout the
// existing codebase. node-postgres returns int8 as a string by default. Keep
// parity with PGlite, while making the safe-integer boundary explicit.
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`PostgreSQL bigint ${value} exceeds the application's safe integer range`);
  }
  return n;
});

function sslConfig(connectionString: string): PoolConfig["ssl"] {
  const mode = (process.env.DATABASE_SSL ?? "").toLowerCase();
  if (mode === "disable" || mode === "false") return false;
  if (mode === "require" || mode === "no-verify") return { rejectUnauthorized: false };
  if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };

  try {
    const url = new URL(connectionString);
    const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslmode === "disable") return false;
    if (sslmode === "require" || sslmode === "prefer" || sslmode === "allow") {
      return { rejectUnauthorized: false };
    }
    if (sslmode === "verify-full" || sslmode === "verify-ca") return { rejectUnauthorized: true };
  } catch {
    // The pool will produce a clearer connection error.
  }
  return undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

class PgExecutor implements Executor {
  constructor(private readonly client: PoolClient) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.client.query(sql, params as never[]);
    return { rows: result.rows as T[] };
  }

  async exec(sql: string): Promise<unknown> {
    return this.client.query(sql);
  }
}

/**
 * Managed PostgreSQL driver. One pool per application process; transactions
 * pin a single client so every financial write is atomic.
 */
export class PgDatabase implements Db {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: positiveInt(process.env.DATABASE_POOL_MAX, 10),
      idleTimeoutMillis: positiveInt(process.env.DATABASE_IDLE_TIMEOUT_MS, 30_000),
      connectionTimeoutMillis: positiveInt(process.env.DATABASE_CONNECT_TIMEOUT_MS, 10_000),
      statement_timeout: positiveInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 30_000),
      query_timeout: positiveInt(process.env.DATABASE_QUERY_TIMEOUT_MS, 30_000),
      application_name: process.env.DATABASE_APPLICATION_NAME ?? "finance-tracker",
      options: "-c timezone=Asia/Kathmandu",
      ssl: sslConfig(connectionString),
    });
    this.pool.on("error", (err) => {
      // A pooled idle-client error must not crash the process. The next query
      // will surface a normal connection error to the caller.
      console.error("PostgreSQL pool error:", err.message);
    });
  }

  async connect(): Promise<void> {
    try {
      await this.pool.query("SELECT 1");
    } catch (err) {
      await this.pool.end().catch(() => undefined);
      throw err;
    }
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.pool.query(sql, params as never[]);
    return { rows: result.rows as T[] };
  }

  async exec(sql: string): Promise<unknown> {
    return this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: TransactionExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PgExecutor(client);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type { QueryResultRow };
