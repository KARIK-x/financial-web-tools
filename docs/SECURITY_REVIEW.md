# SECURITY REVIEW

**Review date:** 2026-10-24
**Scope:** application code, database schema, authentication/authorisation, document handling, exports, deployment assumptions.
**Method:** manual code review, schema/trigger inspection, permission-matrix review, threat modelling, and the automated test suite. No external penetration test was performed.

---

## 1. Assets

| Asset | Sensitivity |
|---|---|
| Financial ledger, claims, payments, budgets | High |
| Receipts/invoices and bank statements | High (PII, account numbers, vendor data) |
| Member/user identities and emails | Medium–High (PII) |
| Password hashes, session tokens, MFA secrets/recovery hashes | Critical |
| Audit trail | High (integrity evidence) |
| Exports (CSV/JSON) | High once downloaded |
| Database and document files on disk | Critical |

## 2. Actors and trust boundaries

- **Anonymous** — can reach `/login`, `/setup` (only when no users exist), static assets.
- **Authenticated member** — own claims, own documents, shared reference data.
- **EVENT_HEAD** — all claims/reports, approvals, uploads; no payments/reconciliation/settings.
- **FINANCE** — operations: approvals, payments, accounts, reconciliation, imports/exports, members, sponsors, budgets.
- **EXECUTIVE** — approvals and read access; no payment execution.
- **AUDITOR** — read-only across claims/documents/reports/audit.
- **ADMIN** — full configuration, including the role matrix (ADMIN row immutable) and MFA reset.
- **CLI/DB operator** — trusted; can bypass application controls. Not defended against by design.

Trust boundaries: browser → Next.js server (untrusted input), server → PGlite (trusted local process), server → filesystem (private document store), server → Tesseract (local subprocess), export consumer (outside the boundary).

---

## 3. Controls implemented

### Authentication
- Scrypt password hashing with per-password salt and stored parameters (`src/server/password.ts`).
- Password policy: ≥ 12 characters, at least one letter and one number, common-password rejection.
- Constant-ish work factor for unknown emails (dummy hash verification).
- Server-side sessions: 32-byte random token, only SHA-256 stored; `HttpOnly`, `SameSite=Lax`, `Secure` when `NODE_ENV=production`.
- Session TTL: 12 hours for ADMIN/FINANCE/EXECUTIVE, 30 days for others; sign-out revokes the row; password change revokes all other sessions.
- Admin-issued/reset accounts are forced to `/change-password` before any financial page.
- **MFA:** TOTP enrollment, replay-step rejection, ten hashed single-use recovery codes, admin reset with session revocation. `MFA_ENFORCE=true` enforces ADMIN/FINANCE/EXECUTIVE; default off for the synthetic demo.
- **Durable login rate limit:** 12 attempts / 15 minutes per email+IP in the `rate_limits` table; survives restart.
- **Persistent lockout:** 8 failed sign-ins in 15 minutes sets `users.locked_until`.

### Authorisation
- 19 permissions, 6 roles, 54 grants in the database.
- Every Server Action calls `requireUser`/`requirePermission`; every restricted page calls `requirePagePermission`; API routes check permissions and return 401/403.
- Object-level document access is centralized in `canAccessDocument`: uploader, claimant, or `document.view.all`. Members only see their own uploads/claims; finance/admin see all.
- The sidebar hides links but is **not** the control; direct URLs are guarded.
- Denied page loads render `/no-access`; denied actions return a form error.
- ADMIN cannot remove its own role matrix permissions (lockout prevention).

### Input and output
- Parameterised SQL everywhere; no string interpolation of user values into queries.
- Zod validation at selected boundaries plus explicit parsers (`parseMoney`, `normaliseDate`, `isValidISODate`).
- React escaping; no `dangerouslySetInnerHTML`, `eval`, or raw HTML injection found.
- CSV formula-injection guard (`= + - @`, tab, CR prefixed with `'`).
- File names sanitised; storage keys are server-generated hashes; path traversal rejected in `readDocument`.
- Upload cap 10 MB; statement cap 10 MB; Server Action body limit 12 MB.

