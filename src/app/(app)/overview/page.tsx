import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { getDashboard, currentFiscalPeriod } from "@/server/reports";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong, formatTimestamp } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState, BarChart, Money } from "@/components/ui";
import { AlertTriangle, ArrowRight, CheckCircle2, FileWarning, Scale, Wallet } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const user = await requireUser();
  const db = await getDb();
  const period = await currentFiscalPeriod(db);
  const [data, counts] = await Promise.all([
    getDashboard(db, period),
    one<{ total: number; synthetic: number; real: number; imported: number; users: number }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM expense_claims) AS total,
        (SELECT COUNT(*)::int FROM expense_claims WHERE is_synthetic) AS synthetic,
        (SELECT COUNT(*)::int FROM expense_claims WHERE NOT is_synthetic) AS real,
        (SELECT COUNT(*)::int FROM expense_claims WHERE source_type='HISTORICAL_IMPORT') AS imported,
        (SELECT COUNT(*)::int FROM users) AS users`,
    ),
  ]);

  const hasRealClaims = (counts?.real ?? 0) > 0;
  const allSynthetic = (counts?.total ?? 0) > 0 && (counts?.synthetic ?? 0) === (counts?.total ?? 0);
  const firstName = user.name.split(/\s+/)[0] ?? user.name;

  const attention: Array<{ icon: React.ReactNode; text: React.ReactNode; href: string }> = [];
  if (data.oldestPending) {
    attention.push({
      icon: <AlertTriangle size={13} />,
      href: "/approvals",
      text: <><b>{data.oldestPending.claim_no}</b> has waited {data.oldestPending.days} day{data.oldestPending.days === 1 ? "" : "s"} for a decision · {formatNPR(Number(data.oldestPending.amount_paisa))}</>,
    });
  }
  if (data.missingDocsCount > 0) {
    attention.push({
      icon: <FileWarning size={13} />,
      href: "/receipts",
      text: <><b>{data.missingDocsCount}</b> claim{data.missingDocsCount === 1 ? "" : "s"} missing evidence · {formatNPR(data.missingDocs)}</>,
    });
  }
  if (data.advances.over30.length > 0) {
    attention.push({
      icon: <Wallet size={13} />,
      href: "/advances",
      text: <><b>{data.advances.over30.length}</b> advance{data.advances.over30.length === 1 ? "" : "s"} outstanding over 30 days</>,
    });
  }
  if (data.unreconciled.unmatched > 0) {
    attention.push({
      icon: <Scale size={13} />,
      href: "/reconciliation",
      text: <><b>{data.unreconciled.unmatched}</b> bank statement line{data.unreconciled.unmatched === 1 ? "" : "s"} not reconciled</>,
    });
  }
  if (data.disputed > 0) {
    attention.push({
      icon: <AlertTriangle size={13} />,
      href: "/expenses?verification=DISPUTED",
      text: <><b>{formatNPR(data.disputed)}</b> under dispute</>,
    });
  }

  return (
    <>
      <PageHeader
        eyebrow={`${period.label}`}
        title={`Good to see you, ${firstName}`}
        sub="Verified and unverified spending are kept apart on purpose. Nothing here is counted as verified until a second person checks the evidence."
        actions={
          <>
            <Link className="btn" href="/reports">Reports</Link>
            <Link className="btn btn-primary" href="/expenses/new">New expense</Link>
          </>
        }
      />

      {allSynthetic ? (
        <div className="warn-box" style={{ marginBottom: 18 }}>
          <b>This workspace currently contains only synthetic demo records.</b> They exist so the workflows can be
          tested end to end. Do not treat any amount below as a real LOCUS balance. Clear them with
          <code> npm run db:reset-demo</code> before entering real data.
        </div>
      ) : !hasRealClaims ? (
        <div className="info-box" style={{ marginBottom: 18 }}>
          <b>The ledger is empty.</b> No expense claims have been recorded yet. Import historical evidence or submit
          the first claim to begin. Balances stay at zero until verified opening balances are entered in Accounts.
        </div>
      ) : null}

      <section className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat
          label="Verified spend"
          value={formatNPRShort(data.verified)}
          foot={`${data.verifiedCount} verified claim${data.verifiedCount === 1 ? "" : "s"}`}
          tone="accent"
          href="/expenses?verification=VERIFIED"
        />
        <Stat
          label="Claimed, not yet verified"
          value={formatNPRShort(data.unverified)}
          foot={`${data.recordedCount - data.verifiedCount} claims awaiting evidence review`}
          tone={data.unverified > 0 ? "warn" : undefined}
          href="/expenses?verification=UNVERIFIED"
        />
        <Stat
          label="Awaiting approval"
          value={formatNPRShort(data.pending)}
          foot={`${data.pendingCount} claim${data.pendingCount === 1 ? "" : "s"} in the queue`}
          href="/approvals"
        />
        <Stat
          label="Reimbursements owed"
          value={formatNPRShort(data.reimbursementOwed)}
          foot={`${data.reimbursementOwedCount} approved claim${data.reimbursementOwedCount === 1 ? "" : "s"} to pay`}
          href="/expenses?status=PAYMENT_PENDING"
        />
      </section>

      <section className="grid grid-4" style={{ marginBottom: 24 }}>
        <Stat label="Cash on hand" value={formatNPR(data.cashTotal)} foot="Counted cash accounts in this system" href="/accounts" />
        <Stat label="Bank & wallet" value={formatNPR(data.bankTotal)} foot="Recorded balances, pending reconciliation" href="/accounts" />
        <Stat
          label="Sponsorship received"
          value={formatNPRShort(data.sponsors.received)}
          foot={`${formatNPRShort(data.sponsors.outstanding)} still outstanding`}
          href="/sponsors"
        />
        <Stat
          label="Outstanding advances"
          value={formatNPRShort(data.advances.outstanding)}
          foot={`${data.advances.count} open advance${data.advances.count === 1 ? "" : "s"}`}
          tone={data.advances.over30.length ? "warn" : undefined}
          href="/advances"
        />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", marginBottom: 24 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Monthly spending</div>
              <div className="section-sub">Sold colour = verified · pale = claimed, not yet verified</div>
            </div>
            <div className="legend">
              <span><i className="swatch" /> Verified</span>
              <span><i className="swatch claimed" /> Unverified</span>
            </div>
          </div>
          <div className="card-body">
            {data.monthly.length ? (
              <>
                <BarChart data={data.monthly.map((m) => ({ label: m.month, total: Number(m.total_paisa), verified: Number(m.verified_paisa) }))} />
                <div className="hairline" style={{ margin: "18px 0 14px" }} />
                <div className="grid grid-3">
                  <div>
                    <div className="tiny muted uppercase">Recorded</div>
                    <div className="num" style={{ fontSize: 18 }}>{formatNPR(data.recorded)}</div>
                  </div>
                  <div>
                    <div className="tiny muted uppercase">Verified</div>
                    <div className="num" style={{ fontSize: 18 }}>{formatNPR(data.verified)}</div>
                  </div>
                  <div>
                    <div className="tiny muted uppercase">Evidence missing</div>
                    <div className="num" style={{ fontSize: 18 }}>{formatNPR(data.missingDocs)}</div>
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                title="No spending recorded in this period"
                text="Once claims are submitted they will appear here, split into verified and unverified amounts."
                action={<Link className="btn btn-sm" href="/expenses/new">Record the first expense</Link>}
              />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="section-title">Needs attention</div>
            <span className="badge badge-gray">{attention.length}</span>
          </div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {attention.length ? (
              attention.map((item) => (
                <Link key={item.href + item.text} href={item.href} className="attention" style={{ color: "inherit" }}>
                  <span className="icon-box badge-amber">{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.text}</span>
                  <ArrowRight size={13} style={{ marginTop: 3, opacity: 0.5 }} />
                </Link>
              ))
            ) : (
              <div style={{ padding: "26px 0", textAlign: "center" }}>
                <CheckCircle2 size={22} style={{ color: "var(--accent)", margin: "0 auto 8px" }} />
                <div className="small" style={{ fontWeight: 500 }}>Nothing is overdue</div>
                <div className="tiny muted">Approvals, evidence and reconciliations are current.</div>
              </div>
            )}
          </div>
          <div className="card-foot">
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div className="tiny muted">Documents</div>
                <div className="small">{data.docs.total} uploaded · {data.docs.needs_review} to review</div>
              </div>
              <div>
                <div className="tiny muted">Budgets over 80%</div>
                <div className="small">{data.budgets.nearLimit.length + data.budgets.overspent.length} flagged</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head">
            <div className="section-title">Where money went</div>
            <Link className="link small" href="/analytics">Analytics</Link>
          </div>
          <div className="table-wrap">
            {data.byCategory.length ? (
              <table className="data">
                <thead><tr><th>Category</th><th className="right">Claims</th><th className="right">Amount</th><th className="right">Share</th></tr></thead>
                <tbody>
                  {data.byCategory.map((row) => {
                    const total = data.byCategory.reduce((s, r) => s + Number(r.amount_paisa), 0) || 1;
                    return (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td className="right muted">{row.count}</td>
                        <td className="right mono">{formatNPR(Number(row.amount_paisa))}</td>
                        <td className="right muted">{Math.round((Number(row.amount_paisa) / total) * 100)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <div className="table-empty">No categorised spending yet.</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="section-title">Recent activity</div>
            <Link className="link small" href="/audit">Audit trail</Link>
          </div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {data.recent.length ? data.recent.map((event) => (
              <div className="list-row" key={event.id}>
                <span className="avatar-sm">{event.actor_name.slice(0, 2).toUpperCase()}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="small">{event.summary}</div>
                  <div className="tiny muted">{event.actor_name} · {formatTimestamp(event.created_at)}</div>
                </div>
              </div>
            )) : <div className="table-empty">No activity recorded yet.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
