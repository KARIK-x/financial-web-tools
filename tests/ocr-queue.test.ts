import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createBatch, uploadOne } from "@/server/documents";
import sharp from "sharp";
import { queueDocumentOcr, processNextOcrJob, processDocumentOcr } from "@/server/ocr-queue";
import { rebuildDocumentSearchIndex, searchDocuments } from "@/server/document-search";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let admin: CurrentUser;
let documentId: string;

let pngBytes: Buffer;
beforeAll(async () => {
  pngBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}, 30000);

beforeAll(async () => {
  db = await createTestDb();
  admin = await createPerson(db, { role: "ADMIN", name: "Queue Admin" });
  const batch = await createBatch(db, admin, "Queue batch", "UPLOAD");
  const uploaded = await uploadOne(db, admin, { filename: "queue-receipt.png", mime: "image/png", bytes: pngBytes, batchId: batch });
  documentId = uploaded.documentId;
});

afterAll(async () => {
  await db.close();
});

describe("OCR queue", () => {
  it("queues and processes a document without duplicates", async () => {
    const queued = await queueDocumentOcr(db, admin, documentId, { force: true });
    expect(queued.status).toBe("QUEUED");

    const duplicate = await queueDocumentOcr(db, admin, documentId);
    expect(duplicate.queued).toBe(false);

    const processed = await processNextOcrJob("test-worker", db);
    expect(processed).not.toBeNull();

    const job = await db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM ocr_jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [documentId]);
    expect(job.rows[0]?.status).toBe("SUCCEEDED");
    expect(job.rows[0]?.attempts).toBe(1);

    const doc = await db.query<{ status: string; ocr_text: string | null }>(`SELECT status, ocr_text FROM documents WHERE id = $1`, [documentId]);
    expect(["EXTRACTED", "NEEDS_REVIEW", "FAILED"]).toContain(doc.rows[0]?.status);
    await rebuildDocumentSearchIndex(db, documentId);
    const search = await searchDocuments(db, admin, { query: "queue" });
    expect(search.total).toBeGreaterThanOrEqual(1);
  });

  it("processDocumentOcr can run manually for a reviewer", async () => {
    const batch = await createBatch(db, admin, "Manual OCR batch", "UPLOAD");
    const uploaded = await uploadOne(db, admin, { filename: "manual-receipt.png", mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]), batchId: batch });
    const outcome = await processDocumentOcr(db, admin, uploaded.documentId, { ip: "127.0.0.1" });
    expect(["SUCCEEDED", "SKIPPED", "FAILED"]).toContain(outcome.status);
    const jobs = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ocr_jobs WHERE document_id = $1`, [uploaded.documentId]);
    expect(jobs.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });
});
