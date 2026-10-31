# CURRENT PROJECT STATE

**As of:** 2026-10-24
**Location:** `/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION`
**Stage:** feature-complete single-organisation application; production hardening partially complete; managed PostgreSQL still blocked.

---

## 1. Summary

The Finance Tracker Intelligence Platform is a working Next.js application backed by a real PostgreSQL-compatible database (PGlite). It implements expense claims, approvals, payments, advances, sponsorships, budgets, documents/OCR review, bank statement reconciliation, double-entry accounting, reports, exports, RBAC, MFA, period locks, durable rate limiting, and an append-only audit trail.

It is **not** a reconstruction of FINANCE TRACKER’s historical books. The supplied materials contained no usable organisational ledger; all current financial rows are synthetic and marked as such.

---

## 2. Verified status

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **TESTED-PASS**, exit 0 |
| Unit/integration | `npm test` | **TESTED-PASS**, 117/117, 15 files, ~20 s |
| Production build | `npm run build` | **TESTED-PASS**, exit 0; `/mfa-setup` included |
| Browser E2E | `npm run test:e2e` | **TESTED-PASS**, 6/6, ~21 s |
| E2E against restored DB | `E2E_BASE_URL=… npm run test:e2e` | **TESTED-PASS**, 6/6 |
| Backup verify | `npm run db:verify-backup -- --from …` | **TESTED-PASS**, `VERIFIED` |
| Restore drill | `npm run db:restore …` + `verify-restored.ts` | **TESTED-PASS**, `RESTORED DATABASE VERIFIED` |
| MFA browser flow | disposable DB, `MFA_ENFORCE=true` | **TESTED-PASS**, enrollment + TOTP + recovery |
| CSP header | production `npm start` + `curl` | **TESTED-PASS**, enforced |
| Managed PostgreSQL | — | **BLOCKED**, no server/client/credentials |

The demo database was **not** reset after the final E2E runs. It contains the seed data plus the synthetic claims/payments created by E2E. That is intentional; the verified backups preserve the earlier states.

---

## 3. Current database (synthetic)

| Entity | Count |
|---|---|
| Users / members | 6 / 6 |
| Expense claims | 12 (12 synthetic) |
| Payments | 10 |
| Documents | 9 (10 files; 1 orphan preserved) |
| Journal entries / lines | 19 / 39 (balanced, 59,575,000 paisa each side) |
| Bank statement lines | 6 (5 matched, 1 open) |
| Statement imports / reconciliations | 1 / 1 |
| Budgets / lines | 1 / 9 |
| Advances | 1 |
| Sponsors / agreements / deliverables | 3 / 3 / 5 |
| Vendors / events / departments | 9 / 2 / 2 |
| Expense categories | 12 |
| Audit events | 69 |
| Accounting periods closed | 0 |
| Non-synthetic financial rows | **0** |

Migrations: `001_init.sql`, `002_reference.sql`, `003_operational_hardening.sql`. Public tables: **39**.

Demo users: `admin@`, `finance@`, `executive@`, `events@`, `member@`, `auditor@` `finance-tracker.demo`. The shared password is in `.data/demo-credentials.txt` (mode 0600). It is never printed.

---

## 4. What works

### Access and governance
- Sign-in with scrypt passwords; server-side sessions with hashed tokens.
- Six roles and 19 permissions, enforced on pages, server actions, and API routes.
- Denied page loads go to `/no-access`; denied actions return a form error.
- Admin-issued/reset passwords force a password change; changing it revokes other sessions.
- Role matrix editing (ADMIN row locked to prevent lockout).
- **MFA**: TOTP enrollment at `/mfa-setup`, replay rejection, ten hashed single-use recovery codes, admin reset with session revocation. `MFA_ENFORCE=true` enforces enrollment for ADMIN/FINANCE/EXECUTIVE; default is off for the synthetic demo.
- **Durable rate limiting**: `rate_limits` table, survives restart; 12 attempts / 15 minutes per email+IP.
- **Persistent lockout**: 8 failed sign-ins in 15 minutes sets `users.locked_until`.
- **Fiscal period close/reopen**: `accounting_periods`, audited close/reopen; journal, expense, and payment posting guard.
- Append-only audit trail with actor, entity, before/after, IP, user agent.
- **CSP** on HTML responses; document responses retain a sandbox CSP.

### Spend
- Create claims with allocations across event/department, vendor, category, BS/AD date.
- Missing-receipt declaration workflow.
- Tiered approvals, self-approval blocked, committee reference, second approval.
- Partial payments, over-payment blocked, status transitions.
- **Payment corrections** by linked equal-and-opposite reversal; original marked VOID; no deletion.
- Verification and dispute handling.
- Reimbursement vs organisation-funded vs advance-funded accounting.
- Advance-funded claim guards: cannot exceed outstanding advance; cannot be paid in cash; personal funding with an advance rejected.

