-- Searchable document repository. Raw OCR text is preserved in ocr_extractions;
-- documents.search_text/search_tsv are derived from the latest OCR text and
-- corrected extracted fields so every uploaded document becomes searchable.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ocr_text text,
  ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (
      coalesce(filename, '') || ' ' ||
      coalesce(doc_type, '') || ' ' ||
      coalesce(notes, '') || ' ' ||
      coalesce(ocr_text, '') || ' ' ||
      coalesce(extracted::text, '')
    ) STORED,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(filename, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(doc_type, '')), 'D') ||
      setweight(to_tsvector('simple', coalesce(notes, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(ocr_text, '')), 'D') ||
      setweight(to_tsvector('simple', coalesce(extracted::text, '')), 'C')
    ) STORED,
  ADD COLUMN IF NOT EXISTS ocr_text_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS documents_search_tsv_idx
  ON documents USING GIN (search_tsv);

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS documents_search_text_trgm_idx ON documents USING GIN (search_text gin_trgm_ops)';
  END IF;
END $$;

-- Backfill the latest successful OCR text without discarding the original extraction rows.
UPDATE documents d
SET ocr_text = latest.raw_text,
    ocr_text_updated_at = latest.started_at
FROM (
  SELECT DISTINCT ON (document_id) document_id, raw_text, started_at
  FROM ocr_extractions
  WHERE status = 'SUCCEEDED' AND raw_text IS NOT NULL
  ORDER BY document_id, started_at DESC
) AS latest
WHERE d.id = latest.document_id
  AND (d.ocr_text IS NULL OR d.ocr_text <> latest.raw_text);
