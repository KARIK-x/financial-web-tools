# TASK QUEUE

Prioritised remaining work. **P0** blocks a real production deployment; **P1** is needed for full operational use; **P2** is improvement/polish. Each task has an acceptance test so “done” is unambiguous.

Status labels: **IMPLEMENTED**, **TESTED-PASS**, **TESTED-FAIL**, **NOT-TESTED**, **BLOCKED**.

---

## P0 — before real money is entered

### P0-1. Migrate from PGlite to managed PostgreSQL
**Status: BLOCKED (production execution) / IMPLEMENTED AND TESTED (local adapter + migration)**
**Why:** PGlite is single-process and filesystem-bound; it cannot run behind multiple app instances or on serverless.
**Done so far:**
- Wrote `docs/POSTGRESQL_MIGRATION_PLAN.md` with schema compatibility, adapter design, cutover sequence, verification queries, rollback, and acceptance criteria.
- Confirmed the migrations are ordinary PostgreSQL SQL with no extensions or PGlite-only syntax.
- Confirmed 39 public tables and three applied migrations.
**Remaining:**
- Add a `pg` adapter behind the existing `Db`/`Executor` interface.
- Support `DATABASE_URL`, pooling, TLS, and migration advisory locks.
- Run the same migrations against a disposable PostgreSQL database.
- Load data logically; compare row counts, deterministic hashes, and financial invariants.
**Blocked by:** no PostgreSQL server/client, no `DATABASE_URL`, no provider/TLS credentials, Docker daemon unavailable.
**Accept:** app runs against managed PostgreSQL; all 117 tests pass against it; E2E passes; no PGlite import in production paths; restore/PITR drill recorded.

### P0-2. Automated, tested backups
**Status: IMPLEMENTED / TESTED-PASS (core); NOT-TESTED (scheduling/offsite)**
**Done:**
- `scripts/lib/backup.ts` creates database + documents + `SHA256SUMS` + `manifest.json` + git commit + timestamp.
- `scripts/backup.ts`, `verify-backup.ts`, `restore-backup.ts`, `verify-restored.ts`.
- `npm run db:backup`, `db:verify-backup`, `db:restore`.
- Restore revokes all sessions by default.
- Genuine drill: backup → verify → restore to disposable target → `RESTORED DATABASE VERIFIED` → E2E 6/6.
- Automated test: `tests/backup-restore.test.ts`.
**Remaining:** scheduler, encrypted off-device storage, retention policy, quarterly drill checklist.
**Accept:** restore into a scratch environment reproduces trial balance and document downloads; drill recorded with date and operator.

### P0-3. Nepali OCR
**Status: IMPLEMENTED / TESTED-PASS**
**Why:** receipts and invoices are commonly in Devanagari; English-only OCR forces manual re-keying.
**Blocked by:** Tesseract has only `eng`, `osd`, `snum`; no `nep` traineddata.
**Do:** install `tesseract-ocr-nep`/`tessdata` `nep`, detect language per document, store language/confidence, add fixtures.
**Accept:** a synthetic Nepali receipt extracts merchant/total with usable confidence; failure falls back to manual entry; capability banner reports Nepali as available.

### P0-4. Scanned-PDF OCR
**Status: IMPLEMENTED / TESTED-PASS**
**Why:** many receipts arrive as scans/photos inside PDFs with no text layer.
**Blocked by:** no `pdftoppm`/`pdftotext`/PDF rasteriser installed.
**Do:** rasterise pages at bounded DPI, OCR each page, cap page count/size, clean temp files.
**Accept:** a scanned PDF produces candidates; oversized PDFs are rejected clearly; no temp files leak.

### P0-5. MFA for privileged roles
**Status: IMPLEMENTED / TESTED-PASS**
**Done:**
- RFC 6238 TOTP with replay-step tracking.
- Ten hashed single-use recovery codes.
- `/mfa-setup` enrollment page; secret shown once; recovery codes shown once.
- `MFA_ENFORCE=true` enforces enrollment for ADMIN/FINANCE/EXECUTIVE.
- Login accepts TOTP or recovery code; invalid/replayed codes increment failed-login counters.
- Admin reset revokes the target's sessions and clears the secret.
- Unit tests + disposable-browser flow (`MFA_E2E_PASS`).
**Remaining:** set `MFA_ENFORCE=true` in production; document an admin-recovery procedure if the last admin loses both authenticator and recovery codes.
**Accept:** elevated login requires a valid TOTP; replay rejected; recovery codes single-use; disable/reset audited.

