import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { getClaim, approvalRequirementLabel } from "@/server/expenses";
import { getSettings } from "@/server/settings";
import { listAccounts } from "@/server/accounts";
import { formatNPR } from "@/lib/money";
import { formatDateLong, formatBsLong, formatTimestamp, todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, StatusBadge, Money, DefRow, SourceTag, Attention } from "@/components/ui";
import { ActionForm, QuickAction } from "@/components/ActionForm";
import { PrintButton } from "@/components/PrintButton";
import {
  decideClaimAction, disputeClaimAction, recordPaymentAction, submitClaimAction, verifyClaimAction, withdrawClaimAction,
} from "@/app/actions/expenses";
import { FileText, ShieldCheck, AlertTriangle, Wallet, Banknote } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();

  let claim;
  try {
    claim = await getClaim(db, user, id);
  } catch {
    notFound();
  }
  if (!claim) notFound();

  const [settings, accounts, categories] = await Promise.all([
    getSettings(db),
    listAccounts(db),
    many<{ id: string; requires_receipt: boolean }>(db, `SELECT id, requires_receipt FROM expense_categories WHERE id=$1`, [claim.category_id]),
  ]);

  const canApprove = can(user.role, "expense.approve", user.permissions) && claim.claimant_user_id !== user.id;
  const canPay = can(user.role, "expense.pay", user.permissions);
  const canVerify = can(user.role, "expense.verify", user.permissions) && claim.claimant_user_id !== user.id;
  const canManageDocs = can(user.role, "document.review", user.permissions);
  const awaiting = ["SUBMITTED", "UNDER_REVIEW"].includes(claim.status);
  const alreadyApproved = claim.approvals.some((a) => a.approver_user_id === user.id && a.decision === "APPROVE");
  const paid = Number(claim.paid_paisa);
  const remaining = Number(claim.amount_paisa) - paid;
  const categoryMeta = categories[0];
  const missingRequiredReceipt = Boolean(categoryMeta?.requires_receipt) && claim.docs === 0;

  return (
    <>
      <PageHeader
        eyebrow={`Claim · ${claim.claim_no}`}
        title={claim.description}
        sub={<>
          <Money paisa={Number(claim.amount_paisa)} /> · paid by {claim.paid_by_name} on {formatDateLong(claim.date_ad)}
          {claim.date_bs ? ` (${formatBsLong(claim.date_bs)})` : ""} · <SourceTag synthetic={claim.is_synthetic} sourceType={claim.source_type} />
        </>}
        actions={
          <>
            <PrintButton label="Print claim" />
            <Link className="btn" href="/expenses">All expenses</Link>
            <StatusBadge status={claim.status} />
          </>
        }
      />

      {claim.status === "REJECTED" ? (
        <div className="error-box" style={{ marginBottom: 16 }}>
          <b>Rejected.</b> {claim.rejected_reason ?? "No reason was recorded."} Create a corrected claim if the purchase was legitimate.
        </div>
      ) : null}
      {claim.status === "DISPUTED" || claim.verification_state === "DISPUTED" ? (
        <div className="error-box" style={{ marginBottom: 16 }}>
          <b>Disputed.</b> A reviewer has questioned this claim. It should not be paid or reported as verified until resolved.
        </div>
      ) : null}
      {missingRequiredReceipt && claim.documentation_state !== "COMPLETE" ? (
        <div className="warn-box" style={{ marginBottom: 16 }}>
          <b>Receipt required.</b> No document is attached to this claim. {claim.missing_receipt_declaration ? "A missing-receipt declaration is on file, but the claim remains unverified." : "Attach the receipt or record a declaration before approval."}
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.65fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Claim record</div><span className="tiny muted">Immutable after approval</span></div>
            <div className="card-body">
              <dl className="kv">
                <DefRow label="Description">{claim.description}</DefRow>
                <DefRow label="Purpose">{claim.business_purpose ?? "—"}</DefRow>
                <DefRow label="Merchant / payee">{claim.vendor_name ?? "—"}</DefRow>
                <DefRow label="Category">{claim.category_name} <span className="faint tiny">({claim.category_code})</span></DefRow>
                <DefRow label="Expense date">{formatDateLong(claim.date_ad)}{claim.date_bs ? <span className="muted"> · {formatBsLong(claim.date_bs)} ({claim.date_bs})</span> : null}</DefRow>
                <DefRow label="Event">{claim.event_name ?? "—"}</DefRow>
                <DefRow label="Funding source">{claim.funding_source.replaceAll("_", " ")}</DefRow>
                <DefRow label="Payment method">{claim.payment_method ?? "—"}</DefRow>
                <DefRow label="Invoice no.">{claim.invoice_no ?? "—"}</DefRow>
                <DefRow label="Seller PAN">{claim.seller_pan ?? "—"}</DefRow>
                <DefRow label="Claimant">{claim.claimant_name} <span className="faint tiny">· {claim.claimant_email}</span></DefRow>
                <DefRow label="Paid by (member)">{claim.paid_by_name}</DefRow>
                <DefRow label="Advance">{claim.advance ? <Link className="link" href={`/advances/${claim.advance.id}`}>{claim.advance.ref}</Link> : "—"}</DefRow>
                <DefRow label="Created">{formatTimestamp(claim.created_at)}</DefRow>
                <DefRow label="Evidence state"><StatusBadge status={claim.documentation_state} /> <StatusBadge status={claim.verification_state} /></DefRow>
                {claim.notes ? <DefRow label="Notes"><span style={{ whiteSpace: "pre-wrap" }}>{claim.notes}</span></DefRow> : null}
                {claim.missing_receipt_declaration ? <DefRow label="Declaration"><span style={{ whiteSpace: "pre-wrap" }}>{claim.missing_receipt_declaration}</span></DefRow> : null}
              </dl>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <div className="section-title">Evidence</div>
                <div className="section-sub">{claim.documents.length} document{claim.documents.length === 1 ? "" : "s"} attached</div>
              </div>
              <Link className="btn btn-sm" href="/receipts">Upload receipt</Link>
            </div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {claim.documents.length ? claim.documents.map((doc) => (
                <div className="list-row" key={doc.id}>
                  <span className="icon-box" style={{ background: "var(--accent-soft)", color: "var(--accent-ink)" }}><FileText size={14} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small" style={{ fontWeight: 500 }}>{doc.filename}</div>
                    <div className="tiny muted">
                      {doc.doc_type} · {(Number(doc.size_bytes) / 1024).toFixed(0)} KB · uploaded {formatTimestamp(doc.uploaded_at)}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                      <StatusBadge status={doc.status} />
                      <StatusBadge status={doc.review_status} />
                      {Object.keys(doc.extracted ?? {}).length ? <span className="badge badge-blue">Fields extracted</span> : null}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <a className="btn btn-xs" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">Open</a>
                    <Link className="btn btn-xs" href={`/receipts/${doc.id}`}>Review</Link>
                  </div>
                </div>
              )) : (
                <div className="tiny muted" style={{ padding: "14px 0" }}>
                  No evidence attached. {canManageDocs ? "Upload the receipt from the Receipts page and attach it to this claim." : "Ask the claimant or finance team to upload the receipt."}
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Approvals & verification</div><span className="tiny muted">{approvalRequirementLabel(Number(claim.amount_paisa), settings)}</span></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {claim.approvals.length ? claim.approvals.map((a) => (
                <div className="list-row" key={a.id}>
                  <StatusBadge status={a.decision === "APPROVE" ? "APPROVED" : a.decision === "REJECT" ? "REJECTED" : a.decision === "VERIFY" ? "VERIFIED" : "UNDER_REVIEW"} />
                  <div style={{ flex: 1 }}>
                    <div className="small">{a.approver_name} <span className="muted">· {a.approver_role.replaceAll("_", " ").toLowerCase()}</span></div>
                    <div className="tiny muted">{a.tier.toLowerCase()} tier · {formatTimestamp(a.created_at)}</div>
                    {a.reason ? <div className="tiny" style={{ marginTop: 2 }}>“{a.reason}”</div> : null}
                  </div>
                </div>
              )) : <div className="tiny muted" style={{ padding: "14px 0" }}>No approval decisions yet.</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Payments</div><span className="tiny muted">{claim.payments.length} recorded</span></div>
            <div className="table-wrap">
              {claim.payments.length ? (
                <table className="data">
                  <thead><tr><th>Reference</th><th>Date</th><th>Type</th><th>Account</th><th className="right">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {claim.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.ref}</td>
                        <td>{formatDateLong(p.date_ad)}</td>
                        <td>{p.type.replaceAll("_", " ").toLowerCase()}</td>
                        <td>{p.account_name ?? "—"}</td>
                        <td className="right mono">{formatNPR(Number(p.amount_paisa))}</td>
                        <td><StatusBadge status={p.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">Nothing paid yet.</div>}
            </div>
            <div className="card-foot" style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="small">Paid <Money paisa={paid} /></span>
              <span className="small">Outstanding <b><Money paisa={Math.max(0, remaining)} /></b></span>
            </div>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 16, position: "sticky", top: 24 }}>
            <div className="card-head"><div className="section-title">Actions</div></div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              <div>
                <div className="stat-label">Status</div>
                <div style={{ marginTop: 4 }}><StatusBadge status={claim.status} /></div>
              </div>

              {claim.status === "DRAFT" && claim.claimant_user_id === user.id ? (
                <ActionForm action={submitClaimAction} submitLabel="Submit for approval" submitClass="btn btn-primary" hideStatus>
                  <input type="hidden" name="claimId" value={claim.id} />
                </ActionForm>
              ) : null}

              {awaiting && (claim.claimant_user_id === user.id || can(user.role, "settings.manage", user.permissions)) ? (
                <QuickAction action={withdrawClaimAction} label="Withdraw claim" fields={{ claimId: claim.id }} className="btn btn-sm" confirm="Withdraw this claim? It will leave the approval queue." />
              ) : null}

              {canApprove && awaiting ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div className="hairline" />
                  <div className="label">Your decision</div>
                  {alreadyApproved ? (
                    <div className="info-box">You have already approved this claim. A different approver must complete the requirement.</div>
                  ) : (
                    <>
                      <ActionForm action={decideClaimAction} submitLabel="Approve" submitClass="btn btn-accent" hideStatus>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="decision" value="APPROVE" />
                      </ActionForm>
                      <ActionForm action={decideClaimAction} submitLabel="Request changes" submitClass="btn" hideStatus>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="decision" value="REQUEST_CHANGES" />
                        <div className="field" style={{ marginBottom: 8 }}>
                          <label className="label" htmlFor="changes-reason">What needs fixing?</label>
                          <textarea id="changes-reason" name="reason" placeholder="e.g. Attach the VAT invoice, or correct the date." />
                        </div>
                      </ActionForm>
                      <ActionForm action={decideClaimAction} submitLabel="Reject" submitClass="btn btn-danger" confirm="Reject this claim? This is final; a corrected claim would need to be created." hideStatus>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <div className="field" style={{ marginBottom: 8 }}>
                          <label className="label" htmlFor="reject-reason">Rejection reason <span className="req">*</span></label>
                          <textarea id="reject-reason" name="reason" required placeholder="Required. Explain what is wrong." />
                        </div>
                      </ActionForm>
                    </>
                  )}
                </div>
              ) : null}

              {canPay && ["APPROVED", "PAYMENT_PENDING", "REIMBURSED", "VERIFIED"].includes(claim.status) && remaining > 0 ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div className="hairline" />
                  <div className="label">Record payment</div>
                  <ActionForm action={recordPaymentAction} submitLabel="Record payment" submitClass="btn btn-primary" hideStatus>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="label" htmlFor="pay-amount">Amount</label>
                      <input id="pay-amount" name="amount" required defaultValue={(remaining / 100).toFixed(2)} inputMode="decimal" />
                    </div>
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="label" htmlFor="pay-account">Pay from</label>
                      <select id="pay-account" name="accountId" required defaultValue={accounts[0]?.id ?? ""}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {formatNPR(Number(a.balance_paisa))}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="label" htmlFor="pay-date">Payment date</label>
                      <input id="pay-date" name="date" type="date" required defaultValue={todayISO()} />
                    </div>
                    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                      <div className="field">
                        <label className="label" htmlFor="pay-method">Method</label>
                        <input id="pay-method" name="method" placeholder="Cash / bank" />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="pay-ref">Reference</label>
                        <input id="pay-ref" name="reference" placeholder="Txn id" />
                      </div>
                    </div>
                  </ActionForm>
                </div>
              ) : null}

              {canVerify && ["APPROVED", "PAYMENT_PENDING", "REIMBURSED", "SETTLED", "UNDER_REVIEW"].includes(claim.status) && claim.verification_state !== "VERIFIED" ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <div className="hairline" />
                  <div className="label">Evidence verification</div>
                  <ActionForm action={verifyClaimAction} submitLabel="Verify evidence" submitClass="btn btn-accent" hideStatus>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="label" htmlFor="verify-note">Note</label>
                      <input id="verify-note" name="note" placeholder="What did you check?" />
                    </div>
                  </ActionForm>
                  <ActionForm action={disputeClaimAction} submitLabel="Flag as disputed" submitClass="btn btn-danger" hideStatus>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="label" htmlFor="dispute-reason">Dispute reason</label>
                      <textarea id="dispute-reason" name="reason" required />
                    </div>
                  </ActionForm>
                </div>
              ) : null}

              {claim.verification_state === "VERIFIED" ? (
                <div className="success-box"><ShieldCheck size={13} style={{ verticalAlign: -2 }} /> Evidence verified {claim.verified_at ? `on ${formatTimestamp(claim.verified_at)}` : ""}.</div>
              ) : null}

              {!canApprove && awaiting ? (
                <Attention icon={<AlertTriangle size={12} />} text="This claim is waiting for an approver. You cannot decide your own claim." />
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Allocation</div></div>
            <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {claim.allocations.map((a) => (
                <div className="list-row" key={a.id} style={{ alignItems: "center" }}>
                  <span className="icon-box badge-blue">{a.event_id ? <Banknote size={13} /> : <Wallet size={13} />}</span>
                  <div style={{ flex: 1 }}>
                    <div className="small">{a.event_name ?? a.department_name ?? "Unallocated"}</div>
                    <div className="tiny muted">{a.event_id ? "Event" : a.department_id ? "Department" : "General"}</div>
                  </div>
                  <Money paisa={Number(a.amount_paisa)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
