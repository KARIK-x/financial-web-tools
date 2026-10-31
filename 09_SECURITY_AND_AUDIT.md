# Security and Audit Design

**Date:** 2026-10-24

## 1. Threat Model (realistic for FINANCE TRACKER)

Primary threats: (a) account takeover of the FM or a member (credential sharing, phishing, lost phone); (b) unauthorized viewing of financial data by non-committee members or outsiders; (c) tampering with records by a departing member; (d) accidental deletion/corruption; (e) data leakage via exports or external OCR. Nation-state and sophisticated adversaries are out of scope.

## 2. Controls

**Authentication & access**
- Supabase Auth: email+password minimum, **TOTP 2FA mandatory for FM, finance team, executives** (optional for claimants).
- Sessions: short-lived JWT access tokens; server-side refresh rotation; sign-out-all on role change; idle timeout 12h FM / 30d members.
- RBAC enforced in Postgres **Row Level Security policies** (not just UI hiding): org_id scoping on every table; finance-read vs claimant-write scopes; read-only auditor role.
- Rate limiting on auth + submission endpoints (per-IP and per-user).
- No shared accounts. Committee transitions: role deactivation + password reset on handover, runbook-checked.

**Data protection**
- TLS everywhere (Supabase default). At-rest encryption via provider (Supabase Pro encrypts volumes).
- Secrets (service-role key, OCR config) in environment/secret store only — **never** in client bundles, never in the git repo; `.env` excluded, example file committed.
- Receipt files: private buckets, signed URLs (short TTL) for viewing; no public buckets. Original bytes immutable; delete rights = FM-only soft-delete with retention hold.
- Exports: FM-only; every export logged in audit_event; CSV exports include a manifest row (generator, timestamp, filters, verification state included).
- Retention: configurable (default: retain all financial records indefinitely — institutional memory is the point; member PII review on a 2-year-after-departure schedule).

**External processing risk (OCR cloud escalation)**
- Default: all documents processed locally (PaddleOCR). Cloud escalation is **per-batch, opt-in by FM**, strips nothing (receipts inherently show merchants/members) — so consent + awareness is the control: the UI states plainly "these N documents will be sent to Google Cloud for processing" before confirmation. Documents of sensitive categories (agreements with personal data) excluded from cloud escalation.

**Integrity & audit**
- Append-only `audit_event` for: logins, role changes, claim state transitions, approvals, payments, verifications, imports, exports, document supersessions, settings changes, reconciliation marks. Fields: actor, action, entity, before/after, IP, UA, timestamp.
- Financial records immutable post-approval: corrections via reversal/adjustment records (see doc 06 §5). DB enforces state-machine transitions via transition table + trigger; UPDATE of approved claims rejected.
- Unique constraints: document SHA-256; one active advance-settlement per claim; Σ allocations = amount.
- Import safety: preview + dry-run + per-row results; never overwrite existing records — imports create new versions/batches only (doc 14/07).
- Soft-delete only, FM-only, with restore; full-delete requires FM + second admin and is itself audited.

**Backups & recovery**
- Supabase Pro: daily automated backups (7-day retention) + weekly self-managed pg_dump to encrypted off-site storage (different provider or local drive held by FM) — guard against both provider loss and account lockout by a departed admin.
- Quarterly restore drill: restore dump into staging and verify row counts + spot totals. **Untested backups don't exist.**

**Environment separation**
- Production, staging, dev projects separate. Seed data synthetic in dev/staging; **never real receipts** outside production.

## 3. Corrections model (traceable, never silent)
Adjustment/reversal chain: original record unchanged → reversal entry (negating amounts, links `reverses_id`) or versioned adjustment with reason + approver + audit rows. Reports read net effect; auditors can expand to see full chain. UI shows "corrected" badge with history on any adjusted record.

## 4. Operational runbook (must exist before go-live)
Admin onboarding/offboarding checklist; credential rotation (semiannual); backup restore drill; incident response (compromised account → revoke sessions, audit review, password resets); handover export procedure for committee change (full export + FM sign-off).
