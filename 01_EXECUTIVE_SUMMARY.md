# Finance Tracker Intelligence Platform — Executive Summary

**Date:** 2026-10-24 · **Status:** Research phase complete. No implementation started.

## 1. The Core Problem

FINANCE TRACKER (engineering student organization, IOE Pulchowk Campus, Nepal) lacks a system of financial visibility. The evidence-based problem statements from the brief — expenses made by many members, scattered/non-digitized receipts, unreconciled personal spending, unclear cash advances, unknown historical expenditure, and continuity loss when committees change — describe a classic **absence of a single source of financial truth**, not a lack of accounting knowledge.

The consequence is that the Finance Manager cannot currently answer, with confidence: *How much has FINANCE TRACKER spent? Who spent it? On what? What is owed to members? What have sponsors actually paid? What cash do we actually have?*

## 2. Proposed Solution

A **custom, web-based financial management platform** built specifically for Finance Tracker's reality: multi-member spending, event-based finance, sponsorship revenue, NPR-only cash operations, poor historical records, and low operating budget.

**Recommendation: Build custom, do not adopt Zoho Expense/Expensify/SAP Concur.**

Why not adopt:
- Commercial tools are priced per-user/per-month for corporate budgets; a 100–300 member student organization faces real recurring cost (or restrictive free tiers).
- They assume corporate-card feeds, corporate tax regimes (IRS/GST mileage rules), and payroll reimbursement rails that do not exist for FINANCE TRACKER.
- They provide **no historical-reconstruction capability** — the single most valuable thing FINANCE TRACKER needs right now. Their data model starts clean from day one; Finance Tracker's starts dirty from year zero.
- Data portability and institutional continuity are weaker when the org's entire financial history lives in a vendor SaaS account owned by a graduating committee member.

Hybrid possibility (rejected for v1 but re-evaluable at Phase 4): Zoho Expense free tier for live expense capture while building the custom platform. Rejected because it duplicates member onboarding effort and splits the financial record across two systems during exactly the period when the record must be unified.

## 3. Major Recommendations (summary)

1. **Phased build**, starting with expense intake + receipt repository + member accountability + historical document import (Phase 1). Do not build accounting, OCR-heavy automation, or analytics first.
2. **Structured data + documents as separate but linked layers.** Original receipts are preserved immutably in object storage; structured transactions reference them. Never store binary files in Postgres rows.
3. **A claim/payment/evidence data model** with explicit verification states (`claimed → approved → verified/paid → reconciled`) instead of a naive "expense" table. This prevents double-counting personal spend + reimbursement, separates commitments from cash, and preserves uncertainty.
4. **Local-first OCR strategy:** PaddleOCR PP-OCRv5 (free, self-hosted, includes a Devanagari model covering Nepali + English) as the primary engine for the historical backlog; optional cloud OCR (Google Document AI Invoice Parser, ~$0.10 per document up to 10 pages) only for low-quality failures, with explicit Finance Manager authorization because receipts leave the premises.
5. **Hosted Postgres backend (Supabase Pro, ~$25/month)** with Next.js frontend, and local OCR workers. Total estimated operating cost: **$25–40/month**, well within student-org budget.
6. **Trustworthy-by-design reporting:** every number traces to transactions; every transaction carries a verification state; the dashboard shows verified vs claimed amounts side by side, never blended.
7. **Configurable Nepal compliance layer**, not hardcoded rules: PAN/VAT fields optional, BS/AD dual dates, NPR formatting, because Finance Tracker's exact legal/institutional status is **unverified** (see 04 and 12).

## 4. Key Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Historical reconstruction abandoned midway (effort fatigue) | High | Phase 1 includes a "minimum viable baseline" milestone; batch queue with progress tracking; do not require 100% completeness to declare a baseline |
| Member non-adoption (continued side-channel spending) | High | Mobile-first submission in <2 minutes; committee mandate that unreimbursed claims not in the system are deprioritized |
| OCR silently corrupting financial data | High | OCR output is never accounting data; review queue + confidence scores + field-level provenance |
| Single-person dependency (new bottleneck = same old problem) | Medium | At least 2 finance-team members with admin rights from day 1; documented runbook |
| Data loss / graduating member takes credentials | High | Org-owned accounts, not personal; 2FA; documented handover export |
| Scope creep into full accounting software | Medium | Phase gates with acceptance criteria; defer double-entry ledger to Phase 3 |

## 5. Expected Value

- **Financial visibility:** verified spend, outstanding reimbursements, sponsor receivables, and cash position available on demand instead of reconstructed per-event.
- **Continuity:** institutional memory survives committee turnover; every balance and transaction has an owner and an audit trail.
- **Member trust:** reimbursements tracked transparently; no "the FM has my receipts somewhere" situations.
- **Sponsor credibility:** professional reporting of commitments vs receipts strengthens future sponsorship negotiations.
- **Audit readiness:** clean evidence chains for campus administration or external review.

## 6. Decision Requested

Finance Manager reviews the 13 research documents, confirms the assumptions in `12_OPEN_QUESTIONS_AND_ASSUMPTIONS.md`, and approves the Phase 0→1 scope in `11_IMPLEMENTATION_ROADMAP.md`. Development must not begin before that approval.
