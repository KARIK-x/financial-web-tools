import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb, many, one } from "@/server/db";
import { listBudgets } from "@/server/budgets";
import { formatNPR } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge, DefRow, ProgressBar, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { reviseBudgetAction } from "@/app/actions/budgets";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();

  const event = await one<{
    id: string; name: string; code: string; starts_on: string | null; ends_on: string | null; status: string;
    notes: string | null; owner_name: string | null;
  }>(
    db,
    `SELECT e.id, e.name, e.code, to_char(e.starts_on,'YYYY-MM-DD') AS starts_on, to_char(e.ends_on,'YYYY-MM-DD') AS ends_on,
            e.status, e.notes, m.name AS owner_name
       FROM events e LEFT JOIN members m ON m.id=e.owner_member_id WHERE e.id=$1`,
    [id],
  );
  if (!event) notFound();

  const [budgets, claims, sponsors, byCategory] = await Promise.all([
    listBudgets(db, { eventId: id }),
    many<{ id: string; claim_no: string; date_ad: string; amount_paisa: number; status: string; category_name: string; claimant_name: string; description: string }>(
      db,
      `SELECT c.id, c.claim_no, to_char(c.date_ad,'YYYY-MM-DD') AS date_ad, a.amount_paisa, c.status,
              cat.name AS category_name, u.name AS claimant_name, c.description
         FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
         JOIN expense_categories cat ON cat.id=c.category_id JOIN users u ON u.id=c.claimant_user_id
        WHERE a.event_id=$1 AND c.status NOT IN ('DRAFT','WITHDRAWN','REJECTED')
        ORDER BY c.date_ad DESC`,
      [id],
    ),
    many<{ id: string; ref: string; sponsor_name: string; state: string; promised_paisa: number; in_kind: boolean }>(
      db,
      `SELECT a.id, a.ref, s.name AS sponsor_name, a.state, a.promised_paisa, a.in_kind
         FROM sponsorship_agreements a JOIN sponsors s ON s.id=a.sponsor_id WHERE a.event_id=$1 ORDER BY a.promised_paisa DESC`,
      [id],
    ),
    many<{ name: string; amount_paisa: number }>(
      db,
      `SELECT cat.name, SUM(a.amount_paisa) AS amount_paisa
         FROM expense_allocations a JOIN expense_claims c ON c.id=a.claim_id
         JOIN expense_categories cat ON cat.id=c.category_id
        WHERE a.event_id=$1 AND c.status IN ('APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED')
        GROUP BY cat.name ORDER BY amount_paisa DESC`,
      [id],
    ),
  ]);

  const manages = can(user.role, "budget.manage", user.permissions);
  const approvedSpend = claims
    .filter((c) => ["APPROVED", "PAYMENT_PENDING", "REIMBURSED", "SETTLED", "VERIFIED", "RECONCILED"].includes(c.status))
    .reduce((s, c) => s + Number(c.amount_paisa), 0);
  const budgetTotal = budgets.reduce((s, b) => s + b.total_paisa, 0);

  return (
    <>
      <PageHeader
        eyebrow={`Event · ${event.code}`}
        title={event.name}
        sub={<>{event.starts_on ? formatDateLong(event.starts_on) : "No start date"}{event.ends_on ? ` → ${formatDateLong(event.ends_on)}` : ""}{event.owner_name ? ` · led by ${event.owner_name}` : ""}</>}
        actions={<><Link className="btn" href="/events">All events</Link><StatusBadge status={event.status} /></>}
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Approved spend" value={formatNPR(approvedSpend)} foot="Incurred, not necessarily paid" tone="accent" />
        <Stat label="Budget" value={formatNPR(budgetTotal)} foot={`${budgets.length} budget${budgets.length === 1 ? "" : "s"}`} />
        <Stat label="Variance" value={formatNPR(budgetTotal - approvedSpend)} foot={approvedSpend > budgetTotal ? "Over budget" : "Remaining"} tone={approvedSpend > budgetTotal ? "danger" : undefined} />
        <Stat label="Claims" value={claims.length} foot="Excluding drafts and rejected" />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.55fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Budget lines</div></div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              {budgets.length ? budgets.flatMap((b) => b.lines.map((line) => (
                <div key={line.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div>
                      <div className="small" style={{ fontWeight: 600 }}>{line.category_name}</div>
                      <div className="tiny muted">{b.name} · FY {b.fiscal_year}</div>
                    </div>
                    <div className="num small">{formatNPR(line.incurred_paisa)} / {formatNPR(line.amount_paisa)}</div>
                  </div>
                  <ProgressBar value={line.utilisation} />
                  {manages ? (
                    <details style={{ marginTop: 6 }}>
                      <summary className="link tiny" style={{ cursor: "pointer" }}>Revise budget line</summary>
                      <div style={{ marginTop: 8 }}>
                        <ActionForm action={reviseBudgetAction} submitLabel="Revise" submitClass="btn btn-sm" hideStatus>
                          <input type="hidden" name="lineId" value={line.id} />
                          <div style={{ display: "flex", gap: 8 }}>
                            <input name="amount" inputMode="decimal" defaultValue={(line.amount_paisa / 100).toFixed(2)} />
                            <input name="reason" placeholder="Reason for revision" required />
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                  ) : null}
                </div>
              ))) : <div className="tiny muted">No budget is set for this event.</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Claims charged to this event</div><span className="tiny muted">{claims.length}</span></div>
            <div className="table-wrap">
              {claims.length ? (
                <table className="data">
                  <thead><tr><th>Claim</th><th>Claimant</th><th>Category</th><th>Date</th><th className="right">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="link" href={`/expenses/${c.id}`}>{c.claim_no}</Link><div className="row-sub">{c.description}</div></td>
                        <td>{c.claimant_name}</td>
                        <td>{c.category_name}</td>
                        <td className="nowrap muted">{formatDateLong(c.date_ad)}</td>
                        <td className="right mono">{formatNPR(Number(c.amount_paisa))}</td>
                        <td><StatusBadge status={c.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <EmptyState title="No spending charged to this event" text="Claims allocated to this event will appear here with their status." />}
            </div>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Event record</div></div>
            <div className="card-body">
              <dl className="kv">
                <DefRow label="Code">{event.code}</DefRow>
                <DefRow label="Status"><StatusBadge status={event.status} /></DefRow>
                <DefRow label="Starts">{event.starts_on ? formatDateLong(event.starts_on) : "—"}</DefRow>
                <DefRow label="Ends">{event.ends_on ? formatDateLong(event.ends_on) : "—"}</DefRow>
                <DefRow label="Owner">{event.owner_name ?? "—"}</DefRow>
                <DefRow label="Notes">{event.notes ?? "—"}</DefRow>
              </dl>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Spend by category</div></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {byCategory.length ? byCategory.map((c) => (
                <div className="list-row" key={c.name} style={{ alignItems: "center" }}>
                  <div style={{ flex: 1 }} className="small">{c.name}</div>
                  <div className="num small">{formatNPR(Number(c.amount_paisa))}</div>
                </div>
              )) : <div className="tiny muted" style={{ padding: "12px 0" }}>No approved spending yet.</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Sponsors</div><Link className="link small" href="/sponsors">All</Link></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {sponsors.length ? sponsors.map((s) => (
                <div className="list-row" key={s.id} style={{ alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <Link className="small link-quiet" href={`/sponsors/${s.id}`}>{s.sponsor_name}</Link>
                    <div className="tiny muted">{s.ref} · {s.state.toLowerCase()}</div>
                  </div>
                  <span className="small num">{s.in_kind ? "In-kind" : formatNPR(Number(s.promised_paisa))}</span>
                </div>
              )) : <div className="tiny muted" style={{ padding: "12px 0" }}>No sponsors linked to this event.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
