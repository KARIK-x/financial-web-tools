# POSTGRESQL MIGRATION PLAN

**Status: IMPLEMENTED (plan and compatibility audit) / BLOCKED (execution and verification)**
**Date:** 2026-10-24
**Current store:** PGlite 0.5.11 in `.data/pglite`
**Target:** managed PostgreSQL 15+ (or a self-hosted PostgreSQL 15+ server)

This document is a migration plan, not a claim that a migration has happened. No PostgreSQL server, client, connection string, or TLS credential exists in this environment. The Docker daemon is also unavailable. A managed migration must not be marked successful until it is performed against a disposable PostgreSQL database and the verification queries in section 7 pass.

---

## 1. What is actually running today

| Area | Current implementation | Evidence |
|---|---|---|
| Database engine | PGlite, embedded PostgreSQL-compatible WASM build | `package.json`, `src/server/db.ts` |
| Persistence | One local data directory (`DATABASE_DIR`, default `.data/pglite`) | `src/server/db.ts` |
| Access pattern | `db.query<T>(sql, params)`, `db.exec(sql)`, `db.transaction(async (tx) => …)` | `src/server/*.ts` |
| Money | `BIGINT` paisa; no floating point | `db/migrations/001_init.sql` |
| Schema history | Raw SQL migrations applied in filename order and recorded in `schema_migrations` | `db/migrations/001_init.sql`, `002_reference.sql`, `003_operational_hardening.sql` |
| Concurrency | Single process. PGlite cannot be shared by two processes or app instances. | operational limitation, confirmed by local use |
| Backups | File-level copy of the data directory + documents, checksummed and restored into a scratch directory | `scripts/lib/backup.ts`, `docs/BACKUP_AND_RESTORE.md` |

The schema is ordinary PostgreSQL SQL: no `CREATE EXTENSION`, no PGlite-only functions, no `CREATE DATABASE`, and no `pg_` system-table writes. It uses `jsonb`, `timestamptz`, `date`, `BIGINT`, partial indexes, `CHECK` constraints, `REFERENCES`, and PL/pgSQL triggers. Those are supported by PostgreSQL 15+.

---

## 2. Why PGlite cannot be the production database

1. **Single writer/process.** The app cannot run two instances, a rolling deploy, a background worker, or a serverless function against the same data directory.
2. **Filesystem durability is not a managed backup.** There is no point-in-time recovery, replication, failover, or provider snapshot.
3. **No connection pool or TLS.** Access is local process memory plus files.
4. **Restore is a file copy.** A restore requires stopping the app and replacing the directory; it cannot be done online.
5. **Operational visibility is limited.** No managed metrics, slow-query log, connection limits, or role separation.

The current implementation is acceptable for a single-user/local demonstration and forensic work, not for a multi-user production finance system.

---

## 3. Target architecture

```
Next.js app (1..n instances)
        |
        | DATABASE_URL (TLS required in production)
        v
Managed PostgreSQL 15+  ---> provider PITR / snapshots / metrics
        ^
        |
Object storage or encrypted volume for receipts (separate from the database)
```

Required target properties:

- PostgreSQL 15 or newer, in the project's assigned region.
- TLS required; `sslmode=verify-full` where the provider supplies a CA.
- A dedicated application role with only `CONNECT`, schema usage, and DML/DDL needed by migrations. Do not use the provider's superuser.
- A separate migration role (or controlled migration job) for DDL.
- Connection pooler if the provider requires it (for example PgBouncer in transaction mode). The app must not depend on session state.
- Automated backups/PITR enabled and tested by the provider; a restore drill remains mandatory.
- Documents remain in the existing content-addressed store or move to encrypted object storage. They are **not** stored in PostgreSQL in this phase.

---

## 4. Adapter work required before cutover

### 4.1 Replace the `Db` type, not every query

`src/server/db.ts` currently exports:

```ts
export type Db = PGlite;
export type { Executor };
```

The rest of the application is written against `query`, `exec`, and `transaction`. Introduce a narrow interface that both PGlite and `pg` can satisfy:

```ts
export interface SqlClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export interface Db extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
```

Then add a `pg` implementation using `Pool` and `PoolClient`:

- `query` maps to `client.query({ text, values })`.
- `transaction` checks out a client, runs `BEGIN`, calls the callback with a client-scoped adapter, then `COMMIT`/`ROLLBACK`, and always releases the client.
- `exec` maps to `client.query(sql)` for multi-statement SQL; prefer `query` for parameterised statements.
- Set `statement_timeout`, `idle_in_transaction_session_timeout`, and an application name.
- Normalise `BIGINT`: `pg` returns `int8` as a string by default. Keep the existing `money()`/`Number()` normalisation at boundaries; do not enable a global parser that silently loses precision.
- Keep parameter placeholders as `$1`, `$2`, …; no rewrite is needed.
- Ensure `postJournal` receives the transaction-scoped client, never the pool, or it will deadlock/escape the transaction.

