import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1];
  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? Number(daysArg) : 30;
  const root = path.join(process.cwd(), "backups");
  if (!Number.isFinite(days) || days < 1) throw new Error("--days must be at least 1.");
  if (apply && confirm !== "DELETE-OLD-BACKUPS") throw new Error("Refusing to delete. Re-run with --apply --confirm=DELETE-OLD-BACKUPS.");

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const old = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("locus-")) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.stat(full);
    if (stat.mtime.getTime() < cutoff) old.push({ name: entry.name, full, mtime: stat.mtime });
  }
  old.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  if (!old.length) {
    console.log(`No backups older than ${days} days.`);
    return;
  }
  for (const item of old) console.log(`${apply ? "DELETE" : "OLD"} ${item.name} mtime=${item.mtime.toISOString()}`);
  if (!apply) {
    console.log(`Dry run only. ${old.length} backup(s) would be deleted with --apply --confirm=DELETE-OLD-BACKUPS.`);
    return;
  }
  for (const item of old) await fs.rm(item.full, { recursive: true, force: true });
  console.log(`Deleted ${old.length} backup(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
