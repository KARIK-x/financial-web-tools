# PRODUCTION READINESS

Status labels used throughout: `IMPLEMENTED`, `TESTED-PASS`, `TESTED-FAIL`, `NOT-TESTED`, `BLOCKED`.

This document is the current release-readiness record for the LOCUS Finance Intelligence Platform. It reflects the repository as inspected and tested on 2026-10-24. It does not claim that blocked external services work.

## 1. Executive summary

- The application builds and typechecks: `npx tsc --noEmit` pass, `npm run build` pass.
- Automated tests pass: `134 passed | 3 skipped` across 19 unit/integration files, plus `6/6` Playwright E2E tests.
- PostgreSQL support is implemented and locally verified: PGlite remains the default; `DATABASE_URL` selects managed PostgreSQL. Adapter and migration tests pass against disposable PostgreSQL 16.15.
- Backups are implemented and a restore drill passed against a disposable database.
- Nepali/Devanagari OCR is implemented and verified against a real Nepali Tesseract model and a scanned PDF.
- Production email is implemented with an adapter, outbox, templates, password reset and reminders; actual delivery remains `BLOCKED` without provider credentials.
- Malware scanning, upload validation, negative-balance controls, sponsor over-receipt review, orphan cleanup, sole-admin break-glass and nonce CSP are implemented.
- Managed PostgreSQL cutover, provider PITR, real email delivery, and historical bulk import remain blocked on external inputs or policy decisions.

## 2. Build and test evidence

| Check | Result |
|---|---|
| TypeScript strict typecheck | `TESTED-PASS` |
| Production build | `TESTED-PASS` |
| Unit/integration tests | `134 passed, 3 skipped` |
| Playwright E2E | `6/6 passed` |
| PostgreSQL adapter tests | `3/3 passed` with `TEST_DATABASE_URL` |
| OCR tests | `5/5 passed` |
| Financial controls tests | `5/5 passed` |
| Historical import tests | `2/2 passed` |
| Malware tests | `4/4 passed` |
| Backup verification | `VERIFIED` |

## 3. Database and migration readiness

| Item | Status | Evidence |
|---|---|---|
| PGlite default driver | `IMPLEMENTED`, `TESTED-PASS` | Default `createDatabase({})` |
| Managed PostgreSQL adapter | `IMPLEMENTED`, `TESTED-PASS` | `src/server/pg-db.ts`; pool, SSL, timeouts, transactions, int8 parsing |
| `DATABASE_URL` selection | `IMPLEMENTED`, `TESTED-PASS` | `databaseConfigFromEnv()` |
| Scripts use env selection | `IMPLEMENTED`, `TESTED-PASS` | migrate, reset-demo, seed-demo, create-admin |
| Disposable PostgreSQL migration | `IMPLEMENTED`, `TESTED-PASS` | `scripts/migrate-to-postgres.ts`; `MIGRATION VERIFIED` |
| Production cutover | `BLOCKED` | No managed provider credentials or production `DATABASE_URL` |
| Provider PITR | `BLOCKED` | No managed provider account |

## 4. Backup and restore

| Item | Status | Evidence |
|---|---|---|
| Backup creation and verification | `IMPLEMENTED`, `TESTED-PASS` | `npm run db:backup`, `db:verify-backup` |
| Restore and database verification | `IMPLEMENTED`, `TESTED-PASS` | Disposable restore drill passed |
| Session revocation on restore | `IMPLEMENTED`, `TESTED-PASS` | Restore revokes sessions by default |
| Offsite/encrypted storage | `NOT-TESTED` | Not implemented |
| Scheduled backups | `NOT-TESTED` | Not implemented |

## 5. OCR

| Item | Status | Evidence |
|---|---|---|
| English OCR | `IMPLEMENTED`, `TESTED-PASS` | Tesseract `eng`, tests pass |
| Nepali/Devanagari OCR | `IMPLEMENTED`, `TESTED-PASS` | `nep.traineddata` installed; real Nepali text extracted |
| Devanagari numerals and NPR formats | `IMPLEMENTED`, `TESTED-PASS` | Unit tests |
| BS/AD dates | `IMPLEMENTED`, `TESTED-PASS` | Unit tests |
| Scanned and mixed PDF OCR | `IMPLEMENTED`, `TESTED-PASS` | MuPDF.js rasterization; `tests/ocr-nepali-pdf.test.ts` |
| Embedded-text PDF OCR | `IMPLEMENTED`, `TESTED-PASS` | pdfjs-dist text extraction |
| OCR review and provenance | `IMPLEMENTED`, `TESTED-PASS` | `ocr_extractions`, review statuses, source/page/confidence |
| OCR never writes claims or journals | `IMPLEMENTED`, `TESTED-PASS` | By design |

## 6. Email and password reset

