# BACKUP AND RESTORE

**Status: IMPLEMENTED / TESTED-PASS (manual/CLI core); NOT-TESTED (scheduled/offsite)**
**Last verified drill:** 2026-10-24
**Scope:** the PGlite database, the private document store, and the restore procedure.

A backup is only valid if it has been restored successfully. This document records the automated scripts and a genuine restore drill, not a theoretical procedure.

---

## 1. What is backed up

| Path | Contents | Included |
|---|---|---|
| `.data/pglite/` | PostgreSQL data directory (books, users, audit trail) | Yes |
| `.data/documents/` | Receipts, invoices, statements (content-addressed files) | Yes |
| `SHA256SUMS` | Per-file checksums | Yes |
| `manifest.json` | Counts, journal totals, document hashes, git commit, timestamp | Yes |
| `GIT_COMMIT`, `BACKED_UP_AT`, `README.txt` | Provenance | Yes |
| `.env` / `.data/*credentials.txt` | Passwords, secrets | **No — excluded by design** |

CSV/JSON exports are **not** a substitute for a database backup: they are partial, capped at 20,000 rows, and do not include passwords, sessions, or all metadata.

Credentials and environment files must be restored from a secret manager, not from the backup.

---

## 2. Before taking a backup

1. **Stop the application.** PGlite is embedded and single-process. Copying a live data directory can produce an inconsistent snapshot.
2. Confirm no `npm run dev` / `npm start` process is using the same `DATABASE_DIR`.
3. Decide the destination. Keep it outside the repository (for example `/Users/ashim/finance-tracker-backups/...`), on a private volume with restricted permissions.

The scripts warn if the application may still be running, but they cannot guarantee consistency. The operator must stop it.

---

## 3. Create a backup

```bash
cd "/Users/ashim/Downloads/FINANCE TRACKER AUTOMATION"
npm run db:backup -- --out /secure/finance-tracker-backups/$(date +%Y%m%d-%H%M%S)
```

Optional paths:

```bash
npm run db:backup -- \
  --database-dir .data/pglite \
  --document-dir .data/documents \
  --out /secure/finance-tracker-backups/20261024
```

Output includes:

- `database/` — copied PGlite data directory
- `documents/` — copied content-addressed files
- `SHA256SUMS` — checksums for every file
- `manifest.json` — table counts, journal totals, document rows/files, orphan list, git commit
- `GIT_COMMIT`, `BACKED_UP_AT`, `README.txt`

The backup is private (`0700` directories, `0600` files).

---

## 4. Verify a backup (before relying on it)

```bash
npm run db:verify-backup -- --from /secure/finance-tracker-backups/20261024
```

A healthy result:

```
VERIFIED
  Created: ...
  Git commit: ...
  Journal: 19 entries, debit=59575000, credit=59575000
  Documents: 9 rows, 10 files
```

The verifier checks:

- manifest/checksum integrity,
- required files,
- journal debit = credit,
- document row/file consistency,
- orphan files (warned, preserved, not deleted),
- count consistency.

`VERIFIED` means the backup is internally consistent. It is **not** proof that a restore works; run the restore drill.

---

## 5. Restore into a disposable target

Never restore over live data as the first test. Use a scratch directory:

```bash
SCRATCH=$(mktemp -d /tmp/finance-tracker-restore.XXXXXX)
npm run db:restore -- \
  --from /secure/finance-tracker-backups/20261024 \
  --database-dir "$SCRATCH/pglite" \
  --document-dir "$SCRATCH/documents"
```

The restore:

- refuses a non-empty target unless `--force` is supplied,
- verifies the backup first,
- copies the database and documents,
- sets private permissions,
- removes a stale `postmaster.pid`,
- **revokes all sessions in the restored database** so an old cookie cannot revive access,
- writes `RESTORED_AT`.

Then verify the restored data:

```bash
npx tsx scripts/verify-restored.ts \
  --database-dir "$SCRATCH/pglite" \
  --document-dir "$SCRATCH/documents" \
  --from /secure/finance-tracker-backups/20261024
```

Expected:

```
RESTORED DATABASE VERIFIED
  Claims: ...
  Documents: ... (... files)
  Journal: ... entries / ... lines, debit=..., credit=...
  Audit events: ...
```

Finally, start the app against the restored paths on a separate port and run a smoke/E2E test:

```bash
DATABASE_DIR="$SCRATCH/pglite" DOCUMENT_DIR="$SCRATCH/documents" PORT=3400 npm run dev
E2E_BASE_URL=http://localhost:3400 npm run test:e2e
```

