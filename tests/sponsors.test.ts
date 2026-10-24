import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createSponsorship, getAgreement, recordSponsorReceipt } from "@/server/sponsors";
import { accountCodeBalance, createPerson, createTestDb, journalTotals } from "./helpers/fixtures";

let db: Db;
let finance: CurrentUser;
let member: CurrentUser;
let bankId: string;

beforeAll(async () => {
  db = await createTestDb();
  finance = await createPerson(db, { role: "FINANCE", name: "Sponsorship Lead" });
  member = await createPerson(db, { role: "MEMBER", name: "Ordinary Member" });
  bankId = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa) VALUES ($1,'Sponsor bank','BANK',0)`,
    [bankId],
  );
});

afterAll(async () => {
  await db.close();
});

describe("sponsorships", () => {
  let cashAgreementId: string;

  it("restricts sponsorship management to authorised roles", async () => {
    await expect(
      createSponsorship(db, member, {
        sponsorName: "Nabil Bank", title: "Title sponsor", state: "COMMITTED", promised: "10000", inKind: false,
      }),
    ).rejects.toThrow(/cannot manage sponsorships/i);
  });

  it("creates a cash commitment and records partial then full receipt", async () => {
    const created = await createSponsorship(db, finance, {
      sponsorName: "Nabil Bank", title: "Title sponsor", packageTier: "Platinum",
      state: "COMMITTED", promised: "10,000", inKind: false, deliverables: "Logo on banner\nSocial media mention",
    });
    cashAgreementId = created.id;
    let agreement = await getAgreement(db, cashAgreementId);
    expect(agreement?.promised_paisa).toBe(1_000_000);
    expect(agreement?.deliverables).toHaveLength(2);

    await recordSponsorReceipt(db, finance, {
      agreementId: cashAgreementId, accountId: bankId, amount: "4000", date: "2026-10-06", reference: "NBL-001",
    });
    agreement = await getAgreement(db, cashAgreementId);
    expect(agreement?.state).toBe("PARTIALLY_RECEIVED");
    expect(agreement?.receipts).toHaveLength(1);

    await recordSponsorReceipt(db, finance, {
      agreementId: cashAgreementId, accountId: bankId, amount: "6000", date: "2026-10-12", reference: "NBL-002",
    });
    agreement = await getAgreement(db, cashAgreementId);
    expect(agreement?.state).toBe("RECEIVED");
    expect(await accountCodeBalance(db, "3000")).toBe(-1_000_000);
    expect(await accountCodeBalance(db, "1010")).toBe(1_000_000);
  });

  it("reuses the sponsor record for a second agreement", async () => {
    await createSponsorship(db, finance, {
      sponsorName: "nabil bank", title: "Award night partner", state: "LEAD", promised: "5000", inKind: false,
    });
    const sponsors = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sponsors`);
    expect(sponsors.rows[0]?.n).toBe(1);
  });

  it("records in-kind support without posting cash income", async () => {
    const inKind = await createSponsorship(db, finance, {
      sponsorName: "Himalayan Java", title: "Refreshments partner", state: "COMMITTED",
      promised: "0", inKind: true, inKindDescription: "Coffee for 150 attendees", inKindValue: "15000",
    });
    const agreement = await getAgreement(db, inKind.id);
    expect(agreement?.in_kind).toBe(true);
    expect(agreement?.promised_paisa).toBe(0);
    expect(agreement?.in_kind_value_paisa).toBe(1_500_000);

    await expect(
      recordSponsorReceipt(db, finance, { agreementId: inKind.id, accountId: bankId, amount: "1000", date: "2026-10-13" }),
    ).rejects.toThrow(/in-kind sponsorship cannot be recorded as cash/i);
    expect(await accountCodeBalance(db, "3000")).toBe(-1_000_000);
  });

  it("requires a description for in-kind records and a positive cash amount otherwise", async () => {
    await expect(
      createSponsorship(db, finance, {
        sponsorName: "Quiet Donor", title: "Support", state: "LEAD", promised: "0", inKind: true,
      }),
    ).rejects.toThrow(/describe the in-kind/i);

    await expect(
      createSponsorship(db, finance, {
        sponsorName: "Quiet Donor", title: "Support", state: "LEAD", promised: "0", inKind: false,
      }),
    ).rejects.toThrow(/greater than zero|positive amount/i);
  });

  it("keeps every sponsorship journal entry balanced", async () => {
    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.entries).toBe(2);
  });
});
