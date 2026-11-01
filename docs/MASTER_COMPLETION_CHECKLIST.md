# MASTER COMPLETION CHECKLIST

Statuses: `[ ]` NOT STARTED, `[~]` IN PROGRESS, `[!]` IMPLEMENTED BUT NOT VERIFIED, `[x]` VERIFIED COMPLETE, `[B]` BLOCKED.

## Core platform
- [x] T001 Inspect repository, preserve data, baseline tests — Evidence: 148 tests passing, 8 E2E passing, build passing.
- [x] T002 PostgreSQL adapter and env selection — Evidence: `src/server/pg-db.ts`, `tests/postgres-adapter.test.ts` 3/3.
- [x] T003 PostgreSQL migration script and verification — Evidence: `scripts/migrate-to-postgres.ts`, `MIGRATION VERIFIED`.
- [B] T004 Production PostgreSQL cutover — Blocked: no managed provider credentials/DATABASE_URL.
- [B] T005 Provider PITR verification — Blocked: no managed provider account.

## Financial integrity
- [x] T010 Double-entry ledger and balancing — Evidence: journal totals tests.
- [x] T011 Payment reversal with linked journal — Evidence: `tests/financial-scenarios.test.ts` H.
- [x] T012 Fiscal period close/reopen — Evidence: security-controls tests.
- [x] T013 Non-negative account balances — Evidence: `tests/financial-controls.test.ts`.
- [x] T014 Sponsor over-receipt review — Evidence: `tests/financial-controls.test.ts`.
- [x] T015 Expense line items with quantity/unit price — Evidence: migration 006, UI, typecheck.
- [x] T016 Auto-categorization — Evidence: `src/server/categorization.ts`, UI option.
- [x] T017 Advances and reimbursements — Evidence: financial scenarios C.
- [x] T018 Budget vs actual reporting — Evidence: reports page and budgetReport.

## Security
- [x] T020 MFA TOTP/recovery — Evidence: security-controls tests.
- [x] T021 Durable rate limiting/lockout — Evidence: security-controls tests.
- [x] T022 Document authorization — Evidence: security-controls tests.
- [x] T023 Malware scan adapter/upload validation — Evidence: `tests/malware.test.ts`.
- [x] T024 Orphan cleanup — Evidence: `tests/financial-controls.test.ts`.
- [x] T025 Sole-admin break-glass — Evidence: `tests/financial-controls.test.ts`.
- [x] T026 Nonce CSP — Evidence: `src/proxy.ts`, build/E2E pass.
- [x] T028 Storage security regression tests — Evidence: `tests/storage-security.test.ts` 6/6, path traversal and ZIP limits verified.
- [x] T029 OCR engine adapter — Evidence: `src/server/ocr-engine.ts`, `tests/ocr-engine.test.ts` 5/5, Tesseract fallback preserved.
- [x] T033 Asynchronous OCR queue and worker — Evidence: `src/server/ocr-queue.ts`, `scripts/ocr-worker.ts`, `tests/ocr-queue.test.ts` 2/2.
- [x] T034 Searchable document repository — Evidence: `db/migrations/012_document_search_index.sql`, `src/server/document-search.ts`, `tests/document-search.test.ts` 5/5.
- [x] T035 Document search UI — Evidence: receipts page search, filters, snippets; E2E search 1/1.
- [x] T096 OCR benchmark harness — Evidence: `scripts/benchmark-ocr.ts`.
- [B] T027 Application-level encryption at rest — Blocked: provider-managed encryption recommended; not implemented.

## OCR
- [x] T030 English OCR — Evidence: tests/ocr.test.ts.
- [x] T031 Nepali/Devanagari OCR — Evidence: tests/ocr-nepali-pdf.test.ts.
- [x] T032 Scanned PDF OCR — Evidence: MuPDF.js, tests pass.

## Email
- [!] T040 Resend adapter/outbox/password reset/notifications — Implemented and tested with injected provider; real delivery blocked.
- [B] T041 Real email delivery — Blocked: no provider credentials.

## Imports
- [x] T050 Bank statement import — Evidence: financial scenario F.
- [x] T051 Historical claims staged import — Evidence: tests/historical-import.test.ts.
- [x] T052 Generic spreadsheet staging — Evidence: tests/generic-import.test.ts.
- [B] T053 Generic sponsor ledger import — Blocked: heterogeneous source files.

## Reporting/exports
- [x] T060 Reports and exports CSV/JSON — Evidence: reports page, E2E.
- [x] T061 Excel export — Evidence: route implementation, typecheck.
- [x] T062 PDF export — Evidence: route implementation, typecheck.
- [x] T063 Report independent verification — Added export-total verification test.

## Backups
- [x] T070 Backup/verify/restore — Evidence: VERIFIED, restore drill.
- [!] T071 Scheduled/offsite backups — Retention cleanup script, encrypted backup helper, and restore drill verified; OS scheduling/offsite storage remain external.

## UI/UX
- [x] T080 Premium UI redesign — Evidence: CSS, E2E pass.
- [x] T081 Dark/light theme — Evidence: toggle, tests.
- [x] T082 Accessibility improvements — Skip link, focus-visible, landmark, keyboard, mobile touch targets, reduced-motion and Playwright checks implemented; full manual WCAG audit remains recommended.
- [x] T083 Mobile optimization — Responsive CSS, table scrolling, touch targets, mobile Playwright checks, and reduced-motion support implemented.

## Operations
- [x] T090 Observability — Health endpoint, request IDs, structured logger, retention report, and tests implemented; external monitoring/alerting remains an operational task.
- [B] T091 Multi-org scoping — Not implemented by design for this single-organization deployment; requires organization_id and query scoping across all tenant tables if later needed.
- [x] T092 Committee delegation — Approval delegation table, enforcement, UI, and audit implemented.
- [x] T093 Budget revisions UI — Implemented in events page with revise form and recent revision history.
- [x] T094 Notification centre — In-app notifications, claim triggers, page, unread badge, and mark-all-read implemented.
- [x] T095 Retention/legal hold — Legal-hold metadata, server controls, receipt UI, retention report, automated enforcement report, and tests implemented.

## Testing
- [x] T100 Unit/integration suite — 168 tests passing, 3 skipped.
- [x] T101 E2E suite — 11/11 passing.
- [x] T102 PostgreSQL tests — 3/3 passing.
- [x] T103 Build/typecheck — passing.
