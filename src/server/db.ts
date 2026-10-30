import { PGlite } from "@electric-sql/pglite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PgDatabase } from "./pg-db";
import type { Executor } from "./journal";

/**
 * The application talks to one small database interface. PGlite (embedded) is
 * the development/demo driver; `pg` (managed PostgreSQL) is the production
 * driver. Keeping the interface explicit makes the persistence choice a
 * deployment concern rather than a rewrite of every server module.
 */
export type TransactionExecutor = Executor & { exec(sql: string): Promise<unknown> };

export type Db = {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: TransactionExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type { Executor };

const MIGRATION_DIR = path.join(process.cwd(), "db", "migrations");

/** Resolve the configured database without opening it. */
export function databaseConfigFromEnv(): { dataDir?: string | null; connectionString?: string } {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return { dataDir: process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite") };
}

/** Safe display name for logs. Never prints credentials. */
export function describeDatabaseTarget(config: { dataDir?: string | null; connectionString?: string }): string {
  if (config.connectionString) {
    try {
      const url = new URL(config.connectionString);
      return `postgresql://${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
    } catch {
      return "postgresql://<configured>";
    }
  }
  return config.dataDir ?? "pglite://memory";
}

async function ensureMigrationsTable(db: Db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function applyMigrations(db: Db): Promise<string[]> {
  await ensureMigrationsTable(db);
  const files = (await fs.readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const done = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const doneSet = new Set(done.rows.map((r) => r.name));
  for (const file of files) {
    if (doneSet.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATION_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
    applied.push(file);
  }
  return applied;
}

class PgliteDatabase implements Db {
  constructor(private readonly db: PGlite) {}

  query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    return this.db.query<T>(sql, params as never[]);
  }

  exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }

  transaction<T>(fn: (tx: TransactionExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx as unknown as TransactionExecutor));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export async function createDatabase(opts: {
  dataDir?: string | null;
  connectionString?: string;
} = {}): Promise<Db> {
  if (opts.connectionString) {
    const db = new PgDatabase(opts.connectionString);
    await db.connect();
    await applyMigrations(db);
    return db;
  }

  if (opts.dataDir) await fs.mkdir(path.dirname(opts.dataDir), { recursive: true });
  const pglite = new PGlite(opts.dataDir ?? undefined);
  await pglite.waitReady;
  if (opts.dataDir) {
    await pglite.exec(`SET TIME ZONE 'Asia/Kathmandu'`);
  }
  const db = new PgliteDatabase(pglite);
  await applyMigrations(db);
  return db;
}

const globalForDb = globalThis as unknown as { __locusDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__locusDb) {
    const config = databaseConfigFromEnv();
    if (!config.connectionString && config.dataDir) {
      globalForDb.__locusDb = fs
        .mkdir(config.dataDir, { recursive: true })
        .then(() => createDatabase(config))
        .catch((err) => {
          globalForDb.__locusDb = undefined;
          throw err;
        });
    } else {
      globalForDb.__locusDb = createDatabase(config).catch((err) => {
        globalForDb.__locusDb = undefined;
        throw err;
      });
    }
  }
  return globalForDb.__locusDb;
}

export async function one<T>(db: Executor, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(sql, params as never[]);
  return res.rows[0] ?? null;
}

export async function many<T>(db: Executor, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params as never[]);
  return res.rows;
}

export async function exec(db: Db, sql: string, params: unknown[] = []) {
  return db.query(sql, params as never[]);
}

export async function nextSequence(db: Executor, sequence: string): Promise<number> {
  const row = await one<{ value: string | number | bigint }>(db, `SELECT nextval($1) AS value`, [sequence]);
  return Number(row?.value ?? 0);
}

/** Normalise PGlite/pg bigint/number/string results to a JS number of paisa. */
export function money(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function iso(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function dateOnly(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
