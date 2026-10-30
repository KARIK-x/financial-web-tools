import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { createExpense, getClaim } from "@/server/expenses";

describe("expense line items", () => {
  it("stores item details and requires them to total the claim amount", async () => {
    const db = await createTestDb();
    try {
      const member = await createPerson(db, { role: "MEMBER", name: "Line Item Member", synthetic: true });
      const claim = await createExpense(db, member, {
        date: "2026-10-12", vendorName: "Stationery Shop", description: "Printing and pens",
        amount: "300", categoryId: "cat_printing", fundingSource: "PERSONAL",
        missingReceiptDeclaration: "Synthetic line-item test", submitNow: false,
        items: [
          { description: "Color print", quantity: "2", unit: "page", unitPrice: "100", discount: "0", tax: "0" },
          { description: "Pen", quantity: "2", unit: "pcs", unitPrice: "50", discount: "0", tax: "0" },
        ],
      });
      const loaded = await getClaim(db, member, claim.id);
      expect(loaded?.items).toHaveLength(2);
      expect(loaded?.items?.reduce((s, i) => s + Number(i.line_total_paisa), 0)).toBe(30000);
      await expect(createExpense(db, member, {
        date: "2026-10-12", vendorName: "Stationery Shop", description: "Bad totals",
        amount: "300", categoryId: "cat_printing", fundingSource: "PERSONAL",
        missingReceiptDeclaration: "Synthetic line-item test", submitNow: false,
        items: [{ description: "Pen", quantity: "1", unit: "pcs", unitPrice: "50", discount: "0", tax: "0" }],
      })).rejects.toThrow(/totals/i);
    } finally { await db.close(); }
  });
});
