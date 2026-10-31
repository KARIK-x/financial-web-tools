import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { getAgreement, AGREEMENT_STATES } from "@/server/sponsors";
import { listAccounts } from "@/server/accounts";
import { formatNPR } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, StatusBadge, DefRow, Money, ProgressBar } from "@/components/ui";
import { ActionForm, QuickAction } from "@/components/ActionForm";
import {
  addDeliverableAction, completeDeliverableAction, recordSponsorReceiptAction, updateAgreementStateAction,
} from "@/app/actions/sponsors";
import { Check, X } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SponsorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();
  const agreement = await getAgreement(db, id);
  if (!agreement) notFound();

  const manages = can(user.role, "sponsor.manage", user.permissions);
  const accounts = manages && !agreement.in_kind ? await listAccounts(db) : [];
  const received = Number(agreement.received_paisa);
  const promised = Number(agreement.promised_paisa);
  const ratio = promised > 0 ? received / promised : 0;

  return (
    <>
      <PageHeader
        eyebrow={`Sponsorship · ${agreement.ref}`}
        title={agreement.sponsor_name}
        sub={<>{agreement.title}{agreement.event_name ? ` · ${agreement.event_name}` : ""}{agreement.in_kind ? " · in-kind" : ""}</>}
        actions={<><Link className="btn" href="/sponsors">All sponsors</Link><StatusBadge status={agreement.state} /></>}
      />

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Agreement</div></div>
            <div className="card-body">
              <dl className="kv">
                <DefRow label="Reference">{agreement.ref}</DefRow>
                <DefRow label="Sponsor">{agreement.sponsor_name}</DefRow>
                <DefRow label="Title">{agreement.title}</DefRow>
                <DefRow label="Package">{agreement.package_tier ?? "—"}</DefRow>
                <DefRow label="Event">{agreement.event_name ?? "—"}</DefRow>
                <DefRow label="State"><StatusBadge status={agreement.state} /></DefRow>
                <DefRow label="Cash commitment">{agreement.in_kind ? "— (in-kind)" : <Money paisa={promised} />}</DefRow>
                <DefRow label="In-kind">{agreement.in_kind ? `${agreement.in_kind_description ?? "—"}${agreement.in_kind_value_paisa ? ` · est. ${formatNPR(Number(agreement.in_kind_value_paisa))}` : ""}` : "No"}</DefRow>
                <DefRow label="Earmark">{agreement.earmark_note ?? "—"}</DefRow>
                <DefRow label="Signed">{agreement.signed_on ? formatDateLong(agreement.signed_on) : "Not signed"}</DefRow>
              </dl>

              {!agreement.in_kind ? (
                <div style={{ marginTop: 18 }}>
                  <ProgressBar value={ratio} label={`${formatNPR(received)} received of ${formatNPR(promised)}`} />
                </div>
              ) : null}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Receipts</div><span className="tiny muted">{agreement.receipts.length}</span></div>
            <div className="table-wrap">
              {agreement.receipts.length ? (
                <table className="data">
                  <thead><tr><th>Reference</th><th>Date</th><th>Account</th><th>Method</th><th className="right">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {agreement.receipts.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.ref}</td>
                        <td>{formatDateLong(r.date_ad)}</td>
                        <td>{r.account_name ?? "—"}</td>
                        <td className="muted">{r.method ?? "—"}</td>
                        <td className="right mono">{formatNPR(Number(r.amount_paisa))}</td>
                        <td><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">No cash received against this agreement.</div>}
            </div>
            <div className="card-foot" style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="small">Received <b><Money paisa={received} /></b></span>
              <span className="small">Outstanding <b><Money paisa={Math.max(0, promised - received)} /></b></span>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Deliverables</div><span className="tiny muted">{agreement.deliverables.length}</span></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {agreement.deliverables.length ? agreement.deliverables.map((d) => (
                <div className="list-row" key={d.id} style={{ alignItems: "center" }}>
                  <StatusBadge status={d.status} />
                  <div style={{ flex: 1 }}>
                    <div className="small">{d.description}</div>
                    <div className="tiny muted">{d.due_on ? `Due ${formatDateLong(d.due_on)}` : "No due date"}</div>
                  </div>
                  {manages && d.status === "PENDING" ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <QuickAction action={completeDeliverableAction} label="Done" fields={{ deliverableId: d.id }} className="btn btn-xs btn-accent" />
                      <QuickAction action={completeDeliverableAction} label="Waive" fields={{ deliverableId: d.id, waive: "true" }} className="btn btn-xs" confirm="Waive this deliverable?" />
                    </div>
                  ) : null}
                </div>
              )) : <div className="tiny muted" style={{ padding: "12px 0" }}>No deliverables recorded.</div>}
            </div>
            {manages ? (
              <div className="card-foot">
                <ActionForm action={addDeliverableAction} submitLabel="Add" submitClass="btn btn-sm" hideStatus>
                  <input type="hidden" name="agreementId" value={agreement.id} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <input name="description" placeholder="New deliverable" required />
                    <input name="dueOn" type="date" style={{ width: 150 }} />
                  </div>
                </ActionForm>
              </div>
            ) : null}
          </div>
        </div>

        <div>
          {manages ? (
            <>
              {!agreement.in_kind ? (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="card-head"><div className="section-title">Record cash receipt</div></div>
                  <div className="card-body">
                    <ActionForm action={recordSponsorReceiptAction} submitLabel="Record receipt">
                      <input type="hidden" name="agreementId" value={agreement.id} />
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label className="label" htmlFor="amount">Amount received</label>
                        <input id="amount" name="amount" required inputMode="decimal" placeholder="e.g. 50,000" />
                      </div>
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label className="label" htmlFor="accountId">Into account</label>
                        <select id="accountId" name="accountId" required defaultValue={accounts[0]?.id ?? ""}>
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {formatNPR(Number(a.balance_paisa))}</option>)}
                        </select>
                      </div>
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label className="label" htmlFor="date">Date</label>
                        <input id="date" name="date" type="date" required defaultValue={todayISO()} />
                      </div>
                      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                        <div className="field"><label className="label" htmlFor="method">Method</label><input id="method" name="method" placeholder="Bank transfer" /></div>
                        <div className="field"><label className="label" htmlFor="reference">Reference</label><input id="reference" name="reference" /></div>
                      </div>
                      <div className="field"><label className="label" htmlFor="notes">Notes</label><input id="notes" name="notes" /></div>
                    </ActionForm>
                    <div className="tiny muted" style={{ marginTop: 6 }}>
                      Only record money that actually reached the selected FINANCE TRACKER account. This posts sponsorship income
                      and cannot be silently deleted afterwards.
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-head"><div className="section-title">State</div></div>
                <div className="card-body">
                  <ActionForm action={updateAgreementStateAction} submitLabel="Update state">
                    <input type="hidden" name="agreementId" value={agreement.id} />
                    <select name="state" defaultValue={agreement.state}>
                      {AGREEMENT_STATES.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ").toLowerCase()}</option>)}
                    </select>
                  </ActionForm>
                </div>
              </div>
            </>
          ) : null}

          <div className="card">
            <div className="card-head"><div className="section-title">Documents</div></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {agreement.documents.length ? agreement.documents.map((d) => (
                <div className="list-row" key={d.id}>
                  <div style={{ flex: 1 }}>
                    <Link className="small link-quiet" href={`/receipts/${d.id}`}>{d.filename}</Link>
                    <div className="tiny muted">{d.doc_type}</div>
                  </div>
                  <a className="btn btn-xs" href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">Open</a>
                </div>
              )) : <div className="tiny muted" style={{ padding: "12px 0" }}>No agreement document attached. Upload from Receipts when available.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
