import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { listClaims } from "@/server/expenses";
import { listAdvances } from "@/server/advances";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState, SourceTag } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MyExpensesPage() {
  const user = await requireUser();
  const db = await getDb();
  const [claims, summary, advances] = await Promise.all([
    listClaims(db, user, { claimant: user.id, limit: 100 }),
    one<{ owed: number; pending: number; verified: number; missing: number }>(
      db,
      `SELECT
        COALESCE(SUM(amount_paisa - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.claim_id=c.id AND p.status='RECORDED' AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')),0))
          FILTER (WHERE c.claimant_user_id=$1 AND c.reimbursement_required AND c.status IN ('APPROVED','PAYMENT_PENDING','VERIFIED')),0) AS owed,
        COALESCE(SUM(amount_paisa) FILTER (WHERE c.claimant_user_id=$1 AND c.status IN ('SUBMITTED','UNDER_REVIEW')),0) AS pending,
        COALESCE(SUM(amount_paisa) FILTER (WHERE c.claimant_user_id=$1 AND c.verification_state='VERIFIED'),0) AS verified,
        COUNT(*) FILTER (WHERE c.claimant_user_id=$1 AND c.documentation_state <> 'COMPLETE' AND c.status NOT IN ('DRAFT','REJECTED','WITHDRAWN'))::int AS missing
       FROM expense_claims c`,
      [user.id],
    ),
    user.memberId ? listAdvances(db, { memberId: user.memberId }) : Promise.resolve([]),
  ]);
  const openAdvances = advances.filter((a) => ["OUTSTANDING", "PARTIALLY_SETTLED", "REQUESTED"].includes(a.status));

  return (
    <>
      <PageHeader
        eyebrow="Personal ledger"
        title="My claims"
        sub="What you have submitted, what is still owed to you, and what evidence is missing. Only you and the finance team can see these claims."
        actions={<Link className="btn btn-primary" href="/expenses/new">New expense</Link>}
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Owed to you" value={formatNPRShort(Number(summary?.owed ?? 0))} foot="Approved personal claims not yet paid" tone="accent" />
        <Stat label="Awaiting decision" value={formatNPRShort(Number(summary?.pending ?? 0))} foot="Submitted or under review" />
        <Stat label="Verified spend" value={formatNPRShort(Number(summary?.verified ?? 0))} foot="Evidence checked by a second person" />
        <Stat label="Missing evidence" value={summary?.missing ?? 0} foot="Claims needing a receipt or declaration" tone={(summary?.missing ?? 0) > 0 ? "warn" : undefined} />
      </section>

      {openAdvances.length ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><div className="section-title">Your open advances</div><Link className="link small" href="/advances">All advances</Link></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Reference</th><th>Purpose</th><th>Disbursed</th><th className="right">Advance</th><th className="right">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {openAdvances.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="link-quiet mono" href={`/advances/${a.id}`}>{a.ref}</Link></td>
                    <td>{a.purpose}</td>
                    <td>{a.disbursed_on ? formatDateLong(a.disbursed_on) : "Not disbursed"}</td>
                    <td className="right mono">{formatNPR(Number(a.amount_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.outstanding_paisa))}</td>
                    <td><StatusBadge status={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div className="section-title">Claim history</div>
          <span className="tiny muted">{claims.length} claims</span>
        </div>
        <div className="table-wrap">
          {claims.length ? (
            <table className="data">
              <thead><tr><th>Claim</th><th>Date</th><th>Category</th><th>Event</th><th className="right">Amount</th><th>Evidence</th><th>Status</th></tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="row-title link-quiet" href={`/expenses/${c.id}`}>{c.claim_no}</Link>
                      <div className="row-sub">{c.vendor_name ?? c.description} <SourceTag synthetic={c.is_synthetic} sourceType={c.source_type} /></div>
                    </td>
                    <td className="nowrap">{formatDateLong(c.date_ad)}</td>
                    <td>{c.category_name}</td>
                    <td className="muted">{c.event_name ?? "—"}</td>
                    <td className="right mono">{formatNPR(Number(c.amount_paisa))}</td>
                    <td><StatusBadge status={c.documentation_state} /></td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="You have not submitted a claim yet"
              text="When you pay for something personally, record it here and attach the receipt. You can save a draft before submitting."
              action={<Link className="btn btn-primary btn-sm" href="/expenses/new">Record an expense</Link>}
            />
          )}
        </div>
      </div>
    </>
  );
}
