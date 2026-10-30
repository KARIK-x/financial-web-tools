import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createBatch, uploadOne } from "@/server/documents";
import { setDocumentLegalHold } from "@/server/retention";
import { expiredRetentionDocuments } from "@/server/retention";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let admin: CurrentUser;

beforeAll(async () => {
  db = await createTestDb();
  admin = await createPerson(db, { role: "ADMIN", name: "Retention Automation Admin" });
});

afterAll(async () => {
  await db.close();
});

describe("retention automation", () => {
  it("lists expired documents that are not on legal hold", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const batch = await createBatch(db, admin, "Retention automation", "UPLOAD");
    const expiredDoc = await uploadOne(db, admin, { filename: "expired.png", mime: "image/png", bytes, batchId: batch });
    const heldDoc = await uploadOne(db, admin, { filename: "held.png", mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]), batchId: batch });
    await db.query(`UPDATE documents SET retention_until = CURRENT_DATE - INTERVAL '1 day' WHERE id IN ($1,$2)`, [expiredDoc.documentId, heldDoc.documentId]);
    await setDocumentLegalHold(db, admin, { documentId: heldDoc.documentId, hold: true, reason: "Hold" });

    const expired = await expiredRetentionDocuments(db);
    expect(expired.map((d) => d.id)).toContain(expiredDoc.documentId);
    expect(expired.map((d) => d.id)).not.toContain(heldDoc.documentId);
  });
});
