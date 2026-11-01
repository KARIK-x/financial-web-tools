import { one, type Db, type Executor } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";

export type DocumentSearchFilters = {
  query?: string | null;
  status?: string | null;
  docType?: string | null;
  uploaderId?: string | null;
  claimId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  sort?: "relevance" | "newest" | "oldest" | "amount" | null;
  page?: number;
  pageSize?: number;
};

export type DocumentSearchResult = {
  id: string;
  filename: string;
  doc_type: string;
  status: string;
  review_status: string;
  uploaded_at: Date;
  uploader: string | null;
  claim_id: string | null;
  claim_no: string | null;
  extracted: Record<string, unknown>;
  score: number;
  snippet: string;
  search_text: string;
  duplicate_of: string | null;
  scan_status: string;
  size_bytes: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function devanagariDigitsToAscii(value: string): string {
  return value.replace(/[०-९]/g, (char) => String(char.charCodeAt(0) - 0x0966));
}

function normalizeAmountToken(value: string): string | null {
  const cleaned = devanagariDigitsToAscii(value).replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return cleaned.replace(/\.00$/, "");
}

function normalizeDateToken(value: string): string | null {
  const cleaned = devanagariDigitsToAscii(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  const slash = cleaned.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (slash) {
    const [, day, month, year] = slash;
    const d = day!.padStart(2, "0");
    const m = month!.padStart(2, "0");
    return `${year}-${m}-${d}`;
  }
  return null;
}

export function normalizeSearchQuery(query: string): string {
  const collapsed = normalizeWhitespace(devanagariDigitsToAscii(query));
  const amountMatch = collapsed.match(/^(?:rs\.?|npr|रु\.?|रू\.?)?\s*[\d,]+(?:\.\d{1,2})?$/i);
  if (amountMatch) {
    const amount = normalizeAmountToken(collapsed);
    if (amount) return amount;
  }
  const date = normalizeDateToken(collapsed);
  if (date) return date;

  return collapsed
    .replace(/(?:rs\.?|npr|रु\.?|रू\.?)\s*([\d,]+(?:\.\d{1,2})?)/gi, (_, amount) => normalizeAmountToken(amount) ?? amount)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSearchText(value: string): string {
  return normalizeWhitespace(devanagariDigitsToAscii(value).replace(/<[^>]*>/g, " "));
}

function extractAmountTokens(extracted: Record<string, unknown>, ocrText: string | null): string {
  const tokens = new Set<string>();
  for (const key of ["totalRaw", "subtotalRaw", "taxRaw", "total", "subtotal", "tax"]) {
    const value = extracted[key];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = normalizeAmountToken(String(value));
      if (normalized) tokens.add(normalized);
    }
  }
  const paisa = extracted.totalPaisa;
  if (typeof paisa === "number" && Number.isFinite(paisa)) {
    const npr = (paisa / 100).toFixed(2).replace(/\.00$/, "");
    tokens.add(npr);
  }
  const text = ocrText ?? "";
  for (const match of text.matchAll(/(?:rs\.?|npr|रु\.?|रू\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi)) {
    const normalized = normalizeAmountToken(match[1] ?? "");
    if (normalized) tokens.add(normalized);
  }
  return [...tokens].join(" ");
}

function extractDateTokens(extracted: Record<string, unknown>, ocrText: string | null): string {
  const tokens = new Set<string>();
  if (typeof extracted.date === "string") {
    const normalized = normalizeDateToken(extracted.date);
    if (normalized) tokens.add(normalized);
  }
  const text = ocrText ?? "";
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/g)) {
    const normalized = normalizeDateToken(match[0]);
    if (normalized) tokens.add(normalized);
  }
  return [...tokens].join(" ");
}

export function buildDocumentSearchText(input: {
  filename: string;
  docType: string;
  notes: string | null;
  ocrText: string | null;
  extracted: Record<string, unknown>;
  uploaderName: string | null;
  claimNo: string | null;
  claimDescription: string | null;
  batchLabel: string | null;
  batchNotes: string | null;
  eventName: string | null;
}): { searchText: string; normalizedAmounts: string; normalizedDates: string } {
  const extractedText = Object.entries(input.extracted)
    .map(([key, value]) => `${key} ${String(value ?? "")}`)
    .join(" ");
  const normalizedAmounts = extractAmountTokens(input.extracted, input.ocrText);
  const normalizedDates = extractDateTokens(input.extracted, input.ocrText);
  const searchText = normalizeSearchText(
    [
      input.filename,
      input.docType,
      input.notes ?? "",
      input.ocrText ?? "",
      extractedText,
      input.uploaderName ?? "",
      input.claimNo ?? "",
      input.claimDescription ?? "",
      input.batchLabel ?? "",
      input.batchNotes ?? "",
      input.eventName ?? "",
      normalizedAmounts,
      normalizedDates,
    ].join(" "),
  );
  return { searchText, normalizedAmounts, normalizedDates };
}

export async function rebuildDocumentSearchIndex(db: Db, documentId: string): Promise<void> {
  const doc = await one<{
    id: string;
    filename: string;
    doc_type: string;
    notes: string | null;
    extracted: Record<string, unknown>;
    uploaded_by: string | null;
    claim_id: string | null;
    batch_id: string | null;
    ocr_text: string | null;
    uploader_name: string | null;
    claim_no: string | null;
    claim_description: string | null;
    event_id: string | null;
    batch_label: string | null;
    batch_notes: string | null;
    event_name: string | null;
    raw_text: string | null;
  }>(
    db,
    `SELECT d.id, d.filename, d.doc_type, d.notes, d.extracted, d.uploaded_by, d.claim_id, d.batch_id,
            d.ocr_text, u.name AS uploader_name, c.claim_no, c.description AS claim_description,
            c.event_id, b.source_label AS batch_label, b.notes AS batch_notes, e.name AS event_name,
            o.raw_text
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN expense_claims c ON c.id = d.claim_id
       LEFT JOIN document_batches b ON b.id = d.batch_id
       LEFT JOIN events e ON e.id = c.event_id
       LEFT JOIN LATERAL (
         SELECT raw_text FROM ocr_extractions
          WHERE document_id = d.id AND status = 'SUCCEEDED' AND raw_text IS NOT NULL
          ORDER BY started_at DESC LIMIT 1
       ) o ON true
      WHERE d.id = $1`,
    [documentId],
  );
  if (!doc) return;

  const ocrText = doc.raw_text ?? doc.ocr_text ?? null;
  await db.query(`UPDATE documents SET ocr_text = $2, ocr_text_updated_at = now() WHERE id = $1`, [documentId, ocrText]);

  const search = buildDocumentSearchText({
    filename: doc.filename,
    docType: doc.doc_type,
    notes: doc.notes,
    ocrText,
    extracted: doc.extracted ?? {},
    uploaderName: doc.uploader_name,
    claimNo: doc.claim_no,
    claimDescription: doc.claim_description,
    batchLabel: doc.batch_label,
    batchNotes: doc.batch_notes,
    eventName: doc.event_name,
  });

  await db.query(
    `INSERT INTO document_search_index (document_id, search_text, search_tsv, normalized_amounts, normalized_dates, updated_at)
     VALUES ($1, $2, to_tsvector('simple', $2), $3, $4, now())
     ON CONFLICT (document_id) DO UPDATE
       SET search_text = EXCLUDED.search_text,
           search_tsv = EXCLUDED.search_tsv,
           normalized_amounts = EXCLUDED.normalized_amounts,
           normalized_dates = EXCLUDED.normalized_dates,
           updated_at = now()`,
    [documentId, search.searchText, search.normalizedAmounts, search.normalizedDates],
  );
}

export async function searchDocuments(
  db: Db,
  viewer: CurrentUser,
  filters: DocumentSearchFilters = {},
): Promise<{ rows: DocumentSearchResult[]; total: number }> {
  const canSearch =
    can(viewer.role, "document.search", viewer.permissions) ||
    can(viewer.role, "document.view.all", viewer.permissions) ||
    can(viewer.role, "document.upload", viewer.permissions);
  if (!canSearch) throw new Error("You cannot search documents.");

  const query = normalizeSearchQuery(filters.query ?? "");
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (can(viewer.role, "document.view.all", viewer.permissions)) {
    // Authorized finance-wide search.
  } else {
    params.push(viewer.id);
    clauses.push(`(d.uploaded_by = $${params.length} OR c.claimant_user_id = $${params.length})`);
  }

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`d.status = $${params.length}`);
  }
  if (filters.docType) {
    params.push(filters.docType);
    clauses.push(`d.doc_type = $${params.length}`);
  }
  if (filters.uploaderId) {
    params.push(filters.uploaderId);
    clauses.push(`d.uploaded_by = $${params.length}`);
  }
  if (filters.claimId) {
    params.push(filters.claimId);
    clauses.push(`d.claim_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    clauses.push(`COALESCE((CASE WHEN d.extracted->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (d.extracted->>'date')::date ELSE d.uploaded_at::date END), d.uploaded_at::date) >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    clauses.push(`COALESCE((CASE WHEN d.extracted->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (d.extracted->>'date')::date ELSE d.uploaded_at::date END), d.uploaded_at::date) <= $${params.length}::date`);
  }
  if (filters.amountMin != null) {
    params.push(Math.round(filters.amountMin * 100));
    clauses.push(`COALESCE(CASE WHEN d.extracted->>'totalPaisa' ~ '^[0-9]+$' THEN (d.extracted->>'totalPaisa')::bigint ELSE 0 END, 0) >= $${params.length}`);
  }
  if (filters.amountMax != null) {
    params.push(Math.round(filters.amountMax * 100));
    clauses.push(`COALESCE(CASE WHEN d.extracted->>'totalPaisa' ~ '^[0-9]+$' THEN (d.extracted->>'totalPaisa')::bigint ELSE 0 END, 0) <= $${params.length}`);
  }

  const hasQuery = query.length >= 2;
  const queryParam = hasQuery ? (params.push(query), params.length) : -1;
  const trigramAvailable = hasQuery
    ? (await one<{ available: boolean }>(db, "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS available"))?.available ?? false
    : false;

  const matchClauses: string[] = [];
  if (hasQuery) {
    matchClauses.push(`si.search_tsv @@ plainto_tsquery('simple', $${queryParam})`);
    matchClauses.push(`si.search_text ILIKE '%' || $${queryParam} || '%'`);
    matchClauses.push(`lower(COALESCE(d.extracted->>'merchant', '')) ILIKE '%' || lower($${queryParam}) || '%'`);
    matchClauses.push(`lower(COALESCE(d.extracted->>'invoiceNo', '')) ILIKE '%' || lower($${queryParam}) || '%'`);
    matchClauses.push(`si.normalized_amounts ILIKE '%' || $${queryParam} || '%'`);
    matchClauses.push(`si.normalized_dates ILIKE '%' || $${queryParam} || '%'`);
  }
  if (matchClauses.length) clauses.push(`(${matchClauses.join(" OR ")})`);

  const scoreExpression = hasQuery
    ? `(
        CASE WHEN lower(COALESCE(d.extracted->>'merchant', '')) = lower($${queryParam}) THEN 8.0 ELSE 0 END +
        CASE WHEN lower(COALESCE(d.extracted->>'merchant', '')) LIKE lower($${queryParam}) || '%' THEN 4.0 ELSE 0 END +
        CASE WHEN lower(COALESCE(d.extracted->>'invoiceNo', '')) = lower($${queryParam}) THEN 8.0 ELSE 0 END +
        CASE WHEN lower(COALESCE(d.extracted->>'invoiceNo', '')) LIKE lower($${queryParam}) || '%' THEN 4.0 ELSE 0 END +
        CASE WHEN COALESCE(d.extracted->>'totalRaw', '') = $${queryParam} THEN 5.0 ELSE 0 END +
        CASE WHEN si.normalized_amounts ILIKE '%' || $${queryParam} || '%' THEN 3.0 ELSE 0 END +
        CASE WHEN si.normalized_dates ILIKE '%' || $${queryParam} || '%' THEN 5.0 ELSE 0 END +
        CASE WHEN lower(d.filename) LIKE '%' || lower($${queryParam}) || '%' THEN 3.0 ELSE 0 END +
        CASE WHEN lower(COALESCE(d.notes, '')) LIKE '%' || lower($${queryParam}) || '%' THEN 2.0 ELSE 0 END +
        (ts_rank_cd(si.search_tsv, plainto_tsquery('simple', $${queryParam})) * 2.0) +
        ${trigramAvailable ? `COALESCE(similarity(si.search_text, $${queryParam}), 0.0)` : "0.0"}
      )`
    : "0.0";

  const snippetExpression = hasQuery
    ? `CASE WHEN si.search_tsv @@ plainto_tsquery('simple', $${queryParam})
           THEN ts_headline('simple', si.search_text, plainto_tsquery('simple', $${queryParam}),
                'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,HighlightAll=FALSE')
           ELSE left(si.search_text, 180)
      END`
    : "left(si.search_text, 180)";

  const orderBy =
    filters.sort === "newest" ? "d.uploaded_at DESC, d.id" :
    filters.sort === "oldest" ? "d.uploaded_at ASC, d.id" :
    filters.sort === "amount" ? "COALESCE(CASE WHEN d.extracted->>'totalPaisa' ~ '^[0-9]+$' THEN (d.extracted->>'totalPaisa')::bigint ELSE NULL END, 0) DESC NULLS LAST, d.uploaded_at DESC, d.id" :
    `score DESC, d.uploaded_at DESC, d.id`;

  const limit = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
  const currentPage = Math.max(1, filters.page ?? 1);
  const offset = (currentPage - 1) * limit;

  params.push(limit, offset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  const baseFrom = `
    FROM documents d
    JOIN document_search_index si ON si.document_id = d.id
    LEFT JOIN users u ON u.id = d.uploaded_by
    LEFT JOIN expense_claims c ON c.id = d.claim_id
  `;

  const sql = `
    SELECT d.id, d.filename, d.doc_type, d.status, d.review_status, d.uploaded_at, d.extracted,
           d.claim_id, c.claim_no, u.name AS uploader, si.search_text, d.duplicate_of, d.scan_status, d.size_bytes,
           ${snippetExpression} AS snippet,
           ${scoreExpression} AS score
      ${baseFrom}
     WHERE ${clauses.length ? clauses.join(" AND ") : "TRUE"}
     ORDER BY ${orderBy}
     LIMIT $${limitParam} OFFSET $${offsetParam}
  `;

  const rows = (
    await db.query<DocumentSearchResult & { score: string | number }>(sql, params as never[])
  ).rows.map((row) => ({ ...row, score: Number(row.score ?? 0) }));

  const countParams = params.slice(0, params.length - 2);
  const countSql = `
    SELECT COUNT(*)::int AS n
      ${baseFrom}
     WHERE ${clauses.length ? clauses.join(" AND ") : "TRUE"}
  `;
  const total = (await db.query<{ n: number }>(countSql, countParams as never[])).rows[0]?.n ?? 0;

  return { rows, total };
}
