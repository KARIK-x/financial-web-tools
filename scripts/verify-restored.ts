import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await visit(root);
  return out;
}

async function main() {
  const databaseDir = arg("database-dir");
  const documentDir = arg("document-dir");
  const from = arg("from");
  if (!databaseDir || !documentDir) throw new Error("Usage: npx tsx scripts/verify-restored.ts --database-dir <dir> --document-dir <dir> [--from <backup>]");
  const errors: string[] = [];
  const db = new PGlite(databaseDir);
  await db.waitReady;
  try {
    const counts = await db.query<{ documents: number; claims: number; journal: number; lines: number; audit: number }>(
      `SELECT (SELECT COUNT(*)::int FROM documents) AS documents,
              (SELECT COUNT(*)::int FROM expense_claims) AS claims,
              (SELECT COUNT(*)::int FROM journal_entries) AS journal,
              (SELECT COUNT(*)::int FROM journal_lines) AS lines,
              (SELECT COUNT(*)::int FROM audit_events) AS audit`,
    );
    const journal = await db.query<{ debit: string | number | bigint; credit: string | number | bigint; unbalanced: number }>(
      `SELECT COALESCE(SUM(debit_paisa),0) AS debit, COALESCE(SUM(credit_paisa),0) AS credit,
              (SELECT COUNT(*)::int FROM (SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_paisa)<>SUM(credit_paisa)) x) AS unbalanced
         FROM journal_lines`,
    );
    const docs = await db.query<{ storage_key: string; sha256: string }>(`SELECT storage_key, sha256 FROM documents`);
    const files = new Set((await walk(documentDir)).map((file) => path.relative(documentDir, file).split(path.sep).join("/")));
    for (const doc of docs.rows) {
      if (!files.has(doc.storage_key)) { errors.push(`missing document file: ${doc.storage_key}`); continue; }
      const hash = createHash("sha256").update(await fs.readFile(path.join(documentDir, doc.storage_key))).digest("hex");
      if (hash !== doc.sha256) errors.push(`document hash mismatch: ${doc.storage_key}`);
    }
    const dbKeys = new Set(docs.rows.map((d) => d.storage_key));
    const orphan = [...files].filter((key) => !dbKeys.has(key));
    if (orphan.length) console.log(`WARN orphan document files: ${orphan.join(", ")}`);
    const j = journal.rows[0];
    if (Number(j?.debit) !== Number(j?.credit)) errors.push(`journal not balanced: ${j?.debit} vs ${j?.credit}`);
    if (Number(j?.unbalanced) > 0) errors.push(`${j?.unbalanced} unbalanced journal entries`);

    if (from) {
      const manifest = JSON.parse(await fs.readFile(path.join(from, "manifest.json"), "utf8")) as { counts: Record<string, number>; journal: { entries: number; totalDebit: number; totalCredit: number } };
      for (const [table, expected] of Object.entries(manifest.counts)) {
        const row = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "${table}"`);
        if (Number(row.rows[0]?.n ?? 0) !== Number(expected)) errors.push(`count mismatch ${table}: ${row.rows[0]?.n} vs ${expected}`);
      }
      if (Number(j?.debit) !== manifest.journal.totalDebit || Number(j?.credit) !== manifest.journal.totalCredit) {
        errors.push("journal totals differ from manifest");
      }
    }

    console.log(errors.length ? "RESTORED DATABASE FAILED" : "RESTORED DATABASE VERIFIED");
    console.log(`  Claims: ${counts.rows[0]?.claims ?? 0}`);
    console.log(`  Documents: ${counts.rows[0]?.documents ?? 0} (${files.size} files)`);
    console.log(`  Journal: ${counts.rows[0]?.journal ?? 0} entries / ${counts.rows[0]?.lines ?? 0} lines, debit=${j?.debit}, credit=${j?.credit}`);
    console.log(`  Audit events: ${counts.rows[0]?.audit ?? 0}`);
    for (const error of errors) console.error(`FAIL ${error}`);
    if (errors.length) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
