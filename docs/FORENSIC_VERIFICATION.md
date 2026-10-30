# FORENSIC VERIFICATION

**Verified:** 2026-10-24
**Repository:** `/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION`
**Baseline commit:** `f2a81d0` (research archive preserved at `5fec879`)
**Final code state:** working tree, uncommitted at the time of this report
**Method:** inspected the documentation, source, migrations, on-disk database, document store, tests, running application, and disposable restore. Prior completion claims were treated as hypotheses until a command or test supported them.

Status labels used in this document:

- **IMPLEMENTED** — code exists and is wired into a real workflow.
- **TESTED-PASS** — a command/test actually exercised the behaviour and passed.
- **TESTED-FAIL** — exercised and failed.
- **NOT-TESTED** — not built, or built but no adequate evidence yet.
- **BLOCKED** — cannot be completed in this environment without an external dependency or credential.

A feature is not marked TESTED-PASS merely because its implementation exists.

---

## 1. Baseline evidence (before this remediation phase)

| Check | Command | Baseline result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **TESTED-PASS**, exit 0 |
| Unit / integration | `npm test` | **TESTED-PASS**, 11 files, 96/96 tests |
| Browser E2E | `npm run test:e2e` | **TESTED-PASS**, 6/6 tests |
| Production build | `npm run build` | **TESTED-PASS** |
| Database | PGlite `.data/pglite` | 36 public tables; migrations `001`, `002` |
| Financial data | Direct query | 13 balanced journals; debit = credit = 58,855,000 paisa; all synthetic |
| Documents | `.data/documents` | 9 rows, 10 files, 1 orphan, 0 missing referenced files |
| Managed PostgreSQL | `psql`, server, credentials | absent — **BLOCKED** |
| Nepali OCR | Tesseract languages | `eng`, `osd`, `snum` only — `nep` **BLOCKED** |
| Scanned-PDF OCR | `pdftoppm` / `pdftotext` | absent — **BLOCKED** |

The pre-change state was preserved before modification at:

- `/Users/ashim/locus-backups/20261024-125330` (pre-change, checksums verified)
- `/Users/ashim/locus-backups/20261024-140908-pre-003` (pre-migration, `VERIFIED`)

---

## 2. Database that is actually in use

**Finding: embedded PostgreSQL-compatible PGlite 0.5.11, not a managed PostgreSQL server.**

Evidence:

- `package.json` depends on `@electric-sql/pglite` `0.5.11`.
- `src/server/db.ts` constructs `new PGlite(dataDir)` and defaults `DATABASE_DIR` to `.data/pglite`.
- `.data/pglite/` is a local PostgreSQL data directory, not a mock.
- No `pg` adapter, `psql`, `pg_dump`, PostgreSQL server, or managed connection string is present.
- PGlite is single-process; two app processes cannot safely share the directory.

After migration `003_operational_hardening.sql`:

| Check | Result |
|---|---|
| Public tables | **39** |
| Applied migrations | `001_init.sql`, `002_reference.sql`, `003_operational_hardening.sql` |
| Journal entries / lines | **19 / 39** |
| Debit = credit | **59,575,000 paisa = 59,575,000 paisa** |
| Unbalanced journal entries | **0** |

The schema is ordinary PostgreSQL SQL. It uses no extensions and no PGlite-only syntax. It is therefore a credible target for a future PostgreSQL migration, but the migration itself has **not** been executed. See `POSTGRESQL_MIGRATION_PLAN.md`.

---

## 3. What financial records exist

**Finding: the database contains synthetic demo records only. No real LOCUS financial history was supplied or reconstructed.**

Current counts after the final E2E runs:

| Table | Rows |
|---|---:|
| users / members | 6 / 6 |
| expense_claims | 12 |
| payments | 10 |
| documents | 9 |
| journal_entries / journal_lines | 19 / 39 |
| bank_statement_lines | 6 |
| audit_events | 69 |
| accounting_periods | 0 |
| non-synthetic financial rows | **0** |

The E2E suite intentionally creates synthetic claims/payments in the demo database. The counts above are therefore not the original seed counts. Every financial row remains flagged `is_synthetic = true`.

The personal eSewa statement in `~/Downloads` was **not** imported. It belongs to an individual, not LOCUS. The historical sponsor files were inspected read-only (see §8), not imported.

