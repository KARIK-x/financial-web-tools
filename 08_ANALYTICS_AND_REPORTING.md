# Analytics and Reporting

**Date:** 2026-10-24. Principle: every metric has a definition, a formula, data requirements, limitations, visualization, and a release assignment. No vanity charts.

## 1. Core Metrics (P1–P3)

| Metric | Purpose | Formula | Data needed | Limitations | Viz | Release |
|---|---|---|---|---|---|---|
| Verified total expenditure | Ground-truth spend | Σ claims where status≥VERIFIED (dedup allocations once) | verified claims | Excludes valid-but-unverified spend; always show alongside | KPI card + trend line | P1 |
| Claimed (unverified) expenditure | Exposure view | Σ claims UNVERIFIED/APPROVED-not-verified | any claim | May include duplicates/rejects | KPI card (paired) | P1 |
| Missing-receipt exposure | Control gap | Σ claim amounts where documentation_state ≠ COMPLETE | claims + docs | Missing ≠ did not happen | KPI + list | P1 |
| Outstanding reimbursements | Cash owed to members | Σ claim amounts status=PENDING_REIMBURSEMENT (+ REIMBURSED-unpaid if any) | claims, payments | Depends on payment recording discipline | KPI + aging table | P1 |
| Outstanding advances | Money held by members | Σ advance.outstanding_amount where not settled | advances | Requires advance records | KPI + list | P2 |
| Sponsor committed vs received | Revenue pipeline | per agreement: promised, received (Σ payments), outstanding | agreements, payments | Commitments are soft | Grouped bar + pipeline funnel | P2 |
| Documentation completion rate | Evidence health | claims with COMPLETE docs / total claims | claims, docs | Historical backlog skews it | Donut + trend | P1 |
| Budget vs actual per event | Control | per budget line: allocated vs Σ verified allocations (+ committed) | budgets, allocations | Accrual vs cash distinction shown | Bullet/progress bars | P2 |
| Spend by category/event/member/vendor | Understanding | Σ verified by dimension | verified claims | Member view for accountability, not ranking | Bar/treemap | P2 |
| Monthly cash flow | Liquidity | Σ inflows − outflows by month (payments table, type≠transfer) | payments | Cash-basis only in P3 | Column chart | P3 |
| Cash & bank balances | Position | derived per account; reconciled flag shown | payments, reconciliations | Unreconciled = provisional | KPI + "as of" stamp | P3 |

## 2. Control Metrics (P2–P3)
- **Average reimbursement cycle time** — claim→payment days; purpose: member experience; limitation: small samples per member.
- **Approval backlog** — count + NPR awaiting approval >7 days; work-queue viz.
- **Reconciliation completion rate** — reconciled periods / closed periods.
- **Duplicate risk score** — count of active duplicate proposals + historical false-merge rate (P2).

## 3. Intelligence (P4) — with explicit advisory framing
- **Anomaly detection:** exact/near duplicate transactions; repeated round amounts from same member (≥3× same NPR 1,000); amount outliers per category (median + MAD); expenses dated outside event windows; split-across-claims pattern (same vendor, same day, multiple claims summing > threshold). All surfaced as "review suggestions", never auto-flagged as wrongdoing, never visible to general members.
- **Budget intelligence:** category burn-rate projection (linear extrapolation + event-shape curve), forecast overspend alerts at 80% consumption, year-over-year event cost comparison.
- **Forecasting:** expected sponsorship cash (per agreement × historical receipt lag), expected reimbursement obligations, 3-month cash requirement projection with scenario toggles (commit/conservative).
- **Natural-language queries (P4):** constrained NL→SQL over a read-only semantic layer with: (a) mandatory grounding — response lists the underlying transactions or a drill-down link; (b) period + basis + verification filter displayed with every answer; (c) estimates labeled ESTIMATED, never presented as verified; (d) write operations impossible; the AI cannot approve, edit, or pay anything. Example supported questions exactly as briefed (spend this year, latest event cost, missing receipts, owed to members, unpaid sponsors, budget breaches, vendor transactions, cross-event transport comparison, current reconciled balances).

## 4. Reporting Safeguards
1. Every report header: period, basis (cash/accrual), verification filter, generation timestamp.
2. Verified and claimed amounts never summed into one number without visual separation.
3. Drill-down path from any figure → transactions → documents (full traceability).
4. Export watermark/label: "Contains unverified claims" when applicable.
5. Anomaly outputs phrased neutrally ("three similar transactions — review suggested"), reviewed by a human before any member is contacted.
