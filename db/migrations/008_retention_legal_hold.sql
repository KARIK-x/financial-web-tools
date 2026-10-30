ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_reason text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_until date;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_policy text;
CREATE INDEX IF NOT EXISTS documents_legal_hold_idx ON documents (legal_hold) WHERE legal_hold;
