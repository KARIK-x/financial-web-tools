import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import sharp from "sharp";
import { canAccessDocument, createBatch, uploadOne } from "@/server/documents";
import { listClaims, summarizeClaims } from "@/server/expenses";
import { csvCell } from "@/lib/csv";

describe("security audit", () => {
  it("blocks cross-user document access and injection-like search input", async () => {
    const db = await createTestDb();
    try {
      const alice = await createPerson(db, { role: "MEMBER", name: "Alice Audit" });
      const bob = await createPerson(db, { role: "MEMBER", name: "Bob Audit" });
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
      const batch = await createBatch(db, alice, "Audit batch", "UPLOAD");
      const uploaded = await uploadOne(db, alice, { filename: "audit.png", mime: "image/png", bytes, batchId: batch });
      expect(await canAccessDocument(db, bob, uploaded.documentId)).toBe(false);
      // Injection-like text must be treated as data, not SQL.
      const claims = await listClaims(db, alice, { q: "' OR 1=1 --" });
      expect(Array.isArray(claims)).toBe(true);
      const summary = await summarizeClaims(db, alice, { q: "' OR 1=1 --" });
      expect(summary.n).toBe(0);
    } finally { await db.close(); }
  });

  it("neutralizes spreadsheet formula injection", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@import")).toBe("'@import");
    expect(csvCell("safe")).toBe("safe");
  });
});
