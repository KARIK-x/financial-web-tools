import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { createAdvance, disburseAdvance, getAdvance, returnAdvanceFunds } from "@/server/advances";
import { createExpense, decideClaim } from "@/server/expenses";
import { accountCodeBalance, createPerson, createTestDb, journalTotals } from "./helpers/fixtures";

let db: Db;
let member: CurrentUser;
let otherMember: CurrentUser;
let finance: CurrentUser;
let executive: CurrentUser;
let cashId: string;

beforeAll(async () => {
  db = await createTestDb();
  member = await createPerson(db, { role: "MEMBER", name: "Advance Holder" });
  otherMember = await createPerson(db, { role: "MEMBER", name: "Other Member" });
  finance = await createPerson(db, { role: "FINANCE", name: "Finance Officer" });
  executive = await createPerson(db, { role: "EXECUTIVE", name: "Committee Executive" });
  cashId = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, opening_balance_paisa) VALUES ($1,'Advance cash','CASH',2000000)`,
    [cashId],
  );
});

afterAll(async () => {
  await db.close();
});

describe("advances", () => {
  let advanceId: string;

  it("lets a member request only their own advance", async () => {
    await expect(
      createAdvance(db, member, { memberId: otherMember.memberId!, purpose: "Not mine", amount: "1000" }),
    ).rejects.toThrow(/only request an advance for yourself/i);

    const created = await createAdvance(db, member, {
      memberId: member.memberId!, purpose: "Event venue deposit", amount: "5,000", dueOn: "2026-11-15",
    });
    advanceId = created.id;
    expect(created.ref).toMatch(/^ADV-\d{4}$/);
    expect((await getAdvance(db, advanceId))?.status).toBe("REQUESTED");
  });

  it("blocks disbursement by roles without advance permission", async () => {
    await expect(
      disburseAdvance(db, member, { advanceId, accountId: cashId, date: "2026-10-05" }),
    ).rejects.toThrow(/cannot disburse advances/i);
  });

  it("disburses into advances receivable", async () => {
    await disburseAdvance(db, finance, { advanceId, accountId: cashId, date: "2026-10-05", method: "Cash" });
    expect((await getAdvance(db, advanceId))?.status).toBe("OUTSTANDING");
    expect(await accountCodeBalance(db, "1100")).toBe(500_000);
    expect(await accountCodeBalance(db, "1000")).toBe(-500_000);
  });

  it("settles part of the advance through an expense claim", async () => {
    const claim = await createExpense(db, member, {
      date: "2026-10-08",
      vendorName: "Venue Office",
      description: "Venue deposit paid from advance",
      amount: "3,000",
      categoryId: "cat_venue",
      fundingSource: "LOCUS_CASH",
      advanceId,
      missingReceiptDeclaration: "Receipt pending from venue office.",
      submitNow: true,
    });
    // NPR 3,000 is above the standard threshold, so both finance and executive approval are required.
    await decideClaim(db, finance, claim.id, "APPROVE", null);
    await decideClaim(db, executive, claim.id, "APPROVE", null);

    const advance = await getAdvance(db, advanceId);
    expect(advance?.status).toBe("PARTIALLY_SETTLED");
    expect(advance?.outstanding_paisa).toBe(200_000);
    expect(await accountCodeBalance(db, "1100")).toBe(200_000);
  });

  it("rejects a return larger than the outstanding balance", async () => {
    await expect(
      returnAdvanceFunds(db, finance, { advanceId, accountId: cashId, amount: "2500", date: "2026-10-09" }),
    ).rejects.toThrow(/exceeds the outstanding advance balance/i);
  });

  it("closes the advance when the remainder is returned", async () => {
    await returnAdvanceFunds(db, finance, { advanceId, accountId: cashId, amount: "2000", date: "2026-10-09" });
    expect((await getAdvance(db, advanceId))?.status).toBe("SETTLED");
    expect(await accountCodeBalance(db, "1100")).toBe(0);
    const totals = await journalTotals(db);
    expect(totals.debit).toBe(totals.credit);
  });

  it("refuses to disburse an already closed advance", async () => {
    await expect(
      disburseAdvance(db, finance, { advanceId, accountId: cashId, date: "2026-10-10" }),
    ).rejects.toThrow(/already been disbursed or closed/i);
  });
});
