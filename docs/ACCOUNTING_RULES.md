# ACCOUNTING RULES

This document defines how the LOCUS Finance platform turns business events into journal entries and reports. It is the reference for anyone reviewing the books or changing the code.

**Currency:** NPR only. **Unit:** integer paisa (NPR 1.00 = 100 paisa). **Basis:** accrual, double-entry. **Fiscal year:** BS, starting in Shrawan (month 4); the period containing 2026-10-24 is BS 2083/84 (2026-07-17 → 2027-07-16).

---

## 1. Chart of accounts

| Code | Account | Type | Used for |
|---|---|---|---|
| 1000 | Cash on hand | Asset | Cash payments and receipts |
| 1010 | Bank account | Asset | Bank payments and receipts |
| 1020 | Digital wallet | Asset | Wallet (eSewa/Khalti) movements |
| 1100 | Advances receivable | Asset | Money given to a member before spending |
| 2000 | Member reimbursements payable | Liability | Amounts owed to members who spent personal funds |
| 2100 | Expense clearing | Liability | Approved organisation-funded expenses awaiting payment |
| 3000 | Sponsorship income | Income | Sponsor receipts |
| 3100 | Opening balance equity | Equity | Opening balances of cash/bank/wallet |
| 3900 | Other income | Income | Reserved for non-sponsorship income |
| 5001–5012 | Expense categories | Expense | Travel, printing, food, venue, equipment, software, prizes, marketing, services, utilities, bank charges, other |
| 5900 | Bank charges | Expense | Fees (also available as category 5011) |

Category ledger codes are stored on `expense_categories.ledger_code`; the journal uses the category’s code and name so reports group naturally.

---

## 2. Journal invariants

1. Every entry has at least two lines and **total debits = total credits** (enforced by `journal_must_balance`).
2. An entry is posted inside the same transaction as the business record it describes. If either fails, both roll back.
3. Posted lines are **immutable** (`journal_lines_immutable`). Corrections are new entries.
4. Entry numbers are sequential (`JE-YYYY-NNNN`), generated in the same transaction.
5. Every entry records `source_type` and `source_id` so it can be traced to the claim, payment, advance, sponsor receipt, transfer, or opening balance.

---

## 3. Event → entry matrix

### 3.1 Expense claim approved — personal funds

The member has already spent their own money; LOCUS owes them.

```
Dr  Expense category (e.g. 5003 Food & Refreshments)   amount
    Cr  2000 Member reimbursements payable              amount
```

Claim status → `PAYMENT_PENDING`.

### 3.2 Expense claim approved — organisation funds

LOCUS will pay a vendor/invoice from its own money. A clearing liability is used until payment, so no member payable is created.

```
Dr  Expense category                                   amount
    Cr  2100 Expense clearing                          amount
```

Claim status → `PAYMENT_PENDING`.

### 3.3 Expense claim approved — advance-funded

The money was already given to the member as an advance.

```
Dr  Expense category                                   amount
    Cr  1100 Advances receivable                       amount
```

Claim status → `SETTLED`; the advance’s outstanding balance is refreshed. No payment row is created.

### 3.4 Payment of a claim

Personal funds:

```
Dr  2000 Member reimbursements payable                 amount
    Cr  1000/1010/1020 (funding account)               amount
```

Organisation funds:

```
Dr  2100 Expense clearing                              amount
    Cr  1000/1010/1020 (funding account)               amount
```

Partial payments are allowed; the status stays `PAYMENT_PENDING` until the cumulative recorded payments reach the claim amount, then becomes `REIMBURSED` (personal) or `SETTLED` (organisation). A payment cannot exceed the outstanding balance.

### 3.5 Advance disbursed

```
Dr  1100 Advances receivable                           amount
    Cr  1000/1010/1020 (funding account)               amount
```

Advance status → `OUTSTANDING`.

### 3.6 Unused advance returned

```
Dr  1000/1010/1020 (receiving account)                 amount
    Cr  1100 Advances receivable                       amount
```

