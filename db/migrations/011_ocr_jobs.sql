CREATE TABLE IF NOT EXISTS ocr_jobs (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  engine_requested text NOT NULL DEFAULT 'auto',
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  error text,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS ocr_jobs_status_created_idx
  ON ocr_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS ocr_jobs_document_idx
  ON ocr_jobs (document_id, created_at DESC);
