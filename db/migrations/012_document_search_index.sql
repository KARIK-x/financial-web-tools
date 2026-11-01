-- Search index for the document repository.
--
-- This table is maintained by the application. It is intentionally separate from
-- documents so searchable text can include linked claim, batch, event, and
-- uploader information without depending on generated columns that cannot
-- reference other tables.

CREATE TABLE IF NOT EXISTS document_search_index (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  search_text text NOT NULL DEFAULT '',
  search_tsv tsvector NOT NULL DEFAULT ''::tsvector,
  normalized_amounts text,
  normalized_dates text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_search_index_tsv_idx
  ON document_search_index USING GIN (search_tsv);

-- pg_trgm is optional in local PGlite but expected in production PostgreSQL.
-- Availability is checked explicitly; if the extension is available but cannot
-- be installed, this migration fails rather than silently continuing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
      RAISE EXCEPTION 'pg_trgm is available but could not be installed';
    END IF;
    EXECUTE 'CREATE INDEX IF NOT EXISTS document_search_index_text_trgm_idx ON document_search_index USING GIN (search_text gin_trgm_ops)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS document_search_index_updated_idx
  ON document_search_index (updated_at DESC);

-- Backfill one row for every existing document, including linked metadata.
INSERT INTO document_search_index (
  document_id,
  search_text,
  search_tsv,
  normalized_amounts,
  normalized_dates,
  updated_at
)
SELECT
  d.id,
  coalesce(d.filename, '') || ' ' ||
  coalesce(d.doc_type, '') || ' ' ||
  coalesce(d.notes, '') || ' ' ||
  coalesce(d.ocr_text, '') || ' ' ||
  coalesce(d.extracted::text, '') || ' ' ||
  coalesce(u.name, '') || ' ' ||
  coalesce(c.claim_no, '') || ' ' ||
  coalesce(c.description, '') || ' ' ||
  coalesce(b.source_label, '') || ' ' ||
  coalesce(b.notes, '') || ' ' ||
  coalesce(e.name, ''),
  to_tsvector(
    'simple',
    coalesce(d.filename, '') || ' ' ||
    coalesce(d.doc_type, '') || ' ' ||
    coalesce(d.notes, '') || ' ' ||
    coalesce(d.ocr_text, '') || ' ' ||
    coalesce(d.extracted::text, '') || ' ' ||
    coalesce(u.name, '') || ' ' ||
    coalesce(c.claim_no, '') || ' ' ||
    coalesce(c.description, '') || ' ' ||
    coalesce(b.source_label, '') || ' ' ||
    coalesce(b.notes, '') || ' ' ||
    coalesce(e.name, '')
  ),
  nullif(coalesce(d.extracted->>'totalRaw', '') || ' ' || coalesce(d.extracted->>'totalPaisa', ''), ' '),
  nullif(coalesce(d.extracted->>'date', ''), ''),
  now()
FROM documents d
LEFT JOIN users u ON u.id = d.uploaded_by
LEFT JOIN expense_claims c ON c.id = d.claim_id
LEFT JOIN document_batches b ON b.id = d.batch_id
LEFT JOIN events e ON e.id = c.event_id
ON CONFLICT (document_id) DO NOTHING;
