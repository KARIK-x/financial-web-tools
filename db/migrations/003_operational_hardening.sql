-- Operational hardening: durable rate limits, period locks, MFA, OCR page provenance.
-- Additive only. No existing financial data is rewritten.

-- ---------------------------------------------------------------------------
-- Durable rate limiting / lockout support
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0 CHECK (count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limits_blocked_idx ON rate_limits (blocked_until) WHERE blocked_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Accounting period close / lock
-- ---------------------------------------------------------------------------
CREATE TABLE accounting_periods (
  id text PRIMARY KEY,
  fiscal_year text NOT NULL UNIQUE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by text REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  closed_reason text,
  reopened_by text REFERENCES users(id) ON DELETE SET NULL,
  reopened_at timestamptz,
  reopened_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closed_reason IS NOT NULL))
);
CREATE INDEX accounting_periods_range_idx ON accounting_periods (period_start, period_end);
CREATE INDEX accounting_periods_status_idx ON accounting_periods (status);

CREATE TABLE accounting_period_events (
  id text PRIMARY KEY,
  period_id text NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('CLOSED','REOPENED')),
  reason text NOT NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_period_events_period_idx ON accounting_period_events (period_id, created_at);

-- ---------------------------------------------------------------------------
-- MFA (TOTP + hashed single-use recovery codes)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_step bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_mfa_enabled_idx ON users (mfa_enabled) WHERE mfa_enabled = true;

-- ---------------------------------------------------------------------------
-- Per-page OCR provenance
-- ---------------------------------------------------------------------------
ALTER TABLE ocr_extractions ADD COLUMN IF NOT EXISTS pages jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ocr_extractions ADD COLUMN IF NOT EXISTS language text;
