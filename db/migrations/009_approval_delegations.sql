CREATE TABLE IF NOT EXISTS approval_delegations (
  id text PRIMARY KEY,
  delegator_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegatee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'ALL' CHECK (scope IN ('ALL','EVENT','DEPARTMENT')),
  scope_id text,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (delegator_user_id <> delegatee_user_id),
  CHECK (expires_at > starts_at)
);
CREATE INDEX IF NOT EXISTS approval_delegations_delegatee_idx ON approval_delegations (delegatee_user_id, expires_at);
CREATE INDEX IF NOT EXISTS approval_delegations_delegator_idx ON approval_delegations (delegator_user_id, created_at DESC);
