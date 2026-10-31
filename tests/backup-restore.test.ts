import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/server/db";
import { ACCOUNTS, postJournal } from "@/server/journal";
import { listAccounts } from "@/server/accounts";
import { currentFiscalPeriod, getDashboard } from "@/server/reports";
import { createBackup, restoreBackup, verifyBackup } from "../scripts/lib/backup";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-tracker-backup-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("backup and restore drill", () => {
  it("backs up a synthetic database and document store, verifies checksums, restores into a disposable target, and reads it back", async () => {
    const root = await tempRoot();
    const sourceDb = path.join(root, "source", "pglite");
    const sourceDocs = path.join(root, "source", "documents");
    const backup = path.join(root, "backup");
    const restoredDb = path.join(root, "restored", "pglite");
    const restoredDocs = path.join(root, "restored", "documents");
    await fs.mkdir(sourceDocs, { recursive: true });

    const db = await createDatabase({ dataDir: sourceDb });
    const userId = randomUUID();
    let storageKey = "";
    try {
      await db.query(
        `INSERT INTO users (id, email, name, password_hash, role, is_synthetic)
         VALUES ($1,$2,$3,'not-a-real-hash','ADMIN',true)`,
        [userId, `backup-${userId.slice(0, 8)}@test.local`, "Backup Fixture Admin"],
      );
      await postJournal(db, {
        date: new Date().toISOString().slice(0, 10),
        memo: "Synthetic backup fixture opening entry",
        sourceType: "OPENING_BALANCE",
        sourceId: null,
        createdBy: userId,
        lines: [
          { accountCode: ACCOUNTS.CASH.code, accountName: ACCOUNTS.CASH.name, debit: 100_000 },
          { accountCode: ACCOUNTS.OPENING_EQUITY.code, accountName: ACCOUNTS.OPENING_EQUITY.name, credit: 100_000 },
        ],
      });
      const bytes = Buffer.from("synthetic backup fixture document\n", "utf8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      storageKey = `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.txt`;
      await fs.mkdir(path.dirname(path.join(sourceDocs, storageKey)), { recursive: true });
      await fs.writeFile(path.join(sourceDocs, storageKey), bytes);
      await db.query(
        `INSERT INTO documents (id, sha256, filename, mime, size_bytes, storage_key, doc_type, uploaded_by, is_synthetic)
         VALUES ($1,$2,'synthetic-fixture.txt','text/plain',$3,$4,'OTHER',$5,true)`,
        [randomUUID(), digest, bytes.length, storageKey, userId],
      );
      await db.query(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`,
        [randomUUID(), `fixture-${userId}`, userId],
      );
    } finally {
      await db.close();
    }

    const manifest = await createBackup({ databaseDir: sourceDb, documentDir: sourceDocs, outDir: backup });
    expect(manifest.journal.entries).toBe(1);
    expect(manifest.journal.totalDebit).toBe(100_000);
    expect(manifest.documents.dbRows).toBe(1);
    expect(manifest.documents.files).toBe(1);

    const verified = await verifyBackup(backup);
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);

    // The source is disposable. Remove it to prove the restore does not depend on it.
    await fs.rm(path.join(root, "source"), { recursive: true, force: true });
    await restoreBackup({ from: backup, databaseDir: restoredDb, documentDir: restoredDocs });

    const restored = new PGlite(restoredDb);
    await restored.waitReady;
    try {
      const counts = await restored.query<{ documents: number; journal: number; lines: number }>(
        `SELECT (SELECT COUNT(*)::int FROM documents) AS documents,
                (SELECT COUNT(*)::int FROM journal_entries) AS journal,
                (SELECT COUNT(*)::int FROM journal_lines) AS lines`,
      );
      expect(counts.rows[0]).toMatchObject({ documents: 1, journal: 1, lines: 2 });

      const accounts = await listAccounts(restored);
      expect(accounts.some((account) => account.id === "acct_cash")).toBe(true);

      const period = await currentFiscalPeriod(restored);
      const dashboard = await getDashboard(restored, period);
      expect(dashboard.recorded).toBe(0);

      const restoredBytes = await fs.readFile(path.join(restoredDocs, storageKey));
      expect(restoredBytes.toString("utf8")).toContain("synthetic backup fixture document");
      const sessions = await restored.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM sessions`);
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]?.revoked_at).not.toBeNull();
    } finally {
      await restored.close();
    }
  });
});
