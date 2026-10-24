import { randomUUID } from "node:crypto";
import { one, type Db } from "./db";
import {
  classifyFile, hamming, mimeForFilename, perceptualHash, readDocument, safeFilename,
  sha256, writeDocument,
} from "./storage";
import { runExtraction, type ExtractionOutcome } from "./ocr";
import { recordAudit } from "./audit";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";

export type UploadResult = {
  documentId: string;
  filename: string;
  duplicate: boolean;
  duplicateOf?: string;
  nearDuplicateOf?: string;
  error?: string;
};

export async function createBatch(db: Db, user: CurrentUser, label: string, kind = "UPLOAD", notes?: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO document_batches (id, kind, source_label, notes, created_by, is_synthetic) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, kind, label, notes ?? null, user.id, user.isSynthetic],
  );
  return id;
}

export async function uploadOne(
  db: Db,
  user: CurrentUser,
  input: { filename: string; mime: string; bytes: Buffer; batchId: string | null; docType?: string; claimId?: string | null },
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<UploadResult> {
  if (!can(user.role, "document.upload", user.permissions)) throw new Error("You cannot upload documents.");
  const filename = safeFilename(input.filename);
  const mime = input.mime || mimeForFilename(filename);
  const hash = sha256(input.bytes);

  const existing = await one<{ id: string; claim_id: string | null }>(
    db, `SELECT id, claim_id FROM documents WHERE sha256 = $1`, [hash],
  );
  let perceptual: string | null = null;
  try {
    perceptual = mime.startsWith("image/") ? await perceptualHash(input.bytes) : null;
  } catch {
    perceptual = null;
  }

  if (existing) {
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "DOCUMENT_DUPLICATE_BLOCKED",
      entityType: "document", entityId: existing.id,
      summary: `Duplicate file ${filename} detected by SHA-256; existing original retained.`,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { documentId: existing.id, filename, duplicate: true, duplicateOf: existing.id };
  }

  const storageKey = await writeDocument(hash, filename, input.bytes);
  const id = randomUUID();

  // Near-image duplicate: same document re-photographed or re-scanned.
  let nearId: string | undefined;
  let nearScore: number | undefined;
  if (perceptual) {
    const candidates = (
      await db.query<{ id: string; perceptual_hash: string }>(
        `SELECT id, perceptual_hash FROM documents WHERE perceptual_hash IS NOT NULL LIMIT 5000`,
      )
    ).rows;
    let best = 8;
    for (const c of candidates) {
      const d = hamming(perceptual, c.perceptual_hash);
      if (d < best) { best = d; nearId = c.id; }
    }
    if (nearId && best <= 6) nearScore = 1 - best / 64;
    else { nearId = undefined; nearScore = undefined; }
  }

  await db.query(
    `INSERT INTO documents
      (id, batch_id, sha256, filename, mime, size_bytes, storage_key, doc_type, status, uploaded_by,
       claim_id, perceptual_hash, duplicate_of, duplicate_score, notes, is_synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, input.batchId, hash, filename, mime, input.bytes.length, storageKey,
      input.docType ?? classifyFile(filename, mime),
      nearId ? "NEEDS_REVIEW" : "UPLOADED",
      user.id, input.claimId ?? null, perceptual, nearId ?? null, nearScore ?? null,
      nearId ? "Potential duplicate of an existing image (perceptual hash). Review before merging." : null,
      user.isSynthetic,
    ],
  );
  if (input.batchId) {
    await db.query(`UPDATE document_batches SET file_count = file_count + 1 WHERE id = $1`, [input.batchId]);
  }
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "DOCUMENT_UPLOADED",
    entityType: "document", entityId: id,
    summary: `Uploaded ${filename} (${(input.bytes.length / 1024).toFixed(1)} KB)`,
    after: { sha256: hash, filename, docType: input.docType ?? null },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { documentId: id, filename, duplicate: false, nearDuplicateOf: nearId };
}

export async function processDocumentOcr(db: Db, user: CurrentUser, documentId: string, ctx: { ip?: string | null } = {}): Promise<ExtractionOutcome> {
  if (!can(user.role, "document.review", user.permissions)) throw new Error("You cannot run or review OCR.");
  const doc = await one<{ id: string; filename: string; mime: string; storage_key: string; doc_type: string }>(
    db, `SELECT id, filename, mime, storage_key, doc_type FROM documents WHERE id = $1`, [documentId],
  );
  if (!doc) throw new Error("Document not found");
  const bytes = await readDocument(doc.storage_key);
  const outcome = await runExtraction(bytes, doc.mime, doc.filename);
  const extractionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ocr_extractions (id, document_id, engine, engine_version, status, raw_text, fields, confidence, error, duration_ms, created_by, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,now())`,
      [
        extractionId, documentId, outcome.engine, outcome.engineVersion, outcome.status,
        outcome.rawText || null, JSON.stringify(outcome.fields), JSON.stringify(outcome.confidence),
        outcome.error ?? null, outcome.durationMs, user.id,
      ],
    );
    await tx.query(
      `UPDATE documents SET status = $2, extracted = $3::jsonb, field_sources = $4::jsonb WHERE id = $1`,
      [
        documentId,
        outcome.status === "FAILED" ? "FAILED" : outcome.status === "SKIPPED" ? "NEEDS_REVIEW" : "EXTRACTED",
        JSON.stringify(outcome.fields),
        JSON.stringify({ ocr_extraction_id: extractionId, engine: outcome.engine, confidence: outcome.confidence }),
      ],
    );
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "OCR_RUN",
    entityType: "document", entityId: documentId,
    summary: `OCR ${outcome.status.toLowerCase()} via ${outcome.engine}${outcome.error ? `: ${outcome.error}` : ""}`,
    ip: ctx.ip,
  });
  return outcome;
}

