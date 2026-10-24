import { randomUUID } from "node:crypto";
import { many, money, one, type Db } from "./db";
import { recordAudit } from "./audit";
import { parseMoney } from "@/lib/money";
import { fiscalYearBsFor } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { ExpenseError } from "./expenses";
import { getSettings } from "./settings";

const COUNTED = `('APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED')`;

export type BudgetLineView = {
  id: string;
  category_id: string;
  category_name: string;
  amount_paisa: number;
  incurred_paisa: number;
  paid_paisa: number;
  outstanding_paisa: number;
  variance_paisa: number;
  utilisation: number;
};

export type BudgetView = {
  id: string;
  name: string;
  scope: string;
  event_id: string | null;
  event_name: string | null;
  department_id: string | null;
  department_name: string | null;
  fiscal_year: string;
  status: string;
  total_paisa: number;
  incurred_paisa: number;
  paid_paisa: number;
  outstanding_paisa: number;
  variance_paisa: number;
  utilisation: number;
  lines: BudgetLineView[];
};

export async function listBudgets(db: Db, filters: { eventId?: string } = {}): Promise<BudgetView[]> {
  const params: unknown[] = [];
  let where = "";
  if (filters.eventId) { params.push(filters.eventId); where = `WHERE b.event_id = $1`; }
  const budgets = await many<{
    id: string; name: string; scope: string; event_id: string | null; event_name: string | null;
    department_id: string | null; department_name: string | null; fiscal_year: string; status: string;
  }>(
    db,
    `SELECT b.id, b.name, b.scope, b.event_id, e.name AS event_name, b.department_id, d.name AS department_name,
            b.fiscal_year, b.status
       FROM budgets b LEFT JOIN events e ON e.id=b.event_id LEFT JOIN departments d ON d.id=b.department_id
       ${where} ORDER BY b.created_at DESC`,
    params,
  );
  if (!budgets.length) return [];
  const budgetIds = budgets.map((b) => b.id);
  const lines = await many<{
    id: string; budget_id: string; category_id: string; category_name: string; amount_paisa: number;
  }>(
    db,
    `SELECT bl.id, bl.budget_id, bl.category_id, c.name AS category_name, bl.amount_paisa
       FROM budget_lines bl JOIN expense_categories c ON c.id=bl.category_id
      WHERE bl.budget_id = ANY($1::text[]) ORDER BY c.sort_order`,
    [budgetIds],
  );

  const eventIds = budgets.map((b) => b.event_id).filter(Boolean) as string[];
  const deptIds = budgets.map((b) => b.department_id).filter(Boolean) as string[];
  const allocations = await many<{
    claim_id: string; event_id: string | null; department_id: string | null; category_id: string;
    date_ad: string; amount_paisa: number; claim_amount: number; paid_paisa: number; status: string;
  }>(
    db,
    `SELECT c.id AS claim_id, a.event_id, a.department_id, c.category_id, to_char(c.date_ad,'YYYY-MM-DD') AS date_ad,
            a.amount_paisa, c.amount_paisa AS claim_amount,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.claim_id=c.id AND p.status='RECORDED'
              AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')),0) AS paid_paisa,
            c.status
       FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
      WHERE c.status IN ${COUNTED}`,
  );

  // Each claim's paid amount is split across its allocations so nothing is double-counted.
  const claimTotals = new Map<string, number>();
  for (const a of allocations) {
    claimTotals.set(a.claim_id, (claimTotals.get(a.claim_id) ?? 0) + money(a.amount_paisa));
  }
  const allocatedPaid = new Map<string, number>();
  for (const a of allocations) {
    const total = claimTotals.get(a.claim_id) ?? 0;
    const share = total > 0 ? Math.round((money(a.paid_paisa) * money(a.amount_paisa)) / total) : 0;
    allocatedPaid.set(`${a.claim_id}:${a.amount_paisa}:${a.category_id}`, share);
  }

  const settings = await getSettings(db);
  return budgets.map((b) => {
    const bLines = lines.filter((l) => l.budget_id === b.id);
    const relevant = allocations.filter((a) => {
      if (b.scope === "EVENT") return a.event_id === b.event_id;
      if (b.scope === "DEPARTMENT") return a.department_id === b.department_id;
      return true;
    });
    const lineViews: BudgetLineView[] = bLines.map((l) => {
      const matches = relevant.filter(
        (a) => a.category_id === l.category_id && fiscalYearBsFor(a.date_ad) === b.fiscal_year,
      );
      let incurred = 0;
      let paid = 0;
      for (const m of matches) {
        incurred += money(m.amount_paisa);
        paid += allocatedPaid.get(`${m.claim_id}:${m.amount_paisa}:${m.category_id}`) ?? 0;
      }
      const budgeted = money(l.amount_paisa);
      const outstanding = Math.max(0, incurred - paid);
      return {
        id: l.id, category_id: l.category_id, category_name: l.category_name,
        amount_paisa: budgeted, incurred_paisa: incurred, paid_paisa: paid,
        outstanding_paisa: outstanding, variance_paisa: budgeted - incurred,
        utilisation: budgeted > 0 ? incurred / budgeted : incurred > 0 ? 1 : 0,
      };
    });
    const total = lineViews.reduce((s, l) => s + l.amount_paisa, 0);
    const incurred = lineViews.reduce((s, l) => s + l.incurred_paisa, 0);
    const paid = lineViews.reduce((s, l) => s + l.paid_paisa, 0);
    const outstanding = lineViews.reduce((s, l) => s + l.outstanding_paisa, 0);
    return {
      ...b,
      total_paisa: total,
      incurred_paisa: incurred,
      paid_paisa: paid,
      outstanding_paisa: outstanding,
      variance_paisa: total - incurred,
      utilisation: total > 0 ? incurred / total : 0,
      lines: lineViews,
      thresholds: settings.approval,
    } as BudgetView & { thresholds: unknown };
  });
}

