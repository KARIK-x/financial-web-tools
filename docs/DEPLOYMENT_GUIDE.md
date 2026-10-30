# DEPLOYMENT GUIDE

This guide runs the LOCUS Finance platform locally or on a single trusted server. It is **not** a guide for serverless or multi-instance deployment; PGlite is single-process (see §9).

---

## 1. Prerequisites

| Requirement | Version used / notes |
|---|---|
| Node.js | **v24.20.0** (any current LTS ≥ 22 should work) |
| npm | Bundled with Node; `package-lock.json` is committed |
| Disk | Database + documents under `.data/`; plan for growth and backups |
| OS | macOS, Linux, or Windows with a persistent filesystem |
| Tesseract (optional) | For receipt OCR; without it, OCR reports unavailable and manual entry still works |
| Chrome (optional) | Only for Playwright E2E tests |

Check:

```bash
node -v
npm -v
tesseract --version   # optional
```

---

## 2. First run (real workspace)

```bash
cd "/path/to/LOCUS FINANCE AUTOMATION"
npm ci
npm run db:migrate
npm run db:create-admin -- --email=finance@your-org.org --name="Finance Manager"
```

`db:create-admin`:
- creates the ADMIN user and member record,
- generates a strong password if `--password` is omitted,
- writes credentials to `.data/initial-admin-credentials.txt` with mode `0600`,
- **never prints the password**,
- audits the action.

Then:

```bash
npm run build
NODE_ENV=production npm start
```

Open `http://localhost:3000` → sign in with the email and the password from the credentials file → you are forced to **choose a new password** (the initial one is single-use) → delete the credentials file.

> Alternatively, open `/setup` in a fresh database and create the first ADMIN in the browser. The CLI path is recommended because it never puts a password in shell history.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_DIR` | `.data/pglite` | PGlite data directory |
| `DOCUMENT_DIR` | `.data/documents` | Private document storage |
| `LOCUS_ADMIN_EMAIL` | — | Alternative to `--email` for `db:create-admin` |
| `LOCUS_ADMIN_NAME` | — | Alternative to `--name` |
| `LOCUS_ADMIN_PASSWORD` | generated | Alternative to `--password`; avoid exporting secrets in shared shells |
| `NODE_ENV` | — | Set to `production` for `Secure` session cookies |
| `MFA_ENFORCE` | off | Set to `true` to require TOTP enrollment for ADMIN/FINANCE/EXECUTIVE |
| `E2E_BASE_URL` | `http://localhost:3000` | Point Playwright at an already-running server |

No `.env` file is required. If you use one, it is gitignored.

---

## 3. Everyday commands

```bash
npm run dev            # development server (Turbopack)
npm run build          # production build
npm start              # serve the production build
npm run typecheck      # tsc --noEmit
npm test               # Vitest: 117 unit/integration tests
npm run test:e2e       # Playwright: 6 browser tests (needs demo data + Chrome)
npm run db:migrate     # apply pending SQL migrations
```

Database scripts:

```bash
npm run db:create-admin -- --email=... --name="..."
npm run db:seed-demo      # synthetic demo only; refuses if real data exists
npm run db:reset-demo     # removes synthetic demo data only
```

---

## 4. Demo / evaluation mode

```bash
npm run db:migrate
npm run db:seed-demo
npm run dev
```

- Demo logins: `admin@`, `finance@`, `executive@`, `events@`, `member@`, `auditor@` `locus.demo`.
- The shared password is in **`.data/demo-credentials.txt`** (mode 0600). It is never printed to the terminal or written to docs.
- The dataset is synthetic: claims, payments, documents, journals, bank lines, budgets, advances, sponsors.
- The UI shows synthetic source tags; `is_synthetic` is set on every seeded row.
- **Never seed demo data into a real workspace.** The seeder refuses if any user/claim/document exists; the reset refuses if any non-synthetic user or financial record exists.
- Stop the dev server before `db:reset-demo` / `db:seed-demo` to avoid two processes writing the same PGlite directory.

The demo intentionally leaves one bank line unmatched (cash deposit on 2026-10-12) so reconciliation has something to resolve.

---

## 5. Production configuration

### 5.1 Single instance only
Run **one** Node process against one PGlite directory. Do not put it behind a load balancer with multiple replicas, and do not deploy to a serverless platform with ephemeral storage. PGlite is not a network database.

### 5.2 Bind to localhost + reverse proxy
```bash
NODE_ENV=production npx next start -H 127.0.0.1 -p 3000
```
Terminate TLS at Nginx/Caddy and forward to `127.0.0.1:3000`. Set `X-Forwarded-For` correctly so audit IPs are meaningful. The session cookie is `Secure` only when `NODE_ENV=production`, so **use HTTPS** in production.

### 5.3 Filesystem permissions
```bash
chmod 700 .data
chmod 700 .data/pglite .data/documents
```
Run the app as a dedicated non-root user. Ensure backups are readable only by that user and the backup operator.

