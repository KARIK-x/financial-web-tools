import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createDatabase } from "@/server/db";
import { ACCOUNTS, postJournal } from "@/server/journal";
import { closePeriod, reopenPeriod } from "@/server/periods";
import { consumeRateLimit, clearRateLimit } from "@/server/rate-limit";
import {
  base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode,
  resetMfaForUser, totpCode, verifyMfaForUser, verifyTotp,
} from "@/server/mfa";
import { attachDocumentToClaim, canAccessDocument, createBatch, listDocuments, processDocumentOcr, reviewDocument, uploadOne } from "@/server/documents";
import { createExpense, getClaim, listClaims, summarizeClaims } from "@/server/expenses";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let admin: CurrentUser;
let finance: CurrentUser;
let alice: CurrentUser;
let bob: CurrentUser;

beforeAll(async () => {
  db = await createTestDb();
  admin = await createPerson(db, { role: "ADMIN", name: "Security Admin" });
  finance = await createPerson(db, { role: "FINANCE", name: "Security Finance" });
  alice = await createPerson(db, { role: "MEMBER", name: "Alice Member" });
  bob = await createPerson(db, { role: "MEMBER", name: "Bob Member" });
});

afterAll(async () => {
  await db.close();
});

describe("MFA", () => {
  it("round-trips base32 and verifies a TOTP code once, rejecting replay", async () => {
    const raw = Buffer.from("finance-tracker-test-secret-20b");
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    const secret = generateTotpSecret();
    const step = Math.floor(Date.now() / 1000 / 30);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code)).not.toBeNull();
    expect(verifyTotp(secret, "000000")).toBeNull();

    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id,email,name,password_hash,role,mfa_enabled,mfa_secret,mfa_last_used_step)
       VALUES ($1,$2,'MFA Test','not-a-real-hash','ADMIN',true,$3,NULL)`,
      [id, `mfa-${id.slice(0, 8)}@test.local`, secret],
    );
    const row = { id, mfa_secret: secret, mfa_enabled: true, mfa_last_used_step: null };
    expect(await verifyMfaForUser(db, row, code)).toMatchObject({ ok: true, method: "TOTP" });
    expect(await verifyMfaForUser(db, row, code)).toMatchObject({ ok: false });
    expect(await verifyMfaForUser(db, { ...row, mfa_last_used_step: step }, totpCode(secret, step + 1))).toMatchObject({ ok: true });
  });

  it("consumes a recovery code exactly once", async () => {
    const id = randomUUID();
    const [code] = generateRecoveryCodes(1);
    await db.query(
      `INSERT INTO users (id,email,name,password_hash,role,mfa_enabled,mfa_secret,mfa_recovery_codes)
       VALUES ($1,$2,'Recovery Test','not-a-real-hash','FINANCE',true,$3,$4::jsonb)`,
      [id, `recovery-${id.slice(0, 8)}@test.local`, generateTotpSecret(), JSON.stringify([hashRecoveryCode(code!)])],
    );
    const row = { id, mfa_secret: null, mfa_enabled: true, mfa_last_used_step: null };
    // A recovery code is not a TOTP code; give a syntactically valid but wrong code.
    expect(await verifyMfaForUser(db, { ...row, mfa_secret: generateTotpSecret() }, code!)).toMatchObject({ ok: true, method: "RECOVERY" });
    expect(await verifyMfaForUser(db, { ...row, mfa_secret: generateTotpSecret() }, code!)).toMatchObject({ ok: false });
  });

  it("resets another user's MFA only for an administrator, revoking sessions and auditing the reset", async () => {
    const id = randomUUID();
    const email = `reset-${id.slice(0, 8)}@test.local`;
    await db.query(
      `INSERT INTO users (id,email,name,password_hash,role,mfa_enabled,mfa_secret,mfa_recovery_codes)
       VALUES ($1,$2,'MFA Reset Target','not-a-real-hash','FINANCE',true,$3,$4::jsonb)`,
      [id, email, generateTotpSecret(), JSON.stringify([hashRecoveryCode(generateRecoveryCodes(1)[0]!)])],
    );
    await db.query(
      `INSERT INTO sessions (id,token_hash,user_id,expires_at) VALUES ($1,$2,$3,now() + interval '1 day')`,
      [randomUUID(), `token-${id}`, id],
    );

    await expect(resetMfaForUser(db, finance, id)).rejects.toThrow(/administrator/i);
    await expect(resetMfaForUser(db, admin, admin.id)).rejects.toThrow(/break-glass/i);

    const result = await resetMfaForUser(db, admin, id);
    expect(result).toMatchObject({ id, mfaEnabled: false });
    const user = await db.query<{ mfa_enabled: boolean; mfa_secret: string | null; recovery_count: number }>(
      `SELECT mfa_enabled, mfa_secret, jsonb_array_length(mfa_recovery_codes)::int AS recovery_count FROM users WHERE id=$1`,
      [id],
    );
    expect(user.rows[0]).toMatchObject({ mfa_enabled: false, mfa_secret: null, recovery_count: 0 });
    const sessions = await db.query<{ active: number }>(
      `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS active FROM sessions WHERE user_id=$1`,
      [id],
    );
    expect(sessions.rows[0]?.active).toBe(0);
    const audit = await db.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_events WHERE action='MFA_RESET' AND entity_id=$1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
  });
});

describe("accounting period lock", () => {
  it("blocks new postings and claims in a closed period, then restores access after an audited reopen", async () => {
    const fiscal = { fiscalYear: "2083/84", periodStart: "2026-07-17", periodEnd: "2027-07-16" };
    await closePeriod(db, admin, { ...fiscal, reason: "Security test close" });
    await expect(postJournal(db, {
      date: "2026-10-24", memo: "Blocked by period", sourceType: "ADJUSTMENT", sourceId: null,
      createdBy: admin.id,
      lines: [
        { accountCode: ACCOUNTS.CASH.code, accountName: ACCOUNTS.CASH.name, debit: 100 },
        { accountCode: ACCOUNTS.OPENING_EQUITY.code, accountName: ACCOUNTS.OPENING_EQUITY.name, credit: 100 },
      ],
    })).rejects.toThrow(/closed accounting period/i);

    await expect(createExpense(db, alice, {
      date: "2026-10-24", vendorName: "Closed period vendor", description: "Must not post",
      amount: "100", categoryId: "cat_printing", fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic period-lock test", submitNow: true,
    })).rejects.toThrow(/closed accounting period/i);

    const periods = await db.query<{ id: string; status: string }>(`SELECT id, status FROM accounting_periods`);
    expect(periods.rows[0]?.status).toBe("CLOSED");
    await reopenPeriod(db, admin, { periodId: periods.rows[0]!.id, reason: "Security test reopen" });
    const entry = await postJournal(db, {
      date: "2026-10-24", memo: "Allowed after reopen", sourceType: "ADJUSTMENT", sourceId: null,
      createdBy: admin.id,
      lines: [
        { accountCode: ACCOUNTS.CASH.code, accountName: ACCOUNTS.CASH.name, debit: 100 },
        { accountCode: ACCOUNTS.OPENING_EQUITY.code, accountName: ACCOUNTS.OPENING_EQUITY.name, credit: 100 },
      ],
    });
    expect(entry).toBeTruthy();
    const events = await db.query<{ action: string }>(`SELECT action FROM accounting_period_events ORDER BY created_at`);
    expect(events.rows.map((r) => r.action)).toEqual(["CLOSED", "REOPENED"]);
    const audit = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action IN ('PERIOD_CLOSED','PERIOD_REOPENED') ORDER BY created_at`);
    expect(audit.rows.map((r) => r.action)).toEqual(["PERIOD_CLOSED", "PERIOD_REOPENED"]);
  });
});

