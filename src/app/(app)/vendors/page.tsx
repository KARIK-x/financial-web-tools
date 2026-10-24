import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { formatNPR } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { PageHeader, Stat, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const user = await requireUser();
  const db = await getDb();
  const canAll = user.permissions.includes("expense.view.all");

  const vendors = await many<{
    id: string; name: string; pan: string | null; claims: number; total: number; last_on: string | null; verified: number;
  }>(
    db,
    `SELECT v.id, v.name, v.pan,
            COUNT(c.id)::int AS claims,
            COALESCE(SUM(c.amount_paisa),0) AS total,
            to_char(MAX(c.date_ad),'YYYY-MM-DD') AS last_on,
            COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state='VERIFIED'),0) AS verified
       FROM vendors v
       LEFT JOIN expense_claims c ON c.vendor_id=v.id AND c.status NOT IN ('DRAFT','WITHDRAWN','REJECTED')
        AND ($1::boolean OR c.claimant_user_id = $2)
      GROUP BY v.id, v.name, v.pan
      ORDER BY total DESC, v.name`,
    [canAll, user.id],
  );

  const used = vendors.filter((v) => v.claims > 0);
  const total = used.reduce((s, v) => s + Number(v.total), 0);

  return (
    <>
      <PageHeader
        eyebrow="Counterparties"
        title="Vendors"
        sub="Vendors are created automatically from claims using a normalised name, so small spelling differences do not create duplicate records. PAN is only stored when it appears on a real document."
      />

      <section className="grid grid-3" style={{ marginBottom: 20 }}>
        <Stat label="Vendors used" value={used.length} foot={`${vendors.length} records in total`} />
        <Stat label="Recorded spend" value={formatNPR(total)} foot="Across visible claims" tone="accent" />
        <Stat label="Largest vendor" value={used[0] ? used[0].name : "—"} foot={used[0] ? formatNPR(Number(used[0].total)) : "No spending yet"} />
      </section>

      <div className="card">
        <div className="table-wrap">
          {vendors.length ? (
            <table className="data">
              <thead><tr><th>Vendor</th><th>PAN</th><th className="right">Claims</th><th className="right">Total spend</th><th className="right">Verified</th><th>Last expense</th></tr></thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.id}>
                    <td><div className="row-title">{v.name}</div></td>
                    <td className="muted mono">{v.pan ?? "—"}</td>
                    <td className="right muted">{v.claims || "—"}</td>
                    <td className="right mono">{v.claims ? formatNPR(Number(v.total)) : "—"}</td>
                    <td className="right mono">{v.claims ? formatNPR(Number(v.verified)) : "—"}</td>
                    <td className="muted nowrap">{v.last_on ? formatDateLong(v.last_on) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState title="No vendors yet" text="Vendor records are created when the first claim is recorded." action={<Link className="btn btn-sm" href="/expenses/new">Record an expense</Link>} />}
        </div>
      </div>
    </>
  );
}