### 5.4 Disk encryption
The database and documents are **not encrypted by the application**. Use full-disk encryption (FileVault/LUKS) or an encrypted volume, and restrict access.

### 5.5 Process supervision
Use systemd, launchd, or a process manager with restart-on-failure. Example systemd unit:

```ini
[Unit]
Description=LOCUS Finance
After=network.target

[Service]
Type=simple
User=locus
WorkingDirectory=/srv/locus-finance
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 5.6 Backups
Stop the app, then run the tested scripts:

```bash
npm run db:backup -- --out /secure/locus-backups/$(date +%Y%m%d-%H%M%S)
npm run db:verify-backup -- --from /secure/locus-backups/<timestamp>
```

Set up the restore procedure in `BACKUP_AND_RESTORE.md` **before** entering real data. A backup that has never been restored is not a backup. Scheduled/offsite encrypted backups are not configured; that remains an operational task.

### 5.7 OCR
Install Tesseract and language data if receipt OCR is required:
- macOS: `brew install tesseract tesseract-lang`
- Debian/Ubuntu: `apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-nep`

The capability banner in the UI reports what is actually available. Nepali OCR additionally requires the `nep` traineddata; this machine does not have it.

---

## 6. Upgrading

```bash
# 1. Back up first
# 2. Stop the app
npm ci
npm run db:migrate
npm run build
npm start
```

Migrations are applied in filename order and recorded in `schema_migrations`. There are no down-migrations; restore from backup to roll back a schema change.

If a migration file was edited **after** it was applied to a local database, the change will not re-run. For a disposable local DB:

```bash
rm -rf .data/pglite
npm run db:migrate
```

Never do that to a real workspace.

---

## 7. Health checks

- `GET /login` returns 200 when the app is up.
- Sign in and open `/overview`.
- `npm test` should pass after an upgrade.
- Check the audit trail for unexpected sign-ins or exports.

There is no dedicated `/health` endpoint; add one only if the proxy requires it, and keep it free of sensitive data.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Could not find a statement header row` | Statement lacks Date + Description headers, or uses an unsupported layout. Re-export or add headers. |
| Import says rows skipped | Rows without a date or without a debit/credit are skipped by design; check warnings. |
| `could not determine data type of parameter` | A code bug in a parameterised query; check the server log and the query’s placeholders. |
| Login loops back to `/login` | Cookie not set: check `NODE_ENV`, HTTPS, and that the browser accepts the cookie. |
| `EADDRINUSE` | Another process is on port 3000; stop it or use `-p`. |
| Build fails on `sharp`/`pglite` | Use the documented Node version and run `npm ci` (not a partial install). |
| Demo reset refuses | Real (non-synthetic) data exists. Do not force it; use a separate workspace. |
| OCR says unavailable | Tesseract not installed or not on `PATH`; manual entry still works. |
| Slow first page | PGlite starts and runs migrations on first request; subsequent requests are fast. |

Logs go to stdout/stderr. Do not log request bodies or credentials.

---

## 9. Why this is not a multi-user internet deployment yet

| Limitation | Consequence |
|---|---|
| PGlite single process | One app instance; no horizontal scaling |
| Local filesystem storage | No shared storage across hosts; documents unavailable if the volume is lost |
| Durable rate limiting/lockout | Implemented in PostgreSQL; verify under the production topology |
| No email/password reset | Admin must reset passwords manually |
| MFA available, not enforced by default | Set `MFA_ENFORCE=true`; define a sole-admin break-glass procedure |
| Static CSP with `unsafe-inline` | XSS defence is improved but not complete; nonce CSP is future work |
| No malware scanning | Uploads are private and served as attachments; add a scanner for untrusted users |
| No application-level encryption at rest | Use full-disk/volume encryption and encrypted backups |

For a public deployment, migrate to managed PostgreSQL, use provider PITR, move documents to encrypted object storage, enforce MFA, add email, and complete the remaining security items. Tracked in `TASK_QUEUE.md`.

---

## 10. Verification checklist before real use

- [ ] `npm ci && npm run db:migrate` succeeds.
- [ ] ADMIN created via CLI; credentials file deleted after first sign-in.
- [ ] Password changed; all demo data absent (`npm run db:reset-demo` on a demo DB, or a fresh DB).
- [ ] HTTPS enabled; `NODE_ENV=production`.
- [ ] `MFA_ENFORCE=true`; at least two admins or a documented break-glass procedure.
- [ ] `.data` permissions restricted; disk encryption on.
- [ ] Backup created, verified, and restored into a disposable target.
- [ ] CSP header present in a production response.
- [ ] Backup + restore rehearsed.
- [ ] Finance and Executive users created; role matrix reviewed.
- [ ] Approval thresholds and compliance settings confirmed with the committee.
- [ ] Opening balances entered **before** any transactions.
- [ ] Bank statement format tested with a real (redacted) statement.
- [ ] `npm test` and `npm run build` pass.
