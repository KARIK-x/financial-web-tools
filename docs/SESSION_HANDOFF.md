# SESSION HANDOFF

**Date:** 2026-10-24
**Project:** Finance Tracker Intelligence Platform
**Path:** `/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION`
**State:** working, tested, documented; single-organisation; managed PostgreSQL still blocked.

---

## 1. Read this first

The application is complete for evaluation and controlled single-instance use. It is **not** a reconstruction of FINANCE TRACKER’s real history: the supplied materials contained no organisational ledger. All current financial rows are synthetic and marked as such.

Do not:
- import the personal eSewa statement or expose its holder/account details,
- seed demo data over real data (the scripts refuse; do not force them),
- commit `.data/`, `.env`, credentials files, exports, or backups,
- edit an applied migration (`001`/`002`/`003`) and expect it to re-run,
- run multiple app processes against one PGlite directory,
- restore over live data without a verified pre-restore backup.

---

## 2. Current verification status

| Check | Command | Status |
|---|---|---|
| Types | `npx tsc --noEmit` | **TESTED-PASS**, exit 0 |
| Unit/integration | `npm test` | **TESTED-PASS**, 117/117, 15 files |
| Build | `npm run build` | **TESTED-PASS**, exit 0 |
| E2E (live demo) | `npm run test:e2e` | **TESTED-PASS**, 6/6 |
| E2E (restored DB) | `E2E_BASE_URL=… npm run test:e2e` | **TESTED-PASS**, 6/6 |
| Backup/restore drill | `db:backup` → `db:verify-backup` → `db:restore` → `verify-restored` | **TESTED-PASS** |
| MFA browser flow | disposable DB + `MFA_ENFORCE=true` | **TESTED-PASS** |
| Managed PostgreSQL | — | **BLOCKED** |
| Nepali/scanned PDF OCR | — | **BLOCKED** |

Current demo DB: **12 claims (all synthetic), 10 payments, 9 documents (10 files, 1 orphan), 19 balanced journal entries / 39 lines, 6 bank lines, 69 audit events, 0 closed periods**. The E2E runs added synthetic claims/payments; the earlier seed state is preserved in verified backups.

---

## 3. Commands

```bash
# setup
npm ci
npm run db:migrate

# real workspace
npm run db:create-admin -- --email=finance@org.org --name="Finance Manager"
npm run build && MFA_ENFORCE=true NODE_ENV=production npm start

# demo
npm run db:seed-demo
npm run dev

# verification
npx tsc --noEmit
npm test
npm run build
npm run test:e2e

# backup
npm run db:backup -- --out /secure/finance-tracker-backup
npm run db:verify-backup -- --from /secure/finance-tracker-backup

# disposable restore
SCRATCH=$(mktemp -d /tmp/finance-tracker-restore.XXXXXX)
npm run db:restore -- --from /secure/finance-tracker-backup \
  --database-dir "$SCRATCH/pglite" --document-dir "$SCRATCH/documents"
npx tsx scripts/verify-restored.ts \
  --database-dir "$SCRATCH/pglite" --document-dir "$SCRATCH/documents" \
  --from /secure/finance-tracker-backup
```

Stop the dev server before backup/restore/reset/seed. E2E starts its own server unless `E2E_BASE_URL` is set.

---

## 4. Where things live

| Concern | File |
|---|---|
| Schema, triggers, reference data | `db/migrations/001_init.sql`, `002_reference.sql`, `003_operational_hardening.sql` |
| DB connection, migrations, helpers | `src/server/db.ts` |
| Auth, sessions, lockout | `src/server/auth.ts`, `src/server/password.ts` |
| MFA | `src/server/mfa.ts`, `src/app/actions/auth.ts`, `src/app/(auth)/mfa-setup/page.tsx` |
| Durable rate limit | `src/server/rate-limit.ts` |
| Period lock | `src/server/periods.ts`, `src/app/actions/settings.ts` |
| Page guard | `src/server/page-auth.ts` |
| Permissions | `src/lib/permissions.ts`, DB `role_permissions` |
| Claims/approvals/payments | `src/server/expenses.ts` |
| Payment reversal | `src/server/corrections.ts` |
| Advances | `src/server/advances.ts` |
| Sponsors | `src/server/sponsors.ts` |
| Budgets | `src/server/budgets.ts` |
| Accounts, statements, reconciliation | `src/server/accounts.ts` |
| Journal | `src/server/journal.ts` |
| Documents/storage/OCR | `src/server/documents.ts`, `storage.ts`, `ocr.ts` |
| Reports/exports | `src/server/reports.ts`, `exports.ts`, `src/lib/csv.ts` |
| Server actions | `src/app/actions/*.ts` |
| Pages | `src/app/(app)/**`, `src/app/(auth)/**` |
| API routes | `src/app/api/documents/[id]`, `src/app/api/export/[type]` |
| Demo seed/reset | `scripts/seed-demo.ts`, `scripts/reset-demo.ts` |
| Backup/restore | `scripts/lib/backup.ts`, `scripts/backup.ts`, `scripts/verify-backup.ts`, `scripts/restore-backup.ts`, `scripts/verify-restored.ts` |
| Tests | `tests/*.test.ts`, `tests/e2e/smoke.spec.ts` |
| Docs | `docs/` |

---

## 5. Non-obvious behaviour / gotchas