### 4.2 Migration runner

Keep the existing `applyMigrations` semantics, but make the migration directory and advisory lock explicit:

1. Acquire a PostgreSQL advisory lock for the migration run.
2. Create `schema_migrations` if absent.
3. Read files in lexical order (`001`, `002`, `003`, …).
4. Apply each unapplied file in a transaction and insert its name.
5. Release the lock.

Do not edit an already-applied migration. Add `004_...sql` for further changes.

### 4.3 Configuration

Add and validate:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | production | PostgreSQL connection string; never log it |
| `DATABASE_SSL` | production | `require` / `verify-full`; do not disable TLS silently |
| `DATABASE_POOL_MAX` | optional | default 10 per instance; account for the provider's connection limit |
| `MIGRATION_DATABASE_URL` | migration job | separate role; not exposed to the web runtime |
| `DATABASE_DIR` | local/PGlite only | ignored when `DATABASE_URL` is set |

The app must fail fast if production starts without `DATABASE_URL`, or if TLS is disabled outside development.

---

## 5. Data movement options

PGlite is a PostgreSQL-compatible engine but its on-disk data directory is not a supported `pg_dump` source. Do not copy the data directory into a managed PostgreSQL data directory. Use a logical export/import.

### Option A — logical table export from PGlite (recommended for this app)

1. Stop the app and take a verified file-level backup first.
2. Open PGlite read-only in a script.
3. Read `information_schema`/`pg_catalog` for tables, columns, and foreign keys.
4. Export tables in dependency order as `COPY ... FROM STDIN`-compatible CSV or as parameterised `INSERT` statements. Preserve `BIGINT` as decimal text; never convert paisa to a JavaScript `number` during export.
5. Export sequences/identity values. The current schema uses application-generated text IDs (`randomUUID()`), but verify every table before assuming there are no sequences.
6. Load into a disposable PostgreSQL database with `ON_ERROR_STOP=1`.
7. Compare row counts, checksums, and financial invariants (section 7).
8. Only then point a staging app at the target.

A migration script must be read-only against the source and must refuse to run if the source app appears live (for example a `postmaster.pid` or an explicit `--allow-live` flag). It must never write to `.data/pglite` or `.data/documents`.

### Option B — application-level JSON export

The existing export API is capped at 20,000 rows and omits some tables. It is useful for reconciliation but **not sufficient** for a full migration. Do not use it as the primary cutover mechanism.

### Option C — provider import tooling

If the provider offers a PostgreSQL logical import from a dump, generate that dump from a real PostgreSQL staging copy first. There is no PGlite `pg_dump` binary in this environment, so this option is not currently testable.

---

## 6. Cutover sequence (safe, reversible)

1. **Freeze writes.** Put the app in maintenance mode or stop it. Record the freeze timestamp.
2. **Back up and verify.** Run `npm run db:backup -- --out /secure/path` and `npm run db:verify-backup -- /secure/path`. Do not proceed if verification fails.
3. **Provision the target.** Create an empty PostgreSQL database, application role, migration role, TLS, and backups/PITR.
4. **Apply migrations.** Run `001`–`003` (and any later files) against the empty target with the migration role. Record every applied filename.
5. **Load data.** Use the logical export/import from section 5. Load in dependency order. Do not disable foreign keys; fix the order instead.
6. **Verify before pointing the app at it.**
   - Row counts per table match the source.
   - Journal debits equal credits.
   - Claim/payment/journal totals match.
   - No orphan document references.
   - `schema_migrations` matches.
   - `audit_events` is append-only.
7. **Staging smoke test.** Start the app against the target with `DATABASE_URL` set. Run `npx tsc --noEmit`, `npm test`, `npm run build`, and the Playwright suite against the staging database. Do not run destructive demo resets against production data.
8. **Cutover.** Switch the production `DATABASE_URL`, keep the old PGlite directory read-only as a rollback copy, and monitor errors/latency.
9. **Rollback.** If verification fails, stop the app, point it back at the old PGlite directory, and keep the failed target for forensics. Never “fix” production by deleting rows.

---

## 7. Verification queries

Run these against both source and target and compare results. They are read-only.

