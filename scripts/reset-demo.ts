/**
 * Remove the synthetic demo dataset.
 *
 *   npm run db:reset-demo
 *
 * This script refuses to run unless every account is synthetic. It also refuses
 * if any claim, payment, document, advance, agreement, budget, event, vendor or
 * financial account is explicitly marked as non-synthetic. Real data is never
 * deleted by this script; use BACKUP_AND_RESTORE.md if you need to start over
 * with real records.
 *
 * Reference data (permissions, categories, settings, organisations) is kept.
 * The cash box account is recreated with a zero opening balance.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDatabase, databaseConfigFromEnv, one } from "../src/server/db";
import { recordAudit } from "../src/server/audit";
import { DOCUMENT_ROOT } from "../src/server/storage";

const DEMO_EMAIL_DOMAIN = "@locus.demo";

async function main() {
  const db = await createDatabase(databaseConfigFromEnv());

  try {
    const users = await one<{ total: number; synthetic: number; foreign: number }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_synthetic)::int AS synthetic,
              COUNT(*) FILTER (WHERE NOT is_synthetic OR lower(email) NOT LIKE $1)::int AS foreign
         FROM users`,
      [`%${DEMO_EMAIL_DOMAIN}`],
    );

    if ((users?.total ?? 0) === 0) {
      const file = path.join(process.cwd(), ".data", "demo-credentials.txt");
      await fs.rm(file, { force: true });
      console.log("No accounts exist; nothing to reset.");
      console.log("Removed .data/demo-credentials.txt if it was present.");
      return;
    }

    if ((users?.foreign ?? 0) > 0) {
      console.error("Refusing to reset: this database contains a non-demo account.");
      console.error("Demo reset only runs on a workspace where every account is synthetic.");
      console.error("Export your data and restore from a backup if you need to remove real records.");
      process.exitCode = 1;
      return;
    }

    const nonSynthetic = await one<{
      members: number; claims: number; payments: number; documents: number; advances: number;
      agreements: number; budgets: number; events: number; vendors: number; accounts: number;
    }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM members WHERE NOT is_synthetic) AS members,
        (SELECT COUNT(*)::int FROM expense_claims WHERE NOT is_synthetic) AS claims,
        (SELECT COUNT(*)::int FROM payments WHERE NOT is_synthetic) AS payments,
        (SELECT COUNT(*)::int FROM documents WHERE NOT is_synthetic) AS documents,
        (SELECT COUNT(*)::int FROM advances WHERE NOT is_synthetic) AS advances,
        (SELECT COUNT(*)::int FROM sponsorship_agreements WHERE NOT is_synthetic) AS agreements,
        (SELECT COUNT(*)::int FROM budgets WHERE NOT is_synthetic) AS budgets,
        (SELECT COUNT(*)::int FROM events WHERE NOT is_synthetic) AS events,
        (SELECT COUNT(*)::int FROM vendors WHERE NOT is_synthetic) AS vendors,
        (SELECT COUNT(*)::int FROM financial_accounts WHERE NOT is_synthetic AND id <> 'acct_cash') AS accounts`,
    );
    const flagged = Object.entries(nonSynthetic ?? {}).filter(([, n]) => Number(n) > 0);
    if (flagged.length) {
      console.error("Refusing to reset: these records are explicitly marked as non-synthetic:");
      for (const [table, count] of flagged) console.error(`  ${table}: ${count}`);
      console.error("Remove or archive them deliberately before resetting the demo.");
      process.exitCode = 1;
      return;
    }

    const counts = await one<{
      users: number; members: number; claims: number; payments: number; documents: number;
      advances: number; agreements: number; budgets: number; journal: number; statements: number;
    }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM members) AS members,
        (SELECT COUNT(*)::int FROM expense_claims) AS claims,
        (SELECT COUNT(*)::int FROM payments) AS payments,
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM advances) AS advances,
        (SELECT COUNT(*)::int FROM sponsorship_agreements) AS agreements,
        (SELECT COUNT(*)::int FROM budgets) AS budgets,
        (SELECT COUNT(*)::int FROM journal_entries) AS journal,
        (SELECT COUNT(*)::int FROM statement_imports) AS statements`,
    );

    const storageKeys = (
      await db.query<{ storage_key: string }>(`SELECT storage_key FROM documents`)
    ).rows.map((r) => r.storage_key);

    await db.exec(`
      TRUNCATE TABLE
        sessions,
        approvals,
        expense_allocations,
        advance_settlements,
        bank_statement_lines,
        reconciliations,
        statement_imports,
        import_rows,
        import_batches,
        journal_lines,
        journal_entries,
        payments,
        expense_claims,
        advances,
        sponsor_deliverables,
        sponsorship_agreements,
        sponsors,
        budget_revisions,
        budget_lines,
        budgets,
        documents,
        ocr_extractions,
        document_batches,
        events,
        departments,
        vendors,
        members,
        users,
        financial_accounts,
        audit_events
      CASCADE;

      INSERT INTO financial_accounts (id, name, type, opening_balance_paisa, notes)
      VALUES ('acct_cash', 'Cash box', 'CASH', 0,
              'Opening balance not yet verified. Set it in Settings → Accounts once counted.');

      INSERT INTO settings (key, value) VALUES
        ('approval_thresholds', '{"standard":200000,"executive":2500000,"committee":10000000}'::jsonb),
        ('display', '{"numberGrouping":"lakh","dateCalendar":"AD","timezone":"Asia/Kathmandu"}'::jsonb),
        ('documentation', '{"missingReceiptRequiresDeclaration":true,"secondApprovalAbove":500000}'::jsonb),
        ('compliance', '{"pan":null,"vatRegistered":false,"legalStatus":"UNVERIFIED","note":"LOCUS legal/tax status is unverified. Do not treat tax fields as obligations until confirmed by a Nepali accountant."}'::jsonb),
        ('reconstruction', '{"baselineVersion":0}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = NULL;

      ALTER SEQUENCE claim_seq RESTART WITH 1;
      ALTER SEQUENCE payment_seq RESTART WITH 1;
      ALTER SEQUENCE advance_seq RESTART WITH 1;
      ALTER SEQUENCE agreement_seq RESTART WITH 1;
      ALTER SEQUENCE journal_seq RESTART WITH 1;
    `);

    let removedFiles = 0;
    const root = path.resolve(DOCUMENT_ROOT);
    for (const key of storageKeys) {
      if (!key || key.includes("..")) continue;
      const full = path.resolve(root, key);
      if (!full.startsWith(`${root}${path.sep}`)) continue;
      try {
        await fs.unlink(full);
        removedFiles++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    await fs.rm(path.join(process.cwd(), ".data", "demo-credentials.txt"), { force: true });

    await recordAudit(db, {
      actorUserId: null, actorName: "CLI",
      action: "DEMO_RESET", entityType: "organization", entityId: null,
      summary: `Synthetic demo reset. Removed ${counts?.claims ?? 0} claims, ${counts?.payments ?? 0} payments, ${counts?.documents ?? 0} documents, ${counts?.journal ?? 0} journal entries.`,
      before: counts,
    });

    console.log("Synthetic demo removed.");
    console.log(`  Accounts:      ${counts?.users ?? 0}`);
    console.log(`  Claims:        ${counts?.claims ?? 0}`);
    console.log(`  Payments:      ${counts?.payments ?? 0}`);
    console.log(`  Documents:     ${counts?.documents ?? 0} (${removedFiles} file(s) deleted)`);
    console.log(`  Journal:       ${counts?.journal ?? 0}`);
    console.log(`  Statements:    ${counts?.statements ?? 0}`);
    console.log("");
    console.log("Reference data and expense categories were kept.");
    console.log("Next: `npm run db:create-admin -- --email=… --name=…` to start a real workspace.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
