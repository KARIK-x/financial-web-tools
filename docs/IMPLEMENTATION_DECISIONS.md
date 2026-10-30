# IMPLEMENTATION DECISIONS

Architecture Decision Records for the LOCUS Finance platform. Each entry states the context, the decision, and the consequence. Decisions are dated 2026-10-24 unless noted.

---

## ADR-001 — Embedded PostgreSQL (PGlite) instead of a hosted database

**Context.** No PostgreSQL/Supabase credentials were available; the system still needed real SQL, constraints, and transactions rather than an in-memory mock.

**Decision.** Use PGlite 0.5.11, a WASM build of PostgreSQL, persisted to `.data/pglite`. All SQL is standard PostgreSQL and migrations are plain `.sql` files.

**Consequences.**
- Real ACID behaviour, triggers, `ANY($1::text[])`, window functions, and `timestamptz` work.
- Single-process, single-writer: unsuitable for serverless or multi-instance deployment.
- Moving to managed Postgres requires only a connection adapter and migration replay; no ORM rewrite.
- Documented as a production blocker in `SECURITY_REVIEW.md` and `DEPLOYMENT_GUIDE.md`.

---

## ADR-002 — Raw SQL with a migration runner, no ORM

**Context.** The financial domain depends on precise constraints, locking, and aggregate queries; an ORM would obscure them.

**Decision.** Hand-written SQL in `src/server/*.ts`, with `db/migrations/*.sql` applied in filename order and recorded in `schema_migrations`.

**Consequences.** Full control and reviewability; more verbose query code; no automatic type generation. Types are declared next to each query.

---

## ADR-003 — Money as integer paisa

**Context.** Floating-point money causes reconciliation drift.

**Decision.** Store `BIGINT` paisa (1 NPR = 100 paisa) in every table. Parse user input with `parseMoney` (BigInt-based, half-up at the third decimal). Format for display with `formatNPR` / `paisaToDecimal`.

**Consequences.** Exact arithmetic and sums. Exports emit **both** integer paisa and decimal NPR strings so downstream tools cannot misinterpret units. `MAX_PAISA` guards absurd values.

---

## ADR-004 — Double-entry journal posted by domain operations

**Context.** Reports must reconcile to the ledger, not to ad-hoc totals.

**Decision.** Every financial event posts a balanced journal entry inside the same database transaction as the business row: claim approval, payment, advance disbursement/return, sponsor receipt, transfer, opening balance. A DB trigger rejects unbalanced entries and mutations of posted lines.

**Consequences.** Trial balance always balances. Corrections require new entries, not edits. Some UI actions (e.g. approval) do more work than a single `UPDATE`.

---

## ADR-005 — Claim lifecycle with explicit states

