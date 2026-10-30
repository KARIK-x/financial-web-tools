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
import { malwareScanRequired, scanBytes, validateUpload } from "./malware";

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
  const validation = validateUpload(input.bytes, mime, filename);
  if (!validation.ok) throw new Error(validation.error);
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

  const scan = await scanBytes(input.bytes);
  if (scan.status === "INFECTED" || (malwareScanRequired() && scan.status !== "CLEAN")) {
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "DOCUMENT_SCAN_BLOCKED",
      entityType: "document_upload", entityId: null,
      summary: `Upload ${filename} was rejected by malware policy (${scan.status}).`,
      after: { sha256: hash, scan_status: scan.status, signature: scan.signature ?? null },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    throw new Error(
      scan.status === "INFECTED"
        ? "The file matched a malware signature and was not stored. Contact the Finance Manager."
        : "Malware scanning is required but no scanner is available. The file was not stored.",
    );
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
       claim_id, perceptual_hash, duplicate_of, duplicate_score, notes, is_synthetic,
       scan_status, scan_engine, scan_detail, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id, input.batchId, hash, filename, mime, input.bytes.length, storageKey,
      input.docType ?? classifyFile(filename, mime),
      nearId ? "NEEDS_REVIEW" : "UPLOADED",
      user.id, input.claimId ?? null, perceptual, nearId ?? null, nearScore ?? null,
      nearId ? "Potential duplicate of an existing image (perceptual hash). Review before merging." : null,
      user.isSynthetic,
      scan.status, scan.engine, scan.detail, scan.status === "UNAVAILABLE" ? null : new Date(),
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
  const doc = await one<{ id: string; filename: string; mime: string; storage_key: string; doc_type: string; scan_status: string }>(
    db, `SELECT id, filename, mime, storage_key, doc_type, scan_status FROM documents WHERE id = $1`, [documentId],
  );
  if (!doc) throw new Error("Document not found");
  if (doc.scan_status === "INFECTED" || (malwareScanRequired() && doc.scan_status !== "CLEAN")) {
    throw new Error("This document is quarantined by malware policy and cannot be processed or viewed.");
  }
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


export async function attachDocumentToClaim(
  db: Db,
  user: CurrentUser,
  input: { documentId: string; claimNo: string },
): Promise<{ documentId: string; claimId: string; claimNo: string }> {
  const doc = await one<{ id: string; filename: string; claim_id: string | null; uploaded_by: string | null; status: string }>(
    db, `SELECT id, filename, claim_id, uploaded_by, status FROM documents WHERE id = $1`, [input.documentId],
  );
  if (!doc) throw new Error("Document not found.");
  const reviewer = can(user.role, "document.review", user.permissions);
  if (doc.uploaded_by !== user.id && !reviewer) throw new Error("You can only attach a document you uploaded.");

  const claim = await one<{ id: string; claim_no: string; status: string; claimant_user_id: string; documentation_state: string }>(
    db, `SELECT id, claim_no, status, claimant_user_id, documentation_state
           FROM expense_claims WHERE upper(claim_no) = upper($1)`, [input.claimNo],
  );
  if (!claim) throw new Error(`No claim found with number ${input.claimNo}.`);
  if (claim.claimant_user_id !== user.id && !reviewer) throw new Error("You can only attach evidence to your own claim.");
  if (["REJECTED", "WITHDRAWN", "RECONCILED"].includes(claim.status)) {
    throw new Error("This claim is closed; attach the receipt to a new claim instead.");
  }
  if (doc.claim_id && doc.claim_id !== claim.id) {
    throw new Error("This document is already attached to another claim. Keep the original link and upload a separate copy only if it is genuinely different evidence.");
  }

  const already = await one<{ n: number }>(
    db, `SELECT COUNT(*)::int AS n FROM documents WHERE claim_id = $1 AND id <> $2`, [claim.id, input.documentId],
  );
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE documents SET claim_id = $2, doc_type = CASE WHEN doc_type='UNKNOWN' THEN 'RECEIPT' ELSE doc_type END WHERE id = $1`,
      [input.documentId, claim.id],
    );
    await tx.query(
      `UPDATE expense_claims SET documentation_state = 'COMPLETE'
        WHERE id = $1 AND documentation_state <> 'COMPLETE'`,
      [claim.id],
    );
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "DOCUMENT_ATTACHED",
    entityType: "document", entityId: input.documentId,
    summary: `Document ${doc.filename} attached to ${claim.claim_no}${(already?.n ?? 0) > 0 ? " (claim already had other documents)" : ""}`,
    before: { claim_id: doc.claim_id, documentation_state: claim.documentation_state },
    after: { claim_id: claim.id, documentation_state: "COMPLETE" },
  });
  return { documentId: input.documentId, claimId: claim.id, claimNo: claim.claim_no };
}

export async function reviewDocument(
  db: Db,
  user: CurrentUser,
  input: { documentId: string; accept: boolean },
): Promise<void> {
  if (!can(user.role, "document.review", user.permissions)) throw new Error("You do not have permission to review documents.");
  const doc = await one<{ id: string }>(db, `SELECT id FROM documents WHERE id=$1`, [input.documentId]);
  if (!doc) throw new Error("Document not found.");
  await db.query(
    `UPDATE documents SET review_status = $2, reviewed_by = $3, reviewed_at = now(),
            status = CASE WHEN $2 = 'ACCEPTED' THEN 'REVIEWED' ELSE 'NEEDS_REVIEW' END
      WHERE id = $1`,
    [input.documentId, input.accept ? "ACCEPTED" : "REJECTED", user.id],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name,
    action: input.accept ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
    entityType: "document", entityId: input.documentId,
    summary: input.accept ? "Reviewer accepted the extracted fields" : "Reviewer rejected the extracted fields",
  });
}

/** Central document visibility rule used by the list, detail page and file API. */
export async function canAccessDocument(db: Db, user: CurrentUser, documentId: string): Promise<boolean> {
  if (can(user.role, "document.view.all", user.permissions)) return true;
  const access = await one<{ uploaded_by: string | null; claimant: string | null }>(
    db,
    `SELECT d.uploaded_by, c.claimant_user_id AS claimant
       FROM documents d LEFT JOIN expense_claims c ON c.id = d.claim_id WHERE d.id = $1`,
    [documentId],
  );
  return access?.uploaded_by === user.id || (access?.claimant != null && access.claimant === user.id);
}

export async function listDocuments(
  db: Db,
  viewer: CurrentUser,
  filters: { q?: string; status?: string; type?: string; limit?: number } = {},
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!can(viewer.role, "document.view.all", viewer.permissions)) {
    params.push(viewer.id);
    clauses.push(`(d.uploaded_by = $${params.length} OR c.claimant_user_id = $${params.length})`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(d.filename) LIKE $${params.length} OR lower(COALESCE(d.notes,'')) LIKE $${params.length} OR lower(d.claim_id) LIKE $${params.length})`);
  }
  if (filters.status) { params.push(filters.status); clauses.push(`d.status = $${params.length}`); }
  if (filters.type) { params.push(filters.type); clauses.push(`d.doc_type = $${params.length}`); }
  params.push(Math.min(filters.limit ?? 100, 300));
  return (
    await db.query<{
      id: string; filename: string; mime: string; size_bytes: number; doc_type: string; status: string;
      uploaded_at: Date; claim_id: string | null; duplicate_of: string | null; extracted: Record<string, unknown>;
      uploader: string | null; claim_no: string | null; review_status: string; scan_status: string; scan_detail: string | null;
    }>(
      `SELECT d.id, d.filename, d.mime, d.size_bytes, d.doc_type, d.status, d.uploaded_at, d.claim_id,
              d.duplicate_of, d.extracted, d.review_status, d.scan_status, d.scan_detail, u.name AS uploader, c.claim_no
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
    scan_status: string; scan_engine: string | null; scan_detail: string | null; scanned_at: Date | null;
    legal_hold: boolean; legal_hold_reason: string | null; retention_until: Date | null; retention_policy: string | null;
  }>(
    db,
    `SELECT d.id, d.filename, d.mime, d.size_bytes, d.doc_type, d.status, d.uploaded_at, d.extracted,
            d.review_status, d.notes, d.claim_id, c.claim_no, d.sha256, d.perceptual_hash, d.duplicate_of,
            u.name AS uploader, d.storage_key, d.field_sources, d.scan_status, d.scan_engine, d.scan_detail, d.scanned_at,
            d.legal_hold, d.legal_hold_reason, d.retention_until, d.retention_policy
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
