# FINANCIAL CONTROL MATRIX

| Control | Implementation | Verification |
|---|---|---|
| Server-side authorization | `requireUser`, `requirePermission`, `canAccessDocument` | security-controls tests |
| Self-approval prevention | `decideClaim` rejects claimant as approver | security-controls tests |
| Double-entry balance | Journal insert and trigger checks | financial-scenarios tests |
| Payment reversal | Linked reversal payment and journal | financial-scenarios H |
| Non-negative cash | `lockAndAssertFunds` | financial-controls tests |
| Fiscal period lock | `assertDateOpen` | security-controls tests |
| Durable rate limiting | `rate_limits` table | security-controls tests |
| MFA | TOTP, recovery codes, replay protection | security-controls tests |
| Document authorization | `canAccessDocument` | security-controls tests |
| Malware scanning | ClamAV adapter and magic-byte validation | malware tests |
| Orphan cleanup | Dry-run default, referenced-file protection | financial-controls tests |
| Sponsor over-receipt review | `over_received_paisa`, audit event | financial-controls tests |
| Retention/legal hold | Document metadata and UI | typecheck/build |
| Approval delegation | `approval_delegations`, enforcement | delegations tests |