**Decision.** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PAYMENT_PENDING → REIMBURSED | SETTLED → VERIFIED → RECONCILED`, plus `REJECTED`, `WITHDRAWN`, `DISPUTED`. Terminal states cannot be left (trigger).

**Consequences.** Clear audit semantics and safe retries. A claim cannot be “un-reconciled” without a correction record.

---

## ADR-006 — Tiered approvals with separation of duties

**Decision.** Thresholds in `settings.approval_thresholds` (paisa): standard 200,000; executive 2,500,000; committee 10,000,000.
- Up to standard: one finance/executive approval.
- Above standard: finance **and** executive.
- Above committee: finance + executive + committee reference.
- A claimant can never approve or verify their own claim (DB trigger).
- Above `documentation.secondApprovalAbove` (500,000) a second approval is required.

**Consequences.** Small expenses stay fast; large ones need multiple people. Thresholds are editable by ADMIN only.

---

## ADR-007 — Personal vs organisational funding determines the credit account

**Context.** Reimbursing a member and paying a vendor from LOCUS funds are economically different.

**Decision.**
- Personal funds (`reimbursement_required = true`): approval debits the expense category and credits **2000 Member reimbursements payable**; payment debits 2000 and credits cash/bank/wallet.
- Organisation funds: approval debits expense and credits **2100 Expense clearing**; payment debits 2100 and credits the funding account.
- Advance-funded: approval debits expense and credits **1100 Advances receivable**; the claim moves directly to `SETTLED`.

**Consequences.** Member payables are never overstated by vendor bills. Clearing nets to zero when payments are recorded.

---

## ADR-008 — Opening balances post to equity, once

**Decision.** Setting an opening balance is allowed only before any recorded movement on that account. It posts `Dr cash/bank/wallet / Cr 3100 Opening balance equity` and records the reason in the audit trail.

**Consequences.** History cannot be rewritten by editing an opening balance. Later adjustments must be explicit entries.

---

## ADR-009 — Private, content-addressed document storage

**Context.** Receipts contain personal and vendor data and must not be publicly served.

**Decision.** Files are written to `.data/documents/<hash[0:2]>/<hash[2:4]>/<sha256><ext>`, never under `public/`. Downloads go through `/api/documents/[id]` after an authorisation check. Exact duplicates are blocked by SHA-256 and the existing original is returned. A 64-bit average hash flags near-duplicates for human review; it never auto-merges.

**Consequences.** Deduplication is reliable; storage is immutable. Deleting a document is blocked by trigger (supersede instead). Backups must include the document directory.

---

## ADR-010 — OCR is a candidate generator, never an authority

**Decision.** Use local Tesseract (English) for images and `pdfjs-dist` for text-layer PDFs. Extracted fields are stored with confidence and `review_status`; a human must correct/accept them. OCR failure never blocks manual entry.

**Consequences.** No cloud OCR dependency or data egress. Nepali and scanned PDFs are unsupported (see `KNOWN_BUGS.md`).

---

## ADR-011 — Server-side authorisation on every mutation

**Decision.** Server Actions call `requireUser`/`requirePermission`; pages call `requirePagePermission`; API routes check permissions and return 401/403 JSON. The sidebar is only a convenience; hiding a link is not a security control.

**Consequences.** Direct URL access and forged form posts are both denied. Denied page loads redirect to `/no-access` instead of throwing a 500.

---

## ADR-012 — Scrypt passwords and hashed session tokens

**Decision.** Passwords: scrypt with per-password salt and stored parameters. Sessions: 32-byte random token in an `HttpOnly`, `SameSite=Lax`, `Secure`-in-production cookie; only its SHA-256 is stored. Elevated roles (ADMIN, FINANCE, EXECUTIVE) get 12-hour sessions; others 30 days. Sign-out revokes the session row.

**Consequences.** Database theft does not directly yield usable sessions. No “remember me” beyond the role TTL. Accounts created or reset by an administrator have `must_change_password = true`; the app layout forces them to `/change-password` before any financial page, and changing the password revokes every other session for that user.

---

## ADR-013 — Audit trail is append-only in the database

**Decision.** `audit_events` has no update/delete path and DB triggers reject both. Each event stores actor, action, entity, summary, before/after JSON, IP, user agent, and timestamp.

**Consequences.** Investigation is possible after the fact. A database superuser can still drop triggers; this is not cryptographic tamper-evidence.

---

## ADR-014 — Nepali dates are first-class

**Decision.** Store business dates as `DATE` plus an explicit calendar (`AD`/`BS`). Convert with `nepali-date-converter`. Budgets are labelled by **BS fiscal year** (`2083/84`) derived from the AD date via `fiscalYearBsFor`. The UI defaults to AD with BS shown alongside.

**Consequences.** Reports align with Nepali practice without ambiguous date strings. Date conversion is centralised and unit-tested.

---

## ADR-015 — Bank statement import is conservative

**Decision.** Accept CSV/TXT/XLSX, detect the header row by looking for Date + Description, map common Nepali/English column aliases, parse debit/credit or withdrawal/deposit pairs, and fingerprint each line. Re-imports skip duplicates instead of aborting. Matching is a suggestion; a human confirms. Reconciled snapshots are stored.

**Consequences.** Safe repeated imports. Ambiguous layouts are rejected with a clear error rather than guessed. No automatic write-back to the ledger from a statement line.

---

## ADR-016 — Exports are permissioned and audited

**Decision.** 13 datasets, CSV or JSON, require `export.run`, are capped at 20,000 rows, and emit an `EXPORT_RUN` audit event. CSV cells beginning with `= + - @` are prefixed with `'` to prevent formula injection.

**Consequences.** Bulk data can leave the system for analysis without silently becoming an exfiltration path. Large exports are truncated and flagged.

---

## ADR-017 — Synthetic data is quarantined by provenance

