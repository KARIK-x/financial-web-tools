import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { previewGenericSpreadsheet, commitGenericSpreadsheet } from "@/server/generic-import";

describe("generic spreadsheet staging", () => {
  it("previews rows, detects duplicates, and commits without changing financial totals", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Generic Finance", synthetic: true });
      const csv = "Item,Cost,By\nTyre,1800,Abiral\nTyre,1800,Abiral\nOil,500,Sangam\n";
      const preview = await previewGenericSpreadsheet(db, finance, { filename: "old.csv", bytes: Buffer.from(csv) });
      expect(preview.totalRows).toBe(3);
      expect(preview.duplicateRows).toBe(1);
      const beforeClaims = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expense_claims`);
      const committed = await commitGenericSpreadsheet(db, finance, { batchId: preview.batchId, confirm: true });
      expect(committed.committed).toBe(2);
      const afterClaims = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expense_claims`);
      expect(afterClaims.rows[0]?.n).toBe(beforeClaims.rows[0]?.n);
    } finally { await db.close(); }
  });

  it("requires confirmation", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Generic Finance 2", synthetic: true });
      const preview = await previewGenericSpreadsheet(db, finance, { filename: "x.csv", bytes: Buffer.from("a,b\n1,2\n") });
      await expect(commitGenericSpreadsheet(db, finance, { batchId: preview.batchId, confirm: false })).rejects.toThrow(/confirmation/i);
    } finally { await db.close(); }
  });
});
