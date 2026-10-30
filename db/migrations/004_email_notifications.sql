-- Email/notification outbox and password-reset tokens.
-- Notification bodies are deliberately minimal and never contain receipt bytes
-- or private document URLs. Links point at authenticated application routes.

CREATE TABLE IF NOT EXISTS notification_outbox (
  id text PRIMARY KEY,
  dedupe_key text UNIQUE,
  kind text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','DELIVERED','BLOCKED')),
  provider text,
  provider_message_id text,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_due_idx ON notification_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS notification_recipient_idx ON notification_outbox (recipient, created_at DESC);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS password_reset_expiry_idx ON password_reset_tokens (expires_at);
