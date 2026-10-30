# KNOWN BUGS AND LIMITATIONS

Status as of 2026-10-24. Items marked **Defect** are implementation faults; **Limitation** is a deliberate or environmental constraint. Fixed items are kept for history and marked **TESTED-PASS**.

No known defect corrupts the ledger or bypasses authorisation at release. The highest-impact remaining gaps are operational (managed PostgreSQL, OCR, email) and policy decisions (negative balances, sponsor over-receipt).

---

## High impact

### BUG-001 — Nepali OCR is unavailable
**Type:** Limitation (environment)
**Status:** **BLOCKED**
**Symptom:** Devanagari receipts are processed with English OCR, producing poor or empty candidates.
**Cause:** Tesseract is installed with `eng`, `osd`, `snum` only; the `nep` traineddata is absent.
**Workaround:** Enter fields manually; keep the original image attached. The review screen is designed for this.
**Fix:** Install `tesseract-ocr-nep`, select language per document, add fixtures (P0-3).

### BUG-002 — Scanned PDFs cannot be OCR'd
**Type:** Limitation (environment)
**Status:** **BLOCKED**
**Symptom:** A PDF with no text layer yields no extracted text.
**Cause:** No rasteriser (`pdftoppm`/Poppler) is installed; only text-layer extraction via pdfjs works.
**Workaround:** Upload a photo/screenshot of the receipt, or type the fields manually.
**Fix:** Add bounded rasterisation + per-page OCR (P0-4).

### BUG-003 — No bulk historical import
**Type:** Limitation (scope)
**Status:** **BLOCKED**
**Symptom:** Prior claims/sponsor ledgers cannot be imported in bulk; only bank statements have an importer.
**Cause:** Deliberately not implemented to avoid fabricating history or guessing column semantics. The supplied sponsor workbooks are heterogeneous planning/contact sheets, not a stable ledger.
**Workaround:** Enter opening balances and reconcile; add historical records individually if truly needed.
**Fix:** Staged importer with dry-run and provenance (P1-1).

### BUG-004 — Cash/bank balances can go negative
**Type:** Limitation (policy)
**Status:** **NOT-TESTED**
**Symptom:** A payment or transfer can exceed the computed account balance; the accounts page shows a negative figure.
**Cause:** No DB constraint or server block; same-day timing and unrecorded deposits make a hard block unsafe without policy.
**Workaround:** Review the projected balance before posting; investigate negatives immediately.
**Fix:** Adopt an explicit policy (block/warn/override) and enforce it server-side (P1-8).

### BUG-005 — Sponsor receipts may exceed the pledge
**Type:** Limitation (policy)
**Status:** **NOT-TESTED**
**Symptom:** An agreement can receive more than `promised_paisa`; state becomes `RECEIVED`.
**Cause:** Real money should not be rejected because a pledge was conservative.
**Workaround:** Review the sponsor report; the excess is visible in receipts.
**Fix:** Decide whether excess should be reclassified or flagged; add a warning if desired.

---

## Medium impact

### BUG-006 — PGlite is single-process and filesystem-bound
**Type:** Limitation (architecture)
**Status:** **BLOCKED for production**
**Symptom:** Cannot run multiple app replicas, serverless, or share the data directory over NFS; concurrent writers are unsafe.
**Workaround:** One process, one local disk, verified backups.
**Fix:** Managed PostgreSQL (P0-1; plan in `POSTGRESQL_MIGRATION_PLAN.md`).

### BUG-007 — Login rate limiting was in-memory
**Type:** Defect
**Status:** **TESTED-PASS**
**Was:** Counters reset on restart and were not shared across processes.
**Now:** Durable `rate_limits` table; 12 attempts / 15 minutes per email+IP; restart test passes.
**Remaining:** alerting on distributed attacks.

### BUG-008 — Account lockout was not persistent
**Type:** Defect
**Status:** **TESTED-PASS**
**Was:** `users.locked_until` was checked but never set automatically; `failed_logins` incremented forever.
**Now:** 8 failed sign-ins in 15 minutes sets `locked_until`; successful sign-in resets counters.

### BUG-009 — No MFA
**Type:** Defect
**Status:** **TESTED-PASS**
**Was:** A stolen password was sufficient for ADMIN/FINANCE/EXECUTIVE.
**Now:** TOTP enrollment at `/mfa-setup`, replay rejection, ten hashed single-use recovery codes, admin reset with session revocation. `MFA_ENFORCE=true` enforces elevated roles; default off for the synthetic demo.
**Remaining:** set enforcement in production; define last-admin recovery procedure.

### BUG-010 — No Content-Security-Policy on HTML pages
**Type:** Defect
**Status:** **TESTED-PASS**
**Was:** Security headers existed but no CSP.
**Now:** Enforced CSP on HTML responses; production header verified. Document responses keep a sandbox CSP.
**Residual:** `unsafe-inline` for scripts/styles because of Next.js inline bootstrap; nonce/hash CSP remains P2-11.

### BUG-011 — No application-level encryption at rest
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** `.data/pglite` and `.data/documents` are plain files; anyone with disk access can read them.
**Workaround:** Full-disk/volume encryption, restricted permissions, encrypted backups.
**Fix:** Encrypted volume by default; field-level encryption for identifiers if required.

### BUG-012 — Export cap of 20,000 rows
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Larger datasets are truncated; the export is flagged.
**Workaround:** Narrow the period/filter; use a database backup for full fidelity.
**Fix:** Streaming/cursor exports (P2-3).

### BUG-013 — No email or self-service reset
**Type:** Limitation
**Status:** **BLOCKED**
**Symptom:** Notifications are absent; a forgotten password requires an ADMIN reset or the CLI.
**Workaround:** Admin resets from Members; CLI `--reset-password` for the last admin.
**Fix:** SMTP + reset tokens + notifications (P0-8, P1-5).

