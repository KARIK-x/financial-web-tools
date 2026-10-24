import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { budgetOverspendAlerts, createBudget, listBudgets, reviseBudgetLine } from "@/server/budgets";
import { createExpense, decideClaim } from "@/server/expenses";
import { createPerson, createTestDb } from "./helpers/fixtures";

let db: Db;
let finance: CurrentUser;
let member: CurrentUser;

beforeAll(async () => {
  db = await createTestDb();
  finance = await createPerson(db, { role: "FINANCE", name: "Budget Officer" });
  member = await createPerson(db, { role: "MEMBER", name: "Budget Claimant" });
});

afterAll(async () => {
  await db.close();
});

describe("budgets", () => {
  let budgetId: string;

  it("validates the BS fiscal-year label", async () => {
    await expect(
      createBudget(db, finance, {
        name: "Bad year", scope: "ORG", fiscalYear: "2083-84",
        lines: [{ categoryId: "cat_travel", amount: "1000" }],
      }),
    ).rejects.toThrow(/fiscal year must look like/i);
  });

  it("restricts budget management to authorised roles", async () => {
    await expect(
      createBudget(db, member, {
        name: "Member budget", scope: "ORG", fiscalYear: "2083/84",
        lines: [{ categoryId: "cat_travel", amount: "1000" }],
      }),
    ).rejects.toThrow(/cannot manage budgets/i);
  });

  it("creates an active budget with category lines", async () => {
    budgetId = await createBudget(db, finance, {
      name: "Core operations 2083/84", scope: "ORG", fiscalYear: "2083/84",
      lines: [
        { categoryId: "cat_travel", amount: "1,000" },
        { categoryId: "cat_printing", amount: "2,000" },
      ],
    });
    const budget = (await listBudgets(db)).find((b) => b.id === budgetId);
    expect(budget?.status).toBe("ACTIVE");
    expect(budget?.total_paisa).toBe(300_000);
    expect(budget?.lines).toHaveLength(2);
  });

  it("counts approved spend against the matching BS fiscal year", async () => {
    const claim = await createExpense(db, member, {
      date: "2026-10-20",
      vendorName: "Budget Travels",
      description: "Taxi to venue",
      amount: "1,500",
      categoryId: "cat_travel",
      fundingSource: "PERSONAL",
      missingReceiptDeclaration: "Taxi receipt not issued.",
      submitNow: true,
    });
    await decideClaim(db, finance, claim.id, "APPROVE", null);

    const budget = (await listBudgets(db)).find((b) => b.id === budgetId);
    const travel = budget?.lines.find((l) => l.category_id === "cat_travel");
    expect(travel?.incurred_paisa).toBe(150_000);
    expect(travel?.variance_paisa).toBe(-50_000);
    expect(travel?.utilisation).toBe(1.5);
    expect(budget?.utilisation).toBeCloseTo(0.5, 5);
  });

  it("raises an overspend alert at 80% or more", async () => {
    const alerts = await budgetOverspendAlerts(db);
    const alert = alerts.find((a) => a.id === budgetId);
    expect(alert?.over).toBe(true);
  });

  it("revises a line and keeps an audit trail", async () => {
    const budget = (await listBudgets(db)).find((b) => b.id === budgetId);
    const travel = budget!.lines.find((l) => l.category_id === "cat_travel")!;
    await reviseBudgetLine(db, finance, { lineId: travel.id, amount: "2,000", reason: "Taxi costs were underestimated." });

    const revised = (await listBudgets(db)).find((b) => b.id === budgetId);
    const line = revised!.lines.find((l) => l.category_id === "cat_travel")!;
    expect(line.amount_paisa).toBe(200_000);
    expect(line.utilisation).toBe(0.75);

    const revisions = await db.query<{ old_paisa: string; new_paisa: string; reason: string }>(
      `SELECT old_paisa, new_paisa, reason FROM budget_revisions WHERE budget_line_id=$1`,
      [travel.id],
    );
    expect(revisions.rows).toHaveLength(1);
    expect(Number(revisions.rows[0]?.new_paisa)).toBe(200_000);
  });
});