describe("durable rate limiting", () => {
  it("persists counters across a database reopen and clears only when asked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-tracker-rate-limit-"));
    try {
      const first = await createDatabase({ dataDir: dir });
      expect((await consumeRateLimit(first, "test:key", 2, 60)).allowed).toBe(true);
      expect((await consumeRateLimit(first, "test:key", 2, 60)).allowed).toBe(true);
      const blocked = await consumeRateLimit(first, "test:key", 2, 60);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      await first.close();

      const reopened = new PGlite(dir);
      await reopened.waitReady;
      try {
        const row = await reopened.query<{ count: number }>(`SELECT count FROM rate_limits WHERE key='test:key'`);
        expect(Number(row.rows[0]?.count)).toBe(3);
        await clearRateLimit(reopened, "test:key");
        expect((await consumeRateLimit(reopened, "test:key", 2, 60)).allowed).toBe(true);
      } finally {
        await reopened.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("document and claim authorization", () => {
  it("does not list another member's private receipt or claim, while finance can see both", async () => {
    const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const batchId = await createBatch(db, alice, "Private receipt batch", "UPLOAD");
    const uploaded = await uploadOne(db, alice, { filename: "alice-private.png", mime: "image/png", bytes, batchId });
    expect(uploaded.duplicate).toBe(false);

    const aliceDocs = await listDocuments(db, alice, {});
    const bobDocs = await listDocuments(db, bob, {});
    const financeDocs = await listDocuments(db, finance, {});
    expect(aliceDocs.some((d) => d.id === uploaded.documentId)).toBe(true);
    expect(bobDocs.some((d) => d.id === uploaded.documentId)).toBe(false);
    expect(financeDocs.some((d) => d.id === uploaded.documentId)).toBe(true);
    expect(await canAccessDocument(db, alice, uploaded.documentId)).toBe(true);
    expect(await canAccessDocument(db, bob, uploaded.documentId)).toBe(false);
    expect(await canAccessDocument(db, finance, uploaded.documentId)).toBe(true);

    const claim = await createExpense(db, bob, {
      date: "2026-10-22", vendorName: "Bob vendor", description: "Bob private claim",
      amount: "100", categoryId: "cat_printing", fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic authorization test", submitNow: true,
    });
    const aliceClaims = await listClaims(db, alice);
    const bobClaims = await listClaims(db, bob);
    expect(bobClaims.some((c) => c.id === claim.id)).toBe(true);
    expect(aliceClaims.some((c) => c.id === claim.id)).toBe(false);
    await expect(getClaim(db, alice, claim.id)).rejects.toThrow(/access/i);

    // A member cannot run OCR/review even if they uploaded the file.
    await expect(processDocumentOcr(db, alice, uploaded.documentId)).rejects.toThrow(/cannot run or review OCR/i);
  });

  it("rejects cross-member attachment, cross-claim reattachment and unauthorised review", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer();
    const batchId = await createBatch(db, alice, "Attachment authorization batch", "UPLOAD");
    const uploaded = await uploadOne(db, alice, { filename: "attachment-auth.png", mime: "image/png", bytes, batchId });
    const claimOne = await createExpense(db, alice, {
      date: "2026-10-23", vendorName: "Alice vendor", description: "Alice claim one",
      amount: "100", categoryId: "cat_printing", fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic attachment test", submitNow: true,
    });
    const claimTwo = await createExpense(db, alice, {
      date: "2026-10-23", vendorName: "Alice vendor", description: "Alice claim two",
      amount: "200", categoryId: "cat_printing", fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Synthetic attachment test", submitNow: true,
    });

    await expect(attachDocumentToClaim(db, bob, { documentId: uploaded.documentId, claimNo: claimOne.claimNo }))
      .rejects.toThrow(/only attach a document you uploaded/i);
    await expect(attachDocumentToClaim(db, alice, { documentId: uploaded.documentId, claimNo: "LOC-9999-9999" }))
      .rejects.toThrow(/no claim found/i);
    const attached = await attachDocumentToClaim(db, alice, { documentId: uploaded.documentId, claimNo: claimOne.claimNo });
    expect(attached.claimId).toBe(claimOne.id);
    await expect(attachDocumentToClaim(db, alice, { documentId: uploaded.documentId, claimNo: claimTwo.claimNo }))
      .rejects.toThrow(/already attached to another claim/i);
    await expect(attachDocumentToClaim(db, finance, { documentId: uploaded.documentId, claimNo: claimTwo.claimNo }))
      .rejects.toThrow(/already attached to another claim/i);

    await expect(reviewDocument(db, alice, { documentId: uploaded.documentId, accept: true }))
      .rejects.toThrow(/permission to review/i);
    await reviewDocument(db, finance, { documentId: uploaded.documentId, accept: true });
    const reviewed = await db.query<{ review_status: string }>(`SELECT review_status FROM documents WHERE id=$1`, [uploaded.documentId]);
    expect(reviewed.rows[0]?.review_status).toBe("ACCEPTED");
    const audit = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at`, [uploaded.documentId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["DOCUMENT_UPLOADED", "DOCUMENT_ATTACHED", "DOCUMENT_ACCEPTED"]);
  });

  it("scopes filtered expense summaries to the viewer and to every active filter", async () => {
    const bobSummary = await summarizeClaims(db, bob);
    expect(bobSummary.n).toBe(1);
    expect(bobSummary.total).toBe(10_000);
    const aliceSummary = await summarizeClaims(db, alice);
    expect(aliceSummary.n).toBe(2);
    expect(aliceSummary.total).toBe(30_000);
    const financeSummary = await summarizeClaims(db, finance);
    expect(financeSummary.n).toBeGreaterThanOrEqual(3);

    const filtered = await summarizeClaims(db, alice, { q: "Alice claim two" });
    expect(filtered.n).toBe(1);
    expect(filtered.total).toBe(20_000);
    const wrong = await summarizeClaims(db, alice, { q: "Bob private claim" });
    expect(wrong.n).toBe(0);
  });
});
