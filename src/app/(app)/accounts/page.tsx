import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { accountLedgerEntries, listAccounts } from "@/server/accounts";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatDateLong, formatTimestamp, todayISO } from "@/lib/nepali-date";
import { can } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge, DefRow, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { createAccountAction, recordTransferAction, setOpeningBalanceAction } from "@/app/actions/accounts";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const accounts = await listAccounts(db);
  const manages = can(user.role, "account.manage", user.permissions);
  const selectedId = typeof sp.account === "string" ? sp.account : undefined;
  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0];
  const ledger = selected ? await accountLedgerEntries(db, selected.id, 150) : [];

  const cash = accounts.filter((a) => a.type === "CASH" || a.type === "WALLET").reduce((s, a) => s + Number(a.balance_paisa), 0);
  const bank = accounts.filter((a) => a.type === "BANK").reduce((s, a) => s + Number(a.balance_paisa), 0);

  return (
    <>
      <PageHeader
        eyebrow="Cash & bank"
        title="Accounts"
        sub="Balances here are what the system has recorded — not a bank confirmation. A balance becomes reconciled only after a statement is imported and matched."
        actions={<Link className="btn" href="/reconciliation">Reconcile</Link>}
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Cash & wallets" value={formatNPRShort(cash)} foot="Physical and digital cash" />
        <Stat label="Bank" value={formatNPRShort(bank)} foot="Recorded bank balances" />
        <Stat label="Total" value={formatNPRShort(cash + bank)} foot={`${accounts.length} active accounts`} tone="accent" />
        <Stat label="Reconciled" value={accounts.filter((a) => a.last_reconciled_at).length} foot="Accounts with a completed reconciliation" />
      </section>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head"><div className="section-title">Accounts</div><span className="tiny muted">Balances exclude internal transfers</span></div>
        <div className="table-wrap">
          {accounts.length ? (
            <table className="data">
              <thead><tr><th>Account</th><th>Type</th><th>Institution</th><th className="right">Opening</th><th className="right">In</th><th className="right">Out</th><th className="right">Balance</th><th>Last activity</th><th>Reconciled</th></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} style={selected?.id === a.id ? { background: "#faf9f5" } : undefined}>
                    <td><Link className="row-title link-quiet" href={`/accounts?account=${a.id}`}>{a.name}</Link>{a.identifier_masked ? <div className="row-sub mono">{a.identifier_masked}</div> : null}</td>
                    <td><span className="badge badge-gray">{a.type}</span></td>
                    <td className="muted">{a.institution ?? "—"}</td>
                    <td className="right mono">{formatNPR(Number(a.opening_balance_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.inflow_paisa))}</td>
                    <td className="right mono">{formatNPR(Number(a.outflow_paisa))}</td>
                    <td className="right mono" style={{ fontWeight: 600 }}>{formatNPR(Number(a.balance_paisa))}</td>
                    <td className="muted nowrap">{a.last_activity_on ? formatDateLong(a.last_activity_on) : "—"}</td>
                    <td>{a.last_reconciled_at ? <StatusBadge status="RECONCILED" /> : <span className="tiny muted">Not yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState title="No accounts" text="Create a cash, bank or wallet account before recording payments." />}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.55fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">{selected ? `${selected.name} — ledger` : "Ledger"}</div>
              <div className="section-sub">Most recent 150 movements</div>
            </div>
            {selected ? <span className="badge badge-ink">{selected.type}</span> : null}
          </div>
          <div className="table-wrap">
            {ledger.length ? (
              <table className="data">
                <thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Memo</th><th className="right">In</th><th className="right">Out</th><th>Status</th></tr></thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td className="nowrap">{formatDateLong(entry.date_ad)}</td>
                      <td className="mono">{entry.ref}</td>
                      <td className="muted">{entry.kind.replaceAll("_", " ").toLowerCase()}</td>
                      <td style={{ maxWidth: 240 }}>{entry.memo}</td>
                      <td className="right mono">{entry.direction === "IN" ? formatNPR(Number(entry.amount_paisa)) : "—"}</td>
                      <td className="right mono">{entry.direction === "OUT" ? formatNPR(Number(entry.amount_paisa)) : "—"}</td>
                      <td><StatusBadge status={entry.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="table-empty">No movements recorded for this account.</div>}
          </div>
          {selected && manages ? (
            <div className="card-foot">
              <details>
                <summary className="link small" style={{ cursor: "pointer" }}>Set opening balance</summary>
                <div style={{ marginTop: 10, maxWidth: 480 }}>
                  <ActionForm action={setOpeningBalanceAction} submitLabel="Save opening balance" submitClass="btn btn-sm" hideStatus>
                    <input type="hidden" name="accountId" value={selected.id} />
                    <div style={{ display: "grid", gap: 8 }}>
                      <input name="openingBalance" inputMode="decimal" defaultValue={(Number(selected.opening_balance_paisa) / 100).toFixed(2)} placeholder="0.00" />
                      <input name="reason" placeholder="Source: counted cash box / bank statement dated…" required />
                    </div>
                  </ActionForm>
                  <div className="tiny muted" style={{ marginTop: 6 }}>Only allowed before the account has movements, so history cannot be rewritten.</div>
                </div>
              </details>
            </div>
          ) : null}
        </div>

        {manages ? (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="card">
              <div className="card-head"><div className="section-title">New account</div></div>
              <div className="card-body">
                <ActionForm action={createAccountAction} submitLabel="Create account" resetOnSuccess>
                  <div className="grid" style={{ gap: 10 }}>
                    <div className="field"><label className="label">Name</label><input name="name" required placeholder="e.g. NIC Asia — LOCUS current" /></div>
                    <div className="field">
                      <label className="label">Type</label>
                      <select name="type" defaultValue="BANK"><option value="BANK">Bank</option><option value="CASH">Cash</option><option value="WALLET">Wallet</option></select>
                    </div>
                    <div className="field"><label className="label">Institution</label><input name="institution" /></div>
                    <div className="field"><label className="label">Masked identifier</label><input name="identifierMasked" placeholder="e.g. •••• 4521" /><span className="hint">Never enter a full account number.</span></div>
                    <div className="field"><label className="label">Opening balance (NPR)</label><input name="openingBalance" inputMode="decimal" defaultValue="0" /></div>
                    <div className="field"><label className="label">Opened on</label><input name="openedOn" type="date" /></div>
                    <div className="field"><label className="label">Notes</label><textarea name="notes" /></div>
                  </div>
                </ActionForm>
              </div>
            </div>

            {accounts.length >= 2 ? (
              <div className="card">
                <div className="card-head"><div className="section-title">Internal transfer</div></div>
                <div className="card-body">
                  <ActionForm action={recordTransferAction} submitLabel="Record transfer">
                    <div className="grid" style={{ gap: 10 }}>
                      <div className="field"><label className="label">From</label><select name="fromAccountId" defaultValue={accounts[0]?.id}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
                      <div className="field"><label className="label">To</label><select name="toAccountId" defaultValue={accounts[1]?.id}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
                      <div className="field"><label className="label">Amount</label><input name="amount" inputMode="decimal" required /></div>
                      <div className="field"><label className="label">Date</label><input name="date" type="date" required defaultValue={todayISO()} /></div>
                      <div className="field"><label className="label">Reference</label><input name="reference" /></div>
                      <div className="field"><label className="label">Notes</label><input name="notes" /></div>
                    </div>
                  </ActionForm>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="card"><div className="card-body tiny muted">You have read-only access to accounts. A Finance Manager can add accounts and record transfers.</div></div>
        )}
      </div>
    </>
  );
}