export async function createBudget(
  db: Db, user: CurrentUser,
  input: {
    name: string; scope: "ORG" | "EVENT" | "DEPARTMENT"; eventId?: string | null;
    departmentId?: string | null; fiscalYear: string;
    lines: Array<{ categoryId: string; amount: string }>;
  },
) {
  if (!can(user.role, "budget.manage", user.permissions)) throw new ExpenseError("You cannot manage budgets.");
  if (!input.name.trim()) throw new ExpenseError("Budget name is required.");
  if (!/^\d{4}\/\d{2}$/.test(input.fiscalYear)) throw new ExpenseError("Fiscal year must look like 2082/83.");
  if (input.scope === "EVENT" && !input.eventId) throw new ExpenseError("Choose an event for an event budget.");
  if (input.scope === "DEPARTMENT" && !input.departmentId) throw new ExpenseError("Choose a department for a department budget.");
  const parsedLines = input.lines
    .filter((l) => l.categoryId && l.amount.trim())
    .map((l) => {
      const p = parseMoney(l.amount);
      if (!p.ok) throw new ExpenseError(`Budget line amount: ${p.error}`);
      return { categoryId: l.categoryId, paisa: p.paisa };
    });
  if (!parsedLines.length) throw new ExpenseError("Add at least one budget line.");

  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO budgets (id, name, scope, event_id, department_id, fiscal_year, status, created_by, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8)`,
      [id, input.name.trim(), input.scope, input.eventId ?? null, input.departmentId ?? null, input.fiscalYear, user.id, user.isSynthetic],
    );
    for (const line of parsedLines) {
      await tx.query(
        `INSERT INTO budget_lines (id, budget_id, category_id, amount_paisa) VALUES ($1,$2,$3,$4)`,
        [randomUUID(), id, line.categoryId, line.paisa],
      );
    }
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "BUDGET_CREATED",
    entityType: "budget", entityId: id,
    summary: `Budget "${input.name}" created for ${input.fiscalYear} (${parsedLines.length} lines)`,
  });
  return id;
}

export async function reviseBudgetLine(
  db: Db, user: CurrentUser,
  input: { lineId: string; amount: string; reason: string },
) {
  if (!can(user.role, "budget.manage", user.permissions)) throw new ExpenseError("You cannot revise budgets.");
  if (!input.reason.trim()) throw new ExpenseError("A revision reason is required.");
  const line = await one<{ id: string; amount_paisa: number; budget_id: string }>(db, `SELECT id, amount_paisa, budget_id FROM budget_lines WHERE id=$1`, [input.lineId]);
  if (!line) throw new ExpenseError("Budget line not found.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO budget_revisions (id, budget_line_id, old_paisa, new_paisa, reason, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), line.id, line.amount_paisa, amount.paisa, input.reason.trim(), user.id],
    );
    await tx.query(`UPDATE budget_lines SET amount_paisa=$2 WHERE id=$1`, [line.id, amount.paisa]);
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "BUDGET_REVISED",
    entityType: "budget_line", entityId: line.id,
    summary: `Budget line revised from NPR ${(money(line.amount_paisa) / 100).toFixed(2)} to NPR ${(amount.paisa / 100).toFixed(2)}: ${input.reason}`,
    before: { amount_paisa: money(line.amount_paisa) }, after: { amount_paisa: amount.paisa },
  });
}

export async function budgetOverspendAlerts(db: Db) {
  const budgets = await listBudgets(db);
  return budgets.flatMap((b) => {
    // A single category can be overspent even when the overall budget is not.
    const worstLine = [...b.lines].sort((a, z) => z.utilisation - a.utilisation)[0];
    const worst = Math.max(b.utilisation, worstLine?.utilisation ?? 0);
    if (worst < 0.8) return [];
    const overLine = b.lines.find((l) => l.utilisation > 1);
    return [{
      id: b.id,
      name: b.name,
      utilisation: worst,
      over: Boolean(overLine) || b.utilisation > 1,
      variance_paisa: overLine ? overLine.variance_paisa : b.variance_paisa,
      category: overLine?.category_name ?? null,
    }];
  });
}
