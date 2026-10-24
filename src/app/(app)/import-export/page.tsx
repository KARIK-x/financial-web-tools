import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, one } from "@/server/db";
import { currentFiscalPeriod } from "@/server/reports";
import { formatDateLong, formatTimestamp } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState } from "@/components/ui";
import { Download, FileSpreadsheet, ShieldCheck, Upload } from "lucide-react";

export const dynamic = "force-dynamic";

const EXPORTS = [
  { type: "claims", label: "Expense claims", detail: "Every claim with amounts in paisa, status, evidence state, funding source and synthetic flag." },
  { type: "payments", label: "Payments", detail: "Recorded cash/bank movements, payee and account. Internal transfers included." },
  { type: "journal", label: "General journal", detail: "One row per journal line, with entry number, memo, debit and credit." },
  { type: "trial-balance", label: "Trial balance", detail: "Period totals per ledger account, including the net balance." },
  { type: "cashflow", label: "Cash flow", detail: "Monthly income, expenditure, advance movement and net cash." },
  { type: "categories", label: "Spend by category", detail: "Claim counts, totals and verified share per expense category." },
  { type: "events", label: "Spend by event", detail: "Allocated spend and verified amounts per event." },
  { type: "sponsors", label: "Sponsorship", detail: "Promised, received and outstanding, with in-kind flags kept separate." },
  { type: "budgets", label: "Budget vs actual", detail: "One row per budget line with incurred, paid and variance." },
  { type: "advances", label: "Advances", detail: "Issued, used, returned, outstanding and days outstanding." },
  { type: "accounts", label: "Account balances", detail: "Opening balance, derived balance, inflows/outflows and last reconciliation." },
  { type: "bank-lines", label: "Bank statement lines", detail: "Imported lines with match state and the matched payment reference." },
  { type: "audit", label: "Audit trail", detail: "Append-only event log for the period. Payloads are included in JSON only." },
] as const;