1. **Transactions.** `postJournal` must run inside an existing transaction and use its `tx` executor. Using the outer `db` inside `db.transaction` deadlocks PGlite.
2. **Period guard.** `postJournal` calls `assertDateOpen`; `periods.ts` must not import `journal.ts` (circular dependency).
3. **Next 16 async APIs.** `cookies()`, `headers()`, `params`, and `searchParams` are async. `redirect()` throws; do not catch it as an error.
4. **Server action exports.** `"use server"` files may only export async functions. Helpers live in `src/server/action-utils.ts`.
5. **Migrations.** Applied files are recorded in `schema_migrations` and never re-run. For a disposable local DB after editing `001`, `rm -rf .data/pglite && npm run db:migrate`.
6. **PGlite bigints.** Aggregates return strings/numbers inconsistently; normalise with `money()` before display or arithmetic.
7. **Claim statuses.** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PAYMENT_PENDING → REIMBURSED/SETTLED → VERIFIED → RECONCILED`; terminal states cannot be left (trigger).
8. **Approval thresholds** are paisa: standard 200,000; executive 2,500,000; committee 10,000,000; second approval above 500,000. Above standard requires finance + executive; above committee requires a committee reference.
9. **Funding accounting.** Personal → `2000 Member reimbursements payable`; organisation → `2100 Expense clearing`; advance-funded → `1100 Advances receivable`.
10. **Opening balances** post to `3100 Opening balance equity` and are only allowed before movements.
11. **Reconciliation.** Statement lines never create payments. Matching a `VERIFIED` claim’s payment moves it to `RECONCILED`.
12. **Fiscal year.** `budgets.fiscal_year` is BS (`2083/84`), derived via `fiscalYearBsFor(iso)`.
13. **Period close.** `closePeriod` rejects closing if DRAFT journal entries exist; pending claims are recorded in audit but do not block close. Reopen is authorized and audited.
14. **Payment reversal.** `reversePayment` creates a linked equal-and-opposite payment/journal, marks the original `VOID`, and recomputes claim status. Reversal rows are excluded from cashflow/paid aggregates. `ADVANCE_*` reversals are intentionally unsupported.
15. **MFA.** `MFA_ENFORCE=true` enforces ADMIN/FINANCE/EXECUTIVE. Demo users have no MFA by default. `requireUser` throws `MFA_PENDING` or `MFA_ENROLLMENT_REQUIRED`; `fail()` maps them to user messages. A sole admin cannot reset their own MFA; use recovery codes or a dual-control break-glass procedure.
16. **MFA setup page.** `/mfa-setup` generates and stores a secret on first view. Recovery codes are shown once in a client component that intentionally does **not** refresh the page; navigate away only after saving them.
17. **CSP.** Static CSP is enforced; `unsafe-inline` remains for Next.js inline bootstrap/styles. A nonce-based CSP is future work.
18. **Backup consistency.** Stop the app before backup. Restore revokes all sessions. The verifier reports orphan files and never deletes them.
19. **Demo provenance.** `is_synthetic` propagates from the user; seed/reset refuse to mix synthetic and real data.
20. **Forced password change.** Admin-created/reset accounts have `must_change_password`; the app layout redirects to `/change-password`, which is outside the app layout. Changing revokes other sessions.
21. **Denied pages** redirect to `/no-access`, not a 500.
22. **E2E credentials** are read from `.data/demo-credentials.txt`; never print the password.
23. **Playwright** uses `channel: "chrome"` (system Chrome). Install Chrome or change the channel.
24. **OCR capability** is detected at runtime. This machine has `eng`, `osd`, `snum`; no `nep`; no `pdftotext`/rasteriser.
25. **PGlite** is single-process; do not run `npm run dev` and `npm start` against the same `.data` simultaneously.
26. **`.data/demo-credentials.txt`** is mode 0600 and gitignored; delete it when demo is finished.
27. **`AGENTS.md`** is generated by `next dev`; it is committed to keep the tree clean.
28. **Backups** live outside the repo (`/Users/ashim/finance-tracker-backups/...`); `backups/` is gitignored.

---

## 6. Open product decisions

1. **Negative balances:** block, warn, or allow with override? (P1-8)
2. **Sponsor over-receipt:** reclassify, flag, or leave as-is? (BUG-005)
3. **Approval thresholds and second-approval amount:** confirm with the FINANCE TRACKER committee; current values are defaults.
4. **Compliance status:** FINANCE TRACKER legal/tax status is `UNVERIFIED`; confirm PAN/VAT with a Nepali accountant before enabling tax fields.
5. **Retention:** how long to keep receipts and audit records; legal hold requirements.
6. **Historical data:** whether to import prior claims/sponsors, and from what source (nothing stable was supplied).
7. **Sole-admin MFA break-glass:** dual-control CLI procedure and documentation.

---

## 7. Next task

**P0-1: migrate to managed PostgreSQL**, then complete the provider-level PITR/restore drill. The local backup/restore core is now tested, but the database is still single-process and filesystem-bound.

If real receipts must be processed before that migration, do **P0-3/P0-4 (Nepali + scanned-PDF OCR)** first, but keep the deployment single-instance and backed up until P0-1 is done.

Detailed acceptance criteria are in `TASK_QUEUE.md`; the migration design is in `POSTGRESQL_MIGRATION_PLAN.md`.

---

## 8. Definition of done for the next session

- [ ] `pg` adapter merged; migrations run against a disposable PostgreSQL database.
- [ ] All 117 tests pass against PostgreSQL; E2E passes.
- [ ] Provider-level backup/PITR restore drill completed and recorded.
- [ ] `docs/TEST_RESULTS.md`, `CURRENT_PROJECT_STATE.md`, and `CHANGELOG.md` updated with the new results.
- [ ] No secrets, `.data`, or backups committed.
- [ ] A new commit with a clear message; baseline `5fec879` preserved.

---

## 9. Final note

The most valuable thing this system does is **refuse to invent numbers**. Keep that property: if a record cannot be traced to evidence or an explicit declaration, it stays unverified and visible. Do not “clean up” synthetic tags, missing-document warnings, orphan files, or unmatched bank lines to make a demo look better.