No historical LOCUS total is asserted anywhere in this report.

---

## 4. Documents and the orphan file

**Finding: private local filesystem, content-addressed by SHA-256.**

- `src/server/storage.ts` stores files at `<sha256[0:2]>/<sha256[2:4]>/<sha256><ext>` under `DOCUMENT_DIR` or `.data/documents`.
- Database `documents` rows store `storage_key`, `sha256`, MIME, size, uploader, claim link, OCR fields, duplicate flags, and review state.
- `/api/documents/[id]` checks session, `document.view`/`document.view.all`, uploader identity, or claim claimant identity before streaming.
- Exact duplicate uploads are blocked by SHA-256; near-duplicates are flagged by a 64-bit average hash and never auto-merged.
- Document deletion and byte mutation are blocked by trigger.

Current state: **9 database rows, 10 files on disk**.

- 9 files match their DB row and SHA-256.
- **1 orphan file** remains: `18/50/1850fc7b72de80ce5833dd5f00b58d0526989ae7a9fc9253a486be4af2028299.png`.
- The orphan has no database row. It is preserved by every backup and reported by the restore verifier. It was not deleted because it may be an interrupted upload and the data-preservation rule forbids silent deletion.
- A possible cause is `uploadOne` writing the file before the database insert; if the insert fails, the file remains. This is recorded as a low-severity defect and a future cleanup job, not a ledger corruption.

---

## 5. Persistence and restart behaviour

**Finding: local data persists across a normal process restart, but this is not durable production storage.**

- PGlite writes to `.data/pglite`; documents are files under `.data/documents`.
- A normal stop/start does not lose data.
- A backup taken while the app is writing can be inconsistent. The documented procedure and scripts require the app to be stopped.
- The application cannot be horizontally scaled, run on a read-only/serverless filesystem, or safely run two processes against one PGlite directory.
- A managed PostgreSQL migration is required for production. It is **BLOCKED** here because no server/client/credentials exist.

---

## 6. Final verification results (after remediation)

| Check | Command | Final result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **TESTED-PASS**, exit 0 |
| Unit / integration | `npm test` | **TESTED-PASS**, 15 files, **117/117** tests, 18.13 s |
| Production build | `npm run build` | **TESTED-PASS**, exit 0; `/mfa-setup` included |
| Browser E2E (live demo DB) | `npm run test:e2e` | **TESTED-PASS**, 6/6, 21.4 s |
| Browser E2E (restored DB) | `E2E_BASE_URL=… npm run test:e2e` | **TESTED-PASS**, 6/6, 18.2 s |
| Backup creation | `npm run db:backup -- --out …` | **TESTED-PASS**, `VERIFIED` |
| Backup restore | `npm run db:restore -- --from …` | **TESTED-PASS**, disposable target |
| Restored DB verification | `npx tsx scripts/verify-restored.ts …` | **TESTED-PASS**, `RESTORED DATABASE VERIFIED` |
| MFA browser flow | disposable DB, `MFA_ENFORCE=true` | **TESTED-PASS**, `MFA_E2E_PASS` |
| CSP response header | production `npm start` + `curl -D -` | **TESTED-PASS**, header present |
| English OCR | `tests/ocr.test.ts` | **TESTED-PASS**, Tesseract extracted total/date |
| Nepali OCR | capability check | **BLOCKED**, no `nep` traineddata |
| Scanned-PDF OCR | capability check | **BLOCKED**, no rasteriser |
| Managed PostgreSQL | server/client/credentials | **BLOCKED** |

### Final database check

```
migrations: 001_init.sql, 002_reference.sql, 003_operational_hardening.sql
public tables: 39
claims: 12 (12 synthetic)
payments: 10
journals: 19 entries / 39 lines
debit: 59,575,000 paisa
credit: 59,575,000 paisa
documents: 9
audit events: 69
bank lines: 6
```

### Backup restore drill (genuinely executed)

1. Created `/Users/ashim/locus-backups/20261024-160509-final-drill` from the stopped demo database.
2. `npm run db:verify-backup -- --from …` returned **`VERIFIED`**.
3. Restored into a disposable temp directory with separate database and document targets.
4. `npx tsx scripts/verify-restored.ts …` returned **`RESTORED DATABASE VERIFIED`**:
   - Claims: 12
   - Documents: 9 (10 files)
   - Journal: 19 entries / 39 lines, debit = credit = 59,575,000
   - Audit events: 69
