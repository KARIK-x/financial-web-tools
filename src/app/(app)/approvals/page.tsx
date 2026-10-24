import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many } from "@/server/db";
import { listClaims } from "@/server/expenses";
import { getSettings, approvalTier } from "@/server/settings";
import { formatNPR } from "@/lib/money";
import { formatDateLong, daysBetween, todayISO } from "@/lib/nepali-date";
import { PageHeader, StatusBadge, EmptyState, SourceTag } from "@/components/ui";
import { QuickAction } from "@/components/ActionForm";
import { decideClaimAction } from "@/app/actions/expenses";
import { CheckCircle2, Clock } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const user = await requirePagePermission("expense.approve");
  const db = await getDb();
  const [claims, settings] = await Promise.all([
    listClaims(db, user, { pendingOnly: true, limit: 100 }),
    getSettings(db),
  ]);

  const claimIds = claims.map((c) => c.id);
  const approvals = claimIds.length
    ? await many<{ claim_id: string; approver_user_id: string; decision: string; approver_name: string }>(
      db,
      `SELECT ap.claim_id, ap.approver_user_id, ap.decision, u.name AS approver_name
         FROM approvals ap JOIN users u ON u.id = ap.approver_user_id
        WHERE ap.claim_id = ANY($1::text[]) AND ap.decision = 'APPROVE'`,
      [claimIds],
    )
    : [];
  const byClaim = new Map<string, typeof approvals>();
  for (const a of approvals) {
    byClaim.set(a.claim_id, [...(byClaim.get(a.claim_id) ?? []), a]);
  }

  return (
    <>
      <PageHeader
        eyebrow="Approval queue"
        title="Waiting for a decision"
        sub="Claims are ordered by expense date. Your own claims never appear as approvable here, and the database rejects self-approval even if the interface is bypassed."
        actions={<span className="badge badge-amber">{claims.length} pending</span>}
      />

      {claims.length ? (
        <div className="grid" style={{ gap: 12 }}>
          {claims.map((claim) => {
            const tier = approvalTier(Number(claim.amount_paisa), settings);
            const prior = byClaim.get(claim.id) ?? [];
            const mine = prior.some((a) => a.approver_user_id === user.id);
            const own = claim.claimant_user_id === user.id;
            const age = claim.submitted_at ? daysBetween(String(claim.submitted_at).slice(0, 10), todayISO()) : 0;
            return (
              <div className="card" key={claim.id}>
                <div className="card-body" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr) auto", gap: 18, alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Link className="link-quiet" href={`/expenses/${claim.id}`} style={{ fontWeight: 600 }}>{claim.claim_no}</Link>
                      <StatusBadge status={claim.status} />
                      <span className={`badge ${tier === "STANDARD" ? "badge-gray" : tier === "EXECUTIVE" ? "badge-amber" : "badge-red"}`}>{tier.toLowerCase()}</span>
                      <SourceTag synthetic={claim.is_synthetic} sourceType={claim.source_type} />
                    </div>
                    <div className="small" style={{ marginTop: 4 }}>{claim.description}</div>
                    <div className="tiny muted" style={{ marginTop: 2 }}>
                      {claim.claimant_name} · {claim.category_name}{claim.event_name ? ` · ${claim.event_name}` : ""} · {formatDateLong(claim.date_ad)}
                    </div>
                    <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <StatusBadge status={claim.documentation_state} />
                      {prior.length ? prior.map((a) => <span className="badge badge-green" key={a.approver_user_id}>✓ {a.approver_name}</span>) : <span className="badge badge-gray">No approvals yet</span>}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Amount</div>
                    <div className="num" style={{ fontSize: 21 }}>{formatNPR(Number(claim.amount_paisa))}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {claim.docs} document{claim.docs === 1 ? "" : "s"} ·{" "}
                      {age === 0 ? "submitted today" : `${age} day${age === 1 ? "" : "s"} waiting`}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Link className="btn btn-sm" href={`/expenses/${claim.id}`}>Review</Link>
                    {own ? (
                      <span className="tiny muted" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Clock size={12} /> Yours</span>
                    ) : mine ? (
                      <span className="tiny muted" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><CheckCircle2 size={12} /> Approved</span>
                    ) : (
                      <QuickAction
                        action={decideClaimAction}
                        label="Approve"
                        className="btn btn-sm btn-accent"
                        fields={{ claimId: claim.id, decision: "APPROVE" }}
                        confirm={`Approve ${claim.claim_no} for ${formatNPR(Number(claim.amount_paisa))}? This posts the expense to the ledger.`}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            title="The queue is clear"
            text="No claims are waiting for a decision. Rejected, withdrawn and approved claims remain in the expense register."
            action={<Link className="btn btn-sm" href="/expenses">Open expense register</Link>}
          />
        </div>
      )}

      <div className="info-box" style={{ marginTop: 18 }}>
        Approval thresholds are configured in Settings: up to {formatNPR(settings.approval.standard)} needs one finance
        approval; above that needs finance + executive; above {formatNPR(settings.approval.committee)} also needs a
        committee reference.
      </div>
    </>
  );
}
