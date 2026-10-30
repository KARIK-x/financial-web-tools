import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";

export const BACKUP_FORMAT = "locus-backup-v1";

export type BackupManifest = {
  format: string;
  createdAt: string;
  gitCommit: string | null;
  source: { databaseDir: string; documentDir: string };
  counts: Record<string, number>;
  journal: { entries: number; lines: number; totalDebit: number; totalCredit: number; unbalancedEntries: number };
  documents: { dbRows: number; files: number; missing: string[]; orphan: string[]; real: number; synthetic: number };
  migrations: string[];
  credentialsExcluded: true;
  warnings: string[];
};

export type VerifyResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: BackupManifest | null;
};

const BACKUP_EXCLUDES = new Set(["SHA256SUMS"]);

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await visit(root);
  return out.sort();
}

async function chmodTree(root: string, dirMode: number, fileMode: number): Promise<void> {
  await fs.chmod(root, dirMode).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await chmodTree(full, dirMode, fileMode);
    else if (entry.isFile()) await fs.chmod(full, fileMode).catch(() => undefined);
  }
}

async function copyDir(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
}

async function sha256File(file: string): Promise<string> {
  return hash(await fs.readFile(file));
}

async function writeChecksums(root: string): Promise<void> {
  const files = (await walk(root)).filter((file) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    return !BACKUP_EXCLUDES.has(rel);
  });
  const lines: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    lines.push(`${await sha256File(file)}  ${rel}`);
  }
  await fs.writeFile(path.join(root, "SHA256SUMS"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function inspectDatabase(databaseDir: string): Promise<{
  counts: Record<string, number>;
  journal: BackupManifest["journal"];
  migrations: string[];
  documents: Array<{ storage_key: string; sha256: string; is_synthetic: boolean }>;
}> {
  const db = new PGlite(databaseDir);
  await db.waitReady;
  try {
    const tableRows = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const counts: Record<string, number> = {};
    for (const table of tableRows.rows) {
      const row = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "${table.tablename}"`);
      counts[table.tablename] = Number(row.rows[0]?.n ?? 0);
    }
    const journal = await db.query<{
      entries: number; lines: number; total_debit: string | number | bigint; total_credit: string | number | bigint; unbalanced: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::int FROM journal_entries) AS entries,
        (SELECT COUNT(*)::int FROM journal_lines) AS lines,
        COALESCE((SELECT SUM(debit_paisa) FROM journal_lines), 0) AS total_debit,
        COALESCE((SELECT SUM(credit_paisa) FROM journal_lines), 0) AS total_credit,
        (SELECT COUNT(*)::int FROM (
           SELECT entry_id FROM journal_lines GROUP BY entry_id
            HAVING SUM(debit_paisa) <> SUM(credit_paisa)
         ) x) AS unbalanced`,
    );
    const j = journal.rows[0];
    const migrations = (await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    const documents = (await db.query<{ storage_key: string; sha256: string; is_synthetic: boolean }>(
      `SELECT storage_key, sha256, is_synthetic FROM documents ORDER BY storage_key`,
    )).rows;
    return {
      counts,
      journal: {
        entries: Number(j?.entries ?? 0),
        lines: Number(j?.lines ?? 0),
        totalDebit: Number(j?.total_debit ?? 0),
        totalCredit: Number(j?.total_credit ?? 0),
        unbalancedEntries: Number(j?.unbalanced ?? 0),
      },
      migrations,
      documents,
    };
  } finally {
    await db.close();
  }
}

export async function createBackup(input: {
  databaseDir: string;
  documentDir: string;
  outDir: string;
  force?: boolean;
}): Promise<BackupManifest> {
  const databaseDir = path.resolve(input.databaseDir);
  const documentDir = path.resolve(input.documentDir);
  const outDir = path.resolve(input.outDir);
  await fs.access(databaseDir);
  await fs.access(documentDir);

  if (!input.force) {
    try {
      const existing = await fs.readdir(outDir);
      if (existing.length > 0) throw new Error(`Backup target is not empty: ${outDir}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  await fs.chmod(outDir, 0o700).catch(() => undefined);

  await copyDir(databaseDir, path.join(outDir, "database"));
  await copyDir(documentDir, path.join(outDir, "documents"));

  const inspected = await inspectDatabase(path.join(outDir, "database"));
  const fileKeys = new Set(
    (await walk(path.join(outDir, "documents")))
      .map((file) => path.relative(path.join(outDir, "documents"), file).split(path.sep).join("/")),
  );
  const dbKeys = new Set(inspected.documents.map((doc) => doc.storage_key));
  const missing = [...dbKeys].filter((key) => !fileKeys.has(key)).sort();
  const orphan = [...fileKeys].filter((key) => !dbKeys.has(key)).sort();

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    source: { databaseDir, documentDir },
    counts: inspected.counts,
    journal: inspected.journal,
    documents: {
      dbRows: inspected.documents.length,
      files: fileKeys.size,
      missing,
      orphan,
      real: inspected.documents.filter((doc) => !doc.is_synthetic).length,
      synthetic: inspected.documents.filter((doc) => doc.is_synthetic).length,
    },
    migrations: inspected.migrations,
    credentialsExcluded: true,
    warnings: [
      "Stop the application before creating a backup so the PGlite directory is not changing.",
      "Credentials and environment files are intentionally excluded. Restore them from your secret manager.",
      "A backup is not proven until restore verification succeeds.",
    ],
  };
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(outDir, "GIT_COMMIT"), `${manifest.gitCommit ?? "unknown"}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(outDir, "BACKED_UP_AT"), `${manifest.createdAt}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(outDir, "README.txt"),
    [
      "LOCUS backup",
      `Created: ${manifest.createdAt}`,
      `Git commit: ${manifest.gitCommit ?? "unknown"}`,
      "",
      "Contents: database/ (PGlite data directory), documents/ (private document store), manifest.json, SHA256SUMS.",
      "Credentials and .env files are not included.",
      "",
      "Verify before relying on this backup:",
      "  npm run db:verify-backup -- --from <this-directory>",
      "",
      "Restore only into a stopped, disposable target first:",
      "  npm run db:restore -- --from <this-directory> --database-dir <target>/pglite --document-dir <target>/documents",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeChecksums(outDir);
  await chmodTree(outDir, 0o700, 0o600);
  return manifest;
}

export async function verifyBackup(backupDir: string): Promise<VerifyResult> {
  const root = path.resolve(backupDir);
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: BackupManifest | null = null;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "locus-verify-"));
  try {
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as BackupManifest;
    } catch {
      return { ok: false, errors: ["manifest.json is missing or unreadable."], warnings, manifest: null };
    }
    if (manifest.format !== BACKUP_FORMAT) errors.push(`Unexpected backup format: ${manifest.format}`);

    // Verify every checksum, and ensure no unlisted file is silently present.
    const sumsPath = path.join(root, "SHA256SUMS");
    let sums = "";
    try {
      sums = await fs.readFile(sumsPath, "utf8");
    } catch {
      errors.push("SHA256SUMS is missing.");
    }
    const listed = new Set<string>();
    for (const line of sums.split("\n")) {
      if (!line.trim()) continue;
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!match) { errors.push(`Malformed checksum line: ${line.slice(0, 80)}`); continue; }
      const [, expected, rel] = match;
      listed.add(rel!);
      const full = path.join(root, rel!);
      try {
        const actual = await sha256File(full);
        if (actual !== expected) errors.push(`Checksum mismatch: ${rel}`);
      } catch {
        errors.push(`Missing checksummed file: ${rel}`);
      }
    }
    const actualFiles = (await walk(root))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((rel) => !BACKUP_EXCLUDES.has(rel));
    for (const rel of actualFiles) {
      if (!listed.has(rel)) errors.push(`Unlisted file in backup: ${rel}`);
    }

    const dbCopy = path.join(temp, "database");
    await copyDir(path.join(root, "database"), dbCopy);
    await fs.rm(path.join(dbCopy, "postmaster.pid"), { force: true });
    const inspected = await inspectDatabase(dbCopy);

    for (const [table, count] of Object.entries(manifest.counts)) {
      if ((inspected.counts[table] ?? 0) !== Number(count)) {
        errors.push(`Row-count mismatch for ${table}: manifest ${count}, actual ${inspected.counts[table] ?? 0}`);
      }
    }
    if (inspected.journal.totalDebit !== inspected.journal.totalCredit) {
      errors.push(`Journal is not balanced: debit ${inspected.journal.totalDebit}, credit ${inspected.journal.totalCredit}`);
    }
    if (inspected.journal.unbalancedEntries > 0) errors.push(`${inspected.journal.unbalancedEntries} journal entries are unbalanced.`);
    if (manifest.journal.totalDebit !== inspected.journal.totalDebit || manifest.journal.totalCredit !== inspected.journal.totalCredit) {
      errors.push("Journal totals do not match the manifest.");
    }
    if (manifest.journal.entries !== inspected.journal.entries || manifest.journal.lines !== inspected.journal.lines) {
      errors.push("Journal row counts do not match the manifest.");
    }

    const documentRoot = path.join(root, "documents");
    const files = new Set((await walk(documentRoot)).map((file) => path.relative(documentRoot, file).split(path.sep).join("/")));
    const dbKeys = new Set(inspected.documents.map((doc) => doc.storage_key));
    const missing = [...dbKeys].filter((key) => !files.has(key)).sort();
    const orphan = [...files].filter((key) => !dbKeys.has(key)).sort();
    if (missing.length) errors.push(`Document rows without files: ${missing.join(", ")}`);
    if (orphan.length) warnings.push(`Orphan document files (preserved, not referenced): ${orphan.join(", ")}`);
    if (manifest.documents.dbRows !== inspected.documents.length) errors.push("Document row count does not match the manifest.");
    if (manifest.documents.files !== files.size) errors.push("Document file count does not match the manifest.");

    for (const doc of inspected.documents) {
      const full = path.join(documentRoot, doc.storage_key);
      try {
        const bytes = await fs.readFile(full);
        if (hash(bytes) !== doc.sha256) errors.push(`Document hash mismatch: ${doc.storage_key}`);
      } catch {
        // Missing files were already reported above.
      }
    }

    // Targeted referential checks that matter to the financial record.
    const fkChecks: Array<[string, string]> = [
      ["claims_without_user", `SELECT COUNT(*)::int AS n FROM expense_claims c LEFT JOIN users u ON u.id=c.claimant_user_id WHERE u.id IS NULL`],
      ["claims_without_member", `SELECT COUNT(*)::int AS n FROM expense_claims c LEFT JOIN members m ON m.id=c.paid_by_member_id WHERE m.id IS NULL`],
      ["payments_without_claim", `SELECT COUNT(*)::int AS n FROM payments p LEFT JOIN expense_claims c ON c.id=p.claim_id WHERE p.claim_id IS NOT NULL AND c.id IS NULL`],
      ["payments_without_account", `SELECT COUNT(*)::int AS n FROM payments p LEFT JOIN financial_accounts a ON a.id=p.account_id WHERE p.account_id IS NOT NULL AND a.id IS NULL`],
      ["documents_without_claim", `SELECT COUNT(*)::int AS n FROM documents d LEFT JOIN expense_claims c ON c.id=d.claim_id WHERE d.claim_id IS NOT NULL AND c.id IS NULL`],
      ["journal_lines_without_entry", `SELECT COUNT(*)::int AS n FROM journal_lines l LEFT JOIN journal_entries e ON e.id=l.entry_id WHERE e.id IS NULL`],
    ];
    const db = new PGlite(dbCopy);
    await db.waitReady;
    try {
      for (const [name, sql] of fkChecks) {
        const row = await db.query<{ n: number }>(sql);
        if (Number(row.rows[0]?.n ?? 0) > 0) errors.push(`Referential check failed: ${name}`);
      }
    } finally {
      await db.close();
    }

    if (manifest.warnings.length) warnings.push(...manifest.warnings);
    return { ok: errors.length === 0, errors, warnings, manifest };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { ok: false, errors, warnings, manifest };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function restoreBackup(input: {
  from: string;
  databaseDir: string;
  documentDir: string;
  force?: boolean;
}): Promise<VerifyResult> {
  const result = await verifyBackup(input.from);
  if (!result.ok) throw new Error(`Backup failed verification: ${result.errors.join("; ")}`);
  const targetDb = path.resolve(input.databaseDir);
  const targetDocs = path.resolve(input.documentDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const target of [targetDb, targetDocs]) {
    try {
      const entries = await fs.readdir(target);
      if (entries.length > 0) {
        if (!input.force) throw new Error(`Restore target is not empty: ${target}. Use --force only after checking it.`);
        await fs.rename(target, `${target}.pre-restore-${stamp}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  await fs.mkdir(path.dirname(targetDb), { recursive: true });
  await fs.mkdir(path.dirname(targetDocs), { recursive: true });
  await fs.rm(targetDb, { recursive: true, force: true });
  await fs.rm(targetDocs, { recursive: true, force: true });
  await copyDir(path.join(input.from, "database"), targetDb);
  await copyDir(path.join(input.from, "documents"), targetDocs);
  await fs.rm(path.join(targetDb, "postmaster.pid"), { force: true });
  await chmodTree(targetDb, 0o700, 0o600);
  await chmodTree(targetDocs, 0o700, 0o600);

  // A restored snapshot contains sessions that were valid when the backup was
  // taken. Revoke them by default so an old cookie cannot revive access.
  const restored = new PGlite(targetDb);
  await restored.waitReady;
  try {
    await restored.query(`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL`);
  } finally {
    await restored.close();
  }
  await fs.writeFile(path.join(path.dirname(targetDb), "RESTORED_AT"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return result;
}
