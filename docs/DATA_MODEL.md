# DATA MODEL

**Database:** PostgreSQL (PGlite 0.5.11 embedded at `.data/pglite`)
**Migrations:** `db/migrations/001_init.sql` (schema + triggers), `db/migrations/002_reference.sql` (reference data, categories, role permissions, settings), `db/migrations/003_operational_hardening.sql` (durable rate limits, accounting periods, MFA, OCR page provenance)
**Tables:** 39 (including `schema_migrations` and staging tables)

All money columns are `BIGINT` **paisa**. All timestamps are `timestamptz`. Business dates are `DATE` with an explicit `calendar` (`AD`/`BS`) where a human-entered date is involved. Identifiers are text UUIDs or stable slugs (`org_finance-tracker`, `cat_food`).

---

## 1. Identity and access

| Table | Purpose | Key columns |
|---|---|---|
| `organizations` | The single workspace | `id`, `name`, `currency`, `fiscal_year_start_month` |
| `users` | Login identities | `email` (unique, case-insensitive), `password_hash`, `role`, `is_active`, `is_synthetic`, `member_id`, `failed_logins`, `locked_until`, `mfa_enabled`, `mfa_secret`, `mfa_recovery_codes`, `mfa_enrolled_at`, `mfa_last_used_step` |
| `members` | People who can be paid or own claims | `name`, `email`, `role_title`, `is_active` |
| `sessions` | Server-side sessions | `token_hash` (unique), `user_id`, `expires_at`, `revoked_at`, `mfa_pending` |
| `rate_limits` | Durable login/request limiter | `key`, `window_start`, `count`, `blocked_until` |
| `accounting_periods` | Fiscal period close/lock | `fiscal_year`, `period_start`, `period_end`, `status`, close/reopen actor/reason |
| `accounting_period_events` | Period close/reopen history | `period_id`, `action`, `reason`, `actor_user_id` |
| `permissions` | Permission catalogue (19 rows) | `key`, `description` |
| `role_permissions` | Role → permission matrix (54 rows) | `role`, `permission` |

Roles: `ADMIN`, `FINANCE`, `EXECUTIVE`, `EVENT_HEAD`, `MEMBER`, `AUDITOR`.

---

## 2. Spend workflow

| Table | Purpose | Notes |
|---|---|---|
| `expense_categories` | 12 categories with ledger codes 5001–5012 | `requires_receipt`, `sort_order` |
| `vendors` | Normalised payees | unique `normalized_name` |
| `events` | Programmes/events | budget and reporting dimension |
| `departments` | Organisational units | second reporting dimension |
| `expense_claims` | The core claim record | status, funding source, amount, dates, verification/documentation state, provenance |
| `expense_allocations` | Split a claim across event/department/category | sum must equal claim amount |
| `approvals` | One row per decision | unique `(claim_id, approver_user_id, decision)`; tier stored |
| `payments` | Money movement | reimbursement, expense payment, advance disbursement/return, sponsor receipt, transfer |
| `advances` | Cash advances to members | `amount_paisa`, `returned_paisa`, `settled_paisa`, status |
| `advance_settlements` | Audit of returns/settlements | linked to advance |

### `expense_claims` highlights
- `claim_no` unique, format `LOC-YYYY-NNNN`.
- `amount_paisa > 0` enforced.
- `funding_source ∈ {PERSONAL, FINANCE_TRACKER_CASH, FINANCE_TRACKER_BANK}`; `reimbursement_required` drives the payable account.
- `status` is a 12-value CHECK constraint.
- `verification_state ∈ {UNVERIFIED, VERIFIED, DISPUTED}`.
- `documentation_state ∈ {COMPLETE, MISSING_DECLARED, MISSING_UNDECLARED}`.
- `source_type ∈ {LIVE, HISTORICAL_IMPORT, OCR_CANDIDATE}` and `is_synthetic` record provenance.
- `correction_of` links a corrective claim to the original.
- `committee_ref` is required above the committee threshold.

### `payments` highlights
- `type ∈ {REIMBURSEMENT, EXPENSE_PAYMENT, ADVANCE_DISBURSEMENT, ADVANCE_RETURN, SPONSOR_RECEIPT, TRANSFER, ADJUSTMENT}`.
- `direction ∈ {IN, OUT}`; transfers use `from_account_id`/`to_account_id`.
- `status ∈ {RECORDED, VOID}`. Recorded rows cannot be deleted or re-amounted (trigger).
- `journal_entry_id` links to the posted entry.
- `reverses_id` links a reversal payment to the original; the original is marked `VOID` and is never edited.
- Reversal rows are excluded from cashflow/paid/received aggregates to avoid double counting.

---

## 3. Documents

| Table | Purpose |
|---|---|
| `document_batches` | Groups an upload session; `file_count` |
| `documents` | Immutable file metadata + extracted fields |
| `ocr_extractions` | One row per OCR attempt, with engine, version, raw text, confidence, error, `pages`, `language` |

`documents` stores `sha256` (unique), `storage_key`, `mime`, `size_bytes`, `doc_type`, `status`, `perceptual_hash`, `duplicate_of`, `duplicate_score`, `extracted` JSONB, `review_status`, `reviewed_by/at`. File bytes live only in `.data/documents`.

Document statuses include `UPLOADED`, `EXTRACTED`, `NEEDS_REVIEW`, `REVIEWED`, `FAILED`. Exact duplicate uploads are blocked and return the existing document; near-duplicates are flagged for review.

---

## 4. Sponsorship

