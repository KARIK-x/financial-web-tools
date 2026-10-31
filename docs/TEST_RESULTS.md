# TEST RESULTS

**Run date:** 2026-10-24
**Environment:** macOS (darwin), Node v24.20.0, local PGlite, system Chrome for E2E.
**Repository:** `/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION`

Every result below was produced by running the command in the project root. No results are estimated. Baseline and post-remediation results are separated so prior claims are not confused with current evidence.

---

## 1. Baseline (before remediation)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **TESTED-PASS**, exit 0 |
| Unit/integration | `npm test` | **TESTED-PASS**, 11 files, 96/96 |
| E2E | `npm run test:e2e` | **TESTED-PASS**, 6/6 |
| Build | `npm run build` | **TESTED-PASS** |

---

## 2. Final TypeScript

```bash
npx tsc --noEmit
```

**Result:** **TESTED-PASS**, exit 0, no diagnostics.

---

## 3. Final unit and integration tests (Vitest)

```bash
npm test
```

**Result:**

```
Test Files  15 passed (15)
     Tests  117 passed (117)
  Duration  18.13s
```

Tests run against **real migrations and a real PGlite database**, not mocks, so constraints and triggers are exercised.

| File | Tests | Focus |
|---|---:|---|
| `tests/advances.test.ts` | 7 | Disbursement, settlement, return cap, status refresh |
| `tests/backup-restore.test.ts` | 1 | Backup checksum/manifest, disposable restore, document readback, session revocation |
| `tests/budgets.test.ts` | 6 | BS fiscal years, committed vs paid, overspend alerts |
| `tests/claim-lifecycle.test.ts` | 17 | Submit → approve → pay → verify, thresholds, separation of duties |
| `tests/csv.test.ts` | 5 | Quoting, formula-injection guard |
| `tests/db-integrity.test.ts` | 12 | Journal balance, immutability, deletion guards, self-approval |
| `tests/documents.test.ts` | 7 | SHA-256 dedupe, storage keys, near-duplicate hashing |
| `tests/financial-scenarios.test.ts` | 10 | Scenarios A–J: double counting, partial payment, advance, sponsor, transfer, statement, split, reversal, unverified, duplicate receipt |
| `tests/money.test.ts` | 13 | Paisa parsing/formatting, shorthand, Nepali digits, limits |
| `tests/nepali-date.test.ts` | 9 | AD/BS conversion, fiscal-year boundaries |
| `tests/ocr.test.ts` | 2 | Real Tesseract execution on a synthetic English receipt; invoice false-positive regression; unsupported input |
| `tests/permissions.test.ts` | 7 | Role matrix, ADMIN lockout prevention |
| `tests/security-controls.test.ts` | 8 | MFA TOTP/replay/recovery/reset, period close/reopen, durable rate-limit restart, document/claim authorization, cross-member/cross-claim attach rejection, review authorization, filtered summary scope |
| `tests/sponsors.test.ts` | 6 | Pledges, receipts, deliverables, over-receipt state |
| `tests/statement-parser.test.ts` | 7 | Header detection, debit/credit mapping, dates, dedupe fingerprints |

### Notable regression tests
- Claim approval inside a transaction does not deadlock (uses the transaction executor).
- Re-importing an identical statement skips duplicates without aborting.
- Compound money shorthand (`1 lakh 50 thousand`) parses; trailing junk is rejected.
- A single over-budget line triggers an overspend alert.
- Bigint values from PGlite are normalised to numbers in advance views.
- `summarizeClaims` applies viewer scope and every active filter.
- Cross-member document attach, cross-claim reattachment, and unauthorised review are rejected.
- Reversing a finalized payment preserves the original and links the reversal.
- Closed-period postings/claims are rejected; reopen is audited.
- Durable rate-limit counters survive a database reopen.
- MFA recovery codes are single-use; TOTP replay is rejected; administrator reset clears MFA, revokes sessions, and is audited.
- Backup restore revokes restored sessions and verifies document hashes.

---

## 4. Final production build

```bash
npm run build
```

**Result:** **TESTED-PASS**, exit 0. No warnings. The route list includes:

```
/mfa-setup
/overview /my-expenses /expenses /expenses/new /expenses/[id]
/approvals /receipts /receipts/[id]
/advances /advances/[id] /sponsors /sponsors/[id]
/accounts /reconciliation /events /events/[id]
/members /vendors /reports /analytics /reconstruction
/audit /import-export /settings /no-access
/api/documents/[id] /api/export/[type]
```

---

## 5. Final browser end-to-end tests (Playwright)

### Against the live demo database

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