Do not point the production app at the scratch directory.

---

## 6. Verified drill — 2026-10-24

| Step | Result |
|---|---|
| Backup created at `/Users/ashim/finance-tracker-backups/20261024-160509-final-drill` | **TESTED-PASS** |
| `npm run db:verify-backup -- --from …` | **`VERIFIED`** |
| Restore to disposable temp directory | **TESTED-PASS** |
| `verify-restored.ts` | **`RESTORED DATABASE VERIFIED`** |
| Restored counts | 12 claims, 9 documents (10 files), 19 journal entries / 39 lines, debit = credit = 59,575,000, 69 audit events |
| E2E against restored database | **6/6 passed** in 18.2 s |
| Disposable directory removed | **TESTED-PASS** |

The backup also reported one orphan document file (`18/50/…png`) with no DB row. It was preserved, not deleted, and the verifier warned about it.

---

## 7. Restore over live data (only after the drill)

Only when you intentionally replace the live database:

1. Stop the application.
2. Take a fresh backup of the current live data and verify it.
3. Restore with `--force` to the live `--database-dir`/`--document-dir`.
4. Verify the restored data with `verify-restored.ts`.
5. Start the app, sign in, and check trial balance, recent claims, and a document download.
6. Keep the pre-restore backup until sign-off.

```bash
npm run db:restore -- \
  --from /secure/finance-tracker-backups/20261024 \
  --database-dir .data/pglite \
  --document-dir .data/documents \
  --force
```

**Warning:** `--force` replaces the target. It is destructive. Never use it without a verified pre-restore backup.

---

## 8. What the drill proves — and what it does not

**Proven:**
- Checksums and manifest match.
- Database opens and passes journal/count checks.
- Documents match their SHA-256 rows.
- Sessions are revoked on restore.
- The application can start and complete E2E flows against the restored data.

**Not proven:**
- Managed PostgreSQL point-in-time recovery (no provider).
- Off-site/encrypted backup storage (not configured).
- Scheduled backups and retention (not configured).
- Recovery from a disk failure on the production host.
- Restore of credentials/secrets (intentionally excluded).

---

## 9. Recommended production policy

1. **Schedule** a daily backup during a maintenance window; stop or quiesce writes.
2. **Encrypt** the backup at rest and in transit; store off-device.
3. **Retain** daily/weekly/monthly copies per FINANCE TRACKER policy.
4. **Verify** every backup automatically (`db:verify-backup`).
5. **Drill** a restore quarterly into a disposable environment, with a signed checklist.
6. **Record** the operator, date, backup path, verification result, and any warnings.
7. **Never** commit backups, credentials, `.data`, or exports.

---

## 10. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `Backup target already exists` | Reusing an output directory | Choose a new timestamped directory or remove the scratch target |
| `Backup verification failed` | Corrupt/missing file or bad manifest | Do not restore; take a new backup from a healthy source |
| `Target database directory is not empty` | Restore target already has data | Use a fresh scratch directory, or `--force` only when intentional |
| `PGlite ... already locked` | App still running | Stop the app; do not copy a live directory |
| `orphan document files` warning | File without DB row | Preserve; investigate; do not auto-delete |
| `journal not balanced` | Corrupt/failed restore | Do not use; restore an older verified backup |
| `document hash mismatch` | Corrupt file or wrong document dir | Restore from a verified backup |

---

## 11. Related files

- `scripts/lib/backup.ts` — create/verify/restore implementation
- `scripts/backup.ts` — CLI
- `scripts/verify-backup.ts` — CLI
- `scripts/restore-backup.ts` — CLI
- `scripts/verify-restored.ts` — restored-data checks
- `tests/backup-restore.test.ts` — automated test
- `docs/POSTGRESQL_MIGRATION_PLAN.md` — future provider-level backup/PITR

## Scheduling and retention

A scheduler is not built into the application. Use the operating-system scheduler or your deployment platform:

```bash
# Daily backup at 02:00
0 2 * * * cd /path/to/finance-tracker && npm run db:backup

# Weekly retention cleanup, keeping 30 days
0 3 * * 0 cd /path/to/finance-tracker && npm run backups:retention -- --days=30 --apply --confirm=DELETE-OLD-BACKUPS
```

Off-site copies must be encrypted before leaving the host. The backup manifest intentionally excludes credentials and environment files; restore them from the secret manager.