### BUG-014 — OCR runs synchronously on upload
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Large images/PDFs make the upload request slow; very large files may hit the platform timeout.
**Workaround:** Upload one file at a time; 10 MB cap.
**Fix:** Background job/queue with status polling.

### BUG-025 — One orphan document file
**Type:** Defect (low)
**Status:** **NOT-TESTED**
**Symptom:** `.data/documents/18/50/1850fc…png` has no `documents` row. The backup/restore verifier reports it as an orphan.
**Cause:** Probable interrupted upload: `uploadOne` writes the content-addressed file before the database insert. If the insert fails, the file remains.
**Workaround:** Preserve it; do not delete evidence blindly. Backups include it.
**Fix:** Clean up the newly written file when the DB insert fails; add a read-only orphan report with explicit human deletion (P1-11).

### BUG-026 — MFA is not enforced by default
**Type:** Operational
**Status:** **IMPLEMENTED**
**Symptom:** Demo and development users can sign in without MFA unless `MFA_ENFORCE=true`.
**Why:** Enforcing MFA on synthetic demo users would break the seeded E2E flow.
**Fix:** Set `MFA_ENFORCE=true` in production and document the elevated-role policy.

### BUG-027 — CSP still allows `unsafe-inline`
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** CSP blocks external script origins but allows inline scripts/styles.
**Why:** Next.js inline bootstrap and the current styling approach need it.
**Fix:** Nonce/hash CSP with report-only rollout (P2-11).

### BUG-028 — A sole admin cannot reset their own MFA
**Type:** Operational
**Status:** **NOT-TESTED**
**Symptom:** `disableMfaAction` refuses self-reset; another admin is required.
**Why:** Prevents a compromised session from silently disabling MFA.
**Workaround:** Keep recovery codes offline; if both authenticator and codes are lost, use the CLI/DB recovery procedure under dual control.
**Fix:** Document and test a break-glass procedure.

---

## Low impact

### BUG-015 — Near-duplicate detection can flag legitimate similar receipts
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Two different receipts from the same merchant with similar layout may be flagged `NEEDS_REVIEW`.
**Cause:** 64-bit average hash; advisory only.
**Workaround:** Review and confirm; it never auto-merges or blocks.
**Fix:** Better perceptual hash or embeddings; keep human confirmation.

### BUG-016 — Single organisation only
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** `organizations` has one row; queries are not org-scoped.
**Fix:** Multi-org scoping (P1-6).

### BUG-017 — NPR only, no FX
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Foreign-currency receipts must be converted manually before entry; FX columns exist but are unused.
**Fix:** FX rate source, historical rates, reporting in NPR (product decision).

### BUG-018 — No down-migrations
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Rolling back a schema change requires restoring a backup.
**Workaround:** Back up before migrating; test migrations on a copy.
**Fix:** Add reversible migrations or a migration policy with snapshots.

### BUG-019 — Sessions revived when restoring an old snapshot
**Type:** Defect
**Status:** **TESTED-PASS**
**Was:** A restored database contained sessions that were valid at backup time.
**Now:** `restoreBackup` revokes all sessions in the restored database by default; the backup-restore test asserts it.

### BUG-020 — Audit log is not cryptographically tamper-evident
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** A database superuser can drop triggers and alter `audit_events`.
**Workaround:** Restrict DB access; ship audit logs off-box; backups.
**Fix:** Hash chain + external anchor (P2-4).

### BUG-021 — Ambiguous bank dates are rejected
**Type:** Behaviour (safe by design)
**Status:** **TESTED-PASS**
**Symptom:** `03/04/2026` is skipped because it could be 3 April or 4 March.
**Workaround:** Re-export as ISO (`YYYY-MM-DD`) or fix the statement.
**Fix:** Optional locale setting with an explicit confirmation, never silent guessing.

### BUG-022 — Some list views cap results
**Type:** Limitation
**Status:** **NOT-TESTED**
**Symptom:** Claims list caps at 200; documents at 300; audit/ledger views have limits.
**Workaround:** Use filters/search or exports.
**Fix:** Add pagination controls to every large list.

### BUG-023 — First request after start is slow
**Type:** Behaviour
**Status:** **NOT-TESTED**
**Symptom:** PGlite initialises and applies pending migrations on first use.
**Workaround:** Warm the app after deploy; run `db:migrate` before starting.
**Fix:** Pre-migrate in the deploy pipeline and keep the process warm.

### BUG-024 — Demo credentials file remains on disk
**Type:** Operational
**Status:** **NOT-TESTED**
**Symptom:** `.data/demo-credentials.txt` contains the shared demo password.
**Workaround:** Demo only; never deploy demo data to production. Delete the file when finished.
**Fix:** Reset script could remove it; documented.

---

## Fixed during this remediation (summary)

- Document attach/review authorization holes.
- Advance-funded claim overuse and cash-payment path.
- Cross-claim receipt reattachment.
- Expense summary totals ignoring filters and viewer scope.
- Fiscal period lock.
- Payment correction/reversal workflow.
- Orphan-file *detection* in backup verification (cleanup still open).
- Missing `/mfa-setup` route (implemented).
- Restore session revocation.
- MFA, durable rate limiting, persistent lockout, CSP, tested backups.

---

## Reporting a new bug

Record: what you did, what you expected, what happened, the claim/payment reference, the time (with timezone), and whether the record is synthetic. Do **not** paste passwords, session cookies, full bank account numbers, or personal data into a ticket. Check the audit trail first — most financial actions leave a trace.
