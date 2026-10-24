# KNOWN BUGS AND LIMITATIONS

Status as of 2026-10-24. Items marked **Defect** are implementation faults; **Limitation** is a deliberate or environmental constraint. Nothing here is hidden from the UI: capability banners and error messages state what is unavailable.

No known defect corrupts the ledger or bypasses authorisation at release. The highest-impact gaps are operational (OCR, deployment model, notifications).

---

## High impact

### BUG-001 — Nepali OCR is unavailable
**Type:** Limitation (environment)
**Symptom:** Devanagari receipts are processed with English OCR, producing poor or empty candidates.
**Cause:** Tesseract is installed with `eng`, `osd`, `snum` only; the `nep` traineddata is absent.
**Workaround:** Enter fields manually; keep the original image attached. The review screen is designed for this.
**Fix:** Install `tesseract-ocr-nep`, select language per document, add fixtures (P0-3).

### BUG-002 — Scanned PDFs cannot be OCR'd
**Type:** Limitation (environment)
**Symptom:** A PDF with no text layer yields no extracted text.
**Cause:** No rasteriser (`pdftoppm`/Poppler) is installed; only text-layer extraction via pdfjs works.
**Workaround:** Upload a photo/screenshot of the receipt, or type the fields manually.
**Fix:** Add bounded rasterisation + per-page OCR (P0-4).

### BUG-003 — No bulk historical import
**Type:** Limitation (scope)
**Symptom:** Prior claims/sponsor ledgers cannot be imported in bulk; only bank statements have an importer.
**Cause:** Deliberately not implemented to avoid fabricating history or guessing column semantics.
**Workaround:** Enter opening balances and reconcile; add historical records individually if truly needed.
**Fix:** Staged importer with dry-run and provenance (P1-1).

### BUG-004 — Cash/bank balances can go negative
**Type:** Limitation (policy)
**Symptom:** A payment or transfer can exceed the computed account balance; the accounts page shows a negative figure.
**Cause:** No DB constraint or server block; same-day timing and unrecorded deposits make a hard block unsafe without policy.
**Workaround:** Review the projected balance before posting; investigate negatives immediately.
**Fix:** Adopt an explicit policy (block/warn/override) and enforce it server-side (P1-8).

### BUG-005 — Sponsor receipts may exceed the pledge
**Type:** Limitation (policy)
**Symptom:** An agreement can receive more than `promised_paisa`; state becomes `RECEIVED`.
**Cause:** Real money should not be rejected because a pledge was conservative.
**Workaround:** Review the sponsor report; the excess is visible in receipts.
**Fix:** Decide whether excess should be reclassified or flagged; add a warning if desired.

---

## Medium impact

### BUG-006 — PGlite is single-process and filesystem-bound
**Type:** Limitation (architecture)
**Symptom:** Cannot run multiple app replicas, serverless, or share the data directory over NFS; concurrent writers are unsafe.
**Workaround:** One process, one local disk, manual/automated backups.
**Fix:** Managed PostgreSQL (P0-1).

### BUG-007 — Login rate limiting is in-memory
**Type:** Limitation
**Symptom:** Counters reset on restart and are not shared across processes. The limit is 12 attempts / 15 min per email+IP; successful logins also count.
**Workaround:** Single instance; monitor audit logs.
**Fix:** Durable counter store (P0-6).

### BUG-008 — Account lockout is not persistent
**Type:** Defect (dead field)
**Symptom:** `users.locked_until` is checked but never set automatically; only the in-memory limiter slows brute force.
**Cause:** Lockout policy was not implemented; `failed_logins` increments but no threshold sets `locked_until`.
**Workaround:** Rate limiter + strong passwords + HTTPS; reset via CLI if needed.
**Fix:** Define and implement lockout/progressive delay (P0-6).

### BUG-009 — No MFA
**Type:** Limitation
**Symptom:** A stolen password is sufficient for ADMIN/FINANCE/EXECUTIVE.
**Workaround:** Strong unique passwords, HTTPS, short elevated sessions (12 h), audit review.
**Fix:** TOTP + recovery codes (P0-5).

### BUG-010 — No Content-Security-Policy on HTML pages
**Type:** Limitation
**Symptom:** Security headers exist (nosniff, frame deny, referrer, permissions), but no CSP; document responses do have a sandbox CSP.
**Workaround:** React escaping, no `dangerouslySetInnerHTML`, strict review of rendered content.
**Fix:** Nonce/hash CSP with report-only rollout (P0-7).

