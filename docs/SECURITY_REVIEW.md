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
| Password hashes, session tokens | Critical |
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
- **ADMIN** — full configuration, including the role matrix (ADMIN row immutable).
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
- Login rate limit: 12 attempts / 15 minutes per email+IP (in-memory).

### Authorisation
- 19 permissions, 6 roles, 54 grants in the database.
- Every Server Action calls `requireUser`/`requirePermission`; every restricted page calls `requirePagePermission`; API routes check permissions and return 401/403.
- Object-level document access: uploader, claimant, or `document.view.all`.
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
- Audit trail append-only at the database level.

### Platform headers
`next.config.ts` sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a restrictive `Permissions-Policy`. `poweredByHeader` is disabled.

### Secrets and PII handling
- No secrets in the repository; `.env*` and `.data/` are gitignored.
- Demo/admin credentials are written to mode-0600 files and never printed.
- The personal eSewa statement was never imported; only its layout informed the parser.
- Audit stores actor name, not password or token; summaries may include vendor/member names (necessary for investigation).
- No request-body logging.

### Exports
- Require `export.run` (ADMIN/FINANCE), audited as `EXPORT_RUN`, `Cache-Control: no-store`, capped at 20,000 rows.
- Money exported as paisa + decimal string to avoid unit confusion.

---

## 4. Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| S-01 | No CSP on HTML pages | Medium | Open (P0-7) |
| S-02 | No MFA for privileged roles | Medium | Open (P0-5) |
| S-03 | Database/documents unencrypted at rest by the app | Medium | Mitigated by disk encryption (documented) |
| S-04 | Rate limiting is in-memory; no persistent lockout | Medium | Open (P0-6) |
| S-05 | PGlite single-process; no multi-instance isolation | Medium | Architectural; P0-1 |
| S-06 | No antivirus/content scanning on uploads | Low–Medium | Open; rely on private storage + attachment disposition |
| S-07 | No explicit CSRF token; relies on SameSite=Lax + Next Server Action origin checks | Low | Accepted for current deployment; verify on proxy setup |
| S-08 | Audit log is not cryptographically tamper-evident | Low | Open (P2-4) |
| S-09 | `fail()` may surface low-level database error text in a form | Low | Accepted; review messages before exposing to untrusted users |
| S-10 | No email verification; admin-created emails are trusted | Low | Accepted for an invited-members organisation |
| S-11 | Multiple concurrent sessions per user are allowed | Low | By design; password change revokes others |
| S-12 | No HSTS header (proxy responsibility) | Low | Configure at the reverse proxy |
| S-13 | Export contains PII and is not watermarked/DLP-protected | Low | Permissioned + audited; handle files per policy |

### Notes on specific findings

**S-01 CSP.** A nonce/hash CSP must account for Next.js inline bootstrap scripts and the app’s inline styles. Roll out in report-only mode, fix violations, then enforce. The document response already has a sandbox CSP.

**S-04 rate limiting.** The limiter keys on `login:email:ip`. An attacker rotating IPs can exceed the per-IP window, and a restart clears counters. A durable store plus progressive delays is required before exposing the app to the internet.

**S-06 uploads.** Files are never executed by the server. Images are parsed by Sharp; PDFs by pdfjs; Tesseract runs on a temp file via `execFile` with fixed arguments (no shell). Inline PDFs may still exercise the browser’s PDF viewer; the sandbox CSP and attachment fallback reduce exposure. Add malware scanning if untrusted users can upload.

**S-07 CSRF.** Next.js Server Actions verify the request origin by default, and the session cookie is `SameSite=Lax`. A reverse proxy must preserve the `Origin`/`Host` headers. If the app is embedded or proxied under a different origin, re-test.

**S-09 error text.** Domain errors (`ExpenseError`, validation) are intentionally shown to users. Unexpected database errors may include constraint or column names. This is information disclosure, not a path to data access. A production hardening pass should map unknown errors to a generic message and log the detail server-side.

---

## 5. Threat scenarios

| Scenario | Outcome |
|---|---|
| Member forges a POST to approve their own claim | Rejected by permission check and DB self-approval trigger |
| Member requests another member’s receipt by ID | 403 unless uploader/claimant or `document.view.all` |
| Finance tries to delete a recorded payment | DB trigger rejects; must void/reverse |
| Admin edits a posted journal line | DB trigger rejects |
| Attacker guesses a session token | 32-byte random token; only hash stored; infeasible |
| Stolen database file | Password hashes are scrypt; session tokens hashed; documents still readable unless disk encrypted |
| Malicious CSV opens in Excel | Formula-leading cells prefixed with `'` |
| Path traversal via filename | Storage key is a server-generated hash; `..` rejected |
| Duplicate receipt to double-claim | Exact SHA-256 blocked; near-duplicate flagged for review |
| Back-dated claim after period close | **Not prevented** — no period lock yet (P1-2) |
| Insider with DB access alters audit | Possible; no hash chain/external anchor |

---

## 6. Production readiness

**Suitable now for:** a controlled single-instance deployment on a trusted network, with HTTPS, disk encryption, restricted filesystem permissions, backups, and a small invited user base.

**Not yet suitable for:** public internet exposure at scale, multi-tenant use, or a threat model that includes malware-uploading outsiders.

**Blocking items before real money at scale:** P0-1 (managed Postgres), P0-2 (tested backups), P0-5 (MFA), P0-6 (durable rate limiting/lockout), P0-7 (CSP), P0-8 (email/reset). P0-3/P0-4 (Nepali/scanned OCR) are usability blockers, not security blockers.

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
