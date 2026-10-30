import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { DOCUMENT_ROOT } from "./storage";
import { recordAudit } from "./audit";

export type OrphanFile = { key: string; bytes: number; modifiedAt: Date };

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await walk(root, full)));
    else if (entry.isFile()) files.push(path.relative(root, full));
  }
  return files;
}

/** Read-only discovery. A file is orphaned only when no document row references it. */
export async function findOrphanDocumentFiles(
  db: Db,
  opts: { root?: string; graceMs?: number; now?: Date } = {},
): Promise<{ root: string; orphans: OrphanFile[]; referenced: number; scanned: number }> {
  const root = opts.root ?? DOCUMENT_ROOT;
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? new Date();
  const referenced = new Set(
    (await db.query<{ storage_key: string }>(`SELECT storage_key FROM documents`)).rows.map((r) => r.storage_key),
  );
  let files: string[] = [];
  try { files = await walk(root); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { root, orphans: [], referenced: referenced.size, scanned: 0 };
    throw err;
  }
  const orphans: OrphanFile[] = [];
  for (const key of files) {
    if (referenced.has(key)) continue;
    const rootPath = path.resolve(root);
    const full = path.resolve(rootPath, key);
    if (full !== rootPath && !full.startsWith(rootPath + path.sep)) continue;
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (now.getTime() - stat.mtime.getTime() < graceMs) continue;
    orphans.push({ key, bytes: stat.size, modifiedAt: stat.mtime });
  }
  orphans.sort((a, b) => a.key.localeCompare(b.key));
  return { root, orphans, referenced: referenced.size, scanned: files.length };
}

/**
 * Delete orphan files only after a second reference query and only when the
 * caller explicitly confirms. The audit event records the storage key and size.
 */
export async function deleteOrphanDocumentFiles(
  db: Db,
  orphans: OrphanFile[],
  opts: { root?: string; actorName?: string } = {},
): Promise<{ deleted: number; refused: number }> {
  const root = opts.root ?? DOCUMENT_ROOT;
  const current = new Set(
    (await db.query<{ storage_key: string }>(`SELECT storage_key FROM documents`)).rows.map((r) => r.storage_key),
  );
  let deleted = 0;
  let refused = 0;
  for (const orphan of orphans) {
    if (current.has(orphan.key)) { refused++; continue; }
    const rootPath = path.resolve(root);
    const full = path.resolve(rootPath, orphan.key);
    if (full !== rootPath && !full.startsWith(rootPath + path.sep)) { refused++; continue; }
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) { refused++; continue; }
    // Re-check immediately before deletion, closing the race with a concurrent upload.
    const still = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM documents WHERE storage_key=$1`, [orphan.key]);
    if (Number(still.rows[0]?.n ?? 0) > 0) { refused++; continue; }
    await fs.rm(full);
    deleted++;
    await recordAudit(db, {
      actorUserId: null,
      actorName: opts.actorName ?? "orphan-cleanup",
      action: "ORPHAN_DOCUMENT_DELETED",
      entityType: "document_file",
      entityId: orphan.key,
      summary: `Deleted unreferenced document file ${orphan.key} (${orphan.bytes} bytes).`,
      before: { storage_key: orphan.key, bytes: orphan.bytes, modified_at: orphan.modifiedAt.toISOString() },
    });
  }
  return { deleted, refused };
}
