import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, money } from "@/server/db";
import {
  cashflow, documentationStats, journalTrialBalance, resolvePeriod, spendByCategory,
  spendByEvent, sponsorReport, budgetReport,
} from "@/server/reports";
import { listAdvances } from "@/server/advances";
import { listAccounts } from "@/server/accounts";
import { formatNPR } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState, ProgressBar } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { formatNPRShort } from "@/lib/money";

export const dynamic = "force-dynamic";

const REPORTS = [
  { key: "summary", label: "Statement" },
  { key: "trial-balance", label: "Trial balance" },
  { key: "cashflow", label: "Cash flow" },
  { key: "categories", label: "Categories" },
  { key: "events", label: "Events" },
  { key: "sponsors", label: "Sponsorship" },
  { key: "budgets", label: "Budgets" },
  { key: "advances", label: "Advances" },
  { key: "documentation", label: "Evidence" },
] as const;

const EXPORT_TYPE: Record<(typeof REPORTS)[number]["key"], string> = {
  summary: "journal",
  "trial-balance": "trial-balance",
  cashflow: "cashflow",
  categories: "categories",
  events: "events",
  sponsors: "sponsors",
  budgets: "budgets",
  advances: "advances",
  documentation: "claims",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; from?: string; to?: string }>;
}) {
  await requirePagePermission("report.view");
  const sp = await searchParams;
  const db = await getDb();
  const type = (REPORTS.some((r) => r.key === sp.type) ? sp.type : "summary") as (typeof REPORTS)[number]["key"];
  const period = await resolvePeriod(db, sp.from, sp.to);

  const [trial, flow, byCategory, byEvent, sponsors, budgets, advances, docs, accounts, missingDocs] = await Promise.all([
    journalTrialBalance(db, period),
    cashflow(db, period),
    spendByCategory(db, period),
    spendByEvent(db, period),
    sponsorReport(db),
    budgetReport(db),
    listAdvances(db),
    documentationStats(db),
    listAccounts(db),
    many<{ id: string; claim_no: string; amount_paisa: number; documentation_state: string; verification_state: string; claimant_name: string; date_ad: string; status: string }>(
      db,
      `SELECT c.id, c.claim_no, c.amount_paisa, c.documentation_state, c.verification_state, u.name AS claimant_name,
              to_char(c.date_ad,'YYYY-MM-DD') AS date_ad, c.status
         FROM expense_claims c JOIN users u ON u.id=c.claimant_user_id
        WHERE c.documentation_state <> 'COMPLETE'
          AND c.status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')
        ORDER BY c.amount_paisa DESC LIMIT 100`,
    ),
  ]);

  const assets = trial.filter((r) => r.account_code.startsWith("1"));
  const liabilities = trial.filter((r) => r.account_code.startsWith("2"));
  const income = trial.filter((r) => r.account_code.startsWith("3"));
  const expense = trial.filter((r) => r.account_code.startsWith("5"));
  const sumNet = (rows: typeof trial) => rows.reduce((s, r) => s + Number(r.debit_paisa) - Number(r.credit_paisa), 0);
  const totalDebit = trial.reduce((s, r) => s + Number(r.debit_paisa), 0);
  const totalCredit = trial.reduce((s, r) => s + Number(r.credit_paisa), 0);
  const assetsTotal = sumNet(assets);
  const liabilitiesTotal = -sumNet(liabilities);
  const incomeTotal = -sumNet(income);
  const expenseTotal = sumNet(expense);
  const surplus = incomeTotal - expenseTotal;
  const cashTotal = accounts.reduce((s, a) => s + money(a.balance_paisa), 0);
  const cashIn = flow.reduce((s, m) => s + Number(m.income), 0) - flow.reduce((s, m) => s + Number(m.advances), 0);
  const cashOut = flow.reduce((s, m) => s + Number(m.expenditure), 0);
  const hasData = trial.length > 0 || byCategory.length > 0;

  const href = (key: string) => {
    const q = new URLSearchParams({ type: key });
    if (sp.from && sp.to) { q.set("from", sp.from); q.set("to", sp.to); }
    return `/reports?${q.toString()}`;
  };
  const exportHref = (format: "csv" | "json") => {
    const q = new URLSearchParams({ from: period.from, to: period.to, format });
    return `/api/export/${EXPORT_TYPE[type]}?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Reports & statements"
        title="The numbers, with their limits"
        sub="Every figure below comes from posted journal entries or recorded payments. Verified and unverified amounts are never merged. Where evidence is missing, that is stated rather than smoothed over."
        actions={
          <>
            <PrintButton label="Print report" />
            <a className="btn no-print" href={exportHref("csv")}>CSV</a>
            <a className="btn no-print" href={exportHref("json")}>JSON</a>
          </>
        }
      />

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", justifyContent: "space-between" }}>
          <form method="get" className="no-print" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <input type="hidden" name="type" value={type} />
            <div className="field" style={{ minWidth: 150 }}>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={period.from} />
            </div>
            <div className="field" style={{ minWidth: 150 }}>
              <label className="label" htmlFor="to">To</label>
              <input id="to" name="to" type="date" defaultValue={period.to} />
            </div>
            <button type="submit" className="btn">Apply</button>
            {sp.from || sp.to ? <Link className="btn btn-ghost" href={href(type)}>Reset to fiscal year</Link> : null}
          </form>
          <div className="tiny muted" style={{ textAlign: "right" }}>
            <div><b>Reporting period</b></div>
            <div>{formatDateLong(period.from)} → {formatDateLong(period.to)}</div>
          </div>
        </div>
      </div>

      <div className="chip-row no-print" style={{ marginBottom: 20 }}>
        {REPORTS.map((r) => (
          <Link key={r.key} href={href(r.key)} className={`chip${type === r.key ? " active" : ""}`}>{r.label}</Link>
        ))}
      </div>

      {!hasData ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <EmptyState
            title="No posted entries in this period"
            text="Reports are built from the journal. Submit and approve a claim, record a payment, or import a verified opening balance to populate them."
            action={<Link className="btn btn-sm" href="/expenses/new">Record an expense</Link>}
          />
        </div>
      ) : null}

      {type === "summary" ? (
        <>
          <section className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="Income posted" value={formatNPRShort(incomeTotal)} foot="Sponsorship and other income" />
            <Stat label="Expenditure posted" value={formatNPRShort(expenseTotal)} foot="Approved claims, by category" />
            <Stat label="Surplus / (deficit)" value={formatNPRShort(surplus)} foot="Income minus expenditure" tone={surplus < 0 ? "danger" : "accent"} />
            <Stat label="Cash & bank balance" value={formatNPRShort(cashTotal)} foot={`${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${cashIn >= 0 ? "net inflow" : "net outflow"} ${formatNPR(Math.abs(cashIn - cashOut))}`} />
          </section>

          <div className="grid grid-2" style={{ marginBottom: 18 }}>
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="section-title">Income & expenditure</div>
                  <div className="section-sub">Accrual view from posted journal entries for the period.</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Account</th><th className="right">Amount</th></tr></thead>
                  <tbody>
                    <tr><td colSpan={2} className="tiny muted uppercase">Income</td></tr>
                    {income.length ? income.map((r) => (
                      <tr key={r.account_code}><td>{r.account_name} <span className="tiny faint mono">{r.account_code}</span></td><td className="right mono">{formatNPR(-(Number(r.debit_paisa) - Number(r.credit_paisa)))}</td></tr>
                    )) : <tr><td colSpan={2} className="muted small">No income posted yet.</td></tr>}
                    <tr><td><b>Total income</b></td><td className="right mono"><b>{formatNPR(incomeTotal)}</b></td></tr>
                    <tr><td colSpan={2} className="tiny muted uppercase">Expenditure</td></tr>
                    {expense.length ? expense.map((r) => (
                      <tr key={r.account_code}><td>{r.account_name} <span className="tiny faint mono">{r.account_code}</span></td><td className="right mono">{formatNPR(Number(r.debit_paisa) - Number(r.credit_paisa))}</td></tr>
                    )) : <tr><td colSpan={2} className="muted small">No expenditure posted yet.</td></tr>}
                    <tr><td><b>Total expenditure</b></td><td className="right mono"><b>{formatNPR(expenseTotal)}</b></td></tr>
                    <tr><td><b>Surplus / (deficit)</b></td><td className="right mono" style={{ color: surplus < 0 ? "var(--danger)" : "var(--accent)" }}><b>{formatNPR(surplus)}</b></td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <div className="section-title">Balance sheet</div>
                  <div className="section-sub">Assets, liabilities and the accumulated result. Opening balances are not invented.</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Account</th><th className="right">Balance</th></tr></thead>
                  <tbody>
                    <tr><td colSpan={2} className="tiny muted uppercase">Assets</td></tr>
                    {assets.length ? assets.map((r) => (
                      <tr key={r.account_code}><td>{r.account_name} <span className="tiny faint mono">{r.account_code}</span></td><td className="right mono">{formatNPR(Number(r.debit_paisa) - Number(r.credit_paisa))}</td></tr>
                    )) : <tr><td colSpan={2} className="muted small">No asset entries.</td></tr>}
                    <tr><td><b>Total assets</b></td><td className="right mono"><b>{formatNPR(assetsTotal)}</b></td></tr>
                    <tr><td colSpan={2} className="tiny muted uppercase">Liabilities</td></tr>
                    {liabilities.length ? liabilities.map((r) => (
                      <tr key={r.account_code}><td>{r.account_name} <span className="tiny faint mono">{r.account_code}</span></td><td className="right mono">{formatNPR(-(Number(r.debit_paisa) - Number(r.credit_paisa)))}</td></tr>
                    )) : <tr><td colSpan={2} className="muted small">No liability entries.</td></tr>}
                    <tr><td><b>Total liabilities</b></td><td className="right mono"><b>{formatNPR(liabilitiesTotal)}</b></td></tr>
                    <tr><td><b>Accumulated surplus / (deficit)</b></td><td className="right mono"><b>{formatNPR(surplus)}</b></td></tr>
                  </tbody>
                </table>
              </div>
              <div className="card-foot">
                <div className="tiny muted">
                  Debits {formatNPR(totalDebit)} · credits {formatNPR(totalCredit)} ·{" "}
                  {totalDebit === totalCredit ? <span style={{ color: "var(--accent)" }}>journal balances</span> : <span style={{ color: "var(--danger)" }}>JOURNAL DOES NOT BALANCE — investigate before using these figures</span>}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="section-title">Monthly cash flow</div>
                <div className="section-sub">Cash basis, from recorded payments only. Internal transfers are excluded.</div>
              </div>
            </div>
            <div className="table-wrap">
              {flow.length ? (
                <table className="data">
                  <thead><tr><th>Month</th><th className="right">Income</th><th className="right">Expenditure</th><th className="right">Advance movement</th><th className="right">Net cash</th></tr></thead>
                  <tbody>
                    {flow.map((m) => {
                      const net = Number(m.income) - Number(m.expenditure) - Number(m.advances);
                      return (
                        <tr key={m.month}>
                          <td className="mono">{m.month}</td>
                          <td className="right mono">{formatNPR(Number(m.income))}</td>
                          <td className="right mono">{formatNPR(Number(m.expenditure))}</td>
                          <td className="right mono">{formatNPR(Number(m.advances))}</td>
                          <td className="right mono" style={{ color: net < 0 ? "var(--danger)" : "var(--accent)" }}>{formatNPR(net)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : <div className="table-empty">No recorded payments in this period.</div>}
            </div>
          </div>
        </>
      ) : null}

      {type === "trial-balance" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Trial balance</div>
              <div className="section-sub">All posted accounts for the period. Positive balances are debits unless the account is income or a liability.</div>
            </div>
            <span className={`badge ${totalDebit === totalCredit ? "badge-green" : "badge-red"}`}>
              {totalDebit === totalCredit ? "Balanced" : "Out of balance"}
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Code</th><th>Account</th><th className="right">Debit</th><th className="right">Credit</th><th className="right">Net</th></tr></thead>
              <tbody>
                {trial.map((r) => (
                  <tr key={r.account_code}>
                    <td className="mono">{r.account_code}</td>
                    <td>{r.account_name}</td>
                    <td className="right mono">{formatNPR(Number(r.debit_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(r.credit_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(r.debit_paisa) - Number(r.credit_paisa))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}><b>Total</b></td>
                  <td className="right mono"><b>{formatNPR(totalDebit)}</b></td>
                  <td className="right mono"><b>{formatNPR(totalCredit)}</b></td>
                  <td className="right mono"><b>{formatNPR(totalDebit - totalCredit)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {type === "cashflow" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Cash flow by month</div>
              <div className="section-sub">Recorded payments only. A negative advance movement means funds were returned.</div>
            </div>
          </div>
          <div className="table-wrap">
            {flow.length ? (
              <table className="data">
                <thead><tr><th>Month</th><th className="right">Income</th><th className="right">Expenditure</th><th className="right">Advances</th><th className="right">Net</th></tr></thead>
                <tbody>
                  {flow.map((m) => {
                    const net = Number(m.income) - Number(m.expenditure) - Number(m.advances);
                    return (
                      <tr key={m.month}>
                        <td className="mono">{m.month}</td>
                        <td className="right mono">{formatNPR(Number(m.income))}</td>
                        <td className="right mono">{formatNPR(Number(m.expenditure))}</td>
                        <td className="right mono">{formatNPR(Number(m.advances))}</td>
                        <td className="right mono">{formatNPR(net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <div className="table-empty">No recorded payments in this period.</div>}
          </div>
        </div>
      ) : null}

      {type === "categories" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Spend by category</div>
              <div className="section-sub">Verified share is shown separately. A category with unverified spend is not presented as fully evidenced.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Category</th><th className="right">Claims</th><th className="right">Total</th><th className="right">Verified</th><th style={{ minWidth: 140 }}>Verified share</th></tr></thead>
              <tbody>
                {byCategory.map((r) => {
                  const total = Number(r.amount_paisa);
                  const verified = Number(r.verified_paisa);
                  return (
                    <tr key={r.code}>
                      <td><div className="row-title">{r.name}</div><div className="row-sub mono">{r.code}</div></td>
                      <td className="right mono">{r.count}</td>
                      <td className="right mono">{formatNPR(total)}</td>
                      <td className="right mono">{formatNPR(verified)}</td>
                      <td><ProgressBar value={total ? verified / total : 0} label={`${Math.round(total ? (verified / total) * 100 : 0)}% verified`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {type === "events" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Spend by event</div>
              <div className="section-sub">Allocation lines determine the event split, so a split claim appears under each event.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Event</th><th className="right">Claims</th><th className="right">Allocated</th><th className="right">Verified</th></tr></thead>
              <tbody>
                {byEvent.map((r) => (
                  <tr key={r.event_id ?? r.name}>
                    <td>{r.event_id ? <Link className="link-quiet" href={`/events/${r.event_id}`}>{r.name}</Link> : <span className="muted">{r.name}</span>}</td>
                    <td className="right mono">{r.count}</td>
                    <td className="right mono">{formatNPR(Number(r.amount_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(r.verified_paisa))}</td>
                  </tr>
                ))}
                {!byEvent.length ? <tr><td colSpan={4} className="muted small">No allocations in this period.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {type === "sponsors" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Sponsorship pipeline</div>
              <div className="section-sub">Promised, received and outstanding are kept distinct. In-kind support is never counted as cash.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Agreement</th><th>Sponsor</th><th>State</th><th className="right">Promised</th><th className="right">Received</th><th className="right">Outstanding</th><th>Event</th></tr></thead>
              <tbody>
                {sponsors.map((s) => (
                  <tr key={s.ref}>
                    <td className="mono">{s.ref}</td>
                    <td>{s.sponsor}{s.in_kind ? <span className="badge badge-gray" style={{ marginLeft: 6 }}>in kind</span> : null}</td>
                    <td><StatusBadge status={s.state} /></td>
                    <td className="right mono">{formatNPR(Number(s.promised_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(s.received_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(s.outstanding_paisa))}</td>
                    <td className="small">{s.event_name ?? "—"}</td>
                  </tr>
                ))}
                {!sponsors.length ? <tr><td colSpan={7} className="muted small">No sponsorship agreements recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {type === "budgets" ? (
        <div className="grid" style={{ gap: 14 }}>
          {budgets.length ? budgets.map((b) => (
            <div className="card" key={b.id}>
              <div className="card-head">
                <div>
                  <div className="section-title">{b.name}</div>
                  <div className="section-sub">{b.scope} · FY {b.fiscal_year}{b.event_name ? ` · ${b.event_name}` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <StatusBadge status={b.status} />
                  <span className="badge badge-gray">{Math.round(b.utilisation * 100)}% used</span>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Category</th><th className="right">Budget</th><th className="right">Incurred</th><th className="right">Paid</th><th className="right">Variance</th><th style={{ minWidth: 120 }}>Use</th></tr></thead>
                  <tbody>
                    {b.lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.category_name}</td>
                        <td className="right mono">{formatNPR(Number(l.amount_paisa))}</td>
                        <td className="right mono">{formatNPR(Number(l.incurred_paisa))}</td>
                        <td className="right mono">{formatNPR(Number(l.paid_paisa))}</td>
                        <td className="right mono" style={{ color: Number(l.variance_paisa) < 0 ? "var(--danger)" : undefined }}>{formatNPR(Number(l.variance_paisa))}</td>
                        <td><ProgressBar value={l.utilisation} label={l.utilisation > 1 ? "Over budget" : `${Math.round(l.utilisation * 100)}%`} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )) : (
            <div className="card"><EmptyState title="No budgets" text="Create a budget on an event or at organisation level to compare planned and actual spend." action={<Link className="btn btn-sm" href="/events">Open events</Link>} /></div>
          )}
        </div>
      ) : null}

      {type === "advances" ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Advances & settlements</div>
              <div className="section-sub">Outstanding is the part of an advance not yet accounted for by a claim or a returned amount.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Ref</th><th>Member</th><th>Purpose</th><th className="right">Issued</th><th className="right">Used</th><th className="right">Returned</th><th className="right">Outstanding</th><th className="right">Days</th><th>Status</th></tr></thead>
              <tbody>
                {advances.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.ref}</td>
                    <td>{a.member_name}</td>
                    <td className="small">{a.purpose}</td>
                    <td className="right mono">{formatNPR(Number(a.amount_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.used_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.returned_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.outstanding_paisa))}</td>
                    <td className="right mono" style={{ color: a.days_outstanding > 30 && Number(a.outstanding_paisa) > 0 ? "var(--danger)" : undefined }}>{a.days_outstanding}</td>
                    <td><StatusBadge status={a.status} /></td>
                  </tr>
                ))}
                {!advances.length ? <tr><td colSpan={9} className="muted small">No advances recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {type === "documentation" ? (
        <>
          <section className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="Evidence complete" value={docs.complete} foot="Receipt or acceptable declaration attached" tone="accent" />
            <Stat label="Missing, declared" value={docs.declared} foot="A written gap explanation exists" />
            <Stat label="Missing, undeclared" value={docs.undeclared} foot="Cannot be verified until resolved" tone="danger" />
            <Stat label="Disputed" value={docs.disputed} foot="Under investigation" tone={docs.disputed ? "warn" : undefined} />
          </section>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="section-title">Claims missing evidence</div>
                <div className="section-sub">These amounts remain unverified even where they have been paid.</div>
              </div>
              <span className="badge badge-amber">{missingDocs.length}</span>
            </div>
            <div className="table-wrap">
              {missingDocs.length ? (
                <table className="data">
                  <thead><tr><th>Claim</th><th>Claimant</th><th>Date</th><th className="right">Amount</th><th>Documentation</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {missingDocs.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.claim_no}</td>
                        <td className="small">{c.claimant_name}</td>
                        <td className="small nowrap">{formatDateLong(c.date_ad)}</td>
                        <td className="right mono">{formatNPR(Number(c.amount_paisa))}</td>
                        <td><StatusBadge status={c.documentation_state} /></td>
                        <td><StatusBadge status={c.status} /></td>
                        <td className="right"><Link className="btn btn-xs" href={`/expenses/${c.id}`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">Every counted claim has complete evidence.</div>}
            </div>
          </div>
        </>
      ) : null}

      <div className="info-box" style={{ marginTop: 18 }}>
        Exports are generated from the same queries as this page. Amounts are exported as integer paisa alongside a decimal
        NPR string so no rounding is introduced by a spreadsheet. Synthetic rows are marked in exports.
      </div>
    </>
  );
}
