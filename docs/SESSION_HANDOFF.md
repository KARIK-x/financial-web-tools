# SESSION HANDOFF

**Date:** 2026-10-24
**Project:** LOCUS Finance Intelligence Platform
**Path:** `/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION`
**State:** working, tested, documented; single-organisation; production hardening pending.

---

## 1. Read this first

The application is complete for evaluation and controlled single-instance use. It is **not** a reconstruction of LOCUS’s real history: the supplied materials contained no organisational ledger. All demo figures are synthetic and marked as such.

Do not:
- import the personal eSewa statement or expose its holder/account details,
- seed demo data over real data (the scripts refuse, but do not force them),
- commit `.data/`, `.env`, credentials files, or exports,
- edit an applied migration (`001`/`002`) and expect it to re-run,
- run multiple app processes against one PGlite directory.

---

## 2. Current verification status

| Check | Command | Status |
|---|---|---|
| Types | `npx tsc --noEmit` | Pass |
| Unit/integration | `npm test` | 96/96, 11 files |
| Build | `npm run build` | Pass, no warnings |
| E2E | `npm run test:e2e` | 6/6 |
| Demo data | `npm run db:reset-demo && npm run db:seed-demo` | Pass, pristine |

Demo DB: 9 claims, 7 payments, 9 documents, 13 balanced journal entries, 5 matched + 1 open bank line, 51 audit events.

---

## 3. Commands

```bash
# setup
npm ci
npm run db:migrate

# real workspace
npm run db:create-admin -- --email=finance@org.org --name="Finance Manager"
npm run build && NODE_ENV=production npm start

# demo
npm run db:seed-demo
npm run dev

# verification
npx tsc --noEmit
npm test
npm run build
npm run db:reset-demo && npm run db:seed-demo
npm run test:e2e
npm run db:reset-demo && npm run db:seed-demo   # leave pristine
```

Stop the dev server before reset/seed. E2E starts its own server unless `E2E_BASE_URL` is set.

---

## 4. Where things live

| Concern | File |
|---|---|
| Schema, triggers, reference data | `db/migrations/001_init.sql`, `002_reference.sql` |
| DB connection, migrations, helpers | `src/server/db.ts` |
| Auth, sessions, rate limit | `src/server/auth.ts`, `src/server/password.ts` |
| Page guard | `src/server/page-auth.ts` |
| Permissions | `src/lib/permissions.ts`, DB `role_permissions` |
| Claims/approvals/payments | `src/server/expenses.ts` |
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
| Admin CLI | `scripts/create-admin.ts` |
| Tests | `tests/*.test.ts`, `tests/e2e/smoke.spec.ts` |
| Docs | `docs/` |

---

## 5. Non-obvious behaviour / gotchas

1. **Transactions.** `postJournal` must run inside an existing transaction and use its `tx` executor. Using the outer `db` inside `db.transaction` deadlocks PGlite.
2. **Next 16 async APIs.** `cookies()`, `headers()`, `params`, and `searchParams` are async. `redirect()` throws; do not catch it as an error.
3. **Server action exports.** `"use server"` files may only export async functions. Helpers live in `src/server/action-utils.ts`.
4. **Migrations.** Applied files are recorded in `schema_migrations` and never re-run. For a disposable local DB after editing `001`, `rm -rf .data/pglite && npm run db:migrate`.
5. **PGlite bigints.** Aggregates return strings/numbers inconsistently; normalise with `money()` before display or arithmetic.
6. **Claim statuses.** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PAYMENT_PENDING → REIMBURSED/SETTLED → VERIFIED → RECONCILED`; terminal states cannot be left (trigger).
7. **Approval thresholds** are paisa: standard 200,000; executive 2,500,000; committee 10,000,000; second approval above 500,000. Above standard requires finance + executive; above committee requires a committee reference.
8. **Funding accounting.** Personal → `2000 Member reimbursements payable`; organisation → `2100 Expense clearing`; advance-funded → `1100 Advances receivable`.
9. **Opening balances** post to `3100 Opening balance equity` and are only allowed before movements.
10. **Reconciliation.** Statement lines never create payments. Matching a `VERIFIED` claim’s payment moves it to `RECONCILED`.
11. **Fiscal year.** `budgets.fiscal_year` is BS (`2083/84`), derived via `fiscalYearBsFor(iso)`.
12. **Demo provenance.** `is_synthetic` propagates from the user; seed/reset refuse to mix synthetic and real data.
13. **Forced password change.** Admin-created/reset accounts have `must_change_password`; the app layout redirects to `/change-password`, which is outside the app layout. Changing revokes other sessions.
14. **Denied pages** redirect to `/no-access`, not a 500.
15. **E2E credentials** are read from `.data/demo-credentials.txt`; never print the password.
16. **Playwright** uses `channel: "chrome"` (system Chrome). Install Chrome or change the channel.
17. **OCR capability** is detected at runtime. This machine has `eng`, `osd`, `snum`; no `nep`; no `pdftotext`/rasteriser.
18. **PGlite** is single-process; do not run `npm run dev` and `npm start` against the same `.data` simultaneously.
19. **`.data/demo-credentials.txt`** is mode 0600 and gitignored; delete it when demo is finished.
20. **`AGENTS.md`** is generated by `next dev`; it is committed to keep the tree clean.

---

## 6. Open product decisions

1. **Negative balances:** block, warn, or allow with override? (P1-8)
2. **Sponsor over-receipt:** reclassify, flag, or leave as-is? (BUG-005)
3. **Approval thresholds and second-approval amount:** confirm with the LOCUS committee; current values are defaults.
4. **Compliance status:** LOCUS legal/tax status is `UNVERIFIED`; confirm PAN/VAT with a Nepali accountant before enabling tax fields.
5. **Retention:** how long to keep receipts and audit records; legal hold requirements.
6. **Historical data:** whether to import prior claims/sponsors, and from what source (nothing usable was supplied).

---

## 7. Next task

**P0-1: migrate to managed PostgreSQL**, then **P0-2: automated, tested backups**. This removes the single-process/filesystem constraint and makes the deployment recoverable. If real receipts must be processed before that, do **P0-3/P0-4 (Nepali + scanned-PDF OCR)** first, but keep the deployment single-instance and manually backed up.

Detailed acceptance criteria are in `TASK_QUEUE.md`.

---

## 8. Definition of done for the next session

- [ ] Managed Postgres adapter merged; migrations run against it.
- [ ] All 96 unit tests pass against Postgres; E2E passes.
- [ ] Backup + restore drill completed and recorded.
- [ ] `docs/TEST_RESULTS.md`, `CURRENT_PROJECT_STATE.md`, and `CHANGELOG.md` updated with the new results.
- [ ] No secrets or `.data` files committed.
- [ ] A new commit with a clear message; baseline `5fec879` preserved.

---

## 9. Final note

The most valuable thing this system does is **refuse to invent numbers**. Keep that property: if a record cannot be traced to evidence or an explicit declaration, it stays unverified and visible. Do not “clean up” synthetic tags, missing-document warnings, or unmatched bank lines to make a demo look better.