### BUG-011 — No application-level encryption at rest
**Type:** Limitation
**Symptom:** `.data/pglite` and `.data/documents` are plain files; anyone with disk access can read them.
**Workaround:** Full-disk/volume encryption, restricted permissions, encrypted backups.
**Fix:** Encrypted volume by default; field-level encryption for identifiers if required.

### BUG-012 — Export cap of 20,000 rows
**Type:** Limitation
**Symptom:** Larger datasets are truncated; the export is flagged.
**Workaround:** Narrow the period/filter; use a database backup for full fidelity.
**Fix:** Streaming/cursor exports (P2-3).

### BUG-013 — No email or self-service reset
**Type:** Limitation
**Symptom:** Notifications are absent; a forgotten password requires an ADMIN reset or the CLI.
**Workaround:** Admin resets from Members; CLI `--reset-password` for the last admin.
**Fix:** SMTP + reset tokens + notifications (P0-8, P1-5).

### BUG-014 — OCR runs synchronously on upload
**Type:** Limitation
**Symptom:** Large images/PDFs make the upload request slow; very large files may hit the platform timeout.
**Workaround:** Upload one file at a time; 10 MB cap.
**Fix:** Background job/queue with status polling.

---

## Low impact

### BUG-015 — Near-duplicate detection can flag legitimate similar receipts
**Type:** Limitation
**Symptom:** Two different receipts from the same merchant with similar layout may be flagged `NEEDS_REVIEW`.
**Cause:** 64-bit average hash; advisory only.
**Workaround:** Review and confirm; it never auto-merges or blocks.
**Fix:** Better perceptual hash or embeddings; keep human confirmation.

### BUG-016 — Single organisation only
**Type:** Limitation
**Symptom:** `organizations` has one row; queries are not org-scoped.
**Fix:** Multi-org scoping (P1-6).

### BUG-017 — NPR only, no FX
**Type:** Limitation
**Symptom:** Foreign-currency receipts must be converted manually before entry; FX columns exist but are unused.
**Fix:** FX rate source, historical rates, reporting in NPR (product decision).

### BUG-018 — No down-migrations
**Type:** Limitation
**Symptom:** Rolling back a schema change requires restoring a backup.
**Workaround:** Back up before migrating; test migrations on a copy.
**Fix:** Add reversible migrations or a migration policy with snapshots.

### BUG-019 — Sessions revive when restoring an old snapshot
**Type:** Limitation
**Symptom:** A restored database contains sessions that were valid at backup time.
**Workaround:** Run `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;` after restore.
**Fix:** Automate revocation in the restore runbook/CLI.

### BUG-020 — Audit log is not cryptographically tamper-evident
**Type:** Limitation
**Symptom:** A database superuser can drop triggers and alter `audit_events`.
**Workaround:** Restrict DB access; ship audit logs off-box; backups.
**Fix:** Hash chain + external anchor (P2-4).

### BUG-021 — Ambiguous bank dates are rejected
**Type:** Behaviour (safe by design)
**Symptom:** `03/04/2026` is skipped because it could be 3 April or 4 March.
**Workaround:** Re-export as ISO (`YYYY-MM-DD`) or fix the statement.
**Fix:** Optional locale setting with an explicit confirmation, never silent guessing.

### BUG-022 — Some list views cap results
**Type:** Limitation
**Symptom:** Claims list caps at 200; documents at 300; audit/ledger views have limits.
**Workaround:** Use filters/search or exports.
**Fix:** Add pagination controls to every large list.

### BUG-023 — First request after start is slow
**Type:** Behaviour
**Symptom:** PGlite initialises and applies pending migrations on first use.
**Workaround:** Warm the app after deploy; run `db:migrate` before starting.
**Fix:** Pre-migrate in the deploy pipeline and keep the process warm.

### BUG-024 — Demo credentials file remains on disk
**Type:** Operational
**Symptom:** `.data/demo-credentials.txt` contains the shared demo password.
**Workaround:** Demo only; never deploy demo data to production. Delete the file when finished.
**Fix:** Reset script could remove it; documented.

---

## Reporting a new bug

Record: what you did, what you expected, what happened, the claim/payment reference, the time (with timezone), and whether the record is synthetic. Do **not** paste passwords, session cookies, full bank account numbers, or personal data into a ticket. Check the audit trail first — most financial actions leave a trace.
