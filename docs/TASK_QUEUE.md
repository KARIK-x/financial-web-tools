# TASK QUEUE

Prioritised remaining work. **P0** blocks a real production deployment; **P1** is needed for full operational use; **P2** is improvement/polish. Each task has an acceptance test so “done” is unambiguous.

---

## P0 — before real money is entered

### P0-1. Migrate from PGlite to managed PostgreSQL
**Why:** PGlite is single-process and filesystem-bound; it cannot run behind multiple app instances or on serverless.
**Do:**
- Add a `pg` connection adapter behind the existing `Db`/`Executor` interface.
- Support `DATABASE_URL`, connection pooling, and TLS.
- Run the same migrations (`001`, `002`, …) against the target.
- Replace PGlite-specific bigint handling where necessary; keep paisa as `BIGINT`.
- Document backup/PITR using the provider’s tooling.
**Accept:** app runs against managed Postgres; all 96 tests pass against a Postgres test database; E2E passes; no PGlite import in production paths.

### P0-2. Automated, tested backups
**Why:** the current procedure is manual; an untested backup is not a backup.
**Do:** scheduled snapshot/`pg_dump` + document sync, encrypted off-device, retention policy, restore runbook, quarterly restore drill with a checklist.
**Accept:** a restore into a scratch environment reproduces trial balance and document downloads; drill recorded with date and operator.

### P0-3. Nepali OCR
**Why:** receipts and invoices are commonly in Devanagari; English-only OCR forces manual re-keying.
**Do:** install `tesseract-ocr-nep` / `tessdata` `nep`, detect language per document (or let the reviewer choose), store the language and confidence, extend fixtures.
**Accept:** a synthetic Nepali receipt extracts merchant/total with usable confidence; failure falls back to manual entry; capability banner reports Nepali as available.

### P0-4. Scanned-PDF OCR
**Why:** many receipts arrive as scans/photos inside PDFs with no text layer.
**Do:** rasterise pages (Poppler `pdftoppm` or pdfjs render) at a bounded DPI, OCR each page, cap page count/size, clean up temp files.
**Accept:** a scanned PDF produces candidates; oversized PDFs are rejected with a clear message; no temp files leak.

### P0-5. MFA for privileged roles
**Why:** ADMIN/FINANCE/EXECUTIVE can move money; a password alone is insufficient.
**Do:** TOTP enrolment with recovery codes, enforced for elevated roles, audited, reset by ADMIN.
**Accept:** elevated login requires a valid TOTP; replay is rejected; recovery codes are single-use; disable/reset is audited.

### P0-6. Durable rate limiting and lockout
**Why:** the in-memory limiter resets on restart and is per process.
**Do:** store counters in Postgres/Redis; define account lockout after repeated failures; alert on spikes; avoid trivially locking out a known account (progressive delay or IP+account combination).
**Accept:** restarting the app does not reset the window; lockout expires automatically; tests cover the boundary.

### P0-7. Content-Security-Policy and header review
**Why:** HTML responses currently have security headers but no CSP.
**Do:** add a nonce/hash-based CSP compatible with Next.js inline styles/scripts; test login, forms, document preview, and exports; keep the document response sandbox CSP.
**Accept:** CSP enforced in report-only first, then blocking; no console violations on core flows; document preview still works.

### P0-8. Production email and password reset
**Why:** admins currently reset passwords manually; there is no notification channel.
**Do:** SMTP/provider integration, verified sender, reset tokens (single-use, short TTL, hashed at rest), approval/payment notifications, opt-out for non-security mail.
**Accept:** reset email works end-to-end; token reuse fails; notifications are queued/retried; no secrets in logs.

---

## P1 — operational completeness

### P1-1. Historical claims and sponsor ledger import
**Why:** real adoption requires bringing prior records in without fabricating them.
**Do:** a staged importer (`import_batches`/`import_rows`) with column mapping, dry-run preview, per-row validation, duplicate detection, provenance `HISTORICAL_IMPORT`, and a reconciliation report. Never auto-approve imported claims.
**Accept:** a redacted historical file imports with a dry-run diff; rejects are explainable; imported rows are visibly marked and excluded from “verified” counts until reviewed.

### P1-2. Fiscal period close and lock
**Why:** prevents back-dating after a period is reported.
**Do:** period table/state, lock date, block new entries before the lock (except explicit corrections), close checklist, audit event.
**Accept:** a locked period rejects new claims/payments; an authorised correction path exists and is audited.

### P1-3. Committee/approval delegation model
**Why:** committee reference is currently free text; delegations are implicit.
**Do:** committee entity, membership dates, delegated approver with expiry, quorum rules.
**Accept:** approvals record the committee/delegate; expired delegation cannot approve; reports show quorum.

### P1-4. Budget revisions UI and history
**Why:** `budget_revisions` exists but the UI is minimal.
**Do:** revise a budget with reason, show a timeline, compare versions, require approval for increases.
**Accept:** each revision is listed with before/after; totals reconcile; revision is audited.

### P1-5. Notification centre
**Why:** users need to know what is waiting on them.
**Do:** in-app notifications for submitted/approved/paid/verified/missing-document/reconciled; email digest; mark read.
**Accept:** events create notifications for the right roles; no duplicate spam; links resolve.

### P1-6. Multi-organisation scoping
**Why:** `organizations` exists but queries are not scoped.
**Do:** `org_id` on tenant tables, session-selected org, row-level filters, migration plan, admin UI.
**Accept:** two orgs cannot see each other’s data in any list, report, export, or document download.

### P1-7. Retention and legal hold
**Why:** receipts and audit records contain personal data and may need retention rules.
**Do:** retention policy per document type, legal hold flag, secure deletion workflow that respects immutability, export-before-delete.
**Accept:** held records cannot be deleted; expired records follow an audited workflow.

### P1-8. Negative-balance policy
**Why:** cash/bank can currently go negative without a hard block.
**Do:** decide policy (block, warn, or require override), implement consistently for payments/transfers, show projected balance before posting.
**Accept:** the chosen policy is enforced server-side and covered by tests; override (if any) is audited.

### P1-9. Accessibility and keyboard audit
**Why:** finance staff may use keyboards/screen readers.
**Do:** WCAG 2.2 AA review of forms, tables, dialogs, focus order, labels, contrast, error announcements.
**Accept:** automated axe scan clean on core pages; manual keyboard-only run of claim creation and approval.

### P1-10. Observability
**Why:** production incidents need evidence.
**Do:** structured logs with request IDs (no PII/secrets), error tracking, slow-query logging, backup/restore alerts, disk-space alerts.
**Accept:** a failed payment can be traced from request to audit event without exposing sensitive data.

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

---

## Completed (for context)

- Schema, migrations, integrity triggers.
- Auth, RBAC, sessions, forced password change.
- Claims, approvals, payments, advances, sponsors, budgets.
- Documents, dedupe, OCR candidates, review.
- Statement import, matching, reconciliation.
- Journal, reports, exports, audit.
- 96 unit/integration tests, 6 E2E tests, clean typecheck/build.
- Documentation set.

---

## Recommended next task

**P0-1 (managed PostgreSQL) followed immediately by P0-2 (automated, tested backups).** Everything else can be layered on once the data store is durable and recoverable. If LOCUS needs to process real receipts before that migration, do **P0-3/P0-4** first so manual re-keying does not become the bottleneck — but keep the deployment single-instance and backed up manually until P0-1/P0-2 are done.
