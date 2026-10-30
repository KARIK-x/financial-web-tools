# FINANCIAL REPORT CATALOG

Reports are generated from posted journal entries, recorded payments, claims, budgets, sponsors, and accounts.

| Report | Source | Filters | Export |
|---|---|---|---|
| Executive summary | Journal, payments, claims, sponsors, accounts | Period | CSV, JSON, Excel, PDF |
| Trial balance | Journal lines | Period | CSV, JSON, Excel, PDF |
| Cash flow | Payments | Period | CSV, JSON, Excel, PDF |
| Expense register | Claims | Period, status, category, event, member, text | CSV, JSON, Excel, PDF |
| Categories | Claims | Period | CSV, JSON, Excel, PDF |
| Events | Allocations | Period | CSV, JSON, Excel, PDF |
| Sponsorship | Sponsorship agreements and receipts | All | CSV, JSON, Excel, PDF |
| Budgets | Budget lines and allocations | All | CSV, JSON, Excel, PDF |
| Advances | Advances | All | CSV, JSON, Excel, PDF |
| Accounts | Financial accounts | All | CSV, JSON, Excel, PDF |
| Audit | Audit events | Period | CSV, JSON, Excel, PDF |
| Bank lines | Bank statement lines | Period | CSV, JSON, Excel, PDF |

Verification evidence:
- `tests/report-export-verification.test.ts` compares export totals with underlying records.
- `tests/financial-scenarios.test.ts` verifies core accounting scenarios.
- E2E export test verifies CSV and JSON downloads.