The return is capped at the outstanding advance; over-return is rejected. A settlement row is recorded.

### 3.7 Sponsorship receipt

```
Dr  1000/1010/1020 (receiving account)                 amount
    Cr  3000 Sponsorship income                        amount
```

Agreement state → `PARTIALLY_RECEIVED` or `RECEIVED` based on cumulative receipts vs pledge. Receipts above the pledge are allowed (see §8).

### 3.8 Internal transfer

```
Dr  Destination account (1000/1010/1020)               amount
    Cr  Source account (1000/1010/1020)                amount
```

A single `payments` row of type `TRANSFER` drives both sides; the account ledger treats `to_account_id` as an inflow and `from_account_id` as an outflow.

### 3.9 Opening balance

Allowed only when the account has **no recorded movements**.

```
Dr  1000/1010/1020 (account)                           amount
    Cr  3100 Opening balance equity                    amount
```

A reason is mandatory and stored in the audit trail. This prevents history from being rewritten by editing a balance.

---

## 4. Claim lifecycle and accounting timing

```
DRAFT ──submit──> SUBMITTED ──review──> UNDER_REVIEW ──approve──> APPROVED
   │                  │                     │                        │
   │                  └──reject──> REJECTED └──reject──> REJECTED    ├──(advance)──> SETTLED
   └──withdraw──> WITHDRAWN                                          └──(funds)──> PAYMENT_PENDING
                                                                          │
                                                          payment(s) ─────┤
                                                                          ├──> REIMBURSED (personal)
                                                                          └──> SETTLED (organisation)
                                                                                  │
                                                                          verify ─┴──> VERIFIED
                                                                                  │
                                                                    bank match ───┴──> RECONCILED
```

- **No journal is posted at draft/submission.** Approval is the accrual point.
- **Verification** confirms evidence; it does not change the amount or post a journal.
- **Reconciliation** happens when a recorded payment is matched to an imported bank line and the claim is already `VERIFIED`; status becomes `RECONCILED`.
- `REJECTED`, `WITHDRAWN`, `DISPUTED` are terminal/exceptional; terminal states cannot be left by trigger.

### Approval requirements

| Claim amount (paisa) | Tier | Required decisions |
|---|---|---|
| ≤ 200,000 (≤ NPR 2,000) | STANDARD | 1 finance/executive approval |
| > 200,000 and ≤ 2,500,000 | EXECUTIVE | Finance **and** Executive |
| > 2,500,000 and ≤ 10,000,000 | EXECUTIVE | Finance and Executive |
| > 10,000,000 | COMMITTEE | Finance + Executive + committee reference |
| > 500,000 | — | A second approval is required (`documentation.secondApprovalAbove`) |

A claimant can never approve or verify their own claim (DB trigger `approvals_no_self`). Duplicate decisions by the same approver are blocked by a unique index.

### Documentation states

- `COMPLETE` — receipt/document attached.
- `MISSING_DECLARED` — no receipt, but a written declaration exists (allowed when `missingReceiptRequiresDeclaration` is true).
- `MISSING_UNDECLARED` — no evidence and no declaration; verification is blocked.

---

## 5. Bank reconciliation

1. **Import** a statement (CSV/TXT/XLSX). Each line is fingerprinted; duplicates are skipped, not re-inserted.
2. **Suggest** matches: same amount and a date within a small window, preferring exact references; confidence 0.8 for strong matches, 0.4 for date-only candidates.
3. **Confirm** a match manually. A payment can match at most one line. Matching a `VERIFIED` claim’s payment moves the claim to `RECONCILED`.
4. **Ignore** non-ledger lines (bank charges already recorded elsewhere, personal transfers, etc.).
5. **Reconcile** the account for a period: compare the computed ledger balance as of the period end with the statement balance. Difference = 0 → `RECONCILED`; otherwise `OPEN` with the difference stored.

A reconciliation snapshot is immutable evidence of what was agreed at that time. Unmatching is allowed before the snapshot is finalized and is audited.

---

## 6. Budgets

