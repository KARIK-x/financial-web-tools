import { createDatabase, databaseConfigFromEnv } from "../src/server/db";
import { retentionEnforcementReport } from "../src/server/retention";

async function main() {
  const db = await createDatabase(databaseConfigFromEnv());
  try {
    const report = await retentionEnforcementReport(db);
    console.log(`Retention check: ${report.expired.length} expired non-held document(s), ${report.heldCount} expired document(s) on legal hold.`);
    for (const doc of report.expired) {
      console.log(`EXPIRED ${doc.id} ${doc.filename} until=${doc.retention_until} policy=${doc.retention_policy ?? "none"}`);
    }
    console.log("Documents are immutable; review expired records before any manual action.");
    if (report.expired.length > 0) process.exitCode = 2;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