5. Started the app against the restored database on a separate port and ran the full Playwright suite: **6/6 passed**.
6. Removed the disposable restore directory. The verified backup remains outside the repository.

The restore also revokes all sessions in the restored database by default, so an old cookie cannot revive access.

---

## 7. Defects found and what happened to them

| ID | Defect | Status |
|---|---|---|
| D-01 | Document attach action had no permission check; any signed-in user could attach any document to any claim | **TESTED-PASS** — centralized `attachDocumentToClaim`; ownership/claim-ownership/reviewer checks; closed claims and cross-claim reattachment rejected |
| D-02 | Document review action had no permission check | **TESTED-PASS** — `document.review` required |
| D-03 | `users.locked_until` was a dead field | **TESTED-PASS** — 8 failures in 15 minutes sets `locked_until`; durable limiter also applies |
| D-04 | Login rate limiting was in-memory and reset on restart | **TESTED-PASS** — durable `rate_limits` table; restart test passes |
| D-05 | Expense summary totals ignored search/event/verification/documentation filters and member scope | **TESTED-PASS** — `summarizeClaims` applies viewer scope and all filters; regression test added |
| D-06 | Advance-funded claims could exceed the outstanding advance | **TESTED-PASS** — server guard caps claim amount and rejects personal funding with an advance |
| D-07 | Advance-funded claims could also be paid in cash | **TESTED-PASS** — explicit rejection |
| D-08 | Receipts could be reattached across claims | **TESTED-PASS** — duplicate/ownership/claim checks; cross-claim attach rejected |
| D-09 | No fiscal period lock | **TESTED-PASS** — `accounting_periods`, close/reopen actions, `postJournal`/expense/payment guards; tests pass |
| D-10 | No MFA for elevated roles | **TESTED-PASS** — TOTP, replay rejection, hashed single-use recovery codes, enrollment page, admin reset; browser flow passed, reset unit test asserts revocation and audit |
| D-11 | No CSP on HTML pages | **TESTED-PASS** — enforced static CSP; residual `unsafe-inline` for Next.js inline bootstrap/styles is documented |
| D-12 | No tested backup/restore | **TESTED-PASS** — scripts, checksums, manifest, disposable restore, E2E against restored DB |
| D-13 | Payment corrections were undefined | **TESTED-PASS** — linked equal-and-opposite reversal payment/journal; original marked VOID; aggregates exclude reversal rows |
| D-14 | Orphan document file | **NOT-TESTED** — preserved and reported; cleanup-on-failed-insert not implemented |
| D-15 | Cash/bank balances can go negative | **NOT-TESTED** — deliberate; documented |
| D-16 | Sponsor receipts can exceed pledge | **NOT-TESTED** — deliberate; visible in reports |
| D-17 | No generic historical claims/sponsor importer | **BLOCKED** — source files are heterogeneous; see §8 |
| D-18 | No production email/password reset | **BLOCKED** — no SMTP/provider |
| D-19 | No Nepali OCR | **BLOCKED** — no `nep` traineddata |
| D-20 | No scanned-PDF OCR | **BLOCKED** — no rasteriser |
| D-21 | No managed PostgreSQL | **BLOCKED** — no server/client/credentials |
| D-22 | No audit hash chain | **NOT-TESTED** — append-only triggers only |
| D-23 | No application-level encryption at rest | **NOT-TESTED** — rely on disk/volume encryption |
| D-24 | No malware scanning on uploads | **NOT-TESTED** — private storage + attachment disposition only |

---

## 8. Historical import readiness

**Finding: the current application cannot safely bulk-import the supplied historical LOCUS sponsor files.**

Source files were inspected read-only outside the repository, including:

- `~/Downloads/Sponsor of locus/Sponsorships of LOCUS 2021.xlsx` — 1,005 rows, 26 columns, mixed company/contact/status/amount free text across years.
- Other sponsor workbooks/proposals in the same folder — heterogeneous columns, merged cells, planning notes, no stable ledger schema.

