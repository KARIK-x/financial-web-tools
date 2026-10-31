# Requirements and Workflows

**Date:** 2026-10-24 · **Status:** Requirements specification (pre-implementation)

## 1. User Roles (proposed, not final)

| Role | Description | Key permissions |
|---|---|---|
| **Finance Manager (FM)** | Accountable owner of Finance Tracker finances | Everything incl. verification, reconciliation, exports, settings |
| **Finance Team Member** | Deputy; shares operational load | Approve, verify, reconcile, import; cannot change roles/permissions or delete org data |
| **Committee Executive** (President/Secretary) | Oversight | Read all + approve over-threshold items; no data entry required |
| **Event/Department Head** | Owns an event budget | Submit own expenses, view own event's finances, approve member claims under threshold |
| **Expense Claimant** (any FINANCE TRACKER member) | Spends money for FINANCE TRACKER | Submit expenses/advances, view own submissions |
| **Read-only Auditor** | Internal audit / campus oversight | Read everything, export nothing, edit nothing |

**Separation of duties (hard rules):**
- A user can never approve their own claim. (System-enforced, not policy-enforced.)
- Verification of evidence and approval of payment are separate steps; for small claims one finance-team member may do both, but the audit log shows who did what.
- Configurable approval thresholds (default proposal: claims ≤ NPR 2,000 → FM or finance team approves; > NPR 2,000 → + executive approval; > NPR 25,000 → committee resolution reference required). Thresholds are settings, not code.

## 2. Core Workflow: Member Expense Submission (live operations)

1. Member opens "Submit Expense" (mobile-first, ≤2 min target).
2. Photographs receipt (or uploads existing file / PDF).
3. OCR auto-fills: date, amount, merchant, invoice number. Member corrects fields (corrections are captured — see data provenance).
4. Member selects: event/department, category, payee details — *who actually paid* (self personal money / FINANCE TRACKER cash / FINANCE TRACKER bank), payment method, whether reimbursement is required.
5. Submits → status `SUBMITTED`. Claimant cannot edit after submission (must withdraw and resubmit, which is logged).
6. Approver reviews receipt image + fields → `APPROVED` or `REJECTED` (reason mandatory).
7. If reimbursement required → enters `PENDING_REIMBURSEMENT` queue; FM records payment (date, method, reference) → `REIMBURSED`.
8. FM (or second reviewer) marks evidence verified when receipt + payment line up → `VERIFIED`.
9. Periodically reconciled against cash count / bank statement → `RECONCILED`.

**States:** `DRAFT → SUBMITTED → APPROVED → PENDING_REIMBURSEMENT → REIMBURSED → VERIFIED → RECONCILED`, with side states `REJECTED`, `WITHDRAWN`, `DISPUTED`.

## 3. Core Workflow: Cash Advance

1. Requester creates advance request (purpose, event, amount, expected date).
2. Approval per threshold → FM disburses (cash or bank) → `ADVANCE_OUTSTANDING`.
3. Requester submits expenses against the advance; system offsets claim amounts against the advance automatically.
4. End state: `SETTLED` — with either (a) full justification, (b) partial justification + returned balance (return recorded as a transaction), or (c) justified-short with FM-approved explanation.
5. Outstanding advances > 30 days old appear on the FM's accountability dashboard and trigger reminders.

## 4. Core Workflow: Sponsorship

Pipeline states (never conflated): `LEAD → PROPOSED → NEGOTIATING → COMMITTED → INVOICED (optional) → PARTIALLY_RECEIVED → RECEIVED → DELIVERABLES_PENDING → CLOSED`.

- A commitment is **never** revenue until cash/transfer is recorded. Commitments appear in pipeline reports only.
- In-kind sponsorship: stored as a separate record type with an estimated value and an explicit `IS_VALUATION_ESTIMATE` flag — it never enters cash balances.
- Earmarking: a sponsorship can be linked to a specific event/budget line; restricted funds are tracked so general spending cannot silently consume earmarked money.
- Deliverables (logo placement, booth, social posts) tracked with due dates → drives the "pending deliverables" report.

## 5. Core Workflow: Historical Reconstruction (see 07 for full pipeline)

1. Bulk import all files (photos, scans, PDFs, spreadsheets, bank statements) — originals preserved, SHA-256 hashed.
2. Document inventory with unique IDs, auto-classification (receipt / invoice / bank statement / agreement / unknown).
3. Batch OCR + field extraction → **candidate** expense records (never posted).
4. Duplicate detection (perceptual hash of image + amount/date/merchant similarity).
5. Matching: receipts ↔ bank statement lines ↔ member claims ↔ payment confirmations.
6. Reviewer queue: humans resolve conflicts, fill missing fields, confirm/reject candidates.
7. Reconciliation pass against bank statements and cash records.
8. **Baseline declaration:** a snapshot report of historical finances with explicit completeness/confidence indicators — not a fake-precise number.

## 6. Business Rules and Edge Cases

- **No receipt:** allowed with "Missing Receipt Declaration" (statement + approver), flagged permanently as low-documentation; above a threshold, mandatory second approval. (Modeled on the lost-receipt-affidavit pattern used by Zoho Expense/Expensify.)
- **Lost receipt:** same as above plus a note; if a duplicate copy surfaces later, attach without deleting the declaration (append-only).
- **Shared expense / split across events:** a claim can have multiple allocation lines (event A 60% / event B 40%); totals must reconcile to receipt amount.
- **Emergency purchase:** claimant may submit within 48h with a marker; expedited approval path, same documentation requirements.
- **Duplicate submission:** system blocks exact-duplicate detection (same file hash or same amount+date+merchant with same claimant) before submission completes; near-duplicates flagged for reviewer.
- **Rejected claims:** visible to claimant with reason; claimant may correct and resubmit (linked to original).
- **Disputed expense:** any finance-team member may flag `DISPUTED`; disputed items excluded from "verified" totals everywhere until resolved.
- **Currency:** NPR is the functional currency. Foreign-currency receipts (e.g., Indian vendors) record original amount + FX rate + NPR equivalent, with source of rate noted. (This matches IRD practice of NRB-rate conversion for foreign currency.)
- **Dates:** all dates stored with explicit calendar (BS/AD) as entered + normalized AD date. Never silently convert.
- **Corrections:** posted financial records are never edited. Corrections = reversal + new record, or a versioned adjustment linked to the original. (See 06 and 09.)

## 7. Functional Requirements (first-release subset, MoSCoW)

**Must (Phase 1):** member submission (mobile), receipt repository with immutable originals + thumbnails, claim status tracking, role-based access, approval workflow w/ self-approval block, reimbursement queue, advance tracking, basic dashboard (verified spend, outstanding reimbursements, outstanding advances, missing receipts), batch historical import w/ inventory + dedupe, audit log, CSV export of claims.
**Should (Phase 2):** sponsorship pipeline module, event budgets w/ variance, OCR auto-fill on submission, email/in-app notifications & reminders, duplicate fuzzy-matching, approval thresholds config.
**Could (Phase 3):** bank statement import + reconciliation, cash accounts + transfers, restricted funds, period closing, double-entry ledger, financial reports (income/expenditure, cash flow).
**Won't (Phase 4+):** anomaly detection, forecasting, natural-language queries, messaging integrations, multi-year analytics.