### Files and downloads
- Documents stored outside `public/` in `.data/documents`, sharded by SHA-256.
- Exact duplicate bytes blocked; near-duplicates flagged for review, never auto-merged.
- Download response: authorisation first, safe filename, `Content-Disposition`, `Cache-Control: private`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`.
- Inline rendering limited to a safe MIME allow-list; everything else is an attachment.
- Document deletion and byte mutation blocked by trigger.

### Data integrity
- Money as `BIGINT` paisa; no float storage.
- Balanced-journal trigger; immutable posted lines; immutable payments/documents/bank lines; no claim deletion; terminal-state guard; self-approval block; allocation-sum checks.
- **Payment correction:** linked equal-and-opposite reversal payment/journal; original marked `VOID`; no deletion or silent overwrite; reports exclude reversal rows to avoid double counting.
- **Fiscal period lock:** closed periods reject journal postings, expenses, and payments; reopen is authorized and audited.
- Audit trail append-only at the database level.

### Platform headers
`next.config.ts` sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, and an enforced `Content-Security-Policy`. `poweredByHeader` is disabled.

CSP current value:

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:;
style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';
connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'
```

Residual: `unsafe-inline` is required by the current Next.js inline bootstrap/styles. A nonce/hash CSP remains future work.

### Secrets and PII handling
- No secrets in the repository; `.env*`, `.data/`, and `backups/` are gitignored.
- Demo/admin credentials are written to mode-0600 files and never printed.
- The personal eSewa statement was never imported; only its layout informed the parser.
- Audit stores actor name, not password/token/MFA secret; summaries may include vendor/member names (necessary for investigation).
- No request-body logging.

### Backups and restore
- Backups contain database, documents, checksums, manifest, git commit, and timestamp.
- Credentials and environment files are excluded by default.
- Files/directories are private (`0600`/`0700`).
- Restore revokes all sessions in the restored database by default.
- A genuine restore drill reproduced counts and document hashes, and E2E passed against the restored database.

### Exports
- Require `export.run` (ADMIN/FINANCE), audited as `EXPORT_RUN`, `Cache-Control: no-store`, capped at 20,000 rows.
- Money exported as paisa + decimal string to avoid unit confusion.

---

## 4. Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| S-01 | No CSP on HTML pages | Medium | **TESTED-PASS** — enforced static CSP; `unsafe-inline` residual |
| S-02 | No MFA for privileged roles | Medium | **TESTED-PASS** — TOTP + recovery codes; enforcement via `MFA_ENFORCE` |
| S-03 | Database/documents unencrypted at rest by the app | Medium | **NOT-TESTED** — mitigated by disk encryption (documented) |
| S-04 | Rate limiting is in-memory; no persistent lockout | Medium | **TESTED-PASS** — durable table + persistent lockout; tests pass |
| S-05 | PGlite single-process; no multi-instance isolation | Medium | **BLOCKED** — architectural; P0-1 |
| S-06 | No antivirus/content scanning on uploads | Low–Medium | **NOT-TESTED** — rely on private storage + attachment disposition |
| S-07 | No explicit CSRF token; relies on SameSite=Lax + Next Server Action origin checks | Low | **NOT-TESTED** for current deployment; verify on proxy setup |
| S-08 | Audit log is not cryptographically tamper-evident | Low | **NOT-TESTED** — append-only triggers only |
| S-09 | `fail()` may surface low-level database error text in a form | Low | **NOT-TESTED**; review messages before exposing to untrusted users |
| S-10 | No email verification; admin-created emails are trusted | Low | **NOT-TESTED** for an invited-members organisation |
| S-11 | Multiple concurrent sessions per user are allowed | Low | **TESTED-PASS**; password change revokes others |
| S-12 | No HSTS header (proxy responsibility) | Low | Configure at the reverse proxy |
| S-13 | Export contains PII and is not watermarked/DLP-protected | Low | Permissioned + audited; handle files per policy |
| S-14 | One orphan document file has no DB row | Low | **NOT-TESTED** — preserved/reported; cleanup-on-failed-insert pending |
| S-15 | A sole admin cannot reset their own MFA | Low | **NOT-TESTED** — break-glass procedure required |

### Notes on specific findings

**S-01 CSP.** The static policy blocks external script origins and framing, but allows inline scripts/styles. This is a meaningful improvement over no CSP, not a complete XSS defense. A nonce/hash CSP should be rolled out in report-only mode, then enforced.

