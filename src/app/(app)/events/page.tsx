import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { listBudgets } from "@/server/budgets";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { fiscalYearBsFor, formatDateLong, todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge, ProgressBar, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { BudgetLines } from "@/components/BudgetLines";
import { createBudgetAction, createEventAction } from "@/app/actions/budgets";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const user = await requireUser();
  const db = await getDb();
  const manages = can(user.role, "budget.manage", user.permissions);

  const [events, budgets, categories] = await Promise.all([
    many<{ id: string; name: string; code: string; starts_on: string | null; ends_on: string | null; status: string; spend: number; claims: number }>(
      db,
      `SELECT e.id, e.name, e.code, to_char(e.starts_on,'YYYY-MM-DD') AS starts_on, to_char(e.ends_on,'YYYY-MM-DD') AS ends_on,
              e.status,
              COALESCE((SELECT SUM(a.amount_paisa) FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
                WHERE a.event_id=e.id AND c.status IN ('APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED')),0) AS spend,
              (SELECT COUNT(DISTINCT c.id) FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
                WHERE a.event_id=e.id AND c.status NOT IN ('DRAFT','WITHDRAWN','REJECTED')) AS claims
         FROM events e ORDER BY e.starts_on DESC NULLS LAST, e.name`,
    ),
    listBudgets(db),
    many<{ id: string; name: string; group_name: string }>(db, `SELECT id, name, group_name FROM expense_categories WHERE is_active ORDER BY sort_order`),
  ]);

  const nowFy = fiscalYearBsFor(todayISO());
  const totalBudget = budgets.reduce((s, b) => s + b.total_paisa, 0);
  const totalIncurred = budgets.reduce((s, b) => s + b.incurred_paisa, 0);

  return (
    <>
      <PageHeader
        eyebrow="Programme finance"
        title="Events & budgets"
        sub="Budgets are limits, not spending. Incurred means an approved claim, whether or not it has been paid. Overspend stays visible instead of being hidden by a revision."
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Events" value={events.length} foot={`${events.filter((e) => e.status === "ACTIVE").length} active`} />
        <Stat label="Budgeted" value={formatNPRShort(totalBudget)} foot={`${budgets.length} budget${budgets.length === 1 ? "" : "s"}`} />
        <Stat label="Incurred" value={formatNPRShort(totalIncurred)} foot="Approved claims against budgets" tone="accent" />
        <Stat label="Remaining" value={formatNPRShort(Math.max(0, totalBudget - totalIncurred))} foot={totalIncurred > totalBudget ? "Over budget" : "Within budget"} tone={totalIncurred > totalBudget ? "danger" : undefined} />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Events</div><span className="tiny muted">Spend counts approved claims only</span></div>
            <div className="table-wrap">
              {events.length ? (
                <table className="data">
                  <thead><tr><th>Event</th><th>Dates</th><th>Status</th><th className="right">Claims</th><th className="right">Approved spend</th></tr></thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td><Link className="row-title link-quiet" href={`/events/${e.id}`}>{e.name}</Link><div className="row-sub mono">{e.code}</div></td>
                        <td className="muted nowrap">{e.starts_on ? formatDateLong(e.starts_on) : "—"}{e.ends_on ? ` → ${formatDateLong(e.ends_on)}` : ""}</td>
                        <td><StatusBadge status={e.status} /></td>
                        <td className="right muted">{e.claims}</td>
                        <td className="right mono">{formatNPR(Number(e.spend))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <EmptyState title="No events yet" text="Create an event to group spending and set a budget. Spending can still be recorded without an event, but it cannot be analysed by event." />}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Budgets</div><span className="tiny muted">{budgets.length}</span></div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              {budgets.length ? budgets.map((b) => (
                <div key={b.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                    <div>
                      <div className="small" style={{ fontWeight: 600 }}>{b.name}</div>
                      <div className="tiny muted">{b.scope.toLowerCase()}{b.event_name ? ` · ${b.event_name}` : ""} · FY {b.fiscal_year} · {b.lines.length} lines</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="num small">{formatNPR(b.incurred_paisa)} / {formatNPR(b.total_paisa)}</div>
                      <div className="tiny muted">{b.variance_paisa < 0 ? `Over by ${formatNPR(Math.abs(b.variance_paisa))}` : `${formatNPR(b.variance_paisa)} left`}</div>
                    </div>
                  </div>
                  <ProgressBar value={b.utilisation} />
                  {b.lines.length ? (
                    <div className="tiny muted" style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {b.lines.map((l) => <span key={l.id}>{l.category_name}: {formatNPR(l.incurred_paisa)} / {formatNPR(l.amount_paisa)}</span>)}
                    </div>
                  ) : null}
                </div>
              )) : <div className="tiny muted">No budgets have been set.</div>}
            </div>
          </div>
        </div>

        {manages ? (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="card">
              <div className="card-head"><div className="section-title">Create event</div></div>
              <div className="card-body">
                <ActionForm action={createEventAction} submitLabel="Create event" resetOnSuccess>
                  <div className="grid" style={{ gap: 10 }}>
                    <div className="field"><label className="label">Name</label><input name="name" required placeholder="e.g. Hackfest 2026" /></div>
                    <div className="field"><label className="label">Code</label><input name="code" required placeholder="HACK26" maxLength={16} /><span className="hint">Uppercase letters, digits, dash.</span></div>
                    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div className="field"><label className="label">Starts</label><input name="startsOn" type="date" /></div>
                      <div className="field"><label className="label">Ends</label><input name="endsOn" type="date" /></div>
                    </div>
                    <div className="field">
                      <label className="label">Status</label>
                      <select name="status" defaultValue="PLANNED">{["PLANNED", "ACTIVE", "COMPLETED", "ARCHIVED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select>
                    </div>
                    <div className="field"><label className="label">Notes</label><textarea name="notes" /></div>
                  </div>
                </ActionForm>
              </div>
            </div>

            <div className="card">
              <div className="card-head"><div className="section-title">Create budget</div></div>
              <div className="card-body">
                <ActionForm action={createBudgetAction} submitLabel="Create budget">
                  <div className="grid" style={{ gap: 10 }}>
                    <div className="field"><label className="label">Name</label><input name="name" required placeholder="e.g. Hackfest 2026 core budget" /></div>
                    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div className="field">
                        <label className="label">Scope</label>
                        <select name="scope" defaultValue="EVENT">
                          <option value="EVENT">Event</option>
                          <option value="DEPARTMENT">Department</option>
                          <option value="ORG">Organisation</option>
                        </select>
                      </div>
                      <div className="field"><label className="label">Fiscal year</label><input name="fiscalYear" defaultValue={nowFy} placeholder="2082/83" /></div>
                    </div>
                    <div className="field">
                      <label className="label">Event (for event budgets)</label>
                      <select name="eventId" defaultValue="">
                        <option value="">—</option>
                        {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label className="label">Lines</label>
                      <BudgetLines categories={categories} />
                    </div>
                  </div>
                </ActionForm>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
