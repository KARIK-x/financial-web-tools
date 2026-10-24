import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createBatch, getDocument, processDocumentOcr, uploadOne } from "@/server/documents";
import { DOCUMENT_ROOT } from "@/server/storage";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let finance: CurrentUser;
let member: CurrentUser;

async function png(background: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer();
}

beforeAll(async () => {
  db = await createTestDb();
  finance = await createPerson(db, { role: "FINANCE", name: "Document Reviewer" });
  member = await createPerson(db, { role: "MEMBER", name: "Uploader" });
});

afterAll(async () => {
  await db.close();
  await fs.rm(DOCUMENT_ROOT, { recursive: true, force: true });
});

describe("document storage", () => {
  let batchId: string;
  let firstId: string;

  it("creates an upload batch", async () => {
    batchId = await createBatch(db, finance, "October receipts", "UPLOAD");
    expect(batchId).toBeTruthy();
  });

  it("stores a new receipt with a content-addressed key", async () => {
    const result = await uploadOne(db, finance, {
      filename: "receipt.png", mime: "image/png", bytes: await png({ r: 200, g: 30, b: 30 }), batchId,
    });
    expect(result.duplicate).toBe(false);
    firstId = result.documentId;

    const doc = await getDocument(db, firstId);
    expect(doc?.doc_type).toBe("RECEIPT");
    expect(doc?.size_bytes).toBeGreaterThan(0);
    expect(doc?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const provenance = await db.query<{ is_synthetic: boolean }>(`SELECT is_synthetic FROM documents WHERE id=$1`, [firstId]);
    expect(provenance.rows[0]?.is_synthetic).toBe(false);

    const stored = path.join(DOCUMENT_ROOT, doc!.storage_key);
    await expect(fs.access(stored)).resolves.toBeUndefined();
  });

  it("blocks an exact duplicate by SHA-256 and keeps one copy", async () => {
    const bytes = await png({ r: 200, g: 30, b: 30 });
    const result = await uploadOne(db, member, { filename: "same-receipt.png", mime: "image/png", bytes, batchId });
    expect(result.duplicate).toBe(true);
    expect(result.duplicateOf).toBe(firstId);
    const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it("flags a re-photographed (near-duplicate) image for review", async () => {
    const result = await uploadOne(db, finance, {
      filename: "receipt-rephoto.png", mime: "image/png", bytes: await png({ r: 190, g: 40, b: 40 }), batchId,
    });
    expect(result.duplicate).toBe(false);
    expect(result.nearDuplicateOf).toBe(firstId);
    const doc = await getDocument(db, result.documentId);
    expect(doc?.status).toBe("NEEDS_REVIEW");
    expect(doc?.review_status).toBe("UNREVIEWED");
  });

  it("keeps original document bytes immutable", async () => {
    await expect(
      db.query(`UPDATE documents SET sha256='deadbeef' WHERE id=$1`, [firstId]),
    ).rejects.toThrow(/immutable/i);
    await expect(db.query(`DELETE FROM documents WHERE id=$1`, [firstId])).rejects.toThrow(/cannot be deleted/i);
  });

  it("refuses OCR to roles without document review permission", async () => {
    await expect(processDocumentOcr(db, member, firstId)).rejects.toThrow(/cannot run or review OCR/i);
  });

  it("records upload audit events for every accepted file", async () => {
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_type='document' ORDER BY created_at`,
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain("DOCUMENT_UPLOADED");
    expect(actions).toContain("DOCUMENT_DUPLICATE_BLOCKED");
  });
});
