import path from "node:path";
import { restoreBackup } from "./lib/backup";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const from = arg("from");
  if (!from) throw new Error("Usage: npm run db:restore -- --from <backup-directory> [--database-dir <dir>] [--document-dir <dir>] [--force]");
  const databaseDir = arg("database-dir") ?? path.join(process.cwd(), ".data", "pglite");
  const documentDir = arg("document-dir") ?? path.join(process.cwd(), ".data", "documents");
  const result = await restoreBackup({ from, databaseDir, documentDir, force: has("force") });
  console.log(`Restored to ${databaseDir} and ${documentDir}`);
  console.log(`  Backup verified: ${result.ok ? "yes" : "no"}`);
  console.log(`  Journal: ${result.manifest?.journal.entries ?? "?"} entries`);
  for (const warning of result.warnings) console.log(`WARN ${warning}`);
  console.log("Start the application only after checking that no old process is still using the target directory.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