The files are **planning/contact sheets**, not a receipt ledger. They do not establish cash received, and a guessed column mapping would fabricate financial history. The only bulk importer implemented is the constrained bank-statement importer (`src/server/accounts.ts`). `import_batches`/`import_rows` exist as staging tables but have no generic importer/UI.

Status: **BLOCKED** pending a source with a stable schema and a human-approved column mapping. No historical claims or sponsor receipts were imported.

---

## 9. OCR status

| Capability | Status | Evidence |
|---|---|---|
| English image OCR | **TESTED-PASS** | `tests/ocr.test.ts` generated a synthetic receipt; Tesseract 5.5.0 extracted `TOTAL NPR 5,000.00`, date `2026-10-20`, total 500,000 paisa |
| Invoice-number false positive | **TESTED-PASS** | Regression test proves `TOTAL` is not captured as an invoice number |
| Text-layer PDF | **IMPLEMENTED** | pdfjs-dist path exists; no synthetic PDF fixture was added in this phase |
| Nepali/Devanagari | **BLOCKED** | Tesseract languages are `eng`, `osd`, `snum`; no `nep` |
| Scanned PDF | **BLOCKED** | No `pdftoppm`/`pdftotext`/rasteriser |
| OCR writes a claim/payment | **TESTED-PASS (negative)** | OCR only stores candidates; human review is required |

OCR never creates a claim, payment, or journal entry.

---

## 10. Financial scenario coverage (A–J)

`tests/financial-scenarios.test.ts` exercises the required scenarios with real migrations and a real database. All 10 tests pass.

| Scenario | What is proven | Status |
|---|---|---|
| A — personal expense + reimbursement | NPR 5,000 expenditure plus NPR 5,000 reimbursement counts as NPR 5,000 expenditure, not NPR 10,000 | **TESTED-PASS** |
| B — partial payment | NPR 8,000 expense with NPR 3,000 reimbursed leaves NPR 5,000 outstanding; no over-payment | **TESTED-PASS** |
| C — advance settlement | NPR 10,000 advance settled by NPR 7,000 expense and NPR 3,000 return has no double count | **TESTED-PASS** |
| D — sponsor commitment vs receipt | NPR 100,000 commitment and NPR 40,000 receipt remain distinct | **TESTED-PASS** |
| E — internal transfer | NPR 20,000 between LOCUS accounts is neither income nor expenditure | **TESTED-PASS** |
| F — statement re-import | Re-importing the same statement creates no duplicate financial recognition | **TESTED-PASS** |
| G — split allocation | Splitting one NPR 5,000 expense across two events does not inflate organisation-wide expenditure | **TESTED-PASS** |
| H — payment reversal | Reversal preserves the original, links the reversal, audits before/after, and does not double count | **TESTED-PASS** |
| I — unverified claim | An unverified claim remains unverified and is not presented as verified expenditure | **TESTED-PASS** |
| J — duplicate receipt reuse | Uploading the same receipt twice and reusing it on another claim does not merge or erase evidence | **TESTED-PASS** |

Period close/reopen is covered separately by `tests/security-controls.test.ts` (closed period rejects postings and claims; reopen is audited).

The exact test names and counts are in `docs/TEST_RESULTS.md`.

---

## 11. Security evidence

| Claim | Evidence | Verdict |
|---|---|---|
| Passwords are scrypt-hashed | `src/server/password.ts`; password tests | **TESTED-PASS** |
| Session tokens are random and stored hashed | `auth.ts`, schema `sessions.token_hash` | **TESTED-PASS** |
| Sessions are server-side and revocable | sign-out/password change; restore revokes all sessions | **TESTED-PASS** |
| Self-approval is blocked in app and DB | trigger + tests | **TESTED-PASS** |
| Audit events are append-only | DB trigger tests | **TESTED-PASS** |
| Documents are private | central `canAccessDocument`; API/detail/receipts use it | **TESTED-PASS** |
| RBAC is enforced server-side | page/action/API guards; denial tests | **TESTED-PASS** |
| Rate limiting survives restart | durable table + restart test | **TESTED-PASS** |
| Persistent lockout | 8 failures / 15 minutes; test | **TESTED-PASS** |
| MFA enrollment/login/recovery/reset | unit tests + disposable-browser flow; reset test asserts revocation and audit | **TESTED-PASS** |
| CSP enforced | production response header verified | **TESTED-PASS** (residual `unsafe-inline`) |
| Exports are authorized | `export.run` + E2E downloads | **TESTED-PASS** |
| Document downloads are authorized | central access checks + security tests | **TESTED-PASS** |
| Audit log is tamper-evident | append-only only, no hash chain | **NOT-TESTED** |

