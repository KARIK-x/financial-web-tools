# Finance Tracker Intelligence Platform

A double-entry finance system for FINANCE TRACKER, IOE Pulchowk Campus: expense claims, approvals, payments, advances, sponsorships, budgets, receipts, bank reconciliation, reports, and an append-only audit trail.

> **Data honesty:** the supplied research material contained no usable FINANCE TRACKER ledger. This repository ships a **synthetic demo dataset** for evaluation. It is not a reconstruction of real Finance Tracker finances. Every demo row is marked synthetic.

## Quick start (demo)

```bash
npm ci
npm run db:migrate
npm run db:seed-demo
npm run dev
```

Open `http://localhost:3000`. Demo accounts are listed in `.data/demo-credentials.txt` (mode 0600); the shared password is deliberately not printed or committed.

## Real workspace

```bash
npm ci
npm run db:migrate
npm run db:create-admin -- --email=finance@your-org.org --name="Finance Manager"
npm run build
NODE_ENV=production npm start
```

Sign in with the generated password (written to `.data/initial-admin-credentials.txt`), set a new password when prompted, then delete the file. See `docs/DEPLOYMENT_GUIDE.md`.

## Verify

```bash
npx tsc --noEmit
npm test          # 168 unit/integration tests
npm run build
npm run test:e2e  # 11 browser tests; needs demo data + Chrome
```

## Documentation

| Document | Contents |
|---|---|
| `docs/PROJECT_AUDIT.md` | What was supplied, what is real vs synthetic, coverage, risks |
| `docs/IMPLEMENTATION_DECISIONS.md` | Architecture decision records |
| `docs/CURRENT_PROJECT_STATE.md` | Verified status, dataset, stack, pages |
| `docs/CHANGELOG.md` | Release history |
| `docs/TASK_QUEUE.md` | Prioritised remaining work |
| `docs/TEST_RESULTS.md` | Exact test/build results |
| `docs/KNOWN_BUGS.md` | Defects and limitations, with workarounds |
| `docs/SECURITY_REVIEW.md` | Threat model, controls, findings |
| `docs/DATA_MODEL.md` | Tables, relationships, triggers |
| `docs/ACCOUNTING_RULES.md` | Chart of accounts, journal entries, lifecycle |
| `docs/IMPORT_FORMATS.md` | Statement import, OCR, exports |
| `docs/DEPLOYMENT_GUIDE.md` | Setup, environment, production notes |
| `docs/BACKUP_AND_RESTORE.md` | Backup and restore runbook |
| `docs/SESSION_HANDOFF.md` | State, gotchas, next task |
| `docs/FORENSIC_VERIFICATION.md` | Evidence-based verification and defect log |
| `docs/POSTGRESQL_MIGRATION_PLAN.md` | Managed PostgreSQL migration plan (execution blocked) |

## Stack

Next.js 16 · React 19 · TypeScript 5.9 (strict) · Tailwind 4 · PGlite (embedded PostgreSQL) · Zod · Vitest · Playwright.

## Important constraints

- **Single process only:** PGlite is an embedded database; do not run multiple replicas or serverless instances.
- **NPR only**, single organisation.
- **Nepali OCR and scanned-PDF OCR are not available** on this machine; manual entry is supported.
- **No email/notifications**; password resets are admin/CLI-driven.
- **MFA is available but not enforced by default**; set `MFA_ENFORCE=true` in production.
- **No managed PostgreSQL yet**; the PGlite deployment is single-process. See `docs/POSTGRESQL_MIGRATION_PLAN.md`.
- Back up `.data/pglite` and `.data/documents` together with the tested scripts, with the app stopped. See `docs/BACKUP_AND_RESTORE.md`.

## License / ownership

Internal project for FINANCE TRACKER, IOE Pulchowk Campus. No license was supplied; treat as private.
