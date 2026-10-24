import { many, money, one, type Db } from "./db";
import { listAccounts } from "./accounts";
import { advanceAging, listAdvances } from "./advances";
import { sponsorshipSummary } from "./sponsors";
import { listBudgets } from "./budgets";
import { getSettings } from "./settings";
import { adToBs, bsToAd, fiscalYearBsFor, todayISO } from "@/lib/nepali-date";
import { formatNPR } from "@/lib/money";
import { listAudit } from "./audit";

const COUNTED = `('SUBMITTED','UNDER_REVIEW','APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')`;

export type Period = { from: string; to: string; label: string };

export async function currentFiscalPeriod(db: Db): Promise<Period> {
  const today = todayISO();
  const bsToday = adToBs(today);
  const bsYear = bsToday ? Number(bsToday.slice(0, 4)) : new Date().getFullYear() - 57;
  const start = bsToAd(`${bsYear}-04-01`) ?? `${new Date().getUTCFullYear()}-07-17`;
  const nextStart = bsToAd(`${bsYear + 1}-04-01`) ?? `${new Date().getUTCFullYear() + 1}-07-17`;
  const endDate = new Date(`${nextStart}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return {
    from: start,
    to: endDate.toISOString().slice(0, 10),
    label: `Fiscal year ${bsYear}/${String(bsYear + 1).slice(-2)} (${start} to ${endDate.toISOString().slice(0, 10)})`,
  };
}

export async function resolvePeriod(db: Db, from?: string | null, to?: string | null): Promise<Period> {
  if (from && to) return { from, to, label: `${from} to ${to}` };
  return currentFiscalPeriod(db);
}

function claimFilter(params: unknown[], period: Period, alias = "c") {
  params.push(period.from);
  const fromIdx = params.length;
  params.push(period.to);
  const toIdx = params.length;
  return `${alias}.date_ad >= $${fromIdx} AND ${alias}.date_ad <= $${toIdx}`;
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

export async function getDashboard(db: Db, period: Period) {
  const params: unknown[] = [];
  const filter = claimFilter(params, period);
  const base = await one<{
    recorded_paisa: number; verified_paisa: number; unverified_paisa: number;
    recorded_count: number; verified_count: number; missing_docs_paisa: number; missing_docs_count: number;
    pending_paisa: number; pending_count: number; reimbursement_owed_paisa: number; reimbursement_owed_count: number;
    disputed_paisa: number; total_claimed_all_time: number;
  }>(
    db,
    `SELECT
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.status IN ${COUNTED}),0) AS recorded_paisa,
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state='VERIFIED' AND c.status IN ${COUNTED}),0) AS verified_paisa,
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state<>'VERIFIED' AND c.status IN ${COUNTED}),0) AS unverified_paisa,
      COUNT(*) FILTER (WHERE c.status IN ${COUNTED})::int AS recorded_count,
      COUNT(*) FILTER (WHERE c.verification_state='VERIFIED' AND c.status IN ${COUNTED})::int AS verified_count,
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.documentation_state<>'COMPLETE' AND c.status IN ${COUNTED}),0) AS missing_docs_paisa,
      COUNT(*) FILTER (WHERE c.documentation_state<>'COMPLETE' AND c.status IN ${COUNTED})::int AS missing_docs_count,
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.status IN ('SUBMITTED','UNDER_REVIEW')),0) AS pending_paisa,
      COUNT(*) FILTER (WHERE c.status IN ('SUBMITTED','UNDER_REVIEW'))::int AS pending_count,
      COALESCE(SUM(GREATEST(0, c.amount_paisa - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p
        WHERE p.claim_id=c.id AND p.status='RECORDED' AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')),0)))
        FILTER (WHERE c.reimbursement_required=true AND c.status IN ('APPROVED','PAYMENT_PENDING','VERIFIED')),0) AS reimbursement_owed_paisa,
      COUNT(*) FILTER (WHERE c.reimbursement_required=true AND c.status IN ('APPROVED','PAYMENT_PENDING','VERIFIED'))::int AS reimbursement_owed_count,
      COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state='DISPUTED'),0) AS disputed_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM expense_claims WHERE status IN ${COUNTED}),0) AS total_claimed_all_time
     FROM expense_claims c WHERE ${filter}`,
    params,
  );

  const [sponsors, accounts, advances, budgets, docs, unreconciled, byCategory, byEvent, monthly, audit, oldestPending] = await Promise.all([
    sponsorshipSummary(db),
    listAccounts(db),
    listAdvances(db),
    listBudgets(db),
    one<{ total: number; reviewed: number; needs_review: number; failed: number; duplicates: number; processed: number }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE review_status IN ('ACCEPTED','CORRECTED'))::int AS reviewed,
              COUNT(*) FILTER (WHERE status IN ('NEEDS_REVIEW','EXTRACTED'))::int AS needs_review,
              COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates,
              COUNT(*) FILTER (WHERE status IN ('EXTRACTED','REVIEWED'))::int AS processed
         FROM documents`,
    ),
    one<{ unmatched: number; imports: number; matched: number }>(
      db,
      `SELECT COUNT(*) FILTER (WHERE match_status IN ('UNMATCHED','SUGGESTED'))::int AS unmatched,
              (SELECT COUNT(*)::int FROM statement_imports) AS imports,
              COUNT(*) FILTER (WHERE match_status='MATCHED')::int AS matched
         FROM bank_statement_lines`,
    ),
    many<{ name: string; amount_paisa: number; count: number }>(
      db,
      `SELECT cat.name, SUM(c.amount_paisa) AS amount_paisa, COUNT(*)::int AS count
         FROM expense_claims c JOIN expense_categories cat ON cat.id=c.category_id
        WHERE c.status IN ${COUNTED} AND c.date_ad BETWEEN $1 AND $2
        GROUP BY cat.name ORDER BY amount_paisa DESC LIMIT 8`,
      [period.from, period.to],
    ),
    many<{ name: string; amount_paisa: number }>(
      db,
      `SELECT COALESCE(e.name,'Unassigned') AS name, SUM(a.amount_paisa) AS amount_paisa
         FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
         LEFT JOIN events e ON e.id=a.event_id
        WHERE c.status IN ${COUNTED} AND c.date_ad BETWEEN $1 AND $2
        GROUP BY e.name ORDER BY amount_paisa DESC LIMIT 8`,
      [period.from, period.to],
    ),
    many<{ month: string; verified_paisa: number; unverified_paisa: number; total_paisa: number }>(
      db,
      `SELECT to_char(date_trunc('month', date_ad),'YYYY-MM') AS month,
              COALESCE(SUM(amount_paisa) FILTER (WHERE verification_state='VERIFIED'),0) AS verified_paisa,
              COALESCE(SUM(amount_paisa) FILTER (WHERE verification_state<>'VERIFIED'),0) AS unverified_paisa,
              COALESCE(SUM(amount_paisa),0) AS total_paisa
         FROM expense_claims WHERE status IN ${COUNTED} AND date_ad BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [period.from, period.to],
    ),
    listAudit(db, { limit: 8 }),
    one<{ days: number; claim_no: string; amount_paisa: number }>(
      db,
      `SELECT GREATEST(0, CURRENT_DATE - submitted_at::date) AS days, claim_no, amount_paisa
         FROM expense_claims WHERE status IN ('SUBMITTED','UNDER_REVIEW') ORDER BY submitted_at ASC LIMIT 1`,
    ),
  ]);

  const aging = advanceAging(advances);
  const overspent = budgets.filter((b) => b.utilisation > 1);
  const nearLimit = budgets.filter((b) => b.utilisation >= 0.8 && b.utilisation <= 1);

  const missingDocsList = await many<{ id: string; claim_no: string; amount_paisa: number; documentation_state: string }>(
    db,
    `SELECT id, claim_no, amount_paisa, documentation_state FROM expense_claims
      WHERE documentation_state <> 'COMPLETE' AND status IN ${COUNTED}
      ORDER BY amount_paisa DESC LIMIT 5`,
  );

  return {
    period,
    recorded: money(base?.recorded_paisa),
    verified: money(base?.verified_paisa),
    unverified: money(base?.unverified_paisa),
    recordedCount: base?.recorded_count ?? 0,
    verifiedCount: base?.verified_count ?? 0,
    missingDocs: money(base?.missing_docs_paisa),
    missingDocsCount: base?.missing_docs_count ?? 0,
    pending: money(base?.pending_paisa),
    pendingCount: base?.pending_count ?? 0,
    reimbursementOwed: money(base?.reimbursement_owed_paisa),
    reimbursementOwedCount: base?.reimbursement_owed_count ?? 0,
    disputed: money(base?.disputed_paisa),
    sponsors,
    accounts,
    cashTotal: accounts.filter((a) => a.type === "CASH" || a.type === "WALLET").reduce((s, a) => s + money(a.balance_paisa), 0),
    bankTotal: accounts.filter((a) => a.type === "BANK").reduce((s, a) => s + money(a.balance_paisa), 0),
    advances: {
      count: advances.filter((a) => ["OUTSTANDING", "PARTIALLY_SETTLED"].includes(a.status)).length,
      outstanding: advances.reduce((s, a) => s + (["OUTSTANDING", "PARTIALLY_SETTLED"].includes(a.status) ? money(a.outstanding_paisa) : 0), 0),
      over30: aging.over30,
    },
    budgets: {
      overspent, nearLimit,
      totalBudget: budgets.reduce((s, b) => s + b.total_paisa, 0),
      totalIncurred: budgets.reduce((s, b) => s + b.incurred_paisa, 0),
    },
    docs: docs ?? { total: 0, reviewed: 0, needs_review: 0, failed: 0, duplicates: 0, processed: 0 },
    unreconciled: unreconciled ?? { unmatched: 0, imports: 0, matched: 0 },
    byCategory,
    byEvent,
    monthly,
    recent: audit,
    oldestPending,
    missingDocsList,
    integrity: {
      pendingApprovalDays: oldestPending?.days ?? 0,
      hasUnreconciled: (unreconciled?.unmatched ?? 0) > 0,
      hasMissingDocs: (base?.missing_docs_count ?? 0) > 0,
      hasOverdueAdvances: aging.over30.length > 0,
    },
  };
}

export async function spendByCategory(db: Db, period: Period) {
  return many<{ name: string; code: string; amount_paisa: number; count: number; verified_paisa: number }>(
    db,
    `SELECT cat.name, cat.code, SUM(c.amount_paisa) AS amount_paisa, COUNT(*)::int AS count,
            COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state='VERIFIED'),0) AS verified_paisa
       FROM expense_claims c JOIN expense_categories cat ON cat.id=c.category_id
      WHERE c.status IN ${COUNTED} AND c.date_ad BETWEEN $1 AND $2
      GROUP BY cat.name, cat.code ORDER BY amount_paisa DESC`,
    [period.from, period.to],
  );
}

export async function spendByEvent(db: Db, period: Period) {
  return many<{ event_id: string | null; name: string; amount_paisa: number; verified_paisa: number; count: number }>(
    db,
    `SELECT a.event_id, COALESCE(e.name,'Unassigned') AS name, SUM(a.amount_paisa) AS amount_paisa,
            COALESCE(SUM(a.amount_paisa) FILTER (WHERE c.verification_state='VERIFIED'),0) AS verified_paisa,
            COUNT(DISTINCT c.id)::int AS count
       FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
       LEFT JOIN events e ON e.id=a.event_id
      WHERE c.status IN ${COUNTED} AND c.date_ad BETWEEN $1 AND $2
      GROUP BY a.event_id, e.name ORDER BY amount_paisa DESC`,
    [period.from, period.to],
  );
}

/** Cash-basis income & expenditure from recorded payments. Internal transfers are excluded. */
export async function cashflow(db: Db, period: Period) {
  const rows = await many<{ month: string; type: string; direction: string; amount_paisa: number }>(
    db,
    `SELECT to_char(date_trunc('month', date_ad),'YYYY-MM') AS month, type, direction, SUM(amount_paisa) AS amount_paisa
       FROM payments WHERE status='RECORDED' AND type <> 'TRANSFER' AND date_ad BETWEEN $1 AND $2
      GROUP BY 1,2,3 ORDER BY 1`,
    [period.from, period.to],
  );
  const months = new Map<string, { month: string; income: number; expenditure: number; advances: number }>();
  for (const r of rows) {
    const entry = months.get(r.month) ?? { month: r.month, income: 0, expenditure: 0, advances: 0 };
    const amount = money(r.amount_paisa);
    if (r.type === "SPONSOR_RECEIPT" || r.type === "OTHER_INCOME") entry.income += amount;
    else if (r.type === "ADVANCE_RETURN") entry.advances -= amount;
    else if (r.type === "ADVANCE_DISBURSEMENT") entry.advances += amount;
    else if (r.type === "REIMBURSEMENT" || r.type === "EXPENSE_PAYMENT" || r.type === "BANK_FEE") entry.expenditure += amount;
    months.set(r.month, entry);
  }
  return [...months.values()];
}

export async function journalTrialBalance(db: Db, period: Period) {
  return many<{ account_code: string; account_name: string; debit_paisa: number; credit_paisa: number; balance_paisa: number }>(
    db,
    `SELECT l.account_code, MIN(l.account_name) AS account_name,
            SUM(l.debit_paisa) AS debit_paisa, SUM(l.credit_paisa) AS credit_paisa,
            SUM(l.debit_paisa - l.credit_paisa) AS balance_paisa
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE e.status='POSTED' AND e.entry_date BETWEEN $1 AND $2
      GROUP BY l.account_code ORDER BY l.account_code`,
    [period.from, period.to],
  );
}

export async function documentationStats(db: Db) {
  const row = await one<{
    complete: number; declared: number; undeclared: number; verified: number; unverified: number; disputed: number;
  }>(
    db,
    `SELECT
      COUNT(*) FILTER (WHERE documentation_state='COMPLETE')::int AS complete,
      COUNT(*) FILTER (WHERE documentation_state='MISSING_DECLARED')::int AS declared,
      COUNT(*) FILTER (WHERE documentation_state='MISSING_UNDECLARED')::int AS undeclared,
      COUNT(*) FILTER (WHERE verification_state='VERIFIED')::int AS verified,
      COUNT(*) FILTER (WHERE verification_state='UNVERIFIED')::int AS unverified,
      COUNT(*) FILTER (WHERE verification_state='DISPUTED')::int AS disputed
     FROM expense_claims WHERE status IN ${COUNTED}`,
  );
  return row ?? { complete: 0, declared: 0, undeclared: 0, verified: 0, unverified: 0, disputed: 0 };
}

export async function monthlySpend(db: Db, period: Period) {
  return many<{ month: string; verified_paisa: number; unverified_paisa: number; total_paisa: number }>(
    db,
    `SELECT to_char(date_trunc('month', date_ad),'YYYY-MM') AS month,
            COALESCE(SUM(amount_paisa) FILTER (WHERE verification_state='VERIFIED'),0) AS verified_paisa,
            COALESCE(SUM(amount_paisa) FILTER (WHERE verification_state<>'VERIFIED'),0) AS unverified_paisa,
            COALESCE(SUM(amount_paisa),0) AS total_paisa
       FROM expense_claims WHERE status IN ${COUNTED} AND date_ad BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 1`,
    [period.from, period.to],
  );
}

export async function sponsorReport(db: Db) {
  return many<{
    ref: string; sponsor: string; state: string; promised_paisa: number; received_paisa: number;
    outstanding_paisa: number; in_kind: boolean; event_name: string | null; deliverables_pending: number;
  }>(
    db,
    `SELECT a.ref, s.name AS sponsor, a.state, a.promised_paisa,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.agreement_id=a.id AND p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0) AS received_paisa,
            GREATEST(0, a.promised_paisa - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.agreement_id=a.id AND p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0)) AS outstanding_paisa,
            a.in_kind, e.name AS event_name,
            (SELECT COUNT(*)::int FROM sponsor_deliverables d WHERE d.agreement_id=a.id AND d.status='PENDING') AS deliverables_pending
       FROM sponsorship_agreements a JOIN sponsors s ON s.id=a.sponsor_id
       LEFT JOIN events e ON e.id=a.event_id
      ORDER BY a.promised_paisa DESC`,
  );
}

export async function budgetReport(db: Db) {
  return listBudgets(db);
}

export async function fiscalYearOptions(db: Db) {
  const rows = await many<{ d: string }>(db, `SELECT DISTINCT to_char(date_ad,'YYYY-MM-DD') AS d FROM expense_claims`);
  const years = new Set<string>();
  for (const row of rows) {
    const fy = fiscalYearBsFor(row.d);
    if (fy) years.add(fy);
  }
  return [...years].sort().reverse();
}

export function periodLabel(period: Period): string {
  return period.label;
}

export function describeAmount(paisa: number): string {
  return formatNPR(paisa);
}
