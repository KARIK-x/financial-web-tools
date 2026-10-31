import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, createPerson, createBankAccount } from "./helpers/fixtures";
import { recordTransfer, createAccount } from "@/server/accounts";
import { createSponsorship, recordSponsorReceipt, sponsorshipSummary } from "@/server/sponsors";
import { breakGlassResetSoleAdminMfa } from "@/server/mfa";
import { deleteOrphanDocumentFiles, findOrphanDocumentFiles } from "@/server/storage-cleanup";
import { FundsError } from "@/server/funds";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("non-negative cash controls", () => {
  it("rejects a transfer larger than the source account balance and writes nothing", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Funds Finance", synthetic: true });
      const cash = await createAccount(db, finance, { name: "Small cash", type: "CASH", openingBalance: "100" });
      const bank = await createBankAccount(db, 0);
      await expect(recordTransfer(db, finance, {
        fromAccountId: cash, toAccountId: bank, amount: "200", date: "2026-10-20",
      })).rejects.toBeInstanceOf(FundsError);
      const payments = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payments`);
      expect(Number(payments.rows[0]?.n)).toBe(0);
    } finally { await db.close(); }
  });

  it("allows a transfer within the available balance", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Funds Finance 2", synthetic: true });
      const cash = await createAccount(db, finance, { name: "Cash two", type: "CASH", openingBalance: "500" });
      const bank = await createBankAccount(db, 0);
      await recordTransfer(db, finance, { fromAccountId: cash, toAccountId: bank, amount: "200", date: "2026-10-20" });
      const payments = await db.query<{ type: string }>(`SELECT type FROM payments`);
      expect(payments.rows[0]?.type).toBe("TRANSFER");
    } finally { await db.close(); }
  });
});

describe("sponsor over-receipt review", () => {
  it("keeps received cash visible and reports the excess without clamping it away", async () => {
    const db = await createTestDb();
    try {
      const finance = await createPerson(db, { role: "FINANCE", name: "Sponsor Finance", synthetic: true });
      const account = await createBankAccount(db, 0);
      const agreement = await createSponsorship(db, finance, {
        sponsorName: "Synthetic Sponsor", title: "Synthetic agreement", state: "COMMITTED",
        promised: "1000", inKind: false,
      });
      await recordSponsorReceipt(db, finance, {
        agreementId: agreement.id, accountId: account, amount: "1500", date: "2026-10-20",
      });
      const summary = await sponsorshipSummary(db);
      expect(summary.received).toBe(150_000);
      expect(summary.overReceived).toBe(50_000);
      const audit = await db.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE action='SPONSOR_OVER_RECEIPT_REVIEW_REQUIRED'`,
      );
      expect(audit.rows).toHaveLength(1);
    } finally { await db.close(); }
  });
});

describe("sole administrator break-glass MFA", () => {
  it("accepts only the configured digest and exactly one active administrator", async () => {
    const db = await createTestDb();
    try {
      const admin = await createPerson(db, { role: "ADMIN", name: "Sole Admin", email: "sole@example.org", member: false });
      await db.query(
        `UPDATE users SET mfa_enabled=true, mfa_secret='JBSWY3DPEHPK3PXP', mfa_recovery_codes='[]'::jsonb WHERE id=$1`,
        [admin.id],
      );
      const token = "synthetic-break-glass-token";
      process.env.MFA_BREAK_GLASS_TOKEN_HASH = createHash("sha256").update(token).digest("hex");
      await expect(breakGlassResetSoleAdminMfa(db, { targetEmail: admin.email, token: "wrong" })).rejects.toThrow(/rejected/);
      const result = await breakGlassResetSoleAdminMfa(db, { targetEmail: admin.email, token });
      expect(result.email).toBe(admin.email);
      const row = await db.query<{ mfa_enabled: boolean }>(`SELECT mfa_enabled FROM users WHERE id=$1`, [admin.id]);
      expect(row.rows[0]?.mfa_enabled).toBe(false);

      const second = await createPerson(db, { role: "ADMIN", name: "Second Admin", email: "second@example.org", member: false });
      await expect(breakGlassResetSoleAdminMfa(db, { targetEmail: second.email, token })).rejects.toThrow(/Another active administrator/);
    } finally { await db.close(); }
  });
});

describe("orphan document cleanup", () => {
  it("reports and deletes only files with no document row, after a grace period", async () => {
    const db = await createTestDb();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-tracker-orphans-"));
    try {
      const referenced = "aa/bb/referenced.png";
      const orphan = "cc/dd/orphan.png";
      for (const key of [referenced, orphan]) {
        await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true });
        await fs.writeFile(path.join(root, key), "synthetic");
      }
      await db.query(
        `INSERT INTO documents (id, sha256, filename, mime, size_bytes, storage_key)
         VALUES ('doc-test','abc','referenced.png','image/png',9,$1)`,
        [referenced],
      );
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await fs.utimes(path.join(root, orphan), old, old);
      const found = await findOrphanDocumentFiles(db, { root, graceMs: 24 * 60 * 60 * 1000 });
      expect(found.orphans.map((o) => o.key)).toEqual([orphan]);
      const deleted = await deleteOrphanDocumentFiles(db, found.orphans, { root, actorName: "test-cleanup" });
      expect(deleted.deleted).toBe(1);
      await expect(fs.stat(path.join(root, referenced))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(root, orphan))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