**S-04 rate limiting.** The limiter is durable and restart-safe. Distributed attacks can still rotate IPs; add alerting/progressive delay if exposed to the public internet.

**S-06 uploads.** Files are never executed by the server. Images are parsed by Sharp; PDFs by pdfjs; Tesseract runs on a temp file via `execFile` with fixed arguments (no shell). Inline PDFs may still exercise the browser’s PDF viewer; the sandbox CSP and attachment fallback reduce exposure. Add malware scanning if untrusted users can upload.

**S-07 CSRF.** Next.js Server Actions verify the request origin by default, and the session cookie is `SameSite=Lax`. A reverse proxy must preserve the `Origin`/`Host` headers. If the app is embedded or proxied under a different origin, re-test.

**S-09 error text.** Domain errors (`ExpenseError`, validation) are intentionally shown to users. Unexpected database errors may include constraint or column names. This is information disclosure, not a path to data access. A production hardening pass should map unknown errors to a generic message and log the detail server-side.

**S-15 MFA reset.** Refusing self-reset prevents a compromised session from silently disabling MFA. A documented dual-control break-glass procedure is still needed for a sole administrator.

---

## 5. Threat scenarios

| Scenario | Outcome |
|---|---|
| Member forges a POST to approve their own claim | Rejected by permission check and DB self-approval trigger |
| Member requests another member’s receipt by ID | 403 unless uploader/claimant or `document.view.all` |
| Member attaches another member’s receipt to their claim | Rejected by ownership/claim checks; tested |
| Member reviews OCR fields without permission | Rejected by `document.review`; tested |
| Finance tries to delete a recorded payment | DB trigger rejects; must void/reverse |
| Admin edits a posted journal line | DB trigger rejects |
| Attacker guesses a session token | 32-byte random token; only hash stored; infeasible |
| Stolen database file | Password hashes are scrypt; session tokens hashed; MFA secrets are present but documents still readable unless disk encrypted |
| Malicious CSV opens in Excel | Formula-leading cells prefixed with `'` |
| Path traversal via filename | Storage key is a server-generated hash; `..` rejected |
| Duplicate receipt to double-claim | Exact SHA-256 blocked; near-duplicate flagged for review |
| Back-dated claim after period close | **Rejected** by `accounting_periods` guard; tested |
| Replaying a used TOTP code | **Rejected** by `mfa_last_used_step`; tested |
| Reusing a recovery code | **Rejected** atomically; tested |
| Insider with DB access alters audit | Possible; no hash chain/external anchor |
| Restoring an old backup revives sessions | **Prevented** — restore revokes all sessions |

---

## 6. Production readiness

**Suitable now for:** a controlled single-instance deployment on a trusted network, with HTTPS, disk encryption, restricted filesystem permissions, verified backups, MFA enforced for elevated roles, and a small invited user base.

**Not yet suitable for:** public internet exposure at scale, multi-tenant use, or a threat model that includes malware-uploading outsiders.

**Blocking items before real money at scale:**
- P0-1 managed PostgreSQL (single-process PGlite).
- Provider-level backup/PITR and a managed restore drill.
- P0-3/P0-4 Nepali and scanned-PDF OCR (usability, not security).
- P0-8 email/password reset (operational).
- S-03 encryption at rest, S-06 malware scanning, S-08 audit hash chain (risk decisions).

MFA, durable rate limiting/lockout, CSP, period locks, tested backups, and document authorization are no longer open blockers.

---

## 7. Review checklist for future changes

- [ ] New Server Action calls `requireUser`/`requirePermission`.
- [ ] New page calls `requirePagePermission`.
- [ ] New API route checks auth and returns 401/403 without leaking data.
- [ ] New SQL uses parameters, never interpolation.
- [ ] New file path derives from server-generated IDs/hashes.
- [ ] New export requires `export.run` and writes an audit event.
- [ ] New financial mutation posts a balanced journal in the same transaction.
- [ ] New table with money uses `BIGINT` paisa.
- [ ] New user-facing error does not expose schema/stack details.
- [ ] Tests cover the denial path, not only the happy path.
- [ ] MFA/recovery/reset changes are audited and revoke sessions where appropriate.
- [ ] New period-sensitive mutation calls `assertDateOpen`.
- [ ] Backup/restore changes are covered by `tests/backup-restore.test.ts`.
