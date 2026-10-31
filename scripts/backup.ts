import path from "node:path";
import { createBackup } from "./lib/backup";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const databaseDir = arg("database-dir") ?? process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  const documentDir = arg("document-dir") ?? process.env.DOCUMENT_DIR ?? path.join(process.cwd(), ".data", "documents");
  const outDir = arg("out") ?? path.join(process.cwd(), "backups", `finance-tracker-${stamp}`);
  const manifest = await createBackup({ databaseDir, documentDir, outDir });
  console.log(`Backup written to ${outDir}`);
  console.log(`  Git commit: ${manifest.gitCommit ?? "unknown"}`);
  console.log(`  Journal: ${manifest.journal.entries} entries, debit=${manifest.journal.totalDebit}, credit=${manifest.journal.totalCredit}`);
  console.log(`  Documents: ${manifest.documents.dbRows} rows, ${manifest.documents.files} files, ${manifest.documents.orphan.length} orphan(s)`);
  console.log("Next: verify it before relying on it: npm run db:verify-backup -- --from " + outDir);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
