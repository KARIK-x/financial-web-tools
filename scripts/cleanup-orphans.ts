import { createDatabase, databaseConfigFromEnv, describeDatabaseTarget } from "../src/server/db";
import { deleteOrphanDocumentFiles, findOrphanDocumentFiles } from "../src/server/storage-cleanup";

async function main() {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1];
  const graceArg = process.argv.find((a) => a.startsWith("--grace-hours="))?.split("=")[1];
  const graceHours = graceArg ? Number(graceArg) : 24;
  if (!Number.isFinite(graceHours) || graceHours < 1) throw new Error("--grace-hours must be at least 1.");
  if (apply && confirm !== "DELETE-ORPHANS") {
    throw new Error("Refusing to delete. Re-run with --apply --confirm=DELETE-ORPHANS after reviewing the dry-run list.");
  }

  const db = await createDatabase(databaseConfigFromEnv());
  try {
    const found = await findOrphanDocumentFiles(db, { graceMs: graceHours * 60 * 60 * 1000 });
    console.log("Target:", describeDatabaseTarget(databaseConfigFromEnv()));
    console.log(`Scanned ${found.scanned} files; ${found.referenced} referenced storage keys.`);
    if (!found.orphans.length) {
      console.log("No orphan files older than the grace period.");
      return;
    }
    for (const orphan of found.orphans) {
      console.log(`${apply ? "DELETE" : "ORPHAN"} ${orphan.key} ${orphan.bytes} bytes mtime=${orphan.modifiedAt.toISOString()}`);
    }
    if (!apply) {
      console.log(`Dry run only. ${found.orphans.length} file(s) would be deleted after --apply --confirm=DELETE-ORPHANS.`);
      return;
    }
    const result = await deleteOrphanDocumentFiles(db, found.orphans, { actorName: "orphan-cleanup-script" });
    console.log(`Deleted ${result.deleted}; refused ${result.refused}.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
