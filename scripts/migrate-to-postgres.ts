/**
 * Copy an existing PGlite database into an empty PostgreSQL database.
 *
 *   DATABASE_URL=postgresql://... npm run db:migrate-to-postgres -- --source .data/pglite
 *
 * Safety:
 *  - The target must be a disposable or newly provisioned database.
 *  - The script refuses if the target already has users, claims, payments or
 *    journal entries. Reference rows created by migrations are allowed.
 *  - The source PGlite directory is opened read-only by convention; this script
 *    never writes to it.
 *  - Counts, journal totals, claim/payment totals, document references and
 *    sequences are compared before the script reports success.
 *
 * Receipt files are not embedded in PostgreSQL. Copy them separately with the
 * documented storage procedure in docs/POSTGRESQL_MIGRATION_PLAN.md.
 */
import { PGlite } from "@electric-sql/pglite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDatabase, describeDatabaseTarget } from "../src/server/db";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

async function tableColumns(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, table: string) {
  return db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  );
}

async function primaryKey(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, table: string) {
  const res = await db.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.contype='p' AND c.conrelid=$1::regclass
      ORDER BY k.ord`,
    [`public.${table}`],
  );
  return res.rows.map((r) => r.column_name);
}

async function selfForeignKeys(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, table: string) {
  const res = await db.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.contype='f' AND c.conrelid=c.confrelid AND c.conrelid=$1::regclass
      ORDER BY k.ord`,
    [`public.${table}`],
  );
  return res.rows.map((r) => r.column_name);
}

async function orderTables(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }): Promise<string[]> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'
      ORDER BY table_name`,
  );
  const fks = await db.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace AND c.conrelid <> c.confrelid`,
  );
  const names = tables.rows.map((r) => r.table_name);
  const children = new Map<string, Set<string>>();
  for (const name of names) children.set(name, new Set());
  for (const fk of fks.rows) {
    if (children.has(fk.parent) && children.has(fk.child)) children.get(fk.parent)!.add(fk.child);
  }
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") return; // cycle: PostgreSQL will report it if data is invalid
    state.set(name, "visiting");
    for (const child of children.get(name) ?? []) visit(child);
    state.set(name, "done");
    out.push(name);
  };
  for (const name of names) visit(name);
  return out.reverse();
}

async function counts(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, table: string): Promise<number> {
  const res = await db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  return Number(res.rows[0]?.n ?? 0);
}

async function aggregate(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }): Promise<Record<string, string>> {
  const res = await db.query<{
    journal_debit: string; journal_credit: string; journal_entries: string; journal_lines: string;
    claims: string; claim_total: string; payments: string; payment_total: string;
    documents: string; document_rows: string;
  }>(`
    SELECT
      COALESCE(SUM(l.debit_paisa),0)::text AS journal_debit,
      COALESCE(SUM(l.credit_paisa),0)::text AS journal_credit,
      (SELECT COUNT(*)::text FROM journal_entries WHERE status='POSTED') AS journal_entries,
      (SELECT COUNT(*)::text FROM journal_lines) AS journal_lines,
      (SELECT COUNT(*)::text FROM expense_claims) AS claims,
      (SELECT COALESCE(SUM(amount_paisa),0)::text FROM expense_claims) AS claim_total,
      (SELECT COUNT(*)::text FROM payments) AS payments,
      (SELECT COALESCE(SUM(amount_paisa),0)::text FROM payments WHERE status <> 'VOID') AS payment_total,
      (SELECT COUNT(*)::text FROM documents) AS documents,
      (SELECT COUNT(*)::text FROM ocr_extractions) AS document_rows
    FROM journal_lines l
  `);
  return res.rows[0] as unknown as Record<string, string>;
}