6 passed (21.4s)
```

### Against a disposable database copy

```bash
E2E_BASE_URL=http://localhost:3400 npm run test:e2e
```

**Result:** **6/6 passed** in 18.3 s. The app was started with `DATABASE_DIR`/`DOCUMENT_DIR` pointing at a disposable copy of the demo database, not the live data.

The suite is serial because the claim created by the member is approved by finance. It reads credentials from `.data/demo-credentials.txt` without printing them.

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

## 6. MFA browser flow (disposable database)

Run against a disposable copy of the database with `MFA_ENFORCE=true` and a synthetic admin user:

1. Sign in with password → redirect to `/mfa-setup`.
2. Read the generated enrollment secret from the page.
3. Generate a TOTP code, submit it, and enable MFA.
4. Verify ten recovery codes are shown once.
5. Sign out and sign in with a fresh TOTP code.
6. Sign out and sign in with a recovery code.

**Result:** **TESTED-PASS**, `MFA_E2E_PASS`.

This test used a disposable database and was removed afterward; it did not enable MFA on the demo users.

---

## 7. Database integrity checks

Current demo database after final E2E runs:

```
Migrations: 001_init.sql, 002_reference.sql, 003_operational_hardening.sql
Public tables: 39
Claims: 12 (12 synthetic)
Payments: 10
Documents: 9 rows / 10 files (1 orphan preserved)
Journal: 19 entries / 39 lines
Debit: 59,575,000 paisa
Credit: 59,575,000 paisa
Unbalanced entries: 0
Audit events: 69
Bank lines: 6
Accounting periods closed: 0
Non-synthetic financial rows: 0
```

The E2E suite added synthetic claims/payments. The earlier seed state (9 claims, 7 payments, 13 journals) is preserved in the verified backups.

---

## 8. Backup and restore drill

**Backup:** `/Users/ashim/finance-tracker-backups/20261024-160509-final-drill`

| Step | Command | Result |
|---|---|---|
| Create | `npm run db:backup -- --out …` | **TESTED-PASS** |
| Verify checksums/manifest | `npm run db:verify-backup -- --from …` | **`VERIFIED`** |
| Restore to disposable target | `npm run db:restore -- --from … --database-dir … --document-dir …` | **TESTED-PASS** |
| Verify restored DB/files | `npx tsx scripts/verify-restored.ts … --from …` | **`RESTORED DATABASE VERIFIED`** |
| E2E against restored DB | `E2E_BASE_URL=… npm run test:e2e` | **6/6 passed** |

Restored counts matched the manifest: 12 claims, 9 documents (10 files), 19 journal entries / 39 lines, debit = credit = 59,575,000, 69 audit events. The disposable directory was removed after the drill.

The backup contains the database, documents, checksums, manifest, git commit, and timestamp. It intentionally excludes credentials and environment files.

---

## 9. CSP header check

Production server (`npm start`) response for `/login`:

```
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(self), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'
```

**Result:** **TESTED-PASS**. Residual risk: `unsafe-inline` is required by the current Next.js inline bootstrap/styles; a nonce-based CSP remains future work.

---

## 10. OCR verification

| Check | Result |
|---|---|
| English image OCR | **TESTED-PASS** — Tesseract 5.5.0 extracted `TOTAL NPR 5,000.00`, date `2026-10-20`, total 500,000 paisa from a generated receipt |
| Invoice false positive | **TESTED-PASS** — `TOTAL` is not captured as an invoice number |
| Unsupported input | **TESTED-PASS** — returns an error instead of fabricating fields |
| Nepali/Devanagari | **BLOCKED** — only `eng`, `osd`, `snum` installed |
| Scanned PDF | **BLOCKED** — no `pdftoppm`/`pdftotext`/rasteriser |
| Text-layer PDF | **IMPLEMENTED** — pdfjs path exists; no synthetic PDF fixture added |

---

## 11. What is not covered by automated tests

| Area | Reason | Status |
|---|---|---|
| Managed PostgreSQL migration | No server/client/credentials | **BLOCKED** |
| PostgreSQL PITR/restore | Depends on managed target | **BLOCKED** |
| Nepali OCR | `nep` traineddata unavailable | **BLOCKED** |
| Scanned-PDF OCR | No rasteriser | **BLOCKED** |
| Real historical import | No stable source ledger/importer | **BLOCKED** |
| Email/notifications/password reset | Not implemented | **BLOCKED** |
| Multi-process concurrency | PGlite single process | **NOT-TESTED** |
| Scheduled/offsite encrypted backups | Scripts exist; no scheduler/remote storage | **NOT-TESTED** |
| Audit hash chain | Not implemented | **NOT-TESTED** |
| Malware scanning | Not implemented | **NOT-TESTED** |
| Export truncation at 20,000 rows | Dataset too small | **NOT-TESTED** |
| Negative-balance policy | Product decision pending | **NOT-TESTED** |

---

## 12. Reproducing

```bash
cd "/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION"
npm ci
npx tsc --noEmit
npm test
npm run build
npm run test:e2e
```

The E2E suite starts its own dev server unless `E2E_BASE_URL` is set. It adds synthetic claims/payments to the demo database; do not run it against real data.

Backup verification:

```bash
npm run db:backup -- --out /secure/finance-tracker-backup
npm run db:verify-backup -- --from /secure/finance-tracker-backup
```

Stop any running app before backup/restore/reset/seed.

---

## 13. Verdict

All recorded automated checks pass on 2026-10-24. The application is stable for evaluation and controlled single-instance use after the remaining production items are addressed. It is **not** a verified managed-PostgreSQL deployment, and the OCR/import/email blockers remain.