### Documents
- Private upload, SHA-256 dedupe, perceptual near-duplicate flag.
- Central `canAccessDocument`; members only see their own uploads/claims, finance/admin see all.
- Authorised streaming download; immutable originals.
- OCR candidate extraction with human review (English images and text-layer PDFs only).
- Document attach/review authorization hardened; closed claims and cross-claim reattachment rejected.

### Money
- Cash/bank/wallet accounts, transfers, opening balances.
- Advances with capped returns.
- Sponsorships with pledges, receipts, deliverables.
- Bank statement import (CSV/TXT/XLSX), duplicate skipping, match suggestions, reconciliation snapshots.
- Budgets by BS fiscal year with overspend alerts.

### Reporting
- Dashboard, category/event spend, cashflow, trial balance, budget, sponsor, documentation, monthly spend.
- 13 export datasets in CSV/JSON, formula-injection guarded, audited, capped at 20,000 rows.
- Reversal payments excluded from cashflow/paid aggregates to avoid double counting.

### Operations
- Checksummed backup with manifest, database, documents, git commit, and restore verification.
- Restore into a disposable target; sessions revoked by default.
- Verified final drill: backup → verify → restore → verify → E2E 6/6.

---

## 5. Pages

```
/login  /setup  /change-password  /mfa-setup
/overview  /my-expenses  /expenses  /expenses/new  /expenses/[id]
/approvals  /receipts  /receipts/[id]
/advances  /advances/[id]  /sponsors  /sponsors/[id]
/accounts  /reconciliation  /events  /events/[id]
/members  /vendors  /reports  /analytics  /reconstruction
/audit  /import-export  /settings  /no-access
/api/documents/[id]  /api/export/[type]
```

---

## 6. Stack

| Layer | Choice |
|---|---|
| Runtime | Node v24.20.0 |
| Framework | Next.js 16.4.3 (App Router), React 19.3.1 |
| Language | TypeScript 5.9.3, `strict` |
| Styling | Tailwind CSS 4.3.3 + custom CSS |
| Database | PGlite 0.5.11 (embedded PostgreSQL), raw SQL, migrations |
| Validation | Zod 4.6.7 (selected boundaries) + explicit parsers |
| Dates | `nepali-date-converter` 3.4.0 |
| Documents | Sharp 0.34, pdfjs-dist 5.4, fflate 0.8, local Tesseract |
| Tests | Vitest 5.0.5, Playwright 1.64.1 (system Chrome) |

---

## 7. Data locations

| Path | Contents | Git |
|---|---|---|
| `.data/pglite` | Database | ignored |
| `.data/documents` | Private files | ignored |
| `.data/demo-credentials.txt` | Demo password (0600) | ignored |
| `.data/initial-admin-credentials.txt` | First-admin password, if generated | ignored |
| `db/migrations` | Schema history | committed |
| `docs/` | Documentation | committed |
| `/Users/ashim/finance-tracker-backups/*` | Verified local backups | outside repo |

---

## 8. Intentionally not built / blocked

- Managed PostgreSQL adapter and production deployment (**BLOCKED**: no server/client/credentials).
- Nepali OCR (`nep` traineddata absent) and scanned-PDF OCR (no rasteriser) (**BLOCKED**).
- Bulk historical claims/sponsor ledger import (**BLOCKED**: no stable source ledger; no generic importer).
- Email/notifications and self-service password reset by email (**BLOCKED**: no SMTP/provider).
- FX/multi-currency; multi-organisation; native mobile app.
- Multi-instance/serverless deployment (PGlite is single-process).
- Scheduled/offsite encrypted backups (scripts exist; no scheduler/remote storage).
- Audit hash chain, malware scanning, application-level encryption at rest.
- Negative-balance policy and sponsor over-receipt policy (deliberate open decisions).

See `KNOWN_BUGS.md`, `TASK_QUEUE.md`, and `POSTGRESQL_MIGRATION_PLAN.md`.

---

## 9. Run it

```bash
cd "/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION"
npm ci
npm run db:migrate
npm run db:seed-demo     # evaluation only
npm run dev
```

Real workspace: `db:migrate` → `db:create-admin` → sign in → forced password change. Production MFA: `MFA_ENFORCE=true NODE_ENV=production npm start`. See `DEPLOYMENT_GUIDE.md`.

Backup:

```bash
npm run db:backup -- --out /secure/finance-tracker-backup
npm run db:verify-backup -- --from /secure/finance-tracker-backup
```

Stop the app before backup/reset/seed.

---

## 10. Git state

- Baseline research commit: `5fec879`.
- Verification baseline: `f2a81d0`.
- The hardening changes are currently **uncommitted** in the working tree.
- `.data/`, `.next/`, `node_modules/`, `test-results/`, `playwright-report/`, `backups/`, and `*.tsbuildinfo` are ignored.

Check the current commit with `git log --oneline -3`.
