# CHANGELOG

All notable changes to the LOCUS Finance Intelligence Platform. Dates are AD (ISO). Money is NPR unless stated.

---

## [0.1.0] — 2026-10-24

First complete build: a single-organisation finance platform with real persistence, enforced double-entry accounting, RBAC, document custody, reconciliation, reporting, and tests.

### Added — foundations
- Next.js 16 App Router application with TypeScript strict mode and Tailwind.
- PGlite (embedded PostgreSQL) persistence with a SQL migration runner.
- 36-table schema: identity, spend, documents, sponsors, budgets, banking, ledger, governance, staging.
- Integer-paisa money model with BigInt parsing and NPR formatting.
- BS/AD date handling and BS fiscal-year derivation.
- Reference data: 12 expense categories, 19 permissions, 54 role-permission grants, default settings.

### Added — access and governance
- Scrypt password hashing, server-side sessions with hashed tokens, 12 h/30 d role-based TTLs.
- Six roles: ADMIN, FINANCE, EXECUTIVE, EVENT_HEAD, MEMBER, AUDITOR.
- Server-side authorisation on pages, actions, and API routes.
- `/no-access` page for denied navigation; no raw 500s.
- Forced password change for admin-issued/reset accounts; other sessions revoked on change.
- Append-only audit trail with before/after JSON, actor, IP, user agent.
- Admin role matrix with the ADMIN row locked to prevent lockout.

### Added — spend workflow
- Claim creation with multi-line allocations, vendors, events, departments, categories, BS/AD dates.
- Missing-receipt declaration and documentation states.
- Tiered approvals (standard/executive/committee), second approval, committee reference.
- Database-enforced separation of duties and no self-approval.
- Partial payments with over-payment protection.
- Verification and dispute handling.
- Advance lifecycle: disbursement, settlement through claims, capped returns.
- Sponsorships: pledges, receipts, deliverables, promised-vs-received reporting.

### Added — documents
- Private content-addressed storage (`.data/documents`) with SHA-256 dedupe.
- Perceptual near-duplicate detection (average hash) with human review.
- Authorised streaming download with sandbox CSP.
- OCR candidate extraction (Tesseract English; pdfjs text-layer PDFs) and correction workflow.
- Immutable originals; supersede instead of delete.

### Added — money and reporting
- Cash/bank/wallet accounts, internal transfers, opening balances to equity.
- CSV/TXT/XLSX bank statement import with header detection, date/amount parsing, fingerprint dedupe.
- Match suggestions, manual confirm/ignore, reconciliation snapshots.
- BS-fiscal-year budgets with committed/paid/outstanding/variance and overspend alerts.
- Dashboard, category/event spend, cashflow, trial balance, sponsor, budget, documentation, monthly spend.
- 13 export datasets in CSV/JSON, formula-injection guarded, audited, 20,000-row cap.

### Added — tooling and tests
- `db:migrate`, `db:create-admin`, `db:seed-demo`, `db:reset-demo`.
- Synthetic demo dataset with provenance and safe reset guards.
- 96 Vitest tests across 11 files using real migrations.
- 6 Playwright E2E tests using system Chrome.
- Full documentation set in `docs/`.

### Fixed during verification
- Claim decision transaction deadlock (outer `db` vs transaction executor).
- Statement parser misdetecting “Description” as a credit column.
- `parseMoney` silently dropping trailing shorthand text; added compound lakh/crore parsing.
- Statement re-import aborting on duplicate fingerprints; now skips and continues.
- Advance return allowed above outstanding; now capped.
- Advance views leaking PostgreSQL bigint strings; normalised to numbers.
- `paymentCandidatesForImport` placeholder mismatch causing a runtime type error.
- Budget overspend alerts ignoring a single over-budget line.
- Turbopack build-tracing warning from document storage.
- Login page hardcoded fiscal year; now computed.
- Reports page stray `<SourceTag />` text.
- Unauthorised page access throwing a 500; now redirects to `/no-access`.
- React warning from `encType` on function-action forms; removed.
- `must_change_password` was set but never enforced; forced-change flow added.

### Security
- HttpOnly, SameSite=Lax, Secure-in-production session cookie.
- Parameterised SQL throughout; React escaping; sandboxed document responses.
- Security headers: nosniff, frame deny, referrer policy, permissions policy.
- Login rate limiting (12 attempts / 15 min per email+IP, in memory).
- Password policy: ≥ 12 characters, letter + number, common-password rejection.
- CSV formula-injection protection.
- Demo/reset scripts refuse to mix synthetic and real data.

### Known limitations at release
- No Nepali OCR or scanned-PDF OCR on this machine.
- No bulk historical import.
- No email/notifications or email-based password reset.
- NPR only; single organisation; PGlite single-process.
- Cash balances can go negative; sponsor over-receipt allowed.
- In-memory rate limiting; no MFA; no application-level encryption at rest.

See `KNOWN_BUGS.md` and `TASK_QUEUE.md`.
