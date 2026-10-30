import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase, type Db } from "@/server/db";
import { createExpense, decideClaim, getClaim, recordClaimPayment } from "@/server/expenses";
import { accountCodeBalance, createPerson, journalTotals } from "./helpers/fixtures";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("managed PostgreSQL adapter", () => {
  let admin: Client;
  let db: Db;
  let databaseName: string;
  let targetUrl: string;

  beforeAll(async () => {
    if (!adminUrl) return;
    databaseName = `locus_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    targetUrl = url.toString();
    db = await createDatabase({ connectionString: targetUrl });
  }, 60_000);

  afterAll(async () => {
    if (!adminUrl) return;
    await db?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it("applies the real migrations and preserves financial transactions", async () => {
    const tables = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    expect(Number(tables.rows[0]?.n)).toBe(44); // 43 domain tables + schema_migrations

    const member = await createPerson(db, { role: "MEMBER", name: "PG Member", synthetic: true });
    const finance = await createPerson(db, { role: "FINANCE", name: "PG Finance", synthetic: true });
    const executive = await createPerson(db, { role: "EXECUTIVE", name: "PG Executive", synthetic: true });
    const cashId = randomUUID();
    await db.query(
      `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa, is_synthetic)
       VALUES ($1,'PG cash','CASH',1000000,true)`,
      [cashId],
    );

    const created = await createExpense(db, member, {
      date: "2026-10-20",
      vendorName: "PG Synthetic Vendor",
      description: "Managed PostgreSQL adapter integration test",
      amount: "5000",
      categoryId: "cat_printing",
      fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic test declaration; no real receipt exists.",
      submitNow: true,
    });
    await decideClaim(db, finance, created.id, "APPROVE", "PG integration approval");
    await decideClaim(db, executive, created.id, "APPROVE", "PG integration second approval");
    await recordClaimPayment(db, finance, {
      claimId: created.id,
      accountId: cashId,
      amount: "5000",
      date: "2026-10-21",
    });

    const claim = await getClaim(db, finance, created.id);
    expect(claim?.status).toBe("REIMBURSED");
    expect(claim?.amount_paisa).toBe(500_000);

    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.debit).toBeGreaterThan(0);
    expect(await accountCodeBalance(db, "2000")).toBe(0);
  }, 60_000);

  it("rolls back a failed financial transaction atomically", async () => {
    const before = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM members`);
    await expect(db.transaction(async (tx) => {
      await tx.query(`INSERT INTO members (id, name, email) VALUES ($1,'Rollback member','rollback@test.local')`, [randomUUID()]);
      throw new Error("intentional rollback");
    })).rejects.toThrow("intentional rollback");
    const after = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM members`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
