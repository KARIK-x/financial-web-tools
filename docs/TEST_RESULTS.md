# TEST RESULTS

**Run date:** 2026-10-24
**Environment:** macOS (darwin), Node v24.20.0, npm, local PGlite, system Chrome for E2E.

Every result below was produced by running the command in the project root. No results are estimated.

---

## 1. TypeScript

```bash
npx tsc --noEmit
```

**Result:** exit 0, no diagnostics.

---

## 2. Unit and integration tests (Vitest)

```bash
npm test
```

**Result:**

```
Test Files  11 passed (11)
     Tests  96 passed (96)
  Duration  13.80s
```

Tests run against **in-memory PGlite with the real migrations**, not mocks, so constraints and triggers are exercised.

| File | Tests | Focus |
|---|---:|---|
| `tests/advances.test.ts` | 7 | Disbursement, settlement, return cap, status refresh |
| `tests/budgets.test.ts` | 6 | BS fiscal years, committed vs paid, overspend alerts |
| `tests/claim-lifecycle.test.ts` | 17 | Submit → approve → pay → verify, thresholds, separation of duties |
| `tests/csv.test.ts` | 5 | Quoting, formula-injection guard |
| `tests/db-integrity.test.ts` | 12 | Journal balance, immutability, deletion guards, self-approval |
| `tests/documents.test.ts` | 7 | SHA-256 dedupe, storage keys, near-duplicate hashing |
| `tests/money.test.ts` | 13 | Paisa parsing/formatting, shorthand, Nepali digits, limits |
| `tests/nepali-date.test.ts` | 9 | AD/BS conversion, fiscal-year boundaries |
| `tests/permissions.test.ts` | 7 | Role matrix, ADMIN lockout prevention |
| `tests/sponsors.test.ts` | 6 | Pledges, receipts, deliverables, over-receipt state |
| `tests/statement-parser.test.ts` | 7 | Header detection, debit/credit mapping, dates, dedupe fingerprints |

### Notable regression tests
- Claim approval inside a transaction does not deadlock (uses the transaction executor).
- Re-importing an identical statement skips duplicates without aborting.
- `paymentCandidatesForImport` binds its parameters correctly (previously a runtime type error).
- Compound money shorthand (`1 lakh 50 thousand`) parses; trailing junk is rejected.
- A single over-budget line triggers an overspend alert.
- Bigint values from PGlite are normalised to numbers in advance views.

---

## 3. Production build

```bash
npm run build
```

**Result:** exit 0. All 26 routes compiled; no warnings. Output includes the dynamic routes:

```
/login /setup /change-password /overview /my-expenses /expenses /expenses/new
/expenses/[id] /approvals /receipts /receipts/[id] /advances /advances/[id]
/sponsors /sponsors/[id] /accounts /reconciliation /events /events/[id]
/members /vendors /reports /analytics /reconstruction /audit
/import-export /settings /no-access
/api/documents/[id] /api/export/[type]
```

---

## 4. Browser end-to-end tests (Playwright)

```bash
npm run test:e2e
```

**Result:**

```
Running 6 tests using 1 worker
✓ member can sign in and create a claim
✓ finance approves, pays and verifies the claim
✓ reconciliation shows the seeded statement and its open line
✓ auditor sees the audit trail but no approval actions
✓ admin can export claims as CSV and JSON
✓ admin settings page loads the role matrix

6 passed (20.1s)
```

The suite is serial because each test builds on the previous one (the claim created by the member is approved by finance). It uses the synthetic demo dataset and reads credentials from `.data/demo-credentials.txt` without printing them.

Covered behaviours:
- Member cannot see Approvals/Settings links.
- Direct navigation to `/approvals` as a member renders **Access restricted**, not a 500.
- Claim creation with missing-receipt declaration.
- Finance approval, payment, and verification.
- Seeded statement and its intentionally open line.
- Auditor read-only access to the audit trail.
- CSV and JSON export responses.
- Admin role matrix page.

---

## 5. Database integrity checks

The demo seed reports:

```
Claims:        9
Payments:      7
Documents:     9
Journal:       13 entries (balanced)
Bank lines:    5 matched, 1 open
Fiscal period: Fiscal year 2083/84 (2026-07-17 to 2027-07-16)
```

A direct query confirmed **13 journal entries / 27 lines**, with **58,855,000 paisa debits = 58,855,000 paisa credits**.

---

## 6. What is not covered by automated tests

| Area | Reason | Manual check |
|---|---|---|
| Real bank statement layouts | Only synthetic fixtures; real formats vary | Import a redacted real statement |
| Nepali OCR | `nep` traineddata unavailable | Manual entry; capability banner |
| Scanned PDF OCR | No rasteriser | Use a text-layer PDF or photo |
| Email/notifications | Not implemented | — |
| Multi-process concurrency | PGlite single process | — |
| Restore from backup | Destructive | Rehearse per `BACKUP_AND_RESTORE.md` |
| Forced password change UI | Covered by typecheck/build, not E2E | Sign in with a newly created user |
| Export truncation at 20,000 rows | Dataset too small | Load synthetic volume or unit-test the cap |

---

## 7. Reproducing

```bash
cd "/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION"
npm ci
npx tsc --noEmit
npm test
npm run build
npm run db:reset-demo && npm run db:seed-demo
npm run test:e2e
npm run db:reset-demo && npm run db:seed-demo   # restore pristine demo
```

Stop any running dev server before reset/seed. E2E starts its own dev server unless `E2E_BASE_URL` is set.

---

## 8. Verdict

All automated checks pass on the recorded date. The application is stable for evaluation and for a controlled single-instance deployment after the hardening items in `TASK_QUEUE.md` are addressed.
