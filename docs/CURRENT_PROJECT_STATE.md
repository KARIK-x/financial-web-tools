# CURRENT PROJECT STATE

**As of:** 2026-10-24
**Location:** `/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION`
**Stage:** feature-complete single-organisation application; production hardening pending.

---

## 1. Summary

The LOCUS Finance Intelligence Platform is a working Next.js application backed by a real PostgreSQL-compatible database. It implements expense claims, approvals, payments, advances, sponsorships, budgets, documents/OCR review, bank statement reconciliation, double-entry accounting, reports, exports, RBAC, and an append-only audit trail.

It is **not** a reconstruction of LOCUS’s historical books. The supplied materials contained no usable organisational ledger; the app therefore starts empty and ships a synthetic demo dataset for evaluation.

---

## 2. Verified status

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **Pass** (exit 0) |
| Unit/integration | `npm test` | **96/96 pass**, 11 files, ~14 s |
| Production build | `npm run build` | **Pass** (exit 0, no warnings) |
| Browser E2E | `npm run test:e2e` | **6/6 pass**, ~20 s |
| Demo reset | `npm run db:reset-demo` | Pass (synthetic only) |
| Demo seed | `npm run db:seed-demo` | Pass |

The demo database was reset and reseeded **after** the last E2E run, so it is pristine.

---

## 3. Demo dataset (synthetic)

| Entity | Count |
|---|---|
| Users / members | 6 / 6 |
| Expense claims | 9 |
| Payments | 7 |
| Documents | 9 |
| Journal entries / lines | 13 / 27 (balanced, 58,855,000 paisa each side) |
| Bank statement lines | 6 (5 matched, 1 open) |
| Statement imports / reconciliations | 1 / 1 |
| Budgets / lines | 1 / 9 |
| Advances | 1 |
| Sponsors / agreements / deliverables | 3 / 3 / 5 |
| Vendors / events / departments | 9 / 2 / 2 |
| Expense categories | 12 |
| Audit events | 51 |

Demo users: `admin@`, `finance@`, `executive@`, `events@`, `member@`, `auditor@` `locus.demo`. The shared password is in `.data/demo-credentials.txt` (mode 0600). It is never printed.

---

## 4. What works

### Access and governance
- Sign-in with scrypt passwords; server-side sessions with hashed tokens.
- Six roles and 19 permissions, enforced on pages, server actions, and API routes.
- Denied page loads go to `/no-access`; denied actions return a form error.
- Admin-issued/reset passwords force a password change; changing it revokes other sessions.
- Role matrix editing (ADMIN row locked to prevent lockout).
- Append-only audit trail with actor, entity, before/after, IP, user agent.

### Spend
- Create claims with allocations across event/department, vendor, category, BS/AD date.
- Missing-receipt declaration workflow.
- Tiered approvals, self-approval blocked, committee reference, second approval.
- Partial payments, over-payment blocked, status transitions.
- Verification and dispute handling.
- Reimbursement vs organisation-funded vs advance-funded accounting.

### Documents
- Private upload, SHA-256 dedupe, perceptual near-duplicate flag.
- Authorised streaming download; immutable originals.
- OCR candidate extraction with human review (English/text PDFs only).

### Money
- Cash/bank/wallet accounts, transfers, opening balances.
- Advances with capped returns.
- Sponsorships with pledges, receipts, deliverables.
- Bank statement import (CSV/TXT/XLSX), duplicate skipping, match suggestions, reconciliation snapshots.
- Budgets by BS fiscal year with overspend alerts.

### Reporting
- Dashboard, category/event spend, cashflow, trial balance, budget, sponsor, documentation, monthly spend.
- 13 export datasets in CSV/JSON, formula-injection guarded, audited, capped at 20,000 rows.

---

## 5. Pages

```
/login  /setup  /change-password
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
| `docs/` | This documentation | committed |

---

## 8. Intentionally not built

- Nepali OCR (`nep` traineddata absent) and scanned-PDF OCR (no rasteriser).
- Bulk historical claims/sponsor ledger import.
- Email/notifications and self-service password reset by email.
- FX/multi-currency; multi-organisation; native mobile app.
- Multi-instance/serverless deployment (PGlite is single-process).

See `KNOWN_BUGS.md` and `TASK_QUEUE.md` for the full list and priorities.

---

## 9. Run it

```bash
cd "/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION"
npm ci
npm run db:migrate
npm run db:seed-demo     # evaluation only
npm run dev
```

Real workspace: `db:migrate` → `db:create-admin` → sign in → forced password change. See `DEPLOYMENT_GUIDE.md`.

---

## 10. Git state

- Baseline research commit: `5fec879` (original docs + archive preserved).
- Application, tests, and documentation are committed together after this state file was written.
- `.data/`, `.next/`, `node_modules/`, `test-results/`, and `*.tsbuildinfo` are ignored.

Check the current commit with `git log --oneline -3`.
