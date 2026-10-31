import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createDatabase, nextSequence, type Db } from "@/server/db";
import { createExpense, decideClaim, getClaim, recordClaimPayment } from "@/server/expenses";
import { createPerson, journalTotals } from "./helpers/fixtures";

const run = promisify(execFile);
const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("PGlite to PostgreSQL data migration", () => {
  let admin: Client;
  let sourceDir: string;
  let targetName: string;
  let targetUrl: string;

  beforeAll(async () => {
    if (!adminUrl) return;
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-tracker-migration-source-"));
    const source = await createDatabase({ dataDir: sourceDir });
    const member = await createPerson(source, { role: "MEMBER", name: "Migration Member", synthetic: true });
    const finance = await createPerson(source, { role: "FINANCE", name: "Migration Finance", synthetic: true });
    const executive = await createPerson(source, { role: "EXECUTIVE", name: "Migration Executive", synthetic: true });
    const cashId = randomUUID();
    await source.query(
      `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa, is_synthetic)
       VALUES ($1,'Migration cash','CASH',1000000,true)`,
      [cashId],
    );
    const created = await createExpense(source, member, {
      date: "2026-10-20",
      vendorName: "Migration Synthetic Vendor",
      description: "PGlite to PostgreSQL migration fixture",
      amount: "5000",
      categoryId: "cat_printing",
      fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic test declaration; no real receipt exists.",
      submitNow: true,
    });
    await decideClaim(source, finance, created.id, "APPROVE", "Migration fixture approval");
    await decideClaim(source, executive, created.id, "APPROVE", "Migration fixture second approval");
    await recordClaimPayment(source, finance, {
      claimId: created.id,
      accountId: cashId,
      amount: "5000",
      date: "2026-10-21",
    });
    await source.close();

    targetName = `finance_tracker_migration_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${targetName}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${targetName}`;
    targetUrl = url.toString();

    await run("npx", ["tsx", "scripts/migrate-to-postgres.ts", "--source", sourceDir, "--target", targetUrl], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "" },
      timeout: 120_000,
    });
  }, 180_000);

  afterAll(async () => {
    if (!adminUrl) return;
    await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(sourceDir, { recursive: true, force: true });
  }, 60_000);

  it("preserves counts, financial totals, identifiers and sequences", async () => {
    const target: Db = await createDatabase({ connectionString: targetUrl });
    try {
      const claim = await target.query<{ id: string; claim_no: string; amount_paisa: number; status: string }>(
        `SELECT id, claim_no, amount_paisa, status FROM expense_claims`,
      );
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0]?.claim_no).toMatch(/^LOC-/);
      expect(claim.rows[0]?.amount_paisa).toBe(500_000);
      expect(claim.rows[0]?.status).toBe("REIMBURSED");

      const totals = await journalTotals(target);
      expect(totals.entries).toBe(2);
      expect(totals.debit).toBe(totals.credit);
      expect(totals.debit).toBe(1_000_000);

      const docs = await target.query<{ n: number }>(`SELECT COUNT(*) AS n FROM documents`);
      expect(Number(docs.rows[0]?.n)).toBe(0);

      expect(await nextSequence(target, "claim_seq")).toBeGreaterThan(1);
      expect(await nextSequence(target, "payment_seq")).toBeGreaterThan(1);
      expect(await nextSequence(target, "journal_seq")).toBeGreaterThan(1);
    } finally {
      await target.close();
    }
  }, 60_000);
});