```sql
-- 1. Migration state
SELECT name FROM schema_migrations ORDER BY name;

-- 2. Table inventory (should be identical)
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- 3. Row counts for critical tables
SELECT 'users' AS table_name, COUNT(*) FROM users
UNION ALL SELECT 'members', COUNT(*) FROM members
UNION ALL SELECT 'expense_claims', COUNT(*) FROM expense_claims
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'journal_entries', COUNT(*) FROM journal_entries
UNION ALL SELECT 'journal_lines', COUNT(*) FROM journal_lines
UNION ALL SELECT 'documents', COUNT(*) FROM documents
UNION ALL SELECT 'audit_events', COUNT(*) FROM audit_events
UNION ALL SELECT 'bank_statement_lines', COUNT(*) FROM bank_statement_lines
ORDER BY table_name;

-- 4. The books must balance
SELECT COALESCE(SUM(debit_paisa), 0) AS debit,
       COALESCE(SUM(credit_paisa), 0) AS credit,
       COALESCE(SUM(debit_paisa), 0) = COALESCE(SUM(credit_paisa), 0) AS balanced
  FROM journal_lines;

-- 5. Every journal entry must have at least two lines and balance
SELECT je.id, COUNT(jl.id) AS lines,
       COALESCE(SUM(jl.debit_paisa), 0) AS debit,
       COALESCE(SUM(jl.credit_paisa), 0) AS credit
  FROM journal_entries je
  LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
 GROUP BY je.id
HAVING COUNT(jl.id) < 2
    OR COALESCE(SUM(jl.debit_paisa), 0) <> COALESCE(SUM(jl.credit_paisa), 0);

-- 6. Document references must resolve
SELECT COUNT(*) AS orphan_documents
  FROM documents d
 WHERE NOT EXISTS (SELECT 1 FROM expense_claim_documents cd WHERE cd.document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM statement_imports si WHERE si.document_id = d.id);

-- 7. Payments must reconcile to the claim aggregate
SELECT c.id, c.amount_paisa,
       COALESCE(SUM(p.amount_paisa) FILTER (
         WHERE p.status = 'RECORDED' AND p.reverses_id IS NULL
       ), 0) AS recorded_payments
  FROM expense_claims c
  LEFT JOIN payments p ON p.claim_id = c.id
 GROUP BY c.id, c.amount_paisa
HAVING COALESCE(SUM(p.amount_paisa) FILTER (
         WHERE p.status = 'RECORDED' AND p.reverses_id IS NULL
       ), 0) > c.amount_paisa;

-- 8. No duplicate document hashes
SELECT sha256, COUNT(*) FROM documents GROUP BY sha256 HAVING COUNT(*) > 1;
```

Also compare a deterministic hash of ordered rows for high-risk tables (`journal_lines`, `payments`, `expense_claims`, `audit_events`) using `md5(string_agg(...))` with explicit ordering. Do not compare only totals: two wrong rows can cancel out.

---

## 8. Application changes required for production

| Change | Why | Status |
|---|---|---|
| `pg` adapter and `DATABASE_URL` | Multi-instance/durable deployment | NOT-TESTED |
| Migration advisory lock | Prevent concurrent migration runs | NOT-TESTED |
| TLS enforcement | Protect credentials and data in transit | NOT-TESTED |
| Connection pool sizing | Avoid exhausting provider connections | NOT-TESTED |
| Online backup/PITR runbook | Provider-specific recovery | BLOCKED (no provider) |
| Restore drill against managed PostgreSQL | Prove recovery, not just file copy | BLOCKED (no provider) |
| Multi-instance session/rate-limit review | PostgreSQL-backed limiter already exists; verify under load | NOT-TESTED |
| Object storage for documents | Decouple files from one app host | NOT-TESTED |
| Remove PGlite from production paths | Avoid accidental local writes | NOT-TESTED |

---

## 9. Current blockers and evidence

- `psql`, `pg_dump`, and a PostgreSQL server are not installed/available.
- Docker is not running; a disposable PostgreSQL container cannot be started.
- No `DATABASE_URL`, provider project, or TLS credential exists.
- No `pg` package is installed; the adapter has not been written.
- Therefore: **no managed PostgreSQL migration has been executed, and no production claim is made.**

The correct status is **BLOCKED** for execution. The schema and plan are **IMPLEMENTED**; local PGlite verification is **TESTED-PASS** and is recorded in `docs/FORENSIC_VERIFICATION.md` and `docs/TEST_RESULTS.md`.

---

## 10. Acceptance criteria for calling the migration complete

All of the following must be true and evidenced:

1. Empty target created with a non-superuser application role and TLS.
2. `001`–`003` applied; `schema_migrations` matches the source.
3. Row counts and deterministic hashes match for every critical table.
4. Journal debits equal credits; no unbalanced or single-line entries.
5. No orphan document references; no duplicate document hashes.
6. All 117 unit/integration tests pass against PostgreSQL.
7. `npm run build` passes.
8. Playwright E2E passes against the PostgreSQL-backed app.
9. A backup/PITR restore into a disposable database reproduces the same verification queries.
10. The old PGlite directory remains read-only and available for rollback until sign-off.

Until then, the production database status is **BLOCKED**, not “done”.
