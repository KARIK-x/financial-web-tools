import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { createBatch, uploadOne } from "@/server/documents";
import { setDocumentLegalHold } from "@/server/retention";

describe("retention and legal hold", () => {
  it("sets and releases a legal hold with an audit trail", async () => {
    const db = await createTestDb();
    try {
      const admin = await createPerson(db, { role: "ADMIN", name: "Retention Admin", member: false });
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const batch = await createBatch(db, admin, "Retention batch", "UPLOAD");
      const uploaded = await uploadOne(db, admin, { filename: "retention.png", mime: "image/png", bytes, batchId: batch });
      await setDocumentLegalHold(db, admin, { documentId: uploaded.documentId, hold: true, reason: "Audit hold", retentionUntil: "2027-01-01", policy: "7-year" });
      const held = await db.query<{ legal_hold: boolean; legal_hold_reason: string }>(`SELECT legal_hold, legal_hold_reason FROM documents WHERE id=$1`, [uploaded.documentId]);
      expect(held.rows[0]).toMatchObject({ legal_hold: true, legal_hold_reason: "Audit hold" });
      await setDocumentLegalHold(db, admin, { documentId: uploaded.documentId, hold: false });
      const released = await db.query<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id=$1`, [uploaded.documentId]);
      expect(released.rows[0]?.legal_hold).toBe(false);
      const audit = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE entity_id=$1 AND action IN ('DOCUMENT_LEGAL_HOLD_SET','DOCUMENT_LEGAL_HOLD_RELEASED')`, [uploaded.documentId]);
      expect(audit.rows.map((r) => r.action)).toEqual(["DOCUMENT_LEGAL_HOLD_SET", "DOCUMENT_LEGAL_HOLD_RELEASED"]);
    } finally { await db.close(); }
  });
});