| Table | Purpose |
|---|---|
| `sponsors` | Sponsor identity, normalised name |
| `sponsorship_agreements` | Pledge: `promised_paisa`, `state`, dates, benefits |
| `sponsor_deliverables` | What FINANCE TRACKER owes the sponsor, with due date/status |

Agreement states: `PLEDGED`, `PARTIALLY_RECEIVED`, `RECEIVED`, `DELIVERABLES_PENDING`, `CLOSED`. Receipts are `payments` rows of type `SPONSOR_RECEIPT` linked by `agreement_id`.

---

## 5. Budgets

| Table | Purpose |
|---|---|
| `budgets` | Scope (`EVENT`, `DEPARTMENT`, `ORGANISATION`), BS fiscal year, status |
| `budget_lines` | Amount per category |
| `budget_revisions` | History of budget changes |

Unique scope: `(scope, event_id, department_id, fiscal_year)`. `fiscal_year` is **BS** (`2083/84`). Incurred spend is derived from approved/settled claims via allocations; paid spend comes from recorded payments.

---

## 6. Banking and reconciliation

| Table | Purpose |
|---|---|
| `financial_accounts` | Cash, bank, wallet; opening balance; masked identifier |
| `statement_imports` | One per uploaded statement; parser warnings, status |
| `bank_statement_lines` | Immutable imported lines; match fields mutable only |
| `reconciliations` | Frozen reconciliation snapshot per account/period |

`bank_statement_lines.match_status ∈ {UNMATCHED, SUGGESTED, MATCHED, IGNORED}`. Lines carry `fingerprint` (unique per import context), `debit_paisa`, `credit_paisa`, `balance_paisa`, `matched_payment_id`, `match_confidence`.

Account balance = opening balance + recorded inflows − recorded outflows ± transfers. It is computed, not stored.

---

## 7. Ledger

| Table | Purpose |
|---|---|
| `journal_entries` | Header: `entry_no`, date, memo, source type/id, created_by |
| `journal_lines` | Debit/credit lines with account code and name |

Every entry must balance (trigger). Posted lines are immutable (trigger). Account codes:

```
1000 Cash on hand                 2000 Member reimbursements payable
1010 Bank account                 2100 Expense clearing
1020 Digital wallet               3000 Sponsorship income
1100 Advances receivable          3100 Opening balance equity
5001–5012 Expense categories      3900 Other income
                                  5900 Bank charges
```

---

## 8. Governance and staging

| Table | Purpose |
|---|---|
| `audit_events` | Append-only log: actor, action, entity, summary, before/after JSON, IP, user agent |
| `settings` | JSONB settings: approval thresholds, compliance, display, documentation, reconstruction |
| `import_batches` / `import_rows` | Staging for future generic imports (schema present, UI limited) |
| `schema_migrations` | Applied migration filenames |
| `rate_limits` | Durable rate-limit counters and blocks |
| `accounting_periods` / `accounting_period_events` | Period lock and its audit history |

---

## 9. Integrity triggers

| Trigger | Rule |
|---|---|
| `audit_events_no_update/no_delete` | Audit log is append-only |
| `approvals_no_self` | A claimant cannot approve/verify their own claim |
| `claims_protect_finalized` | Finalized financial fields cannot be edited |
| `claims_allocations_required` | A submitted claim must have allocations summing to its amount |
| `claims_no_delete` | Claims cannot be deleted |
| `allocations_balance` | Allocation totals must equal the claim amount |
| `journal_must_balance` | Debits must equal credits |
| `journal_lines_immutable` | Posted journal lines cannot be inserted/updated/deleted |
| `payments_guard` | Recorded payments cannot be deleted or re-amounted; reversals are linked, not overwritten |
| `documents_immutable` | Document bytes/metadata cannot be deleted or altered |
| `bank_lines_guard` | Imported statement lines are immutable except match fields |
| `claims_terminal_state` | Terminal claim states cannot be left |
| `rate_limits` / `accounting_periods` | Durable counters; closed periods reject postings in app code |

---

## 10. Relationships (simplified)

```
users 1—1 members
users 1—N sessions
members 1—N expense_claims (paid_by)
users 1—N expense_claims (claimant)
expense_claims 1—N expense_allocations
expense_claims 1—N approvals
expense_claims 1—N payments
expense_claims 1—N documents
expense_claims N—1 advances
advances 1—N advance_settlements
sponsors 1—N sponsorship_agreements 1—N payments
sponsorship_agreements 1—N sponsor_deliverables
budgets 1—N budget_lines
financial_accounts 1—N payments
financial_accounts 1—N statement_imports 1—N bank_statement_lines
financial_accounts 1—N reconciliations
journal_entries 1—N journal_lines
payments 1—1 journal_entries (via journal_entry_id)
```

---

## 11. Indexing

Indexes cover the access paths used by the UI: claims by claimant/status/date/event/category/payer/advance; payments by claim/account/date/advance/agreement; documents by status/claim; journal by date/entry; audit by entity/actor/date; bank lines by account/status. Unique indexes enforce case-insensitive user and member emails, normalised vendor/sponsor names, document SHA-256, and one approval decision per approver per claim.

---

## 12. Changing the schema

1. Add a new numbered migration (`004_*.sql`); never edit an applied migration.
2. Run `npm run db:migrate`.
3. For a local database created before a schema change, `rm -rf .data/pglite && npm run db:migrate` is the clean rebuild (this destroys local data — back up first).
4. Update this document and `ACCOUNTING_RULES.md` if the change affects financial behaviour.