export default async function ImportExportPage() {
  await requirePagePermission("import.run");
  const db = await getDb();
  const period = await currentFiscalPeriod(db);
  const [statementImports, batches, counts, coverage] = await Promise.all([
    many<{ id: string; source_label: string; account_name: string; status: string; created_at: Date; lines: number; matched: number }>(
      db,
      `SELECT si.id, si.source_label, fa.name AS account_name, si.status, si.created_at,
              (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id) AS lines,
              (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id AND b.match_status='MATCHED') AS matched
         FROM statement_imports si JOIN financial_accounts fa ON fa.id=si.account_id
        ORDER BY si.created_at DESC LIMIT 25`,
    ),
    many<{ id: string; kind: string; filename: string; status: string; created_at: Date; rows: number }>(
      db,
      `SELECT b.id, b.kind, b.filename, b.status, b.created_at,
              (SELECT COUNT(*)::int FROM import_rows r WHERE r.batch_id=b.id) AS rows
         FROM import_batches b ORDER BY b.created_at DESC LIMIT 25`,
    ),
    one<{ claims: number; real: number; synthetic: number; imported: number; documents: number; audit: number }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM expense_claims) AS claims,
        (SELECT COUNT(*)::int FROM expense_claims WHERE NOT is_synthetic) AS real,
        (SELECT COUNT(*)::int FROM expense_claims WHERE is_synthetic) AS synthetic,
        (SELECT COUNT(*)::int FROM expense_claims WHERE source_type='HISTORICAL_IMPORT') AS imported,
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM audit_events) AS audit`,
    ),
    one<{ claims_total: number; claims_verified: number; docs_total: number; docs_reviewed: number }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM expense_claims) AS claims_total,
        (SELECT COUNT(*)::int FROM expense_claims WHERE verification_state='VERIFIED') AS claims_verified,
        (SELECT COUNT(*)::int FROM documents) AS docs_total,
        (SELECT COUNT(*)::int FROM documents WHERE review_status IN ('ACCEPTED','CORRECTED')) AS docs_reviewed`,
    ),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Import & export"
        title="Move data without losing its provenance"
        sub="Exports are generated from the same queries as the reports. Imports are staged, fingerprinted and attributed. Nothing here turns a receipt image into a verified payment by itself."
        actions={<Link className="btn" href="/reconstruction">Reconstruction status</Link>}
      />

      <section className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Claims in ledger" value={counts?.claims ?? 0} foot={`${counts?.real ?? 0} real · ${counts?.synthetic ?? 0} synthetic`} />
        <Stat label="Historical imports" value={counts?.imported ?? 0} foot="Marked HISTORICAL_IMPORT" tone={(counts?.imported ?? 0) > 0 ? "accent" : undefined} />
        <Stat label="Documents stored" value={counts?.documents ?? 0} foot={`${coverage?.docs_reviewed ?? 0} reviewed`} />
        <Stat label="Audit events" value={counts?.audit ?? 0} foot="Append-only" />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", marginBottom: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Available exports</div>
              <div className="section-sub">
                Period: {formatDateLong(period.from)} → {formatDateLong(period.to)}. Append <code>?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> to override.
              </div>
            </div>
            <Download size={16} className="muted" />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Dataset</th><th>Contents</th><th className="right">Download</th></tr></thead>
              <tbody>
                {EXPORTS.map((item) => (
                  <tr key={item.type}>
                    <td className="row-title nowrap">{item.label}</td>
                    <td className="small muted" style={{ maxWidth: 420 }}>{item.detail}</td>
                    <td className="right nowrap">
                      <a className="btn btn-xs" href={`/api/export/${item.type}?format=csv&from=${period.from}&to=${period.to}`}>CSV</a>{" "}
                      <a className="btn btn-xs" href={`/api/export/${item.type}?format=json&from=${period.from}&to=${period.to}`}>JSON</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-foot">
            <div className="tiny muted">
              Every export writes an <b>EXPORT_RUN</b> audit event. Money is exported as integer paisa plus a decimal NPR
              string. Text beginning with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> is prefixed with an
              apostrophe to prevent spreadsheet formula execution.
            </div>
          </div>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="section-title">Import paths</div>
                <div className="section-sub">Only two bulk paths are implemented in this build.</div>
              </div>
              <Upload size={16} className="muted" />
            </div>
            <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
              <div className="list-row">
                <span className="icon-box badge-blue"><FileSpreadsheet size={13} /></span>
                <div style={{ flex: 1 }}>
                  <div className="small" style={{ fontWeight: 500 }}>Bank / wallet statements</div>
                  <div className="tiny muted">CSV or XLSX, imported under Reconciliation. Lines are fingerprinted, duplicates skipped, and matching is a manual confirmation.</div>
                  <Link className="link tiny" href="/reconciliation">Open reconciliation →</Link>
                </div>
              </div>
              <div className="list-row">
                <span className="icon-box badge-blue"><Upload size={13} /></span>
                <div style={{ flex: 1 }}>
                  <div className="small" style={{ fontWeight: 500 }}>Receipts and evidence</div>
                  <div className="tiny muted">Images/PDFs up to 10 MB. Exact duplicates are blocked by SHA-256; near-duplicates are flagged for review. OCR output is a candidate only.</div>
                  <Link className="link tiny" href="/receipts">Open receipts →</Link>
                </div>
              </div>
              <div className="list-row" style={{ borderBottom: 0 }}>
                <span className="icon-box badge-amber"><ShieldCheck size={13} /></span>
                <div style={{ flex: 1 }}>
                  <div className="small" style={{ fontWeight: 500 }}>Not implemented: generic spreadsheet import</div>
                  <div className="tiny muted">Historical claims and sponsor ledgers cannot be bulk-imported yet. Recording them without a reviewed importer would risk fabricating money; the gap is documented in KNOWN_BUGS.md.</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Data quality</div></div>
            <div className="card-body grid" style={{ gap: 10 }}>
              <div className="kv" style={{ gridTemplateColumns: "150px 1fr" }}>
                <dt>Claims verified</dt><dd className="num">{coverage?.claims_verified ?? 0} / {coverage?.claims_total ?? 0}</dd>
                <dt>Documents reviewed</dt><dd className="num">{coverage?.docs_reviewed ?? 0} / {coverage?.docs_total ?? 0}</dd>
                <dt>Claims (real / synthetic)</dt><dd className="num">{counts?.real ?? 0} / {counts?.synthetic ?? 0}</dd>
                <dt>Statement imports</dt><dd className="num">{statementImports.length}</dd>
              </div>
              <div className="warn-box">
                An export is a point-in-time extract, not a backup. Copy <code>.data/pglite</code> and <code>.data/documents</code> together while the app is stopped.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Statement imports</div>
              <div className="section-sub">Source files are attributed and line counts are auditable.</div>
            </div>
            <span className="badge badge-gray">{statementImports.length}</span>
          </div>
          <div className="table-wrap">
            {statementImports.length ? (
              <table className="data">
                <thead><tr><th>Source</th><th>Account</th><th className="right">Lines</th><th className="right">Matched</th><th>Status</th><th>Imported</th></tr></thead>
                <tbody>
                  {statementImports.map((s) => (
                    <tr key={s.id}>
                      <td className="small">{s.source_label}</td>
                      <td className="small">{s.account_name}</td>
                      <td className="right mono">{s.lines}</td>
                      <td className="right mono">{s.matched}</td>
                      <td><StatusBadge status={s.status} /></td>
                      <td className="small nowrap">{formatTimestamp(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="No statements imported" text="Bank and wallet statements arrive through Reconciliation." action={<Link className="btn btn-sm" href="/reconciliation">Import a statement</Link>} />}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Staged import batches</div>
              <div className="section-sub">Reserved for preview/commit imports. Empty until a reviewed importer is added.</div>
            </div>
            <span className="badge badge-gray">{batches.length}</span>
          </div>
          <div className="table-wrap">
            {batches.length ? (
              <table className="data">
                <thead><tr><th>File</th><th>Kind</th><th className="right">Rows</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td className="small">{b.filename}</td>
                      <td className="small">{b.kind}</td>
                      <td className="right mono">{b.rows}</td>
                      <td><StatusBadge status={b.status} /></td>
                      <td className="small nowrap">{formatTimestamp(b.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="No staged batches" text="Spreadsheet batches will appear here after a preview is created. The table exists so an unfinished import can never be mistaken for committed data." />}
          </div>
        </div>
      </div>

      <div className="info-box" style={{ marginTop: 18 }}>
        Access requires <b>import.run</b>. Downloads also require <b>export.run</b>; an auditor who can read reports but not
        export is prevented from removing personal data in bulk. The role matrix is on <Link className="link" href="/settings">Settings</Link>.
      </div>
    </>
  );
}
