# Product Specification

**Date:** 2026-10-24 · Scope: what to build, for whom, and what each page does. Phase assignments per document 11.

## 1. Product Principles

1. **Trustworthy numbers over many numbers** — every figure labeled verified/claimed/estimated.
2. **Two-minute submission** — a member must be able to submit a documented expense from a phone in under two minutes.
3. **Review, don't retype** — OCR and imports produce candidates; humans confirm.
4. **Nothing is deleted** — corrections are reversals/versions; originals immutable.
5. **Continuity** — every committee can inherit a complete, exportable financial record.

## 2. Information Architecture & Navigation

```
Finance Tracker
├── Dashboard (role-aware)
├── Expenses
│   ├── My Expenses (claimant)
│   ├── All Expenses (finance/executive)
│   ├── Submit Expense
│   ├── Approvals
│   └── Advances & Reimbursements
├── Documents
│   ├── Receipt Inbox
│   └── Historical Reconstruction
├── Money In
│   ├── Sponsors
│   └── Income
├── Money Out
│   ├── Vendors
│   └── Payments
├── Budgets & Events
├── Accounts
│   ├── Cash & Bank
│   └── Reconciliation
├── Reports
├── Analytics (Phase 4)
├── Audit Log
├── Import / Export
└── Settings (org, roles, categories, thresholds, fiscal year)
```

One/two-click actions: Submit Expense (always 1 click from anywhere), My pending items, Approve/Reject (from notification), Record payment, Upload receipts.

## 3. Page Specifications (18 pages, ranked; P1 = first release)

### 3.1 Executive Finance Dashboard — **P1**
- **Users:** FM, executives. **Objective:** answer "where are we?" in 10 seconds.
- **Content (each card labeled VERIFIED or includes claimed component):** verified spend this fiscal year; outstanding reimbursements (count + NPR); outstanding advances; sponsor commitments vs received; cash on hand (last counted); bank balance (last reconciled) with "as of" timestamps; missing-receipt exposure; recent activity feed.
- **Warnings banner:** unreconciled > 30 days, advances overdue, negative event variance.
- **Charts:** monthly spend bar (verified vs claimed stacked), nothing else in P1.
- **Mobile:** cards stacked, warnings on top.

### 3.2 Expenses (list) — **P1**
- Filters: status, event, member, category, date range, vendor, documentation state, verification state.
- Table: date, claimant, vendor, amount, event, status chip, receipt thumbnail, verification badge.
- Bulk actions (finance role): approve batch, export CSV, assign event.

### 3.3 Submit Expense — **P1**
- Camera-first mobile flow (see workflow §2 of doc 02). OCR prefill with editable fields + "corrected by user" capture. Offline draft: photo saved locally, submit when online (P2 enhancement; P1 requires connectivity but keeps drafts).
- Split-allocation lines for multi-event expenses.

### 3.4 Receipt Inbox — **P1**
- All documents, searchable (merchant, amount, date, invoice no., member, event, document type). Duplicate badge. Document detail: image viewer, extracted fields w/ confidence, linked expense, OCR provenance. Replace/supersede with history.

### 3.5 Historical Reconstruction — **P1 (batch import, inventory, review queue); matching intelligence P2**
- Progress dashboard: documents imported / classified / extracted / reviewed / matched; estimated completeness; confidence histogram. Reviewer work queue sorted by risk (high-value, low-confidence first).

### 3.6 Members & Accountability — **P2**
- Per-member: claims count/amount, outstanding reimbursements, advances status, missing receipts, avg approval time. No shaming design — used for follow-up lists, not leaderboards.

### 3.7 Advances & Reimbursements — **P2**
- Two queues: money owed to members (reimbursement queue w/ aging), money held by members (advance settlement queue). One-click "record payment/settlement".

### 3.8 Sponsors & Revenue — **P2**
- Pipeline board (commitment states), sponsor detail (agreements, promised/received/outstanding, deliverables, documents), in-kind register, earmarked funds view.

### 3.9 Budgets & Events — **P2**
- Event cards: budgeted vs committed vs incurred vs paid vs forecast; variance bar; overspend alert. Budget revision history. Rule: amounts roll up, never double-count — allocation lines define which budget an expense consumes (one owner budget per line).

### 3.10 Vendors — **P2**
- Vendor master + spend history, price-trend flag (P4 anomaly), linked documents.

### 3.11 Cash & Bank Accounts — **P3**
- Account ledger: opening/closing, transfers (excluded from income/expense), petty cash counts with difference recording.

### 3.12 Reconciliation — **P3**
- Statement import → line matching (amount/date fuzzy) → unmatched queues both sides → difference report → "mark reconciled" with evidence requirements (statement file + period + reviewer).

### 3.13 Financial Reports — **P3**
- Income & expenditure (cash-basis default, accrual view P3), cash flow, event P&L, sponsor report, member accountability report, documentation completeness report. Every report shows period, basis, and verification filter.

### 3.14 Analytics & Insights — **P4** (per doc 08)

### 3.15 Approvals — **P1**
- Queue of pending items with batch approve, delegation ("I'm away → delegate to X" with audit), threshold indicators.

### 3.16 Audit Log — **P1**
- Append-only, filterable by actor/entity/action/date. Exportable by FM only.

### 3.17 Import / Export — **P1**
- Import: file batch, spreadsheet mapping wizard, preview, error report, import ledger (see doc 14 concepts). Export: full CSV/JSON export of all structured data + manifest; FM-only.

### 3.18 Organization Settings — **P1**
- Fiscal year dates, roles/permissions matrix, approval thresholds, expense categories, events/departments, numbering prefixes, retention policy, compliance settings (PAN/VAT fields on/off, date calendar default).

## 4. Non-functional UX requirements

- Responsive from 360px width; camera capture tested on low-end Android (dominant device class).
- All amounts in NPR with lakh/crore grouping setting; BS/AD date display setting.
- Every list page ≤3s load at 10k records (pagination + indexes per doc 06).
- Empty states teach the next action ("No receipts yet — drag files here or photograph one").
