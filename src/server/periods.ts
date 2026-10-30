import { randomUUID } from "node:crypto";
import { many, one, type Db, type Executor } from "./db";
import { recordAudit } from "./audit";
import { isValidISODate } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";

export class PeriodError extends Error {}

export type AccountingPeriod = {
  id: string;
  fiscal_year: string;
  period_start: string;
  period_end: string;
  status: "OPEN" | "CLOSED";
  closed_by_name: string | null;
  closed_at: Date | null;
  closed_reason: string | null;
  reopened_by_name: string | null;
  reopened_at: Date | null;
  reopened_reason: string | null;
  created_at: Date;
};

/** The closed period covering a business date, if one exists. */
export async function closedPeriodForDate(db: Executor, date: string): Promise<{ id: string; fiscal_year: string; period_end: string } | null> {
  if (!isValidISODate(date)) return null;
  return one<{ id: string; fiscal_year: string; period_end: string }>(
    db,
    `SELECT id, fiscal_year, to_char(period_end,'YYYY-MM-DD') AS period_end
       FROM accounting_periods
      WHERE status = 'CLOSED' AND $1::date BETWEEN period_start AND period_end
      ORDER BY period_end DESC LIMIT 1`,
    [date],
  );
}

/** Server-side period guard used by every financial write path. */
export async function assertDateOpen(db: Executor, date: string, context = "This transaction"): Promise<void> {
  const closed = await closedPeriodForDate(db, date);
  if (closed) {
    throw new PeriodError(
      `${context} falls in closed accounting period ${closed.fiscal_year} (ended ${closed.period_end}). ` +
      `Reopen the period with an audited reason before posting, or use the current period.`,
    );
  }
}

export async function listPeriods(db: Db): Promise<AccountingPeriod[]> {
  return many<AccountingPeriod>(
    db,
    `SELECT p.id, p.fiscal_year, to_char(p.period_start,'YYYY-MM-DD') AS period_start,
            to_char(p.period_end,'YYYY-MM-DD') AS period_end, p.status,
            cu.name AS closed_by_name, p.closed_at, p.closed_reason,
            ru.name AS reopened_by_name, p.reopened_at, p.reopened_reason, p.created_at
       FROM accounting_periods p
       LEFT JOIN users cu ON cu.id = p.closed_by
       LEFT JOIN users ru ON ru.id = p.reopened_by
      ORDER BY p.period_start DESC`,
  );
}

export async function closePeriod(
  db: Db,
  user: CurrentUser,
  input: { fiscalYear: string; periodStart: string; periodEnd: string; reason: string },
): Promise<{ id: string; status: "CLOSED" }> {
  if (!can(user.role, "settings.manage", user.permissions)) throw new PeriodError("You cannot close accounting periods.");
  if (!input.fiscalYear.trim()) throw new PeriodError("A fiscal-year label is required.");
  if (!isValidISODate(input.periodStart) || !isValidISODate(input.periodEnd)) throw new PeriodError("Period dates are invalid.");
  if (input.periodEnd < input.periodStart) throw new PeriodError("The period end cannot be before its start.");
  if (!input.reason.trim()) throw new PeriodError("Explain what was checked before closing the period.");

  const existing = await one<{ id: string; status: string }>(
    db, `SELECT id, status FROM accounting_periods WHERE fiscal_year = $1`, [input.fiscalYear.trim()],
  );
  if (existing?.status === "CLOSED") throw new PeriodError("That fiscal period is already closed.");

  const draftJournal = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM journal_entries
      WHERE status='DRAFT' AND entry_date BETWEEN $1 AND $2`,
    [input.periodStart, input.periodEnd],
  );
  if ((draftJournal?.n ?? 0) > 0) {
    throw new PeriodError(`There are ${draftJournal?.n} draft journal entries in this period. Post or remove them before closing.`);
  }

  const pendingClaims = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM expense_claims
      WHERE date_ad BETWEEN $1 AND $2 AND status IN ('SUBMITTED','UNDER_REVIEW')`,
    [input.periodStart, input.periodEnd],
  );

  const id = existing?.id ?? randomUUID();
  await db.transaction(async (tx) => {
    if (existing) {
      await tx.query(
        `UPDATE accounting_periods
            SET status='CLOSED', closed_by=$2, closed_at=now(), closed_reason=$3,
                period_start=$4, period_end=$5, updated_at=now()
          WHERE id=$1`,
        [id, user.id, input.reason.trim(), input.periodStart, input.periodEnd],
      );
    } else {
      await tx.query(
        `INSERT INTO accounting_periods
          (id, fiscal_year, period_start, period_end, status, closed_by, closed_at, closed_reason)
         VALUES ($1,$2,$3,$4,'CLOSED',$5,now(),$6)`,
        [id, input.fiscalYear.trim(), input.periodStart, input.periodEnd, user.id, input.reason.trim()],
      );
    }
    await tx.query(
      `INSERT INTO accounting_period_events (id, period_id, action, reason, actor_user_id)
       VALUES ($1,$2,'CLOSED',$3,$4)`,
      [randomUUID(), id, input.reason.trim(), user.id],
    );
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "PERIOD_CLOSED",
    entityType: "accounting_period", entityId: id,
    summary: `Closed ${input.fiscalYear} (${input.periodStart} → ${input.periodEnd})${pendingClaims?.n ? `; ${pendingClaims.n} pending claim(s) remain` : ""}`,
    after: {
      fiscalYear: input.fiscalYear, periodStart: input.periodStart, periodEnd: input.periodEnd,
      reason: input.reason.trim(), pendingClaims: pendingClaims?.n ?? 0,
    },
  });
  return { id, status: "CLOSED" };
}

export async function reopenPeriod(
  db: Db,
  user: CurrentUser,
  input: { periodId: string; reason: string },
): Promise<{ id: string; status: "OPEN" }> {
  if (!can(user.role, "settings.manage", user.permissions)) throw new PeriodError("You cannot reopen accounting periods.");
  if (!input.reason.trim()) throw new PeriodError("A reopen reason is required.");
  const period = await one<{ id: string; fiscal_year: string; status: string }>(
    db, `SELECT id, fiscal_year, status FROM accounting_periods WHERE id=$1`, [input.periodId],
  );
  if (!period) throw new PeriodError("Accounting period not found.");
  if (period.status !== "CLOSED") throw new PeriodError("That period is already open.");

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE accounting_periods
          SET status='OPEN', reopened_by=$2, reopened_at=now(), reopened_reason=$3, updated_at=now()
        WHERE id=$1`,
      [period.id, user.id, input.reason.trim()],
    );
    await tx.query(
      `INSERT INTO accounting_period_events (id, period_id, action, reason, actor_user_id)
       VALUES ($1,$2,'REOPENED',$3,$4)`,
      [randomUUID(), period.id, input.reason.trim(), user.id],
    );
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "PERIOD_REOPENED",
    entityType: "accounting_period", entityId: period.id,
    summary: `Reopened ${period.fiscal_year}: ${input.reason.trim()}`,
    after: { reason: input.reason.trim() },
  });
  return { id: period.id, status: "OPEN" };
}
