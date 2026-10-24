import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb } from "@/server/db";
import {
  listAccounts, listReconciliations, listStatementImports, paymentCandidatesForImport,
  statementLines, unreconciledSummary,
} from "@/server/accounts";
import { formatNPR, paisaToDecimal } from "@/lib/money";
import { daysBetween, formatDateLong, formatTimestamp, todayISO } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState } from "@/components/ui";
import { ActionForm, QuickAction } from "@/components/ActionForm";
import { confirmMatchAction, importStatementAction, runReconciliationAction, unmatchAction } from "@/app/actions/reconciliation";
import { CheckCircle2, Scale, Upload } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ import?: string; recon?: string }>;
}) {
  const user = await requirePagePermission("recon.manage");
  const params = await searchParams;
  const db = await getDb();

  const [accounts, imports, reconciliations, summary] = await Promise.all([
    listAccounts(db),
    listStatementImports(db),
    listReconciliations(db),
    unreconciledSummary(db),
  ]);

  const selected = params.import ? imports.find((i) => i.id === params.import) ?? null : null;
  const lines = selected ? await statementLines(db, selected.id) : [];
  const candidates = selected ? await paymentCandidatesForImport(db, selected.id) : [];

  const zeroBalanceAccounts = accounts.filter((a) => a.balance_paisa === 0 && a.type !== "CASH");

  function optionsFor(line: { txn_date: string; debit_paisa: number; credit_paisa: number }) {
    const amount = Number(line.debit_paisa) > 0 ? Number(line.debit_paisa) : Number(line.credit_paisa);
    const direction = Number(line.debit_paisa) > 0 ? "OUT" : "IN";
    return candidates
      .filter((c) => Number(c.amount_paisa) === amount && c.direction === direction && Math.abs(daysBetween(c.date_ad, line.txn_date)) <= 7)
      .sort((a, b) => Math.abs(daysBetween(a.date_ad, line.txn_date)) - Math.abs(daysBetween(b.date_ad, line.txn_date)));
  }

  const lastRecon = reconciliations[0];

  return (
    <>
      <PageHeader
        eyebrow="Bank reconciliation"
        title="Match the ledger to the statement"
        sub="Statement lines are immutable once imported. Matching is evidence: it never changes a balance. A reconciliation only closes when the computed ledger balance equals the statement balance exactly."
        actions={<Link className="btn" href="/accounts">Accounts</Link>}
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Statement imports" value={summary.imports} foot="Files recorded with provenance" />
        <Stat label="Matched lines" value={summary.matched} foot="Confirmed against a payment" tone="accent" />
        <Stat label="Unmatched / suggested" value={summary.unmatched} foot="Needs a human decision" tone={summary.unmatched ? "warn" : undefined} />
        <Stat
          label="Last closed reconciliation"
          value={lastRecon?.status === "RECONCILED" ? formatDateLong(lastRecon.period_end) : "None"}
          foot={lastRecon ? `${lastRecon.account_name} · ${lastRecon.status.toLowerCase()}` : "No reconciliation run yet"}
        />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr)", marginBottom: 20 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Import a statement</div>
              <div className="section-sub">CSV or XLSX exported by the bank or wallet.</div>
            </div>
            <Upload size={16} className="muted" />
          </div>
          <div className="card-body">
            <ActionForm action={importStatementAction} submitLabel="Import statement" className="grid" confirm="Import this statement? Existing duplicate lines will be skipped.">
              <div className="field">
                <label className="label" htmlFor="accountId">Account <span className="req">*</span></label>
                <select id="accountId" name="accountId" required defaultValue={zeroBalanceAccounts[0]?.id ?? accounts[0]?.id ?? ""}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} · {a.type.toLowerCase()} · {formatNPR(a.balance_paisa)}</option>
                  ))}
                </select>
                {accounts.length === 1 ? (
                  <span className="hint">Only the cash box exists. <Link className="link" href="/accounts">Add the bank account</Link> that issued this statement first.</span>
                ) : null}
              </div>
              <div className="field">
                <label className="label" htmlFor="file">Statement file <span className="req">*</span></label>
                <input id="file" name="file" type="file" accept=".csv,.xlsx,.xls,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
                <span className="hint">Header must include a date and a description/narration column, plus debit/credit or withdrawal/deposit.</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="sourceLabel">Source label</label>
                <input id="sourceLabel" name="sourceLabel" placeholder="e.g. NIC Asia current account, Ashadh statement" />
              </div>
            </ActionForm>
            <div className="info-box" style={{ marginTop: 14 }}>
              Scanned PDF statements are not converted here. Export them to CSV from the bank portal, or upload a PDF
              under <Link className="link" href="/receipts">Receipts</Link> for storage while typing the lines manually.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Statement imports</div>
              <div className="section-sub">Imported lines are fingerprinted so the same statement cannot double-count.</div>
            </div>
            <span className="badge badge-gray">{imports.length}</span>
          </div>
          <div className="table-wrap">
            {imports.length ? (
              <table className="data">
                <thead>
                  <tr><th>Imported</th><th>Account</th><th>Period</th><th className="right">Lines</th><th className="right">Matched</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {imports.map((imp) => (
                    <tr key={imp.id} style={selected?.id === imp.id ? { background: "#f6faf8" } : undefined}>
                      <td>
                        <div className="row-title">{imp.source_label}</div>
                        <div className="row-sub">{formatTimestamp(imp.created_at)}</div>
                      </td>
                      <td className="small">{imp.account_name}</td>
                      <td className="small nowrap">
                        {imp.period_start ? formatDateLong(imp.period_start) : "—"}
                        <span className="faint"> → </span>
                        {imp.period_end ? formatDateLong(imp.period_end) : "—"}
                      </td>
                      <td className="right mono">{imp.total}</td>
                      <td className="right mono">{imp.matched}{imp.suggested ? <span className="tiny muted"> +{imp.suggested} suggested</span> : null}</td>
                      <td><StatusBadge status={imp.status} /></td>
                      <td className="right"><Link className="btn btn-xs" href={`/reconciliation?import=${imp.id}`}>Review</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No statements imported" text="Import the first bank or wallet statement to start matching payments to evidence." />
            )}
          </div>
        </div>
      </div>

      {selected ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head">
            <div>
              <div className="section-title">{selected.source_label}</div>
              <div className="section-sub">
                {selected.account_name} · {selected.total} lines · {selected.matched} matched · {selected.suggested} suggested · {selected.unmatched} unmatched
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="badge badge-gray">{selected.status}</span>
              <Link className="btn btn-xs" href="/reconciliation">Close</Link>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th><th>Description</th><th className="right">Out</th><th className="right">In</th>
                  <th>Match</th><th style={{ minWidth: 250 }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const options = optionsFor(line);
                  const suggested = line.matched_payment_id ? candidates.find((c) => c.id === line.matched_payment_id) : null;
                  return (
                    <tr key={line.id}>
                      <td className="small nowrap">{formatDateLong(line.txn_date)}</td>
                      <td>
                        <div className="small">{line.description}</div>
                        {line.notes ? <div className="row-sub">{line.notes}</div> : null}
                      </td>
                      <td className="right mono">{line.debit_paisa ? formatNPR(Number(line.debit_paisa)) : "—"}</td>
                      <td className="right mono">{line.credit_paisa ? formatNPR(Number(line.credit_paisa)) : "—"}</td>
                      <td>
                        <StatusBadge status={line.match_status} />
                        {line.payment_ref ? <div className="row-sub mono">{line.payment_ref}</div> : null}
                      </td>
                      <td>
                        {line.match_status === "MATCHED" ? (
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span className="tiny muted"><CheckCircle2 size={12} style={{ verticalAlign: -2 }} /> Confirmed</span>
                            <QuickAction action={unmatchAction} label="Unmatch" className="btn btn-xs" fields={{ lineId: line.id }} confirm="Remove this match? The line returns to the unmatched queue." />
                          </div>
                        ) : line.match_status === "IGNORED" ? (
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span className="tiny muted">Ignored</span>
                            <QuickAction action={unmatchAction} label="Reopen" className="btn btn-xs" fields={{ lineId: line.id }} />
                          </div>
                        ) : line.match_status === "SUGGESTED" && line.matched_payment_id ? (
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span className="tiny muted">Suggested: <b>{line.payment_ref ?? suggested?.ref ?? "payment"}</b> ({Math.round((line.match_confidence ?? 0) * 100)}%)</span>
                            <QuickAction action={confirmMatchAction} label="Confirm" className="btn btn-xs btn-accent" fields={{ lineId: line.id, paymentId: line.matched_payment_id }} confirm="Confirm this statement line matches that payment?" />
                            <QuickAction action={confirmMatchAction} label="Ignore" className="btn btn-xs btn-ghost" fields={{ lineId: line.id }} />
                          </div>
                        ) : options.length ? (
                          <ActionForm action={confirmMatchAction} submitLabel="Match" submitClass="btn btn-xs" hideStatus className="">
                            <input type="hidden" name="lineId" value={line.id} />
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <select name="paymentId" defaultValue={options[0]?.id} style={{ minWidth: 180, padding: "4px 7px", minHeight: 28, fontSize: 11.5 }}>
                                {options.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.ref} · {formatDateLong(c.date_ad)} · {formatNPR(Number(c.amount_paisa))}{c.payee_name ? ` · ${c.payee_name}` : ""}
                                  </option>
                                ))}
                              </select>
                              <button type="submit" className="btn btn-xs">Match</button>
                            </div>
                          </ActionForm>
                        ) : null}
                        {line.match_status !== "MATCHED" && line.match_status !== "IGNORED" ? (
                          <div style={{ marginTop: 5 }}>
                            <QuickAction action={confirmMatchAction} label="Ignore line" className="btn btn-xs btn-ghost" fields={{ lineId: line.id }} confirm="Ignore this line? Use this for bank charges already recorded elsewhere or lines outside LOCUS." />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)" }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Close a period</div>
              <div className="section-sub">Only possible when the ledger and statement agree to the paisa.</div>
            </div>
            <Scale size={16} className="muted" />
          </div>
          <div className="card-body">
            {selected ? (
              <ActionForm action={runReconciliationAction} submitLabel="Run reconciliation" className="grid" confirm="Run reconciliation for this period?">
                <input type="hidden" name="accountId" value={selected.account_id} />
                <input type="hidden" name="importId" value={selected.id} />
                <div className="grid grid-2">
                  <div className="field">
                    <label className="label" htmlFor="periodStart">Period start</label>
                    <input id="periodStart" name="periodStart" type="date" defaultValue={selected.period_start ?? todayISO()} required />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="periodEnd">Period end</label>
                    <input id="periodEnd" name="periodEnd" type="date" defaultValue={selected.period_end ?? todayISO()} required />
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="statementBalance">Statement closing balance (NPR)</label>
                  <input id="statementBalance" name="statementBalance" defaultValue={paisaToDecimal(Number(selected.closing_balance_paisa ?? 0))} inputMode="decimal" required />
                  <span className="hint">Taken from the statement itself, not typed from memory.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="notes">Notes</label>
                  <textarea id="notes" name="notes" rows={2} placeholder="Explain any unresolved difference." />
                </div>
              </ActionForm>
            ) : (
              <EmptyState title="Select a statement first" text="Open an import above, review its lines, then close the period here." />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Reconciliation history</div>
              <div className="section-sub">A non-zero difference stays open and visible. Nothing is forced to zero.</div>
            </div>
            <span className="badge badge-gray">{reconciliations.length}</span>
          </div>
          <div className="table-wrap">
            {reconciliations.length ? (
              <table className="data">
                <thead>
                  <tr><th>Account</th><th>Period</th><th className="right">Computed</th><th className="right">Statement</th><th className="right">Difference</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {reconciliations.map((r) => (
                    <tr key={r.id}>
                      <td className="small">{r.account_name}</td>
                      <td className="small nowrap">{formatDateLong(r.period_start)} → {formatDateLong(r.period_end)}</td>
                      <td className="right mono">{formatNPR(Number(r.computed_balance_paisa))}</td>
                      <td className="right mono">{r.statement_balance_paisa == null ? "—" : formatNPR(Number(r.statement_balance_paisa))}</td>
                      <td className="right mono" style={{ color: Number(r.difference_paisa ?? 0) === 0 ? "var(--accent)" : "var(--danger)" }}>
                        {r.difference_paisa == null ? "—" : formatNPR(Number(r.difference_paisa))}
                      </td>
                      <td><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No reconciliations yet" text="Once a statement is imported and reviewed, close the period here. Open differences are kept, never hidden." />
            )}
          </div>
        </div>
      </div>

      <div className="info-box" style={{ marginTop: 18 }}>
        Bank charges, interest and transfers that exist only on the statement are not silently posted. Record them in
        <Link className="link" href="/accounts"> Accounts</Link> or as an expense, then re-import or re-match. This keeps the
        ledger explainable to an auditor.
      </div>
    </>
  );
}
