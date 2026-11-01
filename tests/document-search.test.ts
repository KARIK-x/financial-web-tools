import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createBatch, uploadOne } from "@/server/documents";
import { rebuildDocumentSearchIndex, searchDocuments } from "@/server/document-search";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let admin: CurrentUser;
let member: CurrentUser;
let adminDocId: string;
let memberDocId: string;

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

beforeAll(async () => {
  db = await createTestDb();
  admin = await createPerson(db, { role: "ADMIN", name: "Search Admin" });
  member = await createPerson(db, { role: "MEMBER", name: "Search Member" });

  const adminBatch = await createBatch(db, admin, "Search admin batch", "UPLOAD");
  const memberBatch = await createBatch(db, member, "Search member batch", "UPLOAD");
  const adminUpload = await uploadOne(db, admin, { filename: "everest-hotel.png", mime: "image/png", bytes: pngBytes, batchId: adminBatch });
  const memberUpload = await uploadOne(db, member, { filename: "everest-member.png", mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]), batchId: memberBatch });
  adminDocId = adminUpload.documentId;
  memberDocId = memberUpload.documentId;

  const extracted = { merchant: "Everest Hotel", invoiceNo: "INV-2026-42", totalRaw: "2,500.00", totalPaisa: 250000, date: "2026-10-01" };
  await db.query(`UPDATE documents SET extracted = $2::jsonb, status = 'EXTRACTED', review_status = 'UNREVIEWED' WHERE id = $1`, [adminDocId, JSON.stringify(extracted)]);
  await db.query(`UPDATE documents SET extracted = $2::jsonb, status = 'EXTRACTED', review_status = 'UNREVIEWED' WHERE id = $1`, [memberDocId, JSON.stringify({ ...extracted, merchant: "Everest Member Hotel" })]);

  await db.query(
    `INSERT INTO ocr_extractions (id, document_id, engine, engine_version, status, raw_text, fields, confidence, finished_at)
     VALUES ($1,$2,'tesseract','test','SUCCEEDED',$3,$4::jsonb,$5::jsonb,now())`,
    [crypto.randomUUID(), adminDocId, "Everest Hotel receipt invoice INV-2026-42 amount NPR 2,500.00", JSON.stringify(extracted), JSON.stringify({ merchant: 0.9 })],
  );
  await db.query(
    `INSERT INTO ocr_extractions (id, document_id, engine, engine_version, status, raw_text, fields, confidence, finished_at)
     VALUES ($1,$2,'tesseract','test','SUCCEEDED',$3,$4::jsonb,$5::jsonb,now())`,
    [crypto.randomUUID(), memberDocId, "Everest Member Hotel receipt invoice INV-2026-42 amount NPR 2,500.00", JSON.stringify({ ...extracted, merchant: "Everest Member Hotel" }), JSON.stringify({ merchant: 0.9 })],
  );

  await rebuildDocumentSearchIndex(db, adminDocId);
  await rebuildDocumentSearchIndex(db, memberDocId);
});

afterAll(async () => {
  await db.close();
});

describe("document search", () => {
  it("finds an exact merchant and returns a snippet", async () => {
    const result = await searchDocuments(db, admin, { query: "Everest Hotel" });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.id)).toContain(adminDocId);
    expect(result.rows[0]?.snippet).toContain("<mark>");
  });

  it("filters by permission so members only see their own documents", async () => {
    const result = await searchDocuments(db, member, { query: "Everest" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(memberDocId);
  });

  it("finds invoice numbers and normalized amounts", async () => {
    const invoice = await searchDocuments(db, admin, { query: "INV-2026-42" });
    expect(invoice.total).toBe(2);

    const amount = await searchDocuments(db, admin, { query: "2500" });
    expect(amount.total).toBe(2);
    expect(amount.rows.every((r) => r.score > 0)).toBe(true);
  });

  it("supports status, type, and amount filters", async () => {
    const result = await searchDocuments(db, admin, {
      query: "Everest",
      status: "EXTRACTED",
      docType: "RECEIPT",
      amountMin: 2000,
      amountMax: 3000,
    });
    expect(result.total).toBe(2);
  });

  it("returns all accessible documents when no query is supplied", async () => {
    const result = await searchDocuments(db, admin, {});
    expect(result.total).toBe(2);
  });
});
