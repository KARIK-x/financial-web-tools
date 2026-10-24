import { PGlite } from "@electric-sql/pglite";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Executor } from "./journal";

export type Db = PGlite;
export type { Executor };

const MIGRATION_DIR = path.join(process.cwd(), "db", "migrations");

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

export async function createDatabase(opts: { dataDir?: string | null } = {}): Promise<Db> {
  if (opts.dataDir) await fs.mkdir(path.dirname(opts.dataDir), { recursive: true });
  const db = new PGlite(opts.dataDir ?? undefined);
  await db.waitReady;
  if (opts.dataDir) {
    await db.exec(`SET TIME ZONE 'Asia/Kathmandu'`);
  }
  await applyMigrations(db);
  return db;
}

const globalForDb = globalThis as unknown as { __locusDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__locusDb) {
    const dataDir = process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite");
    globalForDb.__locusDb = fs
      .mkdir(dataDir, { recursive: true })
      .then(() => createDatabase({ dataDir }))
      .catch((err) => {
        globalForDb.__locusDb = undefined;
        throw err;
      });
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

/** Normalise PGlite bigint/number/string results to a JS number of paisa. */
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