| Item | Status | Evidence |
|---|---|---|
| Resend HTTPS adapter | `IMPLEMENTED`, `TESTED-PASS` (adapter) | `src/server/email.ts` |
| Config validation | `IMPLEMENTED`, `TESTED-PASS` | `tests/email.test.ts` |
| Outbox and retry | `IMPLEMENTED`, `TESTED-PASS` | Tests cover failure/backoff/retry |
| Password reset tokens | `IMPLEMENTED`, `TESTED-PASS` | Hashed, single-use, 30-minute TTL, session revocation |
| Claim notifications | `IMPLEMENTED`, `TESTED-PASS` (composition) | `src/server/notifications.ts` |
| Daily reminders | `IMPLEMENTED`, `TESTED-PASS` (composition) | `scripts/queue-reminders.ts` |
| Real delivery | `BLOCKED` | No provider credentials |

## 7. Security controls

| Item | Status | Evidence |
|---|---|---|
| MFA for privileged roles | `IMPLEMENTED`, `TESTED-PASS` | TOTP, recovery codes, replay protection, reset |
| Sole-admin break-glass | `IMPLEMENTED`, `NOT-TESTED` (UI/ops) | `scripts/mfa-break-glass.ts`; unit test pass |
| Durable rate limiting | `IMPLEMENTED`, `TESTED-PASS` | Survives database reopen |
| Persistent lockout | `IMPLEMENTED`, `TESTED-PASS` | `users.locked_until` |
| Document authorization | `IMPLEMENTED`, `TESTED-PASS` | Cross-member and cross-claim tests |
| CSP | `IMPLEMENTED`, `TESTED-PASS` | Static headers plus nonce proxy; E2E pass |
| Malware scanning | `IMPLEMENTED`, `TESTED-PASS` (adapter) | ClamAV unavailable in this environment; fake-scanner tests pass |
| Upload validation | `IMPLEMENTED`, `TESTED-PASS` | Magic bytes, size, MIME, NUL checks |
| Orphan cleanup | `IMPLEMENTED`, `TESTED-PASS` | Dry-run default; referenced files protected |
| Negative balances | `IMPLEMENTED`, `TESTED-PASS` | Transfer, claim payment and advance disbursement guards |
| Sponsor over-receipt review | `IMPLEMENTED`, `TESTED-PASS` | `over_received_paisa`, audit event, UI warning |
| Application-level encryption at rest | `BLOCKED`/not implemented | Provider-managed encryption recommended |

## 8. Financial integrity

| Item | Status | Evidence |
|---|---|---|
| Double-entry ledger | `IMPLEMENTED`, `TESTED-PASS` | Journal totals and triggers |
| Payment reversal | `IMPLEMENTED`, `TESTED-PASS` | Linked reversal, void original, excluded from aggregates |
| Fiscal period lock | `IMPLEMENTED`, `TESTED-PASS` | Close/reopen and guards |
| Financial scenarios A–J | `IMPLEMENTED`, `TESTED-PASS` | `tests/financial-scenarios.test.ts` |
| Financial controls K–O | `IMPLEMENTED`, `TESTED-PASS` | `tests/financial-controls.test.ts` |
| Sponsor over-receipt review | `IMPLEMENTED`, `TESTED-PASS` | `tests/financial-controls.test.ts` |

## 9. Imports and historical data

| Item | Status | Evidence |
|---|---|---|
| Bank statement import | `IMPLEMENTED`, `TESTED-PASS` | Fingerprinting and duplicate handling |
| Receipt upload and deduplication | `IMPLEMENTED`, `TESTED-PASS` | SHA-256 and perceptual hash |
| Historical claims staged import | `IMPLEMENTED`, `TESTED-PASS` | Preview, validation, duplicates, commit; imported rows remain unverified |
| Generic historical sponsor import | `BLOCKED` | Source workbooks are heterogeneous; no safe generic importer |
| Opening balances | `IMPLEMENTED` | One account at a time |

## 10. Remaining blockers

1. Managed PostgreSQL production cutover and provider PITR: no provider credentials or `DATABASE_URL`.
2. Real email delivery: no Resend/SMTP credentials.
3. ClamAV installation: Homebrew installation failed in this environment; adapter is ready and reports `UNAVAILABLE`.
4. Historical sponsor ledger bulk import: no stable source schema.
5. Committee delegation, budget revisions UI, notification centre, multi-organisation scoping, retention/legal hold, accessibility audit, observability: not implemented.
6. Sole-admin break-glass operation is implemented but requires out-of-band token setup and operator discipline.

## 11. Required environment variables

- `DATABASE_URL` or `DATABASE_DIR`
- `APP_URL`
- `MFA_ENFORCE`
- `ALLOW_NEGATIVE_ACCOUNT_BALANCE`
- `MALWARE_SCAN_REQUIRED`
- `MAX_UPLOAD_BYTES`
- `CLAMSCAN_PATH`
- `CSP_REPORT_ONLY`
- `CSP_REPORT_URI`
- `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_API_BASE_URL`
- `MFA_BREAK_GLASS_TOKEN_HASH`

## 12. Recommended next actions

1. Provision managed PostgreSQL and run `npm run db:migrate-to-postgres` against a disposable target.
2. Complete a provider-level restore/PITR drill and record it.
3. Obtain email provider credentials and run a real delivery test.
4. Install or provide ClamAV and rerun malware tests against a real scanner.
5. Complete the remaining P1 operational features before real-money use.
