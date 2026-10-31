# Final Recommendation

**Date:** 2026-10-24 · Decision: what to build first, and what to build overall.

## 1. The Decision

**Build a custom Finance Tracker Intelligence Platform.** Do not adopt Zoho Expense, Expensify, SAP Concur, or QuickBooks (see 03 for the verified comparison). The decisive reason: Finance Tracker's core need is reconstructing and governing a fragmented financial past plus a multi-member spending present, and commercial expense tools solve neither — they start from clean corporate spend with card feeds and tax engines FINANCE TRACKER doesn't have, at recurring per-user cost, without historical ingestion, and with weaker institutional continuity.

## 2. What to build first (Phase 1, 10–16 weeks)

In strict priority order:

1. **Identity & permissions** — org-owned accounts, roles, 2FA for officers, RLS-enforced. (Everything depends on it.)
2. **Member expense submission (mobile-first) + immutable receipt repository** — the behavior change that stops the bleeding of undocumented spend.
3. **Approval + reimbursement + advance workflows** with the no-self-approval rule — the accountability core.
4. **Historical reconstruction pipeline (P1 scope):** batch import, inventory, dedupe, PaddleOCR extraction, human review queue — plus a declared **baseline v1**.
5. **P1 dashboard + audit log + full export** — trust and continuity from day one.

Deliberately **not** in the first build: double-entry journal, bank reconciliation, OCR cloud services, AI analytics, native mobile app, messaging bots. Each is phased in docs 11.

## 3. Architecture in one paragraph

Next.js + TypeScript frontend; PostgreSQL via Supabase Pro ($25/mo) with row-level security and DB-enforced integrity; private object storage for immutable documents; a small Python (FastAPI) worker running PaddleOCR PP-OCRv5 (free, Devanagari+English) with pg-boss for background jobs; email/in-app notifications; total operating cost **≈ $30–40/month**; weekly off-site encrypted backups with quarterly restore drills. This stack is boring, cheap, portable (full export is a P1 deliverable), and within the skills reach of Pulchowk student developers.

## 4. Highest-risk financial-control problems (ranked)

1. **Unrecorded/unreimbursed member spending** — resolved by submission workflow + reimbursement queue + outstanding-claims visibility.
2. **Cash advances never settled** — resolved by advance state machine + aging alerts.
3. **Double-counting personal spend + reimbursement** — resolved by claim/payment separation and derivation rules (doc 06 §5).
4. **Sponsorship commitments treated as cash** — resolved by pipeline state machine (committed ≠ received, structurally).
5. **Silent corruption via OCR or over-merging** — resolved by confidence + human review + never-auto-merge policy.
6. **Continuity loss at committee handover** — resolved by org-owned infrastructure, runbooks, and exportable history.

## 5. Conditions before development starts

1. FM reviews all 13 documents, especially **12_OPEN_QUESTIONS_AND_ASSUMPTIONS.md** — Critical questions (Q1–Q4, Q6) answered.
2. Phase 0 data inventory completed (Q4/Q5).
3. FM signs off Phase 1 acceptance criteria (doc 11).
4. At least one successor operator identified (Q9).

Until then: **no application implementation has been or should be started.**

## 6. Expected outcome

Within one committee cycle, FINANCE TRACKER will be able to state, from evidence: how much it has spent and on what, who is owed money, which sponsors have paid, what cash it truly holds, and what share of its records are verified — with every number drillable to a transaction and every transaction drillable to a document.
