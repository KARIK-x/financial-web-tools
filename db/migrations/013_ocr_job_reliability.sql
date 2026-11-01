-- Reliability extensions for asynchronous OCR processing.
ALTER TABLE ocr_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ocr_jobs_lease_idx
  ON ocr_jobs (lease_expires_at)
  WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS ocr_jobs_retry_idx
  ON ocr_jobs (next_retry_at, created_at)
  WHERE status = 'QUEUED';

-- Only one queued or running job may exist for a document at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ocr_jobs_one_active_per_document
  ON ocr_jobs (document_id)
  WHERE status IN ('QUEUED', 'RUNNING');
