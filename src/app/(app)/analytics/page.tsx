import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, one } from "@/server/db";
import {
  currentFiscalPeriod, documentationStats, getDashboard, monthlySpend, spendByCategory, spendByEvent,
} from "@/server/reports";
import { memberAccountability } from "@/server/advances";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, ProgressBar, BarChart, EmptyState } from "@/components/ui";
import { TrendingUp, AlertTriangle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  await requirePagePermission("report.view");
  const db = await getDb();
  const period = await currentFiscalPeriod(db);
  const [dash, byCategory, byEvent, monthly, docs, accountability, claimsCount, topVendors] = await Promise.all([
    getDashboard(db, period),
    spendByCategory(db, period),
    spendByEvent(db, period),
    monthlySpend(db, period),
    documentationStats(db),
    memberAccountability(db),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM expense_claims WHERE status NOT IN ('DRAFT','WITHDRAWN')`),
    many<{ name: string; amount_paisa: number; claims: number }>(
      db,
      `SELECT COALESCE(v.name, c.vendor_name_raw, 'Unknown') AS name, SUM(c.amount_paisa) AS amount_paisa, COUNT(*)::int AS claims
         FROM expense_claims c LEFT JOIN vendors v ON v.id=c.vendor_id
        WHERE c.status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')
          AND c.date_ad BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY amount_paisa DESC LIMIT 5`,
      [period.from, period.to],
    ),
  ]);

  const totalSpend = byCategory.reduce((s, r) => s + Number(r.amount_paisa), 0);
  const verifiedTotal = byCategory.reduce((s, r) => s + Number(r.verified_paisa), 0);
  const verificationRate = totalSpend ? verifiedTotal / totalSpend : 0;
  const sampleSize = claimsCount?.n ?? 0;
  const topCategory = byCategory[0];

  return (
    <>
      <PageHeader
        eyebrow={`Analytics · ${period.label}`}
        title="Where the money actually goes"
        sub="Descriptive analytics only. No forecast is presented as fact, and no synthetic or unverified amount is counted as confirmed spend."
        actions={<Link className="btn" href="/reports">Formal reports</Link>}
      />

      {sampleSize > 0 && sampleSize < 20 ? (
        <div className="warn-box" style={{ marginBottom: 18 }}>
          <b>Small sample.</b> This period has {sampleSize} claim{sampleSize === 1 ? "" : "s"}. Percentages are indicative only;
          do not present them as trends or benchmarks.
        </div>
      ) : null}

      <section className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Recorded spend" value={formatNPRShort(dash.recorded)} foot={`${dash.recordedCount} claims in the period`} />
        <Stat label="Verified share" value={`${Math.round(verificationRate * 100)}%`} foot={`${formatNPRShort(verifiedTotal)} of ${formatNPRShort(totalSpend)}`} tone={verificationRate < 0.5 ? "warn" : "accent"} />
        <Stat label="Top category" value={topCategory ? topCategory.name : "—"} foot={topCategory ? `${formatNPRShort(Number(topCategory.amount_paisa))} · ${Math.round((Number(topCategory.amount_paisa) / (totalSpend || 1)) * 100)}% of spend` : "No spend yet"} />
        <Stat label="Open advances" value={formatNPRShort(dash.advances.outstanding)} foot={`${dash.advances.count} outstanding · ${dash.advances.over30.length} over 30 days`} tone={dash.advances.over30.length ? "warn" : undefined} />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", marginBottom: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Category concentration</div>
              <div className="section-sub">Sorted by amount. The bar shows the verified share of each category.</div>
            </div>
            <TrendingUp size={16} className="muted" />
          </div>
          <div className="card-body grid" style={{ gap: 14 }}>
            {byCategory.length ? byCategory.map((row) => {
              const total = Number(row.amount_paisa);
              const verified = Number(row.verified_paisa);
              const share = total / (totalSpend || 1);
              return (
                <div key={row.code}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
                    <div className="small"><b>{row.name}</b> <span className="faint tiny mono">{row.code}</span></div>
                    <div className="small num">{formatNPR(total)} <span className="muted tiny">({Math.round(share * 100)}%)</span></div>
                  </div>
                  <ProgressBar value={verified / (total || 1)} label={`${Math.round((verified / (total || 1)) * 100)}% verified · ${row.count} claim${row.count === 1 ? "" : "s"}`} />
                </div>
              );
            }) : <EmptyState title="No categorised spend" text="Submit a claim to start building the category view." />}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Verification coverage</div>
              <div className="section-sub">Evidence status across every counted claim.</div>
            </div>
          </div>
          <div className="card-body grid" style={{ gap: 12 }}>
            <div>
              <div className="tiny muted uppercase">Documentation</div>
              <div className="grid grid-3" style={{ gap: 8, marginTop: 6 }}>
                <div><div className="num" style={{ fontSize: 20 }}>{docs.complete}</div><div className="tiny muted">Complete</div></div>
                <div><div className="num" style={{ fontSize: 20, color: "var(--amber)" }}>{docs.declared}</div><div className="tiny muted">Declared gap</div></div>
                <div><div className="num" style={{ fontSize: 20, color: "var(--danger)" }}>{docs.undeclared}</div><div className="tiny muted">Undeclared gap</div></div>
              </div>
            </div>
            <div className="hairline" />
            <div>
              <div className="tiny muted uppercase">Verification state</div>
              <div className="grid grid-3" style={{ gap: 8, marginTop: 6 }}>
                <div><div className="num" style={{ fontSize: 20, color: "var(--accent)" }}>{docs.verified}</div><div className="tiny muted">Verified</div></div>
                <div><div className="num" style={{ fontSize: 20 }}>{docs.unverified}</div><div className="tiny muted">Unverified</div></div>
                <div><div className="num" style={{ fontSize: 20, color: "var(--danger)" }}>{docs.disputed}</div><div className="tiny muted">Disputed</div></div>
              </div>
            </div>
            <div className="info-box">
              A paid claim is not a verified claim. The two states are tracked separately so a reimbursement cannot launder
              an evidence gap.
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", marginBottom: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Monthly spend</div>
              <div className="section-sub">Pale = unverified, solid = verified. Months without activity are omitted.</div>
            </div>
          </div>
          <div className="card-body">
            {monthly.length ? (
              <>
                <BarChart data={monthly.map((m) => ({ label: m.month, total: Number(m.total_paisa), verified: Number(m.verified_paisa) }))} height={150} />
                <div className="legend" style={{ marginTop: 12 }}>
                  <span><i className="swatch" /> Verified</span>
                  <span><i className="swatch claimed" /> Unverified</span>
                </div>
              </>
            ) : <EmptyState title="No monthly activity" text="There are no counted claims in this fiscal year." />}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Event allocation</div>
              <div className="section-sub">Split claims appear under each event they were allocated to.</div>
            </div>
          </div>
          <div className="table-wrap">
            {byEvent.length ? (
              <table className="data">
                <thead><tr><th>Event</th><th className="right">Claims</th><th className="right">Amount</th><th className="right">Verified</th></tr></thead>
                <tbody>
                  {byEvent.map((e) => (
                    <tr key={e.event_id ?? e.name}>
                      <td>{e.event_id ? <Link className="link-quiet" href={`/events/${e.event_id}`}>{e.name}</Link> : <span className="muted">{e.name}</span>}</td>
                      <td className="right mono">{e.count}</td>
                      <td className="right mono">{formatNPR(Number(e.amount_paisa))}</td>
                      <td className="right mono">{formatNPR(Number(e.verified_paisa))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="table-empty">No event allocations in this period.</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="card-head"><div className="section-title">Top payees</div></div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {topVendors.length ? topVendors.map((v) => (
              <div className="list-row" key={v.name}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="small" style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</div>
                  <div className="tiny muted">{v.claims} claim{v.claims === 1 ? "" : "s"}</div>
                </div>
                <div className="small num">{formatNPR(Number(v.amount_paisa))}</div>
              </div>
            )) : <div className="table-empty">No payees yet.</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="section-title">Budget pressure</div></div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {[...dash.budgets.overspent, ...dash.budgets.nearLimit].length ? (
              [...dash.budgets.overspent, ...dash.budgets.nearLimit].slice(0, 6).map((b) => (
                <div className="list-row" key={b.id}>
                  <span className={`icon-box ${b.utilisation > 1 ? "badge-red" : "badge-amber"}`}><AlertTriangle size={12} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small">{b.name}</div>
                    <div className="tiny muted">{Math.round(b.utilisation * 100)}% of {formatNPRShort(b.total_paisa)}</div>
                  </div>
                  <StatusBadge status={b.utilisation > 1 ? "DISPUTED" : "PENDING"} label={b.utilisation > 1 ? "Over" : "Near"} />
                </div>
              ))
            ) : <div className="table-empty">No budget is above 80% utilisation.</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="section-title">Advance accountability</div></div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {accountability.filter((m) => Number(m.advances_outstanding_paisa) > 0).length ? accountability
              .filter((m) => Number(m.advances_outstanding_paisa) > 0)
              .slice(0, 6)
              .map((m) => (
                <div className="list-row" key={m.member_id}>
                  <span className="avatar-sm">{m.name.slice(0, 2).toUpperCase()}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small">{m.name}</div>
                    <div className="tiny muted">{m.submitted_count} claim{m.submitted_count === 1 ? "" : "s"} submitted</div>
                  </div>
                  <div className="small num">{formatNPR(Number(m.advances_outstanding_paisa))}</div>
                </div>
              )) : <div className="table-empty">No outstanding advances.</div>}
          </div>
        </div>
      </div>

      <div className="info-box">
        Period: {formatDateLong(period.from)} → {formatDateLong(period.to)}. Analytics reflect recorded claims, not cash
        movement. For cash, use <Link className="link" href="/reports?type=cashflow">cash flow</Link>.
      </div>
    </>
  );
}
