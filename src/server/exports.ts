import { many, money, iso, type Db } from "./db";
import { listAccounts } from "./accounts";
import { listAdvances } from "./advances";
import { listBudgets } from "./budgets";
import { sponsorReport, cashflow, journalTrialBalance, spendByCategory, spendByEvent, type Period } from "./reports";
import { paisaToDecimal } from "@/lib/money";

export type ExportType =
  | "claims" | "payments" | "journal" | "trial-balance" | "cashflow" | "categories"
  | "events" | "sponsors" | "budgets" | "advances" | "accounts" | "audit" | "bank-lines";

export type ExportResult = {
  headers: string[];
  records: Array<Record<string, unknown>>;
  truncated: boolean;
};

const MAX_ROWS = 20_000;

function npr(paisa: unknown): string | null {
  if (paisa == null) return null;
  return paisaToDecimal(money(paisa));
}

function withAmounts<T extends Record<string, unknown>>(records: T[], fields: string[]): Array<Record<string, unknown>> {
  return records.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const field of fields) next[`${field.replace(/_paisa$/, "")}_npr`] = npr(row[field]);
    return next;
  });
}

export async function buildExport(
  db: Db,
  type: ExportType,
  period: Period,
  filters: { status?: string; documentation?: string } = {},
): Promise<ExportResult> {
  if (type === "claims") {
    const params: unknown[] = [period.from, period.to];
    const clauses = [`c.date_ad BETWEEN $1 AND $2`];
    if (filters.status) { params.push(filters.status); clauses.push(`c.status = $${params.length}`); }
    if (filters.documentation) { params.push(filters.documentation); clauses.push(`c.documentation_state = $${params.length}`); }
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT c.id, c.claim_no, to_char(c.date_ad,'YYYY-MM-DD') AS date_ad, c.date_bs, c.status,
              cu.name AS claimant, pm.name AS paid_by, cat.name AS category, e.name AS event,
              COALESCE(v.name, c.vendor_name_raw) AS vendor, c.description, c.amount_paisa, c.funding_source,
              c.reimbursement_required, c.verification_state, c.documentation_state, c.source_type, c.is_synthetic,
              c.submitted_at, c.approved_at, c.paid_at, c.verified_at
         FROM expense_claims c
         JOIN users cu ON cu.id=c.claimant_user_id
         JOIN members pm ON pm.id=c.paid_by_member_id
         JOIN expense_categories cat ON cat.id=c.category_id
         LEFT JOIN vendors v ON v.id=c.vendor_id
         LEFT JOIN events e ON e.id=c.event_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY c.date_ad, c.claim_no LIMIT ${MAX_ROWS + 1}`,
      params,
    );
    const truncated = rows.length > MAX_ROWS;
    const records = withAmounts(rows.slice(0, MAX_ROWS).map((r) => ({
      ...r,
      submitted_at: r.submitted_at ? iso(r.submitted_at) : null,
      approved_at: r.approved_at ? iso(r.approved_at) : null,
      paid_at: r.paid_at ? iso(r.paid_at) : null,
      verified_at: r.verified_at ? iso(r.verified_at) : null,
    })), ["amount_paisa"]);
    return {
      headers: [
        "id", "claim_no", "date_ad", "date_bs", "status", "claimant", "paid_by", "category", "event", "vendor",
        "description", "amount_paisa", "amount_npr", "funding_source", "reimbursement_required",
        "verification_state", "documentation_state", "source_type", "is_synthetic",
        "submitted_at", "approved_at", "paid_at", "verified_at",
      ],
      records,
      truncated,
    };
  }

  if (type === "payments") {
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT p.id, p.ref, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad, p.type, p.direction, p.amount_paisa,
              COALESCE(p.payee_name, m.name) AS payee, c.claim_no, fa.name AS account_name,
              p.method, p.reference, p.status, p.notes, p.is_synthetic
         FROM payments p
         LEFT JOIN members m ON m.id=p.counterparty_member_id
         LEFT JOIN expense_claims c ON c.id=p.claim_id
         LEFT JOIN financial_accounts fa ON fa.id=p.account_id
        WHERE p.date_ad BETWEEN $1 AND $2
        ORDER BY p.date_ad, p.ref LIMIT ${MAX_ROWS + 1}`,
      [period.from, period.to],
    );
    return {
      headers: ["id", "ref", "date_ad", "type", "direction", "amount_paisa", "amount_npr", "payee", "claim_no", "account_name", "method", "reference", "status", "notes", "is_synthetic"],
      records: withAmounts(rows.slice(0, MAX_ROWS), ["amount_paisa"]),
      truncated: rows.length > MAX_ROWS,
    };
  }

  if (type === "journal") {
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT e.entry_no, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date, e.memo, e.source_type, e.status,
              l.account_code, l.account_name, l.debit_paisa, l.credit_paisa
         FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id
        WHERE e.entry_date BETWEEN $1 AND $2
        ORDER BY e.entry_date, e.entry_no, l.account_code LIMIT ${MAX_ROWS + 1}`,
      [period.from, period.to],
    );
    return {
      headers: ["entry_no", "entry_date", "memo", "source_type", "status", "account_code", "account_name", "debit_paisa", "debit_npr", "credit_paisa", "credit_npr"],
      records: withAmounts(rows.slice(0, MAX_ROWS), ["debit_paisa", "credit_paisa"]),
      truncated: rows.length > MAX_ROWS,
    };
  }

  if (type === "trial-balance") {
    const rows = await journalTrialBalance(db, period);
    return {
      headers: ["account_code", "account_name", "debit_paisa", "debit_npr", "credit_paisa", "credit_npr", "net_paisa", "net_npr"],
      records: rows.map((r) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        debit_paisa: money(r.debit_paisa),
        debit_npr: npr(r.debit_paisa),
        credit_paisa: money(r.credit_paisa),
        credit_npr: npr(r.credit_paisa),
        net_paisa: money(r.balance_paisa),
        net_npr: npr(r.balance_paisa),
      })),
      truncated: false,
    };
  }

  if (type === "cashflow") {
    const rows = await cashflow(db, period);
    return {
      headers: ["month", "income_paisa", "income_npr", "expenditure_paisa", "expenditure_npr", "advances_paisa", "advances_npr", "net_paisa", "net_npr"],
      records: rows.map((r) => {
        const net = Number(r.income) - Number(r.expenditure) - Number(r.advances);
        return {
          month: r.month, income_paisa: Number(r.income), income_npr: npr(r.income),
          expenditure_paisa: Number(r.expenditure), expenditure_npr: npr(r.expenditure),
          advances_paisa: Number(r.advances), advances_npr: npr(r.advances),
          net_paisa: net, net_npr: npr(net),
        };
      }),
      truncated: false,
    };
  }

  if (type === "categories") {
    const rows = await spendByCategory(db, period);
    return {
      headers: ["code", "name", "count", "amount_paisa", "amount_npr", "verified_paisa", "verified_npr"],
      records: rows.map((r) => ({
        code: r.code, name: r.name, count: r.count,
        amount_paisa: money(r.amount_paisa), amount_npr: npr(r.amount_paisa),
        verified_paisa: money(r.verified_paisa), verified_npr: npr(r.verified_paisa),
      })),
      truncated: false,
    };
  }

  if (type === "events") {
    const rows = await spendByEvent(db, period);
    return {
      headers: ["event", "count", "amount_paisa", "amount_npr", "verified_paisa", "verified_npr"],
      records: rows.map((r) => ({
        event: r.name, count: r.count,
        amount_paisa: money(r.amount_paisa), amount_npr: npr(r.amount_paisa),
        verified_paisa: money(r.verified_paisa), verified_npr: npr(r.verified_paisa),
      })),
      truncated: false,
    };
  }

  if (type === "sponsors") {
    const rows = await sponsorReport(db);
    return {
      headers: ["ref", "sponsor", "state", "in_kind", "event", "promised_paisa", "promised_npr", "received_paisa", "received_npr", "outstanding_paisa", "outstanding_npr", "deliverables_pending"],
      records: rows.map((r) => ({
        ref: r.ref, sponsor: r.sponsor, state: r.state, in_kind: r.in_kind, event: r.event_name,
        promised_paisa: money(r.promised_paisa), promised_npr: npr(r.promised_paisa),
        received_paisa: money(r.received_paisa), received_npr: npr(r.received_paisa),
        outstanding_paisa: money(r.outstanding_paisa), outstanding_npr: npr(r.outstanding_paisa),
        deliverables_pending: r.deliverables_pending,
      })),
      truncated: false,
    };
  }

  if (type === "budgets") {
    const budgets = await listBudgets(db);
    const records: Array<Record<string, unknown>> = [];
    for (const budget of budgets) {
      for (const line of budget.lines) {
        records.push({
          budget: budget.name, scope: budget.scope, fiscal_year: budget.fiscal_year, status: budget.status,
          event: budget.event_name, category: line.category_name,
          amount_paisa: money(line.amount_paisa), amount_npr: npr(line.amount_paisa),
          incurred_paisa: money(line.incurred_paisa), incurred_npr: npr(line.incurred_paisa),
          paid_paisa: money(line.paid_paisa), paid_npr: npr(line.paid_paisa),
          outstanding_paisa: money(line.outstanding_paisa), outstanding_npr: npr(line.outstanding_paisa),
          variance_paisa: money(line.variance_paisa), variance_npr: npr(line.variance_paisa),
          utilisation: line.utilisation,
        });
      }
    }
    return {
      headers: ["budget", "scope", "fiscal_year", "status", "event", "category", "amount_paisa", "amount_npr", "incurred_paisa", "incurred_npr", "paid_paisa", "paid_npr", "outstanding_paisa", "outstanding_npr", "variance_paisa", "variance_npr", "utilisation"],
      records,
      truncated: false,
    };
  }

  if (type === "advances") {
    const rows = await listAdvances(db);
    return {
      headers: ["ref", "member", "purpose", "disbursed_on", "due_on", "status", "amount_paisa", "amount_npr", "used_paisa", "used_npr", "returned_paisa", "returned_npr", "outstanding_paisa", "outstanding_npr", "days_outstanding"],
      records: rows.map((r) => ({
        ref: r.ref, member: r.member_name, purpose: r.purpose, disbursed_on: r.disbursed_on, due_on: r.due_on, status: r.status,
        amount_paisa: money(r.amount_paisa), amount_npr: npr(r.amount_paisa),
        used_paisa: money(r.used_paisa), used_npr: npr(r.used_paisa),
        returned_paisa: money(r.returned_paisa), returned_npr: npr(r.returned_paisa),
        outstanding_paisa: money(r.outstanding_paisa), outstanding_npr: npr(r.outstanding_paisa),
        days_outstanding: r.days_outstanding,
      })),
      truncated: false,
    };
  }

  if (type === "accounts") {
    const rows = await listAccounts(db);
    return {
      headers: ["name", "type", "institution", "identifier_masked", "opening_paisa", "opening_npr", "balance_paisa", "balance_npr", "inflow_paisa", "inflow_npr", "outflow_paisa", "outflow_npr", "last_reconciled_at", "last_reconciled_balance_paisa"],
      records: rows.map((r) => ({
        name: r.name, type: r.type, institution: r.institution, identifier_masked: r.identifier_masked,
        opening_paisa: money(r.opening_balance_paisa), opening_npr: npr(r.opening_balance_paisa),
        balance_paisa: money(r.balance_paisa), balance_npr: npr(r.balance_paisa),
        inflow_paisa: money(r.inflow_paisa), inflow_npr: npr(r.inflow_paisa),
        outflow_paisa: money(r.outflow_paisa), outflow_npr: npr(r.outflow_paisa),
        last_reconciled_at: r.last_reconciled_at ? iso(r.last_reconciled_at) : null,
        last_reconciled_balance_paisa: r.last_reconciled_balance_paisa == null ? null : money(r.last_reconciled_balance_paisa),
      })),
      truncated: false,
    };
  }

  if (type === "audit") {
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT created_at, actor_name, action, entity_type, entity_id, summary, ip, before, after
         FROM audit_events
        WHERE created_at::date BETWEEN $1 AND $2
        ORDER BY created_at DESC LIMIT ${MAX_ROWS + 1}`,
      [period.from, period.to],
    );
    return {
      headers: ["created_at", "actor_name", "action", "entity_type", "entity_id", "summary", "ip"],
      records: rows.slice(0, MAX_ROWS).map((r) => ({ ...r, created_at: iso(r.created_at) })),
      truncated: rows.length > MAX_ROWS,
    };
  }

  if (type === "bank-lines") {
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT si.source_label, fa.name AS account_name, to_char(b.txn_date,'YYYY-MM-DD') AS txn_date,
              b.description, b.debit_paisa, b.credit_paisa, b.balance_paisa, b.match_status, b.external_ref,
              p.ref AS payment_ref
         FROM bank_statement_lines b
         JOIN statement_imports si ON si.id=b.statement_import_id
         JOIN financial_accounts fa ON fa.id=b.account_id
         LEFT JOIN payments p ON p.id=b.matched_payment_id
        WHERE b.txn_date BETWEEN $1 AND $2
        ORDER BY b.txn_date, b.description LIMIT ${MAX_ROWS + 1}`,
      [period.from, period.to],
    );
    return {
      headers: ["source_label", "account_name", "txn_date", "description", "debit_paisa", "debit_npr", "credit_paisa", "credit_npr", "balance_paisa", "balance_npr", "match_status", "external_ref", "payment_ref"],
      records: withAmounts(rows.slice(0, MAX_ROWS), ["debit_paisa", "credit_paisa", "balance_paisa"]),
      truncated: rows.length > MAX_ROWS,
    };
  }

  throw new Error(`Unknown export type: ${type as string}`);
}
