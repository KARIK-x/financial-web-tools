# SECURITY AUDIT RESULTS

Date: 2026-10-25

## Automated checks
- `npm audit --omit=dev`: 0 vulnerabilities after upgrading `sharp` to 0.35.5 and overriding `uuid` to 11.1.1.
- `npm audit fix`: could not resolve without breaking changes.
- `npx tsc --noEmit`: pass.
- `npm run build`: pass.
- Full Vitest suite: 150 tests passing, 3 skipped.
- Playwright E2E: 8 passed.

## Code review checks
- SQL queries use parameterized inputs in reviewed server modules.
- Authentication uses server-side sessions, httpOnly cookies, rate limiting, and lockout.
- MFA uses TOTP with replay-step tracking and hashed recovery codes.
- Document access is centralized through `canAccessDocument`.
- Uploads are validated by size, MIME type, and magic bytes.
- CSV exports prefix formula-injection characters.
- CSP uses per-request nonces for scripts.
- Malware scanning reports `UNAVAILABLE` instead of clean when no scanner exists.

## Residual risks
- Dependency audit is clean after the targeted upgrade/override. Continue monitoring transitive dependencies.
- Application-level encryption at rest is not implemented.
- Multi-organization isolation is not implemented.
- Real email delivery and ClamAV remain unverified due missing credentials/services.
