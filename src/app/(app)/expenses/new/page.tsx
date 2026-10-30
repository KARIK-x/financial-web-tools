import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { getSettings } from "@/server/settings";
import { listAdvances } from "@/server/advances";
import { formatNPR } from "@/lib/money";
import { PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { AmountField, DateField } from "@/components/ExpenseFields";
import { createExpenseAction } from "@/app/actions/expenses";

export const dynamic = "force-dynamic";

export default async function NewExpensePage() {
  const user = await requireUser();
  const db = await getDb();
  const [categories, events, departments, settings, advances] = await Promise.all([
    many<{ id: string; name: string; group_name: string; requires_receipt: boolean }>(
      db, `SELECT id, name, group_name, requires_receipt FROM expense_categories WHERE is_active ORDER BY sort_order`,
    ),
    many<{ id: string; name: string; code: string }>(db, `SELECT id, name, code FROM events WHERE status <> 'ARCHIVED' ORDER BY starts_on DESC NULLS LAST`),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM departments WHERE is_active ORDER BY name`),
    getSettings(db),
    user.memberId ? listAdvances(db, { memberId: user.memberId, status: "OUTSTANDING" }) : Promise.resolve([]),
  ]);

  const groups = [...new Set(categories.map((c) => c.group_name))];
  const noMember = !user.memberId;

  return (
    <>
      <PageHeader
        eyebrow="New claim"
        title="Record an expense"
        sub="Attach the receipt before submitting. If you paid personally, approving the claim creates a reimbursement payable to you; it is not paid automatically."
        actions={<Link className="btn" href="/expenses">Cancel</Link>}
      />

      {noMember ? (
        <div className="error-box" style={{ marginBottom: 16 }}>
          Your login is not linked to a member record, so a claim cannot be created. Ask the Finance Manager to link
          your user account to a member on the Members page.
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Claim details</div>
              <div className="section-sub">Required fields are marked with an asterisk.</div>
            </div>
            <span className="badge badge-gray">{user.memberId ? "Linked to member record" : "No member record"}</span>
          </div>
          <div className="card-body">
            <ActionForm action={createExpenseAction} submitLabel="Save & submit">
              <div className="form-grid">
                <DateField />
                <div className="field">
                  <label className="label" htmlFor="categoryId">Category <span className="req">*</span></label>
                  <select id="categoryId" name="categoryId" defaultValue="auto">
                    <option value="auto">Auto-detect from merchant and description (recommended)</option>
                    {groups.map((group) => (
                      <optgroup key={group} label={group}>
                        {categories.filter((c) => c.group_name === group).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}{c.requires_receipt ? "" : " (receipt optional)"}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div className="field span-2">
                  <div className="section-title" style={{ fontSize: 13, marginBottom: 6 }}>Line items (optional)</div>
                  <div className="tiny muted" style={{ marginBottom: 8 }}>Quantity × unit price is calculated automatically. Item totals must equal the expense total.</div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit price</th><th>Discount</th><th>Tax</th></tr></thead>
                      <tbody>
                        {[0,1,2].map((i) => (
                          <tr key={i}>
                            <td><input name="itemDescription" placeholder="Item" /></td>
                            <td><input name="itemQty" inputMode="decimal" placeholder="1" defaultValue={i === 0 ? "1" : ""} /></td>
                            <td><input name="itemUnit" placeholder="pcs" /></td>
                            <td><input name="itemUnitPrice" inputMode="decimal" placeholder="0.00" /></td>
                            <td><input name="itemDiscount" inputMode="decimal" placeholder="0.00" /></td>
                            <td><input name="itemTax" inputMode="decimal" placeholder="0.00" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="field span-2">
                  <label className="label" htmlFor="vendorName">Paid to / merchant <span className="req">*</span></label>
                  <input id="vendorName" name="vendorName" required placeholder="e.g. Sagar Stationery, Nabil Bank, Pathao" maxLength={160} />
                </div>

                <div className="field span-2">
                  <label className="label" htmlFor="description">What was purchased <span className="req">*</span></label>
                  <input id="description" name="description" required minLength={3} maxLength={300} placeholder="e.g. 200 A4 sheets and 4 marker pens for the orientation workshop" />
                </div>

                <div className="field">
                  <AmountField thresholds={settings.approval} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="businessPurpose">Business purpose</label>
                  <input id="businessPurpose" name="businessPurpose" maxLength={500} placeholder="Why LOCUS needed this" />
                </div>

                <div className="field">
                  <label className="label">Who paid? <span className="req">*</span></label>
                  <select name="fundingSource" defaultValue="PERSONAL">
                    <option value="PERSONAL">I paid personally — reimburse me</option>
                    <option value="LOCUS_CASH">Paid from LOCUS cash</option>
                    <option value="LOCUS_BANK">Paid from LOCUS bank / wallet</option>
                  </select>
                  <span className="hint">Personal claims create a payable to your member record once approved.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="paymentMethod">Payment method</label>
                  <input id="paymentMethod" name="paymentMethod" placeholder="Cash, eSewa, Fonepay, card…" maxLength={60} />
                </div>

                <div className="field">
                  <label className="label" htmlFor="eventId">Charge to event</label>
                  <select id="eventId" name="eventId" defaultValue="">
                    <option value="">No event</option>
                    {events.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="departmentId">Charge to department</label>
                  <select id="departmentId" name="departmentId" defaultValue="">
                    <option value="">No department</option>
                    {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>

                {advances.length ? (
                  <div className="field span-2">
                    <label className="label" htmlFor="advanceId">Settle against an advance</label>
                    <select id="advanceId" name="advanceId" defaultValue="">
                      <option value="">No advance</option>
                      {advances.map((a) => (
                        <option key={a.id} value={a.id}>{a.ref} — outstanding {formatNPR(Number(a.outstanding_paisa))}</option>
                      ))}
                    </select>
                    <span className="hint">Using an advance posts against advances receivable instead of creating a payable.</span>
                  </div>
                ) : null}

                <div className="field span-2">
                  <label className="label" htmlFor="notes">Notes</label>
                  <textarea id="notes" name="notes" maxLength={1000} placeholder="Anything the approver or auditor should know" />
                </div>
              </div>

              <hr className="divider" />

              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div className="field">
                  <label className="label" htmlFor="invoiceNo">Invoice / bill number</label>
                  <input id="invoiceNo" name="invoiceNo" maxLength={80} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="sellerPan">Seller PAN / VAT</label>
                  <input id="sellerPan" name="sellerPan" maxLength={20} />
                </div>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label className="label" htmlFor="files">Receipt or invoice</label>
                <input id="files" name="files" type="file" multiple accept="image/*,application/pdf" />
                <span className="hint">Up to 6 files, 10 MB each. Files are SHA-256 hashed; uploading the same receipt twice is blocked.</span>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label className="label" htmlFor="missingReceiptDeclaration">Missing-receipt declaration</label>
                <textarea id="missingReceiptDeclaration" name="missingReceiptDeclaration" maxLength={1000} placeholder="If no receipt exists, state what happened and who can confirm it. This is kept on the record and shown to approvers." />
                <span className="hint">Filling this in does not mark the claim verified. Verification is a separate step by a second person.</span>
              </div>

              <label className="check" style={{ marginTop: 18 }}>
                <input type="checkbox" name="submitNow" defaultChecked />
                <span><b>Submit for approval now.</b> Uncheck to keep this as a draft you can edit or discard.</span>
              </label>
            </ActionForm>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">How approval works</div></div>
            <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-2)", display: "grid", gap: 12 }}>
              <div>
                <div className="tiny uppercase muted">Up to {formatNPR(settings.approval.standard)}</div>
                <div>One finance-team approval.</div>
              </div>
              <div>
                <div className="tiny uppercase muted">Above {formatNPR(settings.approval.standard)}</div>
                <div>Finance approval plus an executive approval — from two different people.</div>
              </div>
              <div>
                <div className="tiny uppercase muted">Above {formatNPR(settings.approval.committee)}</div>
                <div>Both approvals plus a committee resolution reference recorded on the claim.</div>
              </div>
              <div className="warn-box" style={{ padding: "8px 10px" }}>
                You can never approve your own claim. The database also refuses it.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Evidence standard</div></div>
            <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-2)", display: "grid", gap: 10 }}>
              <p>A receipt is required for most categories. If it is genuinely unavailable, the declaration above is kept and the claim stays visibly unverified.</p>
              <p>OCR only proposes fields. A human must check the merchant, date and total against the image before they are used.</p>
              <p className="tiny muted">Files live in private storage and are served only through an authorised route. They are never public URLs.</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