### P0-6. Durable rate limiting and lockout
**Status: IMPLEMENTED / TESTED-PASS**
**Done:**
- `rate_limits` table; durable fixed-window limiter in `src/server/rate-limit.ts`.
- 12 attempts / 15 minutes per email+IP; survives restart.
- Persistent account lockout: 8 failures in 15 minutes sets `users.locked_until`.
- Tests cover restart persistence and lockout boundary.
**Remaining:** alerting on spikes; consider progressive delay for distributed attacks.
**Accept:** restarting the app does not reset the window; lockout expires automatically; tests cover the boundary.

### P0-7. Content-Security-Policy and header review
**Status: IMPLEMENTED / TESTED-PASS (static CSP); NOT-TESTED (nonce CSP)**
**Done:**
- CSP enforced on HTML responses in `next.config.ts`.
- Production `curl` confirmed `Content-Security-Policy` header.
- Document responses keep a sandbox CSP.
- Core E2E flows pass with CSP.
**Remaining:** nonce/hash-based CSP to remove `unsafe-inline` for scripts/styles; report-only rollout first.
**Accept:** CSP enforced; no console violations on core flows; document preview still works.

### P0-8. Production email and password reset
**Status: IMPLEMENTED / TESTED-PASS (adapter) / BLOCKED (delivery)**
**Why:** admins currently reset passwords manually; there is no notification channel.
**Blocked by:** no SMTP/provider credentials or reset-token implementation.
**Do:** SMTP/provider integration, verified sender, reset tokens (single-use, short TTL, hashed at rest), approval/payment notifications.
**Accept:** reset email works end-to-end; token reuse fails; notifications are queued/retried; no secrets in logs.

---

## P1 — operational completeness

### P1-1. Historical claims and sponsor ledger import
**Status: IMPLEMENTED / TESTED-PASS (claims and generic CSV) / BLOCKED (sponsor ledger)**
**Why:** real adoption requires bringing prior records in without fabricating them.
**Finding:** supplied sponsor workbooks are heterogeneous planning/contact sheets (for example 1,005 rows × 26 columns with free-text status/amount), not a stable ledger. The app deliberately has no generic spreadsheet importer.
**Do:** a staged importer (`import_batches`/`import_rows`) with column mapping, dry-run preview, per-row validation, duplicate detection, provenance `HISTORICAL_IMPORT`, and a reconciliation report. Never auto-approve imported claims.
**Accept:** a redacted historical file imports with a dry-run diff; rejects are explainable; imported rows are visibly marked and excluded from “verified” counts until reviewed.

### P1-2. Fiscal period close and lock
**Status: IMPLEMENTED / TESTED-PASS**
**Done:** `accounting_periods`, close/reopen actions, audit events, `postJournal`/expense/payment guards, settings UI, tests.
**Remaining:** period-close checklist UI polish; pending claims are audited but do not block close.
**Accept:** a locked period rejects new claims/payments; an authorised reopen is audited.

### P1-3. Committee/approval delegation model
**Status: NOT-TESTED**
**Why:** committee reference is free text; delegations are implicit.
**Do:** committee entity, membership dates, delegated approver with expiry, quorum rules.
**Accept:** approvals record the committee/delegate; expired delegation cannot approve; reports show quorum.

### P1-4. Budget revisions UI and history
**Status: NOT-TESTED** (table exists)
**Do:** revise a budget with reason, show a timeline, compare versions, require approval for increases.
**Accept:** each revision is listed with before/after; totals reconcile; revision audited.

### P1-5. Notification centre
**Status: NOT-TESTED**
**Do:** in-app notifications for submitted/approved/paid/verified/missing-document/reconciled; email digest; mark read.
**Accept:** events create notifications for the right roles; no duplicate spam; links resolve.

