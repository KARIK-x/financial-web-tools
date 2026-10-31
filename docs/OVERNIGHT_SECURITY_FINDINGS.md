# OVERNIGHT SECURITY FINDINGS

Date: 2026-10-24

## Scope
Local authorized review of the Finance Tracker application, its dependencies, authentication, authorization, uploads, exports, and backup scripts.

## Method
- Static inspection of server-side code and SQL usage.
- Dependency audit with `npm audit --omit=dev`.
- Review of authentication, sessions, MFA, rate limiting, document access, CSP, and backup handling.
- Targeted unit and integration tests.

## Findings

### F-001: Dependency vulnerabilities in optional spreadsheet/image stack
Severity: Medium/High (as reported by npm audit)
Affected: `exceljs` via `uuid`; `sharp`; `fflate`
Reproduction: `npm audit --omit=dev`
Impact: Potential denial of service or parsing issues in spreadsheet/image processing.
Fix: Non-breaking audit fix did not resolve all issues. Avoid `npm audit fix --force` because it would downgrade `exceljs`/`sharp` and risk regressions. Keep uploads validated and size-limited; revisit targeted upgrades in a controlled change.
Regression test: `tests/malware.test.ts`, `tests/ocr.test.ts`, full suite.
Residual risk: Vulnerabilities remain in transitive dependencies.

### F-002: No application-level encryption at rest
Severity: Medium
Affected: `.data/pglite`, `.data/documents`
Impact: Local database and files rely on OS/provider encryption.
Fix: Documented as blocked/not implemented. Recommend provider-managed encryption and OS-level protections.
Residual risk: Plaintext at rest on local disk.

### F-003: Multi-organization isolation not implemented
Severity: Medium (for multi-tenant use)
Affected: All tenant queries
Impact: Single-organization deployment only; no cross-organization isolation.
Fix: Not implemented. Requires schema and query changes across all modules.
Residual risk: Not safe for multi-tenant hosting.

### F-004: Committee delegation not implemented
Severity: Low/Medium
Affected: Approval workflow
Impact: Delegated approval expiry and quorum are not modeled.
Fix: Not implemented.
Residual risk: Approvals rely on current role permissions only.

### F-005: Retention and legal hold now partially implemented
Severity: Low
Affected: Documents
Impact: Legal hold and retention metadata can now be recorded; automated deletion is not implemented.
Fix: Migration 008 and `src/server/retention.ts`.
Residual risk: Retention enforcement is manual.

## Controls verified
- Server-side authorization via `requireUser` and `requirePermission`.
- MFA with TOTP replay protection and recovery codes.
- Durable rate limiting and persistent lockout.
- CSP with per-request nonce for scripts.
- Upload MIME and magic-byte validation.
- Private document storage and authorized download.
- Formula-injection protection in CSV exports.
- Backup verification and restore drill.
- Financial reversal and period-lock controls.

## Conclusion
No critical application-code injection or authorization bypass was identified in the reviewed paths. Remaining security work is primarily dependency upgrades, multi-tenant isolation, and operational hardening.
