import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { previewHistoricalClaimsCsv, commitHistoricalClaimsImport } from "@/server/historical-import";

describe("historical claims import", () => {
  it("previews valid, invalid and duplicate rows without writing claims, then commits only valid rows", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Import Finance", synthetic: true });
      const member = await createPerson(db, { role: "MEMBER", name: "Import Member", email: "import.member@example.org" });
      // create an existing claim to test duplicate detection
      await db.query(
        `INSERT INTO expense_claims (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, vendor_name_raw, description, amount_paisa, category_id, funding_source, status, source_type, is_synthetic, verification_state, created_by)
         VALUES ($1,'DUP-1',$2,$3,'2026-10-01','Vendor','Existing',100000,'cat_printing','PERSONAL','SUBMITTED','LIVE',false,'UNVERIFIED',$4)`,
        [randomUUID(), finance.id, member.memberId, finance.id],
      );

      const csv = [
        "date,member,vendor,description,amount,claim_no",
        "2026-10-02,import.member@example.org,Vendor,New claim,2000,NEW-1",
        "bad-date,import.member@example.org,Vendor,Bad,1000,BAD-1",
        "2026-10-01,import.member@example.org,Vendor,Duplicate,1000,DUP-1",
      ].join("\n");

      const preview = await previewHistoricalClaimsCsv(db, finance, { filename: "history.csv", bytes: Buffer.from(csv) });
      expect(preview.totalRows).toBe(3);

      const beforeClaims = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expense_claims`);
      const rows = await db.query<any>(`SELECT row_no,status,raw FROM import_rows WHERE batch_id=$1`, [preview.batchId]);
      const committed = await commitHistoricalClaimsImport(db, finance, { batchId: preview.batchId, confirm: true });
      expect(committed.imported).toBe(1);
      expect(committed.skipped).toBe(2);

      const afterClaims = await db.query<{ n: number; source_type: string }>(
        `SELECT COUNT(*)::int AS n, source_type FROM expense_claims WHERE source_type='HISTORICAL_IMPORT' GROUP BY source_type`,
      );
      expect(afterClaims.rows[0]?.n).toBe(1);
      const importedClaim = await db.query<{ status: string; verification_state: string; is_synthetic: boolean }>(
        `SELECT status, verification_state, is_synthetic FROM expense_claims WHERE claim_no='NEW-1'`,
      );
      expect(importedClaim.rows[0]).toMatchObject({ status: "SUBMITTED", verification_state: "UNVERIFIED", is_synthetic: false });
      const batch = await db.query<{ status: string }>(`SELECT status FROM import_batches WHERE id=$1`, [preview.batchId]);
      expect(batch.rows[0]?.status).toBe("COMMITTED");
    } finally { await db.close(); }
  });

  it("requires explicit confirmation", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Import Finance 2", synthetic: true });
      const csv = "date,member,vendor,description,amount\n2026-10-02,missing@example.org,Vendor,New,1000\n";
      const preview = await previewHistoricalClaimsCsv(db, finance, { filename: "history2.csv", bytes: Buffer.from(csv) });
      await expect(commitHistoricalClaimsImport(db, finance, { batchId: preview.batchId, confirm: false })).rejects.toThrow(/confirmation/i);
    } finally { await db.close(); }
  });
});
