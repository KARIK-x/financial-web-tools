import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { listAgreements, sponsorshipSummary } from "@/server/sponsors";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge, EmptyState, SourceTag } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { createSponsorshipAction } from "@/app/actions/sponsors";
import { Handshake } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SponsorsPage() {
  const user = await requireUser();
  const db = await getDb();
  const [agreements, summary, events] = await Promise.all([
    listAgreements(db),
    sponsorshipSummary(db),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM events WHERE status <> 'ARCHIVED' ORDER BY starts_on DESC NULLS LAST`),
  ]);
  const manages = can(user.role, "sponsor.manage", user.permissions);

  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Sponsorships"
        sub="Commitments are not income. Cash is recognised only when a receipt is actually recorded against an agreement; in-kind support is tracked separately and never counted as cash."
        actions={<span className="badge badge-gray">{agreements.length} agreements</span>}
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Committed" value={formatNPRShort(summary.committed)} foot="Cash agreements past negotiation" tone="accent" />
        <Stat label="Received" value={formatNPRShort(summary.received)} foot="Recorded receipts only" />
        <Stat label="Outstanding" value={formatNPRShort(summary.outstanding)} foot="Promised but not received" tone={summary.outstanding > 0 ? "warn" : undefined} />
        <Stat label="Pipeline / in-kind" value={`${summary.pipelineCount} / ${summary.inKindCount}`} foot="Leads, proposals and non-cash support" />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head"><div className="section-title">Agreements</div><span className="tiny muted">Newest first</span></div>
          <div className="table-wrap">
            {agreements.length ? (
              <table className="data">
                <thead><tr><th>Reference</th><th>Sponsor</th><th>Event</th><th>State</th><th className="right">Promised</th><th className="right">Received</th><th className="right">Outstanding</th><th>Deliverables</th></tr></thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id}>
                      <td><Link className="mono link-quiet" href={`/sponsors/${a.id}`}>{a.ref}</Link><div className="row-sub">{a.signed_on ? formatDateLong(a.signed_on) : "Unsigned"} <SourceTag synthetic={a.is_synthetic} /></div></td>
                      <td>{a.sponsor_name}<div className="row-sub">{a.title}</div></td>
                      <td className="muted">{a.event_name ?? "—"}</td>
                      <td><StatusBadge status={a.state} />{a.in_kind ? <div className="row-sub">In-kind</div> : null}</td>
                      <td className="right mono">{a.in_kind ? "—" : formatNPR(Number(a.promised_paisa))}</td>
                      <td className="right mono">{formatNPR(Number(a.received_paisa))}</td>
                      <td className="right mono">{a.in_kind ? "—" : formatNPR(Number(a.outstanding_paisa))}</td>
                      <td>{a.pending_deliverables ? <span className="badge badge-amber">{a.pending_deliverables} pending</span> : <span className="tiny muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState
                title="No sponsorship agreements recorded"
                text="Create an agreement when a sponsor commits. Do not enter a receipt until money actually reaches a LOCUS account."
              />
            )}
          </div>
        </div>

        {manages ? (
          <div className="card">
            <div className="card-head"><div className="section-title">New agreement</div><Handshake size={15} className="muted" /></div>
            <div className="card-body">
              <ActionForm action={createSponsorshipAction} submitLabel="Create agreement">
                <div className="grid" style={{ gap: 10 }}>
                  <div className="field"><label className="label" htmlFor="sponsorName">Sponsor</label><input id="sponsorName" name="sponsorName" required placeholder="Company or individual" /></div>
                  <div className="field"><label className="label" htmlFor="title">Agreement title</label><input id="title" name="title" required placeholder="e.g. Title sponsor — Hackfest 2026" /></div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div className="field">
                      <label className="label" htmlFor="packageTier">Package</label>
                      <input id="packageTier" name="packageTier" placeholder="Title / Gold / Partner" />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="state">State</label>
                      <select id="state" name="state" defaultValue="LEAD">
                        {["LEAD", "PROPOSED", "NEGOTIATING", "COMMITTED", "INVOICED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="field"><label className="label" htmlFor="promised">Cash commitment (NPR)</label><input id="promised" name="promised" inputMode="decimal" placeholder="0 for in-kind" defaultValue="0" /></div>
                  <label className="check">
                    <input type="checkbox" name="inKind" />
                    <span>This is an in-kind contribution (goods or services, not cash).</span>
                  </label>
                  <div className="field"><label className="label" htmlFor="inKindDescription">In-kind description</label><input id="inKindDescription" name="inKindDescription" placeholder="e.g. 50 event t-shirts" /></div>
                  <div className="field"><label className="label" htmlFor="inKindValue">Estimated in-kind value (NPR)</label><input id="inKindValue" name="inKindValue" inputMode="decimal" placeholder="Optional, for reporting only" /></div>
                  <div className="field"><label className="label" htmlFor="eventId">Event</label>
                    <select id="eventId" name="eventId" defaultValue=""><option value="">No event</option>{events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                  </div>
                  <div className="field"><label className="label" htmlFor="signedOn">Signed on</label><input id="signedOn" name="signedOn" type="date" /></div>
                  <div className="field"><label className="label" htmlFor="earmarkNote">Earmark / restrictions</label><input id="earmarkNote" name="earmarkNote" placeholder="e.g. Prize money only" /></div>
                  <div className="field"><label className="label" htmlFor="deliverables">Deliverables (one per line)</label><textarea id="deliverables" name="deliverables" placeholder={"Logo on backdrop\nTwo social posts\nBooth at venue"} /></div>
                  <div className="field"><label className="label" htmlFor="contactName">Contact name</label><input id="contactName" name="contactName" /></div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div className="field"><label className="label" htmlFor="email">Email</label><input id="email" name="email" type="email" /></div>
                    <div className="field"><label className="label" htmlFor="phone">Phone</label><input id="phone" name="phone" /></div>
                  </div>
                </div>
              </ActionForm>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-body tiny muted">
              You have read-only access to sponsorship reporting. Ask the finance team to create or change agreements.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
