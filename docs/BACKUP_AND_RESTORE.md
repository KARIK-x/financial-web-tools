# BACKUP AND RESTORE

**Scope:** the PGlite database, the private document store, and the credentials files under `.data/`.

A backup is only valid if you have restored it successfully. Schedule a restore rehearsal before real financial data is entered, then quarterly.

---

## 1. What must be backed up

| Path | Contents | Criticality |
|---|---|---|
| `.data/pglite/` | PostgreSQL data directory (all books, users, audit trail) | **Critical** |
| `.data/documents/` | Receipts, invoices, statements (content-addressed files) | **Critical** |
| `.data/initial-admin-credentials.txt` | Generated first-admin password (if still present) | Sensitive; delete after first sign-in |
| `.data/demo-credentials.txt` | Demo password (demo only) | Not for production |
| `.env` / environment | `DATABASE_DIR`, `DOCUMENT_DIR`, etc. | Needed to reproduce the deployment |
| `db/migrations/` | Schema history (in git) | Needed for restore/upgrade |

CSV/JSON exports are **not** a substitute for a database backup: they are partial, capped at 20,000 rows, and do not include passwords, sessions, or all metadata.

---

## 2. Backup procedure (consistent copy)

PGlite is an embedded single-process database. **Stop the application before copying** so the data directory is not changing mid-copy.

```bash
cd "/path/to/LOCUS FINANCE AUTOMATION"

# 1. Stop the app (systemd example)
sudo systemctl stop locus-finance
# or: stop the `npm start` / `npm run dev` process

# 2. Create a timestamped, private backup directory
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$HOME/locus-backups/$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$HOME/locus-backups" "$BACKUP"

# 3. Copy the database and documents (preserve permissions)
cp -a .data/pglite "$BACKUP/pglite"
cp -a .data/documents "$BACKUP/documents"

# 4. Record what was backed up
( cd .data && find pglite documents -type f -print0 | xargs -0 shasum -a 256 ) > "$BACKUP/SHA256SUMS"
cp package-lock.json "$BACKUP/"
git rev-parse HEAD > "$BACKUP/GIT_COMMIT" 2>/dev/null || true
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$BACKUP/BACKED_UP_AT"

# 5. Restrict access
chmod -R go-rwx "$BACKUP"

# 6. Restart
sudo systemctl start locus-finance
```

### Notes
- `cp -a` preserves timestamps and permissions; do not use a tool that follows symlinks unexpectedly.
- If the app cannot be stopped, a filesystem snapshot (LVM/ZFS/APFS snapshot or VM snapshot) taken atomically is the only safe alternative. A plain `cp` of a live PGlite directory can capture a torn state.
- Do not back up to the same disk. Use an external/encrypted destination or object storage with server-side encryption.
- Keep at least 7 daily, 4 weekly, and 12 monthly copies, or per LOCUS policy.
- Encrypt backups at rest (`age`, GPG, or an encrypted volume). The database is not encrypted by the app.

---

## 3. Verify a backup immediately

```bash
cd "$BACKUP"
shasum -a 256 -c SHA256SUMS
```

Then do a **restore test** into a scratch location (§4) at least once per quarter. A checksum match proves the copy is intact, not that PostgreSQL can open it.

---

## 4. Restore procedure

> Destructive. Confirm you are restoring the intended snapshot and that the current data is either backed up or disposable.

```bash
cd "/path/to/LOCUS FINANCE AUTOMATION"

# 1. Stop the app
sudo systemctl stop locus-finance

# 2. Move the current data aside (do not delete yet)
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p ".data/attic-$STAMP"
mv .data/pglite ".data/attic-$STAMP/pglite"
mv .data/documents ".data/attic-$STAMP/documents"

# 3. Copy the backup into place
cp -a "$BACKUP/pglite" .data/pglite
cp -a "$BACKUP/documents" .data/documents
chmod 700 .data .data/pglite .data/documents

# 4. Verify file checksums again
( cd .data && shasum -a 256 -c "$BACKUP/SHA256SUMS" )

# 5. Start and verify
sudo systemctl start locus-finance
```

### Post-restore checks
1. Sign in as ADMIN.
2. Open **Overview** — figures render without errors.
3. Open **Reports → Trial balance** — debits equal credits.
4. Open **Audit trail** — recent events are present up to the backup time.
5. Open a known claim and its receipt (document download works).
6. Run a bank reconciliation view; matched lines are intact.
7. Confirm no demo data is present in a real workspace.
8. Only after these checks, remove `.data/attic-*` (it contains sensitive data; delete securely).

If the app fails to start, check ownership/permissions and the server log. Do not “repair” the data directory by deleting files; restore the previous snapshot instead.

---

## 5. Restoring to a different machine

1. Install the same Node version and run `npm ci`.
2. Copy `.data/pglite` and `.data/documents` with permissions.
3. Ensure `DATABASE_DIR`/`DOCUMENT_DIR` point at the restored paths (or use the defaults).
4. Set `NODE_ENV=production` and HTTPS as before.
5. Start once; migrations already applied are skipped.
6. Run the post-restore checks.

Sessions are stored in the database. Restoring an old snapshot revives sessions that were valid at that time; **revoke all sessions** after a restore by running:

```sql
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
```

There is no CLI wrapper for this yet; use a one-off `tsx` script or the database console, then sign in again.

---

## 6. Point-in-time and partial recovery

- **Accidental claim/payment change:** the audit trail records before/after values. Financial rows are append-only or void-only, so the correct fix is a correction entry, not a restore.
- **Deleted document:** deletion is blocked by trigger. If a file is missing from disk, restore `documents/` from backup; the database row still points at the content hash.
- **Corrupted database:** restore the last good snapshot. Any transactions after it are lost unless you have exported them; document the gap in the audit/notes.
- **Lost admin password:** restore is not required. Use `npm run db:create-admin -- --email=... --name="..." --reset-password` to replace the password and revoke existing sessions.

---

## 7. Retention and destruction

- Backups contain personal data (member names, emails, receipts, bank identifiers). Apply the same access controls as production.
- Delete expired backups securely (`shred`, encrypted-volume destruction, or provider lifecycle rules).
- When decommissioning, destroy `.data`, all backups, and credentials files; revoke any external credentials.

---

## 8. Backup checklist

- [ ] App stopped or filesystem snapshot taken atomically.
- [ ] `pglite/` and `documents/` copied together (same point in time).
- [ ] Checksums generated and verified.
- [ ] Backup stored off-device and encrypted.
- [ ] Restore rehearsed into a scratch directory.
- [ ] Post-restore checks passed (trial balance, audit, document download).
- [ ] Sessions revoked after restoring an old snapshot.
- [ ] Retention schedule documented and followed.