Residual security risks are listed in `SECURITY_REVIEW.md` and `KNOWN_BUGS.md`.

---

## 12. E2E workflows verified

On both the live demo database and the restored disposable database:

1. Member signs in and creates a claim with a missing-receipt declaration.
2. Finance approves, records payment, and verifies evidence.
3. Finance reviews the seeded bank statement and its intentionally open line.
4. Auditor sees the audit trail but no approval actions.
5. Admin downloads claims as CSV and JSON.
6. Admin loads the role matrix.

Additionally, on a disposable database with `MFA_ENFORCE=true`:

7. Admin signs in and is redirected to `/mfa-setup`.
8. Enrollment secret is read from the page, a TOTP code is generated, and MFA is enabled.
9. Ten recovery codes are shown once.
10. Sign-out and re-login with a fresh TOTP code succeeds.
11. Sign-out and re-login with a recovery code succeeds; that code is consumed.

---

## 13. Local startup

```bash
cd "/Users/ashim/Downloads/LOCUS FINANCE AUTOMATION"
npm ci
npm run db:migrate
npm run db:seed-demo      # synthetic demo only
npm run dev
```

Real workspace:

```bash
npm run db:migrate
npm run db:create-admin -- --email=finance@org.org --name="Finance Manager"
npm run build && NODE_ENV=production npm start
```

Production MFA:

```bash
MFA_ENFORCE=true NODE_ENV=production npm start
```

Backup and restore:

```bash
npm run db:backup -- --out /secure/locus-backup
npm run db:verify-backup -- --from /secure/locus-backup
npm run db:restore -- --from /secure/locus-backup \
  --database-dir /scratch/pglite --document-dir /scratch/documents
```

Stop the app before backup/reset/seed. The E2E suite starts its own server unless `E2E_BASE_URL` is set.

---

## 14. Remaining blockers and not-tested areas

| Item | Status | Why |
|---|---|---|
| Managed PostgreSQL migration | **BLOCKED** | No server/client/credentials; no `pg` adapter |
| PostgreSQL restore/PITR drill | **BLOCKED** | Depends on managed target |
| Nepali OCR | **BLOCKED** | No `nep` traineddata |
| Scanned-PDF OCR | **BLOCKED** | No rasteriser |
| Real historical import | **BLOCKED** | No stable source ledger; no importer |
| Production email/password reset | **BLOCKED** | No SMTP/provider; no reset-token implementation |
| Scheduled/offsite encrypted backups | **NOT-TESTED** | Scripts exist; no scheduler/remote storage configured |
| Multi-instance concurrency | **NOT-TESTED** | PGlite single-process |
| Audit hash chain | **NOT-TESTED** | Append-only triggers only |
| Malware scanning | **NOT-TESTED** | No scanner |
| Application-level encryption at rest | **NOT-TESTED** | Rely on volume encryption |
| Negative-balance policy | **NOT-TESTED** | Deliberate product decision |
| Sponsor over-receipt policy | **NOT-TESTED** | Deliberate product decision |
| Orphan upload cleanup | **NOT-TESTED** | Preserved, not deleted |

---

## 15. Conclusion

The application is a credible single-instance finance system with real double-entry accounting, enforced separation of duties, private document custody, durable rate limiting, MFA, period locks, tested backups, and a passing 117-test suite. The highest-impact authorization and financial-integrity defects found in the baseline were fixed and covered by regression tests.

It is **not** a production-ready multi-instance deployment. The remaining production blockers are managed PostgreSQL, provider-level backup/PITR, Nepali/scanned-PDF OCR, real email/reset, and several documented policy/security gaps. Those are reported as **BLOCKED** or **NOT-TESTED**, not hidden.

The most important property is preserved: the system refuses to invent LOCUS’s history. All current financial data is synthetic, and no historical total is asserted without evidence.
