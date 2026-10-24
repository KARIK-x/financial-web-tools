import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { advanceAging, listAdvances } from "@/server/advances";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong, todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { createAdvanceAction } from "@/app/actions/advances";

export const dynamic = "force-dynamic";

export default async function AdvancesPage() {
  const user = await requireUser();
  const db = await getDb();
  const manages = can(user.role, "advance.manage", user.permissions);

  const [advances, members, events] = await Promise.all([
    listAdvances(db, manages ? {} : { memberId: user.memberId ?? "__none__" }),
    manages
      ? many<{ id: string; name: string }>(db, `SELECT id, name FROM members WHERE is_active ORDER BY name`)
      : Promise.resolve([]),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM events WHERE status <> 'ARCHIVED' ORDER BY starts_on DESC NULLS LAST`),
  ]);

  const aging = advanceAging(advances);
  const open = advances.filter((a) => ["OUTSTANDING", "PARTIALLY_SETTLED"].includes(a.status));

  return (
    <>
      <PageHeader
        eyebrow="Cash advances"
        title="Advances"
        sub="Money given to a member before spending. An advance is not an expense: it becomes an expense only when a claim is approved against it or the unused balance is returned."
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Outstanding" value={formatNPRShort(aging.outstanding)} foot={`${aging.count} open advance${aging.count === 1 ? "" : "s"}`} tone="accent" />
        <Stat label="Over 30 days" value={aging.over30.length} foot="Should be followed up" tone={aging.over30.length ? "warn" : undefined} />
        <Stat label="Total issued" value={formatNPRShort(advances.reduce((s, a) => s + Number(a.amount_paisa), 0))} foot={`${advances.length} advances recorded`} />
        <Stat label="Settled" value={advances.filter((a) => a.status === "SETTLED").length} foot="Fully accounted for" />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head"><div className="section-title">All advances</div><span className="tiny muted">{advances.length}</span></div>
          <div className="table-wrap">
            {advances.length ? (
              <table className="data">
                <thead><tr><th>Reference</th><th>Member</th><th>Purpose</th><th className="right">Advance</th><th className="right">Outstanding</th><th>Days</th><th>Status</th></tr></thead>
                <tbody>
                  {advances.map((a) => (
                    <tr key={a.id}>
                      <td><Link className="mono link-quiet" href={`/advances/${a.id}`}>{a.ref}</Link><div className="row-sub">{a.disbursed_on ? formatDateLong(a.disbursed_on) : "Not disbursed"}</div></td>
                      <td>{a.member_name}</td>
                      <td style={{ maxWidth: 220 }}>{a.purpose}</td>
                      <td className="right mono">{formatNPR(Number(a.amount_paisa))}</td>
                      <td className="right mono">{formatNPR(Number(a.outstanding_paisa))}</td>
                      <td>{open.includes(a) ? <span className={a.days_outstanding > 30 ? "badge badge-red" : "muted"}>{a.days_outstanding}d</span> : "—"}</td>
                      <td><StatusBadge status={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No advances recorded" text="Request an advance when a member needs cash before a purchase. It must be disbursed from a real account before spending it." />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="section-title">Request an advance</div></div>
          <div className="card-body">
            <ActionForm action={createAdvanceAction} submitLabel="Request advance">
              {manages ? (
                <div className="field" style={{ marginBottom: 10 }}>
                  <label className="label" htmlFor="memberId">Member</label>
                  <select id="memberId" name="memberId" required defaultValue={user.memberId ?? ""}>
                    <option value="" disabled>Select a member</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              ) : (
                <input type="hidden" name="memberId" value={user.memberId ?? ""} />
              )}
              <div className="field" style={{ marginBottom: 10 }}>
                <label className="label" htmlFor="purpose">Purpose</label>
                <input id="purpose" name="purpose" required minLength={3} placeholder="e.g. Venue deposit for Hackfest" />
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label className="label" htmlFor="amount">Amount (NPR)</label>
                <input id="amount" name="amount" required inputMode="decimal" placeholder="e.g. 15,000" />
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label className="label" htmlFor="eventId">Event</label>
                <select id="eventId" name="eventId" defaultValue="">
                  <option value="">No event</option>
                  {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label className="label" htmlFor="dueOn">Settle by</label>
                <input id="dueOn" name="dueOn" type="date" min={todayISO()} />
              </div>
              <div className="field">
                <label className="label" htmlFor="notes">Notes</label>
                <textarea id="notes" name="notes" />
              </div>
            </ActionForm>
          </div>
        </div>
      </div>
    </>
  );
}
