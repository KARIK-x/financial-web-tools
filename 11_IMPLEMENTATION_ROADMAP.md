# Implementation Roadmap

**Date:** 2026-10-24. Effort estimates assume a small student dev team (2–4 people, part-time) — treat as ranges, not commitments.

## Phase 0 — Research, requirements, data discovery (2–4 weeks)
- Confirm open questions in doc 12 (registration status, bank accounts, existing files, committee sign-off).
- Inventory existing financial material (count files, formats, years covered). Deliverable: **data inventory report**.
- **Acceptance:** FM signs off assumptions register; inventory complete; Phase 1 scope approved.

## Phase 1 — Secure expense intake, receipt repository, accountability, historical import (10–16 weeks)
Build: auth + roles (RLB), Submit Expense (mobile), Receipt Inbox, Approvals (with self-approval block), reimbursement queue, advances, audit log, import/export, batch document import + inventory + dedupe + PaddleOCR extraction + review queue (P1 scope of reconstruction), baseline v1 declaration support, dashboard P1.
- **Acceptance criteria:**
  1. A member submits a documented expense from a phone in ≤2 minutes (usability test, 5 members).
  2. Self-approval is technically impossible (test).
  3. 100% of imported files preserved with SHA-256; duplicate detection demonstrated on seeded set incl. re-photographed receipts.
  4. Reconstruction progress dashboard live; at least one full event-year processed through review queue.
  5. Full CSV/JSON export produced and independently re-imported into a spreadsheet by a non-developer, matching totals.
  6. Backup restore drill passed.
- **Risk ranking basis:** highest financial-risk reduction per effort: visibility + receipts + no-double-count data model first.

## Phase 2 — Approvals depth, budgets, sponsors, notifications (8–12 weeks)
Approval thresholds config, delegation, sponsorship pipeline + earmarked funds, event budgets + variance alerts, OCR prefill on live submission, email/in-app reminders (advance aging, missing receipts), member accountability page, fuzzy duplicate proposals.
- **Acceptance:** sponsor commitment vs received report matches manual check on 10 real sponsors; budget overspend alert fires in staging demo; reminder emails sent for all advances >30d.

## Phase 3 — Cash/bank, reconciliation, accounting core (10–14 weeks)
Financial accounts + transfers, bank statement import + line matching + reconciliation workflow, period closing, double-entry journal layer + income/expenditure + cash-flow reports, restricted-funds view.
- **Acceptance:** a full month reconciled end-to-end (statement import → match → difference report → reconciled mark) with zero unexplained differences above NPR 100; journal Σdr=Σcr invariant proven by property test.

## Phase 4 — Intelligence (8–12 weeks)
Anomaly detection (doc 08 §3), forecasting, NL query layer with grounding safeguards, cloud OCR escalation, SMS notifications.
- **Acceptance:** NL answers show drill-down + basis + period in 100% of test cases; no write path from AI layer (pen-test checklist); anomaly suggestions precision ≥60% on labeled historical set (advisory-only requirement).

## Phase 5 — Advanced (ongoing, post-stabilization)
Multi-year analytics, e-invoicing export if IRD mandates become applicable, messaging integrations, optional mobile native app, public transparency page (sanitized).

## Effort & cost summary
| Phase | Effort (student team) | Infra cost |
|---|---|---|
| 0 | 2–4 wks | $0 |
| 1 | 10–16 wks | $25–40/mo |
| 2 | 8–12 wks | $25–40/mo |
| 3 | 10–14 wks | $25–40/mo |
| 4 | 8–12 wks | +$0–50/mo (OCR escalation as used) |

Dependencies: P2 budgets depend on P1 allocation model; P3 journal depends on P1 payment model stability; P4 analytics depend on ≥2 periods of clean P1–P3 data. **Do not reorder.** Quick wins deliberately placed early: dashboard, submission, receipts — highest frequency of use and highest data-quality impact.
