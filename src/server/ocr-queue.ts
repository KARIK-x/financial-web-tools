import { randomUUID } from "node:crypto";
import { one, type Db } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { readDocument } from "./storage";
import { runExtraction, type ExtractionOutcome } from "./ocr";
import { requestedOcrEngine } from "./ocr-engine";
import { recordAudit } from "./audit";
import { rebuildDocumentSearchIndex } from "./document-search";

export type OcrJob = {
  id: string;
  document_id: string;
  engine_requested: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  attempts: number;
  max_attempts: number;
  error: string | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

export type OcrQueueResult = {
  jobId: string;
  status: OcrJob["status"];
  queued: boolean;
};

function canQueueOcr(user: CurrentUser): boolean {
  return can(user.role, "document.upload", user.permissions) || can(user.role, "document.review", user.permissions);
}

export async function claimNextOcrJob(db: Db, workerId: string): Promise<OcrJob | null> {
  await db.query(
    `UPDATE ocr_jobs
        SET status = 'QUEUED',
            next_retry_at = now(),
            lease_expires_at = NULL,
            heartbeat_at = now()
      WHERE status = 'RUNNING'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()`,
  );
  return one<OcrJob>(
    db,
    `WITH next_job AS (
       SELECT id FROM ocr_jobs
        WHERE status = 'QUEUED'
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE ocr_jobs
        SET status = 'RUNNING',
            started_at = now(),
            attempts = attempts + 1,
            worker_id = $1,
            lease_expires_at = now() + interval '2 minutes',
            heartbeat_at = now()
      WHERE id = (SELECT id FROM next_job)
      RETURNING *`,
    [workerId],
  );
}

export async function processOcrJob(
  db: Db,
  job: OcrJob,
  actor: { id: string; name: string } | null = null,
  alreadyClaimed = false,
): Promise<ExtractionOutcome> {
  let claimed: OcrJob | null = null;
  if (alreadyClaimed || job.status === "RUNNING") {
    claimed = job;
  } else if (job.status === "QUEUED") {
    claimed = await one<OcrJob>(
      db,
      `UPDATE ocr_jobs
          SET status = 'RUNNING',
              started_at = COALESCE(started_at, now()),
              attempts = attempts + 1,
              worker_id = COALESCE(worker_id, $2),
              lease_expires_at = now() + interval '2 minutes',
              heartbeat_at = now()
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING *`,
      [job.id, actor ? actor.id : "worker"],
    );
  }

  const currentJob = claimed ?? (await one<OcrJob>(db, `SELECT * FROM ocr_jobs WHERE id = $1`, [job.id]));
  if (!currentJob) throw new Error("OCR job not found.");
  if (currentJob.status === "RUNNING" && !claimed && job.status !== "RUNNING") {
    return {
      engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {},
      status: "SKIPPED", error: "OCR is already running for this document.", durationMs: 0,
    };
  }
  if (currentJob.status === "SUCCEEDED") {
    const latest = await one<{ engine: string; engine_version: string; raw_text: string | null; fields: Record<string, unknown>; confidence: Record<string, number>; error: string | null; duration_ms: number | null; pages: unknown }>(
      db,
      `SELECT engine, engine_version, raw_text, fields, confidence, error, duration_ms, pages
         FROM ocr_extractions WHERE document_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [currentJob.document_id],
    );
    if (latest) {
      return {
        engine: latest.engine,
        engineVersion: latest.engine_version,
        rawText: latest.raw_text ?? "",
        fields: latest.fields ?? {},
        confidence: latest.confidence ?? {},
        status: "SUCCEEDED",
        error: latest.error ?? undefined,
        durationMs: latest.duration_ms ?? 0,
        pages: Array.isArray(latest.pages) ? latest.pages as ExtractionOutcome["pages"] : undefined,
      };
    }
  }
  if (currentJob.status === "CANCELLED") {
    return {
      engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {},
      status: "SKIPPED", error: "OCR job was cancelled.", durationMs: 0,
    };
  }
  if (!claimed) {
    return {
      engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {},
      status: "SKIPPED", error: "OCR job is not queued.", durationMs: 0,
    };
  }

  const doc = await one<{ id: string; filename: string; mime: string; storage_key: string; scan_status: string }>(
    db,
    `SELECT id, filename, mime, storage_key, scan_status FROM documents WHERE id = $1`,
    [claimed.document_id],
  );
  if (!doc) throw new Error("Document not found.");
  if (doc.scan_status === "INFECTED" || (process.env.MALWARE_SCAN_REQUIRED === "true" && doc.scan_status !== "CLEAN")) {
    const error = "This document is quarantined by malware policy and cannot be processed.";
    await db.query(`UPDATE ocr_jobs SET status = 'FAILED', error = $2, finished_at = now(), lease_expires_at = NULL WHERE id = $1`, [claimed.id, error]);
    await db.query(`UPDATE documents SET status = 'FAILED' WHERE id = $1`, [doc.id]);
    return { engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {}, status: "FAILED", error, durationMs: 0 };
  }

  const started = Date.now();
  const heartbeat = setInterval(() => {
    void db.query(
      `UPDATE ocr_jobs SET heartbeat_at = now(), lease_expires_at = now() + interval '2 minutes' WHERE id = $1 AND status = 'RUNNING'`,
      [claimed.id],
    ).catch(() => {});
  }, 15000);
  try {
    const bytes = await readDocument(doc.storage_key);
    const outcome = await runExtraction(bytes, doc.mime, doc.filename, claimed.engine_requested as "tesseract" | "unlimited-ocr" | "auto");
    const extractionId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ocr_extractions (id, document_id, engine, engine_version, status, raw_text, fields, confidence, error, duration_ms, created_by, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,now())`,
        [
          extractionId, doc.id, outcome.engine, outcome.engineVersion, outcome.status,
          outcome.rawText || null, JSON.stringify(outcome.fields), JSON.stringify(outcome.confidence),
          outcome.error ?? null, outcome.durationMs, actor?.id ?? null,
        ],
      );
      await tx.query(
        `UPDATE documents
            SET status = $2,
                extracted = $3::jsonb,
                field_sources = $4::jsonb,
                ocr_text = $5,
                ocr_text_updated_at = now()
          WHERE id = $1`,
        [
          doc.id,
          outcome.status === "FAILED" ? "FAILED" : outcome.status === "SKIPPED" ? "NEEDS_REVIEW" : "EXTRACTED",
          JSON.stringify(outcome.fields),
          JSON.stringify({ ocr_extraction_id: extractionId, engine: outcome.engine, confidence: outcome.confidence }),
          outcome.rawText || null,
        ],
      );
      await rebuildDocumentSearchIndex(tx as unknown as Db, doc.id);
      await tx.query(
        `UPDATE ocr_jobs
            SET status = 'SUCCEEDED', finished_at = now(), lease_expires_at = NULL, heartbeat_at = now(), error = $2
          WHERE id = $1`,
        [claimed.id, outcome.error ?? null],
      );
    });
    await recordAudit(db, {
      actorUserId: actor?.id ?? null,
      actorName: actor?.name ?? "OCR worker",
      action: "OCR_RUN",
      entityType: "document",
      entityId: doc.id,
      summary: `OCR ${outcome.status.toLowerCase()} via ${outcome.engine}${outcome.error ? `: ${outcome.error}` : ""}`,
    });
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const current = await one<OcrJob>(db, `SELECT * FROM ocr_jobs WHERE id = $1`, [claimed.id]);
    const attempts = current?.attempts ?? claimed.attempts;
    if (attempts < claimed.max_attempts) {
      await db.query(
        `UPDATE ocr_jobs
            SET status = 'QUEUED',
                error = $2,
                next_retry_at = now() + ($3 || ' minutes')::interval,
                lease_expires_at = NULL,
                heartbeat_at = now()
          WHERE id = $1`,
        [claimed.id, error, String(Math.min(2 ** attempts, 30))],
      );
    } else {
      await db.query(
        `UPDATE ocr_jobs
            SET status = 'FAILED', error = $2, finished_at = now(), lease_expires_at = NULL, heartbeat_at = now()
          WHERE id = $1`,
        [claimed.id, error],
      );
      await db.query(`UPDATE documents SET status = 'FAILED' WHERE id = $1`, [claimed.document_id]);
    }
    return {
      engine: "none",
      engineVersion: "n/a",
      rawText: "",
      fields: {},
      confidence: {},
      status: "FAILED",
      error,
      durationMs: Date.now() - started,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

export async function processNextOcrJob(workerId: string, dbOverride?: Db): Promise<ExtractionOutcome | null> {
  const db = dbOverride ?? await (await import("./db")).getDb();
  const job = await claimNextOcrJob(db, workerId);
  if (!job) return null;
  return processOcrJob(db, job, null, true);
}

export async function processDocumentOcr(
  db: Db,
  user: CurrentUser,
  documentId: string,
  ctx: { ip?: string | null } = {},
  options: { engine?: string; force?: boolean } = {},
): Promise<ExtractionOutcome> {
  const doc = await one<{ id: string; uploaded_by: string | null; scan_status: string }>(
    db,
    `SELECT id, uploaded_by, scan_status FROM documents WHERE id = $1`,
    [documentId],
  );
  if (!doc) throw new Error("Document not found.");
  if (!can(user.role, "document.review", user.permissions)) {
    throw new Error("You cannot run or review OCR.");
  }
  if (doc.scan_status === "INFECTED" || (process.env.MALWARE_SCAN_REQUIRED === "true" && doc.scan_status !== "CLEAN")) {
    throw new Error("This document is quarantined by malware policy and cannot be processed or viewed.");
  }

  const queued = await queueDocumentOcr(db, user, documentId, {
    engine: options.engine,
    force: options.force ?? true,
  });
  const job = await one<OcrJob>(db, `SELECT * FROM ocr_jobs WHERE id = $1`, [queued.jobId]);
  if (!job) throw new Error("OCR job was not created.");

  if (job.status === "RUNNING") {
    return {
      engine: "none", engineVersion: "n/a", rawText: "", fields: {}, confidence: {},
      status: "SKIPPED", error: "OCR is already running for this document.", durationMs: 0,
    };
  }
  if (job.status === "SUCCEEDED" && !options.force) {
    const latest = await one<{ engine: string; engine_version: string; raw_text: string | null; fields: Record<string, unknown>; confidence: Record<string, number>; error: string | null; duration_ms: number | null; pages: unknown }>(
      db,
      `SELECT engine, engine_version, raw_text, fields, confidence, error, duration_ms, pages
         FROM ocr_extractions WHERE document_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [documentId],
    );
    if (latest) {
      return {
        engine: latest.engine,
        engineVersion: latest.engine_version,
        rawText: latest.raw_text ?? "",
        fields: latest.fields ?? {},
        confidence: latest.confidence ?? {},
        status: "SUCCEEDED",
        error: latest.error ?? undefined,
        durationMs: latest.duration_ms ?? 0,
        pages: Array.isArray(latest.pages) ? latest.pages as ExtractionOutcome["pages"] : undefined,
      };
    }
  }

  return processOcrJob(db, job, user, false);
}

export async function queueDocumentOcr(
  db: Db,
  user: CurrentUser,
  documentId: string,
  options: { engine?: string; force?: boolean } = {},
): Promise<OcrQueueResult> {
  if (!can(user.role, "document.upload", user.permissions) && !can(user.role, "document.review", user.permissions)) {
    throw new Error("You cannot queue OCR for this document.");
  }
  const doc = await one<{ id: string; scan_status: string }>(
    db,
    `SELECT id, scan_status FROM documents WHERE id = $1`,
    [documentId],
  );
  if (!doc) throw new Error("Document not found.");
  if (doc.scan_status === "INFECTED" || (process.env.MALWARE_SCAN_REQUIRED === "true" && doc.scan_status !== "CLEAN")) {
    throw new Error("This document is quarantined by malware policy and cannot be processed.");
  }

  const engine = options.engine ?? requestedOcrEngine();
  const active = await one<OcrJob>(
    db,
    `SELECT * FROM ocr_jobs WHERE document_id = $1 AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1`,
    [documentId],
  );
  if (active) return { jobId: active.id, status: active.status, queued: false };

  const latestSucceeded = await one<OcrJob>(
    db,
    `SELECT * FROM ocr_jobs WHERE document_id = $1 AND status = 'SUCCEEDED' ORDER BY created_at DESC LIMIT 1`,
    [documentId],
  );
  if (latestSucceeded && !options.force) {
    return { jobId: latestSucceeded.id, status: latestSucceeded.status, queued: false };
  }

  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO ocr_jobs (id, document_id, engine_requested, status) VALUES ($1, $2, $3, 'QUEUED')`,
      [id, documentId, engine],
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      const current = await one<OcrJob>(
        db,
        `SELECT * FROM ocr_jobs WHERE document_id = $1 AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1`,
        [documentId],
      );
      if (current) return { jobId: current.id, status: current.status, queued: false };
    }
    throw err;
  }

  await db.query(`UPDATE documents SET status = 'QUEUED' WHERE id = $1`, [documentId]);
  await recordAudit(db, {
    actorUserId: user.id,
    actorName: user.name,
    action: "OCR_QUEUED",
    entityType: "document",
    entityId: documentId,
    summary: `OCR queued with ${engine}.`,
  });
  return { jobId: id, status: "QUEUED", queued: true };
}
