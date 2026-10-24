import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { getAdvance } from "@/server/advances";
import { listAccounts } from "@/server/accounts";
import { formatNPR } from "@/lib/money";
import { formatDateLong, formatTimestamp, todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, StatusBadge, DefRow, Money } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { disburseAdvanceAction, returnAdvanceAction, writeOffAdvanceAction } from "@/app/actions/advances";

export const dynamic = "force-dynamic";

export default async function AdvanceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();
  const advance = await getAdvance(db, id);
  if (!advance) notFound();

  const manages = can(user.role, "advance.manage", user.permissions);
  const isAdmin = can(user.role, "settings.manage", user.permissions);
  const accounts = manages ? await listAccounts(db) : [];
  const isOpen = ["OUTSTANDING", "PARTIALLY_SETTLED"].includes(advance.status);

  return (
    <>
      <PageHeader
        eyebrow={`Advance · ${advance.ref}`}
        title={advance.purpose}
        sub={<>{advance.member_name}{advance.event_name ? ` · ${advance.event_name}` : ""}</>}
        actions={<><Link className="btn" href="/advances">All advances</Link><StatusBadge status={advance.status} /></>}
      />

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Advance record</div></div>
            <div className="card-body">
              <dl className="kv">
                <DefRow label="Member">{advance.member_name}</DefRow>
                <DefRow label="Requested by">{advance.requester_name ?? "—"}</DefRow>
                <DefRow label="Event">{advance.event_name ?? "—"}</DefRow>
                <DefRow label="Purpose">{advance.purpose}</DefRow>
                <DefRow label="Advance amount"><Money paisa={Number(advance.amount_paisa)} /></DefRow>
                <DefRow label="Disbursed">{advance.disbursed_on ? formatDateLong(advance.disbursed_on) : "Not yet disbursed"}</DefRow>
                <DefRow label="Due">{advance.due_on ? formatDateLong(advance.due_on) : "—"}</DefRow>
                <DefRow label="Days outstanding">{advance.days_outstanding}</DefRow>
                <DefRow label="Notes">{advance.notes ?? "—"}</DefRow>
              </dl>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <div><div className="tiny uppercase muted">Advance</div><div className="num">{formatNPR(Number(advance.amount_paisa))}</div></div>
                <div><div className="tiny uppercase muted">Used</div><div className="num">{formatNPR(Number(advance.used_paisa))}</div></div>
                <div><div className="tiny uppercase muted">Returned</div><div className="num">{formatNPR(Number(advance.returned_paisa))}</div></div>
                <div><div className="tiny uppercase muted">Outstanding</div><div className="num" style={{ fontWeight: 600 }}>{formatNPR(Number(advance.outstanding_paisa))}</div></div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Claims against this advance</div><span className="tiny muted">{advance.claims.length}</span></div>
            <div className="table-wrap">
              {advance.claims.length ? (
                <table className="data">
                  <thead><tr><th>Claim</th><th>Date</th><th className="right">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {advance.claims.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="link" href={`/expenses/${c.id}`}>{c.claim_no}</Link></td>
                        <td>{formatDateLong(c.date_ad)}</td>
                        <td className="right mono">{formatNPR(Number(c.amount_paisa))}</td>
                        <td><StatusBadge status={c.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">No expense claims are linked to this advance yet.</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Payments & returns</div></div>
            <div className="table-wrap">
              {advance.payments.length ? (
                <table className="data">
                  <thead><tr><th>Reference</th><th>Type</th><th>Date</th><th>Account</th><th className="right">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {advance.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.ref}</td>
                        <td>{p.type.replaceAll("_", " ").toLowerCase()}</td>
                        <td>{formatDateLong(p.date_ad)}</td>
                        <td>{p.account_name ?? "—"}</td>
                        <td className="right mono">{formatNPR(Number(p.amount_paisa))}</td>
                        <td><StatusBadge status={p.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">No money has moved for this advance.</div>}
            </div>
          </div>
        </div>

        <div>
          {manages && ["REQUESTED", "APPROVED"].includes(advance.status) ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head"><div className="section-title">Disburse advance</div></div>
              <div className="card-body">
                <ActionForm action={disburseAdvanceAction} submitLabel="Record disbursement">
                  <input type="hidden" name="advanceId" value={advance.id} />
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label className="label" htmlFor="accountId">From account</label>
                    <select id="accountId" name="accountId" required defaultValue={accounts[0]?.id ?? ""}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {formatNPR(Number(a.balance_paisa))}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label className="label" htmlFor="date">Date</label>
                    <input id="date" name="date" type="date" required defaultValue={todayISO()} />
                  </div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div className="field"><label className="label" htmlFor="method">Method</label><input id="method" name="method" placeholder="Cash" /></div>
                    <div className="field"><label className="label" htmlFor="reference">Reference</label><input id="reference" name="reference" /></div>
                  </div>
                </ActionForm>
              </div>
            </div>
          ) : null}

          {manages && isOpen ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head"><div className="section-title">Return unused funds</div></div>
              <div className="card-body">
                <ActionForm action={returnAdvanceAction} submitLabel="Record return">
                  <input type="hidden" name="advanceId" value={advance.id} />
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label className="label" htmlFor="return-amount">Amount returned</label>
                    <input id="return-amount" name="amount" required inputMode="decimal" defaultValue={(Number(advance.outstanding_paisa) / 100).toFixed(2)} />
                  </div>
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label className="label" htmlFor="return-account">Into account</label>
                    <select id="return-account" name="accountId" required defaultValue={accounts[0]?.id ?? ""}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label className="label" htmlFor="return-date">Date</label>
                    <input id="return-date" name="date" type="date" required defaultValue={todayISO()} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="return-notes">Notes</label>
                    <input id="return-notes" name="notes" />
                  </div>
                </ActionForm>
              </div>
            </div>
          ) : null}

          {isAdmin && isOpen ? (
            <div className="card">
              <div className="card-head"><div className="section-title">Write off</div></div>
              <div className="card-body">
                <div className="warn-box" style={{ marginBottom: 10 }}>
                  Writing off does not record a payment or clear the receivable in the ledger. It only closes the
                  advance for follow-up. A finance decision is still required.
                </div>
                <ActionForm action={writeOffAdvanceAction} submitLabel="Write off advance" submitClass="btn btn-danger" confirm="Write off this advance? This cannot be undone.">
                  <input type="hidden" name="advanceId" value={advance.id} />
                  <div className="field">
                    <label className="label" htmlFor="reason">Reason</label>
                    <textarea id="reason" name="reason" required />
                  </div>
                </ActionForm>
              </div>
            </div>
          ) : null}

          {advance.settlements.length ? (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head"><div className="section-title">Settlement log</div></div>
              <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
                {advance.settlements.map((s) => (
                  <div className="list-row" key={s.id}>
                    <div style={{ flex: 1 }}>
                      <div className="small">{formatDateLong(s.settled_on)} · returned {formatNPR(Number(s.returned_paisa))}</div>
                      <div className="tiny muted">{s.notes ?? "No note"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-body tiny muted">
              Created {formatTimestamp(advance.created_at)}. Advances are tracked as a receivable (1100) until a claim
              is approved against them or the cash is returned.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