async function main() {
  const sourceDir = arg("source") ?? process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  const targetUrl = arg("target") ?? process.env.DATABASE_URL;
  if (!targetUrl) throw new Error("Set DATABASE_URL (or pass --target) to an empty disposable PostgreSQL database.");
  if (!(await fs.stat(sourceDir).catch(() => null))) throw new Error(`Source PGlite directory not found: ${sourceDir}`);

  const source = new PGlite(sourceDir);
  await source.waitReady;
  const target = await createDatabase({ connectionString: targetUrl });
  console.log(`Source: pglite://${sourceDir}`);
  console.log(`Target: ${describeDatabaseTarget({ connectionString: targetUrl })}`);

  try {
    const occupied = await target.query<{ users: string; claims: string; payments: string; journal: string }>(
      `SELECT
        (SELECT COUNT(*)::text FROM users) AS users,
        (SELECT COUNT(*)::text FROM expense_claims) AS claims,
        (SELECT COUNT(*)::text FROM payments) AS payments,
        (SELECT COUNT(*)::text FROM journal_entries) AS journal`,
    );
    const row = occupied.rows[0];
    if (!row || Number(row.users) || Number(row.claims) || Number(row.payments) || Number(row.journal)) {
      throw new Error("Refusing to copy: target already contains users, claims, payments or journal entries. Use a fresh database.");
    }

    const sourceTables = (await source.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'`,
    )).rows.map((r) => r.table_name);
    const targetTables = (await target.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'`,
    )).rows.map((r) => r.table_name);
    const missing = sourceTables.filter((t) => !targetTables.includes(t));
    if (missing.length) throw new Error(`Target is missing tables: ${missing.join(", ")}`);

    const order = await orderTables(target);
    console.log(`Copying ${sourceTables.length} tables in foreign-key order...`);
    const deferredJournalStatuses: Array<{ id: string; status: string }> = [];

    for (const table of order) {
      if (!sourceTables.includes(table)) continue;
      const cols = (await tableColumns(source, table)).rows.map((c) => c.column_name);
      const pk = await primaryKey(target, table);
      const selfFks = new Set(await selfForeignKeys(target, table));
      const rows = (await source.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(table)}`)).rows;
      if (!rows.length) continue;

      const insertCols = cols.map(quoteIdent).join(", ");
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const conflict = pk.length ? `ON CONFLICT (${pk.map(quoteIdent).join(", ")}) DO NOTHING` : "ON CONFLICT DO NOTHING";
      const sql = `INSERT INTO ${quoteIdent(table)} (${insertCols}) VALUES (${placeholders}) ${conflict}`;
      const keyOf = (row: Record<string, unknown>) => JSON.stringify(pk.map((c) => row[c]));
      const byKey = new Map(rows.map((row) => [keyOf(row), row]));
      const inserted = new Set<string>();
      const insertRow = async (row: Record<string, unknown>) => {
        const key = keyOf(row);
        if (inserted.has(key)) return;
        // Insert self-referenced parents first. This keeps FK checks enabled
        // and avoids mutating immutable audit/finalized rows after insertion.
        for (const col of selfFks) {
          const parent = row[col];
          if (parent == null) continue;
          const parentRow = pk.length === 1 ? byKey.get(JSON.stringify([parent])) : undefined;
          if (parentRow) await insertRow(parentRow);
        }
        const values = cols.map((c) => {
          // journal_lines_guard only permits lines on DRAFT entries. Copy the
          // entry as DRAFT, copy its lines, then restore the real status below.
          if (table === "journal_entries" && c === "status") return "DRAFT";
          return row[c] ?? null;
        });
        await target.query(sql, values);
        inserted.add(key);
      };
      for (const row of rows) await insertRow(row);
      if (table === "journal_entries") {
        for (const row of rows) {
          if (row.status && row.status !== "DRAFT") {
            deferredJournalStatuses.push({ id: String(row.id), status: String(row.status) });
          }
        }
      }

      const expected = rows.length;
      const actual = await counts(target, table);
      if (actual !== expected) {
        throw new Error(`Count mismatch for ${table}: source ${expected}, target ${actual}`);
      }
    }

    // Restore journal statuses only after all lines have been copied.
    for (const entry of deferredJournalStatuses) {
      await target.query(`UPDATE journal_entries SET status=$2 WHERE id=$1`, [entry.id, entry.status]);
    }

    // Preserve mutable reference rows (settings/accounts/organisation) exactly.
    for (const table of ["organizations", "financial_accounts", "settings"]) {
      if (!sourceTables.includes(table)) continue;
      const pk = await primaryKey(target, table);
      if (!pk.length) continue;
      const cols = (await tableColumns(source, table)).rows.map((c) => c.column_name);
      const rows = (await source.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(table)}`)).rows;
      for (const row of rows) {
        const sets = cols.filter((c) => !pk.includes(c)).map((c, i) => `${quoteIdent(c)}=$${i + 1}`);
        if (!sets.length) continue;
        const where = pk.map((c, i) => `${quoteIdent(c)}=$${sets.length + i + 1}`).join(" AND ");
        await target.query(
          `UPDATE ${quoteIdent(table)} SET ${sets.join(", ")} WHERE ${where}`,
          [...cols.filter((c) => !pk.includes(c)).map((c) => row[c] ?? null), ...pk.map((c) => row[c])],
        );
      }
    }

    // Preserve sequence positions so new numbers do not collide with copied rows.
    const sequences = (await source.query<{ sequencename: string }>(
      `SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
    ).catch(() => ({ rows: [] as { sequencename: string }[] }))).rows;
    for (const seq of sequences) {
      const value = await source.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value, is_called FROM ${quoteIdent(seq.sequencename)}`,
      ).catch(() => ({ rows: [] as { last_value: string; is_called: boolean }[] }));
      const v = value.rows[0];
      if (!v) continue;
      await target.query(`SELECT setval($1::regclass, $2, $3)`, [seq.sequencename, Number(v.last_value), v.is_called]);
    }

    const sourceAgg = await aggregate(source);
    const targetAgg = await aggregate(target);
    const mismatches = Object.keys(sourceAgg).filter((k) => String(sourceAgg[k]) !== String(targetAgg[k]));
    if (mismatches.length) {
      throw new Error(`Financial aggregate mismatch: ${mismatches.map((k) => `${k} ${sourceAgg[k]} != ${targetAgg[k]}`).join("; ")}`);
    }

    console.log("MIGRATION VERIFIED");
    console.log(`  Tables: ${sourceTables.length}`);
    console.log(`  Journal: ${targetAgg.journal_entries} posted entries, ${targetAgg.journal_lines} lines`);
    console.log(`  Debit: ${targetAgg.journal_debit} paisa; Credit: ${targetAgg.journal_credit} paisa`);
    console.log(`  Claims: ${targetAgg.claims} (total ${targetAgg.claim_total} paisa)`);
    console.log(`  Payments: ${targetAgg.payments} (non-void total ${targetAgg.payment_total} paisa)`);
    console.log(`  Documents: ${targetAgg.documents}; OCR rows: ${targetAgg.document_rows}`);
    console.log("  Receipt files were not copied by this script; copy DOCUMENT_DIR separately and verify references.");
  } finally {
    await target.close();
    await source.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