### P1-6. Multi-organisation scoping
**Status: NOT-TESTED**
**Why:** `organizations` exists but queries are not scoped.
**Do:** `org_id` on tenant tables, session-selected org, row-level filters, migration plan, admin UI.
**Accept:** two orgs cannot see each other’s data in any list, report, export, or document download.

### P1-7. Retention and legal hold
**Status: NOT-TESTED**
**Do:** retention policy per document type, legal hold flag, secure deletion workflow that respects immutability, export-before-delete.
**Accept:** held records cannot be deleted; expired records follow an audited workflow.

### P1-8. Negative-balance policy
**Status: IMPLEMENTED / TESTED-PASS**
**Why:** cash/bank can currently go negative without a hard block.
**Do:** decide policy (block, warn, or require override), implement consistently for payments/transfers, show projected balance before posting.
**Accept:** the chosen policy is enforced server-side and covered by tests; override (if any) is audited.

### P1-9. Accessibility and keyboard audit
**Status: NOT-TESTED**
**Do:** WCAG 2.2 AA review of forms, tables, dialogs, focus order, labels, contrast, error announcements.
**Accept:** automated axe scan clean on core pages; manual keyboard-only run of claim creation and approval.

### P1-10. Observability
**Status: NOT-TESTED**
**Do:** structured logs with request IDs (no PII/secrets), error tracking, slow-query logging, backup/restore alerts, disk-space alerts.
**Accept:** a failed payment can be traced from request to audit event without exposing sensitive data.

### P1-11. Orphan-upload cleanup
**Status: IMPLEMENTED / TESTED-PASS**
**Finding:** one orphan document file has no DB row. It is preserved and reported.
**Do:** make `uploadOne` clean up the newly written file if the DB insert fails; add a read-only orphan report command that never auto-deletes.
**Accept:** a failed upload leaves no new orphan; the report lists existing orphans with size/hash and requires explicit human deletion.

---

## P2 — improvements

| ID | Task | Acceptance |
|---|---|---|
| P2-1 | Nepali UI / i18n | Language toggle; all labels translated; dates remain BS/AD correct |
| P2-2 | Saved filters and bulk actions | Persist filter sets; bulk verify/ignore with audit |
| P2-3 | Streaming exports beyond 20k | Cursor-based CSV streaming; no memory blow-up |
| P2-4 | Audit hash chain | Each event links to the previous hash; verification command |
| P2-5 | Sponsor/event P&L reports | Income vs direct spend per sponsor/event |
| P2-6 | Receipt line items | Item-level OCR and category suggestion |
| P2-7 | PWA/offline capture | Draft claims queued offline, synced with conflict handling |
| P2-8 | API tokens for integrations | Scoped, expiring tokens; audit per call |
| P2-9 | Dependency and container scanning | CI job with SBOM and vulnerability gate |
| P2-10 | Seed/demo data generator | Configurable volume for performance testing |
| P2-11 | Nonce-based CSP | Remove `unsafe-inline`; report-only rollout first |

---

## Completed (for context)

- Schema, migrations (`001`–`003`), integrity triggers, 39 tables.
- Auth, RBAC, sessions, forced password change.
- MFA (TOTP + recovery codes), durable rate limiting, persistent lockout.
- Fiscal period close/reopen.
- Claims, approvals, payments, advances, sponsors, budgets.
- Payment reversal/correction workflow.
- Documents, dedupe, OCR candidates, review, centralized access control.
- Statement import, matching, reconciliation.
- Journal, reports, exports, audit.
- Backup/verify/restore scripts and a genuine restore drill.
- 117 unit/integration tests across 15 files; 6 E2E tests; clean typecheck/build.
- Documentation set, including `FORENSIC_VERIFICATION.md` and `POSTGRESQL_MIGRATION_PLAN.md`.

---

## Recommended next task

**P0-1 (managed PostgreSQL) followed by the provider-level PITR/restore drill.** The data store is now backed up and restorable, but it is still single-process and local. Everything else can be layered on once the database is durable and recoverable.

If LOCUS needs to process real receipts before that migration, do **P0-3/P0-4** first so manual re-keying does not become the bottleneck — but keep the deployment single-instance and backed up until P0-1 is done.