- A budget has a scope (`EVENT`, `DEPARTMENT`, `ORGANISATION`) and a **BS fiscal year** (`2083/84`).
- Lines are per expense category.
- **Incurred** = approved/settled/reimbursed/verified/reconciled claim allocations in the period.
- **Paid** = recorded payments against those claims.
- **Outstanding** = incurred − paid.
- **Variance** = budget − incurred. Negative variance is overspend.
- Overspend alerts fire per line and for the budget total; a single over-budget line is enough to alert.
- Budget changes are recorded in `budget_revisions` rather than silently overwriting history.

---

## 7. Reports

| Report | Definition |
|---|---|
| Dashboard | Period spend, pending approvals, outstanding payables, unreconciled lines, missing evidence |
| Spend by category | Approved+ claim totals grouped by category |
| Spend by event | Allocations grouped by event |
| Cashflow | Recorded inflows/outflows by account and period |
| Trial balance | Journal debits/credits by account for the period; must balance |
| Budget report | Budget vs incurred vs paid per line |
| Sponsor report | Promised vs received vs outstanding, deliverables |
| Documentation stats | Complete / declared-missing / undeclared-missing counts |
| Monthly spend | Spend by AD month within the period |

Periods default to the current BS fiscal year. All report money is paisa internally and formatted as NPR for display.

---

## 8. Deliberate rules and known edges

- **Sponsor over-receipt is allowed.** A sponsor may pay more than pledged; the agreement shows `RECEIVED` and the excess remains visible in receipts. Do not “fix” this by rejecting real money.
- **Cash/bank can go negative.** There is no DB constraint preventing a payment that exceeds the computed balance. The accounts page shows the negative balance; a hard block would prevent recording legitimate same-day timing differences. Treat a negative balance as an operational warning.
- **No FX.** `original_currency`, `original_amount_paisa`, and `fx_rate` columns exist for future use but the UI is NPR-only. Do not record a foreign amount as if it were NPR.
- **No automatic bank write-back.** A statement line never creates a payment or journal by itself; a human matches it to an existing payment.
- **No deletion.** Claims, payments, documents, journal lines, bank lines, and audit events are append-only or void-only. Use corrections.
- **Rounding.** Input with more than two decimals is rounded half-up at the third decimal; the stored value is exact paisa thereafter.
- **Negative amounts are rejected** for claims and payments (`> 0` checks); use a correction or refund entry instead.

---

## 9. Month/period close

**Implemented in `accounting_periods` / `accounting_period_events` (`003_operational_hardening.sql`).**

1. Import the final bank statement and match every line (or mark it ignored with a reason).
2. Reconcile each account; investigate any difference.
3. Verify all claims that have evidence; dispute anything questionable.
4. Review the trial balance and cashflow for the period.
5. Export `journal`, `trial-balance`, `cashflow`, `claims`, and `payments` for the record.
6. Back up the database and documents (`BACKUP_AND_RESTORE.md`).
7. Close the period in **Settings → Accounting periods** with a reason. Closing is audited.
8. After close, `postJournal`, expense creation/submission, and payment recording reject dates inside the closed period.
9. Reopen only through the authorized, audited action; document the reason. Do **not** edit prior entries.
10. Corrections to a closed period must be posted in an open period with a memo referencing the original, or the period must be reopened under review.

### Payment corrections

A recorded payment is never edited or deleted. `reversePayment` creates a linked equal-and-opposite payment and journal entry, marks the original `VOID`, recomputes the claim status, and writes an audit event with before/after. Reversal rows are excluded from cashflow and paid/received aggregates. `ADVANCE_*` reversals are intentionally unsupported and must be handled as a documented exception.

---

## 10. What this system does not decide

- Whether a particular expense is programmatically allowable under LOCUS’s constitution.
- Whether LOCUS is VAT-registered or has a PAN (status is `UNVERIFIED` in settings).
- Whether a sponsor pledge is legally enforceable.
- Tax treatment of any receipt or payment.

Those require a human accountant and are intentionally left as explicit settings/notes, not invented rules.
