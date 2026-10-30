import { verifyBackup } from "./lib/backup";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const from = arg("from");
  if (!from) throw new Error("Usage: npm run db:verify-backup -- --from <backup-directory>");
  const result = await verifyBackup(from);
  console.log(result.ok ? "VERIFIED" : "VERIFICATION FAILED");
  if (result.manifest) {
    console.log(`  Created: ${result.manifest.createdAt}`);
    console.log(`  Git commit: ${result.manifest.gitCommit ?? "unknown"}`);
    console.log(`  Journal: ${result.manifest.journal.entries} entries, debit=${result.manifest.journal.totalDebit}, credit=${result.manifest.journal.totalCredit}`);
    console.log(`  Documents: ${result.manifest.documents.dbRows} rows, ${result.manifest.documents.files} files`);
  }
  for (const warning of result.warnings) console.log(`WARN ${warning}`);
  for (const error of result.errors) console.error(`FAIL ${error}`);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