**Decision.** `users.is_synthetic` propagates to created rows. The demo seeder refuses to run over non-empty/non-demo data; the reset script refuses if any user or financial record is real. Demo credentials are written to `.data/demo-credentials.txt` (mode 0600) and never printed.

**Consequences.** Demo and real books cannot be silently mixed. Evaluation is reproducible without contaminating a real workspace.

---

## ADR-018 — Single organisation, NPR only

**Decision.** One organisation row (`org_locus`), one currency (NPR), no FX. `organizations` exists to make a future multi-tenant migration possible, but queries are not org-scoped.

**Consequences.** Simpler, correct accounting now. Multi-org requires schema and query changes, tracked in `TASK_QUEUE.md`.

---

## ADR-019 — Tests use real migrations, not mocks

**Decision.** Vitest runs against in-memory PGlite with the real `001`–`003` migrations; Playwright drives the real app with the demo dataset.

**Consequences.** Constraints and triggers are exercised. Tests are slower (~20 s unit, ~21 s E2E) but catch the failures that matter in a finance system. The final suite is 117 tests across 15 files.

---

## ADR-020 — Honest capability reporting over silent degradation

**Decision.** Where a capability is unavailable (Nepali OCR, scanned PDFs, email, FX), the UI and docs say so. No placeholder feature pretends to work.

**Consequences.** Users know when to fall back to manual entry. The remaining work is explicit and prioritised.

---

## ADR-021 — MFA is TOTP plus hashed single-use recovery codes

**Context.** ADMIN/FINANCE/EXECUTIVE can move money; a password alone is insufficient.

**Decision.** Implement RFC 6238 TOTP with a ±1 step window and replay-step tracking. Generate ten recovery codes, store only SHA-256 hashes, and consume a code atomically. Enrollment is at `/mfa-setup`; recovery codes are shown once. `MFA_ENFORCE=true` requires enrollment for elevated roles. An admin reset clears the secret and revokes the target's sessions. A user cannot reset their own MFA.

**Consequences.** No external identity provider or SMS dependency. A lost authenticator can be recovered with a code or an admin reset. A sole admin needs a documented break-glass procedure. Enforcement is off by default for the synthetic demo.

---

## ADR-022 — Period close is a posting guard, not a data rewrite

**Context.** Reports must be stable after a period is presented, but corrections still need a path.

**Decision.** Store periods in `accounting_periods`; closing requires a reason and is audited. `postJournal`, expense creation/submission, and payment recording call `assertDateOpen` for the business date. Reopening is authorized and audited. Closing is blocked if DRAFT journal entries exist.

**Consequences.** Back-dated entries are rejected while closed. Corrections can be posted in an open period with a reference, or the period can be reopened under review. Pending claims do not block close but are recorded in the audit event.

---

## ADR-023 — Payment corrections are linked reversals, never edits

**Context.** A recorded payment may be wrong, but deleting or editing it destroys evidence.

**Decision.** `reversePayment` creates an equal-and-opposite payment and journal entry linked by `reverses_id`; the original is marked `VOID`; the claim status is recomputed; before/after is audited. Reports and aggregates exclude reversal rows.

**Consequences.** The original remains inspectable and the books stay balanced. Reversing an advance payment is intentionally unsupported and must be handled as a documented exception.

---

## ADR-024 — Backups are verified by restoration, not by copy success

**Context.** An untested backup is not a backup.

**Decision.** The backup includes database, documents, checksums, manifest, git commit, and timestamp; credentials are excluded. The verifier checks checksums, counts, journal balance, and document hashes. The restore refuses a non-empty target unless forced, revokes all sessions, and writes `RESTORED_AT`. A disposable restore drill must pass before a backup is trusted.

**Consequences.** Recovery is evidence-based. Scheduled/offsite encrypted storage is still an operational task; the local CLI does not replace provider PITR.

---

## ADR-025 — Static CSP now, nonce CSP later

**Context.** The app had security headers but no CSP; a nonce-based policy requires coordinated Next.js changes.

**Decision.** Enforce a static CSP with `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, and a narrow allow-list. Keep `unsafe-inline` for scripts/styles until a nonce/hash rollout is tested. Keep the document-response sandbox CSP separate.

**Consequences.** External script injection and framing are blocked, but inline injection is not fully mitigated. A nonce-based CSP remains P2-11.