export async function saveDocumentCorrection(
  db: Db, user: CurrentUser, documentId: string, fields: Record<string, unknown>,
) {
  if (!can(user.role, "document.review", user.permissions)) throw new Error("You cannot review documents.");
  const doc = await one<{ extracted: Record<string, unknown> }>(db, `SELECT extracted FROM documents WHERE id=$1`, [documentId]);
  if (!doc) throw new Error("Document not found");
  await db.query(
    `UPDATE documents SET extracted = $2::jsonb, review_status = 'CORRECTED', reviewed_by = $3, reviewed_at = now(), status = 'REVIEWED'
     WHERE id = $1`,
    [documentId, JSON.stringify({ ...doc.extracted, ...fields, corrected: true }), user.id],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "OCR_CORRECTED",
    entityType: "document", entityId: documentId,
    summary: "Reviewer corrected extracted fields", before: doc.extracted, after: fields,
  });
}

export async function listDocuments(
  db: Db,
  filters: { q?: string; status?: string; type?: string; limit?: number } = {},
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(filename) LIKE $${params.length} OR lower(COALESCE(notes,'')) LIKE $${params.length} OR lower(claim_id) LIKE $${params.length})`);
  }
  if (filters.status) { params.push(filters.status); clauses.push(`status = $${params.length}`); }
  if (filters.type) { params.push(filters.type); clauses.push(`doc_type = $${params.length}`); }
  params.push(Math.min(filters.limit ?? 100, 300));
  return (
    await db.query<{
      id: string; filename: string; mime: string; size_bytes: number; doc_type: string; status: string;
      uploaded_at: Date; claim_id: string | null; duplicate_of: string | null; extracted: Record<string, unknown>;
      uploader: string | null; claim_no: string | null; review_status: string;
    }>(
      `SELECT d.id, d.filename, d.mime, d.size_bytes, d.doc_type, d.status, d.uploaded_at, d.claim_id,
              d.duplicate_of, d.extracted, d.review_status, u.name AS uploader, c.claim_no
         FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN expense_claims c ON c.id = d.claim_id
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY d.uploaded_at DESC LIMIT $${params.length}`,
      params as never[],
    )
  ).rows;
}

export async function getDocument(db: Db, id: string) {
  const doc = await one<{
    id: string; filename: string; mime: string; size_bytes: number; doc_type: string; status: string;
    uploaded_at: Date; extracted: Record<string, unknown>; review_status: string; notes: string | null;
    claim_id: string | null; claim_no: string | null; sha256: string; perceptual_hash: string | null;
    duplicate_of: string | null; uploader: string | null; storage_key: string; field_sources: Record<string, unknown>;
  }>(
    db,
    `SELECT d.id, d.filename, d.mime, d.size_bytes, d.doc_type, d.status, d.uploaded_at, d.extracted,
            d.review_status, d.notes, d.claim_id, c.claim_no, d.sha256, d.perceptual_hash, d.duplicate_of,
            u.name AS uploader, d.storage_key, d.field_sources
       FROM documents d LEFT JOIN expense_claims c ON c.id = d.claim_id LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.id = $1`,
    [id],
  );
  if (!doc) return null;
  const extractions = (
    await db.query<{ id: string; engine: string; engine_version: string; status: string; error: string | null; duration_ms: number; started_at: Date; fields: Record<string, unknown>; confidence: Record<string, unknown> }>(
      `SELECT id, engine, engine_version, status, error, duration_ms, started_at, fields, confidence
         FROM ocr_extractions WHERE document_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [id],
    )
  ).rows;
  return { ...doc, extractions };
}
