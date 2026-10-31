import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, one } from "@/server/db";
import { getSettings } from "@/server/settings";
import { can } from "@/lib/permissions";
import { formatNPR } from "@/lib/money";
import { formatTimestamp } from "@/lib/nepali-date";
import { PageHeader, Stat, StatusBadge, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { setReconstructionBaselineAction } from "@/app/actions/settings";
import { AlertTriangle, CheckCircle2, FileSearch, History, Lock } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReconstructionPage() {
  const user = await requirePagePermission("report.view");
  const db = await getDb();
  const settings = await getSettings(db);
  const [counts, batches, sponsors, balanceCounts, lastBaselineAudit] = await Promise.all([
    one<{
      claims: number; historical: number; live: number; synthetic: number; documents: number;
      imported_documents: number; journal: number; reconciliations: number; statements: number;
    }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM expense_claims) AS claims,
        (SELECT COUNT(*)::int FROM expense_claims WHERE source_type='HISTORICAL_IMPORT') AS historical,
        (SELECT COUNT(*)::int FROM expense_claims WHERE source_type='LIVE') AS live,
        (SELECT COUNT(*)::int FROM expense_claims WHERE is_synthetic) AS synthetic,
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM documents WHERE notes LIKE '%historical%' OR doc_type='SPREADSHEET') AS imported_documents,
        (SELECT COUNT(*)::int FROM journal_entries) AS journal,
        (SELECT COUNT(*)::int FROM reconciliations) AS reconciliations,
        (SELECT COUNT(*)::int FROM statement_imports) AS statements`,
    ),
    many<{ id: string; kind: string; filename: string; status: string; created_at: Date; committed_at: Date | null; rows: number; imported: number }>(
      db,
      `SELECT b.id, b.kind, b.filename, b.status, b.created_at, b.committed_at,
              (SELECT COUNT(*)::int FROM import_rows r WHERE r.batch_id=b.id) AS rows,
              (SELECT COUNT(*)::int FROM import_rows r WHERE r.batch_id=b.id AND r.status='IMPORTED') AS imported
         FROM import_batches b ORDER BY b.created_at DESC`,
    ),
    one<{ agreements: number; promised: number; received: number; in_kind: number }>(
      db,
      `SELECT COUNT(*)::int AS agreements,
              COALESCE(SUM(a.promised_paisa),0) AS promised,
              COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0) AS received,
              COUNT(*) FILTER (WHERE a.in_kind)::int AS in_kind
         FROM sponsorship_agreements a`,
    ),
    one<{ cash_opening: number; bank_opening: number; accounts: number }>(
      db,
      `SELECT COALESCE(SUM(opening_balance_paisa) FILTER (WHERE type='CASH'),0) AS cash_opening,
              COALESCE(SUM(opening_balance_paisa) FILTER (WHERE type='BANK'),0) AS bank_opening,
              COUNT(*)::int AS accounts
         FROM financial_accounts WHERE is_active=true`,
    ),
    one<{ actor_name: string; summary: string; created_at: Date }>(
      db,
      `SELECT actor_name, summary, created_at FROM audit_events WHERE action='RECONSTRUCTION_BASELINE_SET' ORDER BY created_at DESC LIMIT 1`,
    ),
  ]);

  const baseline = settings.reconstruction.baselineVersion;
  const hasOpening = (balanceCounts?.cash_opening ?? 0) > 0 || (balanceCounts?.bank_opening ?? 0) > 0;
  const hasHistorical = (counts?.historical ?? 0) > 0;
  const hasStatements = (counts?.statements ?? 0) > 0;
  const hasSponsors = (sponsors?.agreements ?? 0) > 0;

  const steps = [
    {
      title: "Source inventory and audit",
      done: true,
      detail: "Research documents and the supplied workbook were read without modifying them. Findings are recorded in docs/PROJECT_AUDIT.md.",
    },
    {
      title: "Opening balances counted or confirmed",
      done: hasOpening,
      detail: hasOpening
        ? `Opening balances exist for ${balanceCounts?.accounts ?? 0} active account(s). They still need a statement or count reference.`
        : "No non-zero opening balance exists. Every balance currently shown is derived from recorded movements only.",
    },
    {
      title: "Historical expense records imported",
      done: hasHistorical,
      detail: hasHistorical
        ? `${counts?.historical} claim(s) are marked HISTORICAL_IMPORT. Each is unverified until evidence is attached.`
        : "No historical claim has been imported. The workspace deliberately does not invent them.",
    },
    {
      title: "Bank / wallet statements imported",
      done: hasStatements,
      detail: hasStatements
        ? `${counts?.statements} statement import(s) recorded; ${counts?.reconciliations} reconciliation run(s).`
        : "No statement has been imported. Cash and bank balances cannot be called reconciled.",
    },
    {
      title: "Sponsorship agreements reconstructed",
      done: hasSponsors,
      detail: hasSponsors
        ? `${sponsors?.agreements} agreement(s): ${formatNPR(Number(sponsors?.promised))} promised, ${formatNPR(Number(sponsors?.received))} actually received.`
        : "No agreement exists. The supplied sponsor workbook is a partial tier sheet (8 rows, NPR 1,50,000 in total) and is not a complete sponsorship ledger.",
    },
    {
      title: "Baseline locked",
      done: baseline > 0,
      detail: baseline > 0
        ? `Baseline v${baseline} locked${lastBaselineAudit ? ` by ${lastBaselineAudit.actor_name} on ${formatTimestamp(lastBaselineAudit.created_at)}` : ""}.`
        : "No baseline has been locked. Until v1 exists, historical figures are provisional.",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <>
      <PageHeader
        eyebrow="Historical reconstruction"
        title="Rebuild the past without inventing it"
        sub="FINANCE TRACKER’s earlier finances are reconstructed from evidence: statements, receipts, agreements and signed minutes. A blank field stays blank until a source supports it. This page shows what is actually known."
        actions={<Link className="btn" href="/import-export">Import & export</Link>}
      />

      <section className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Reconstruction readiness" value={`${doneCount} / ${steps.length}`} foot="Evidence stages completed" tone={doneCount === steps.length ? "accent" : "warn"} />
        <Stat label="Baseline" value={baseline === 0 ? "Not locked" : `v${baseline}`} foot={baseline === 0 ? "Historical figures are provisional" : "Locked with an audit record"} />
        <Stat label="Historical claims" value={counts?.historical ?? 0} foot={`${counts?.synthetic ?? 0} synthetic demo row(s) kept separate`} />
        <Stat label="Evidence documents" value={counts?.documents ?? 0} foot={`${counts?.journal ?? 0} journal entries in total`} />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", marginBottom: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Reconstruction plan</div>
              <div className="section-sub">Each stage is a gate. Do not present a later stage as complete while an earlier one is open.</div>
            </div>
            <History size={16} className="muted" />
          </div>
          <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
            {steps.map((step, index) => (
              <div className="list-row" key={step.title} style={{ alignItems: "flex-start", padding: "13px 0" }}>
                <span className={`icon-box ${step.done ? "badge-green" : "badge-amber"}`} style={{ width: 28, height: 28 }}>
                  {step.done ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                </span>
                <div style={{ flex: 1 }}>
                  <div className="small" style={{ fontWeight: 600 }}>
                    {index + 1}. {step.title}
                  </div>
                  <div className="tiny muted" style={{ maxWidth: "60ch" }}>{step.detail}</div>
                </div>
                <StatusBadge status={step.done ? "DONE" : "PENDING"} />
              </div>
            ))}
          </div>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="section-title">What the source material contains</div>
                <div className="section-sub">Observed, not assumed.</div>
              </div>
              <FileSearch size={16} className="muted" />
            </div>
            <div className="card-body grid" style={{ gap: 12 }}>
              <div className="attention">
                <span className="icon-box badge-amber"><AlertTriangle size={12} /></span>
                <span><b>Sponsor workbook:</b> 8 tier rows totalling <b>NPR 1,50,000</b>. It is an incomplete extract, not a full receipt ledger, and cannot be used to claim money was received.</span>
              </div>
              <div className="attention">
                <span className="icon-box badge-green"><Lock size={12} /></span>
                <span><b>Personal wallet statement:</b> withheld on purpose. It belongs to an individual, not FINANCE TRACKER, and its holder name and account number must not be imported or displayed.</span>
              </div>
              <div className="attention" style={{ borderBottom: 0 }}>
                <span className="icon-box badge-blue"><History size={12} /></span>
                <span><b>Research documents:</b> 13 planning files and the supplied archive are preserved untouched in the repository root for traceability.</span>
              </div>
              <div className="info-box">
                Imported rows are always flagged <b>Imported</b> or <b>Synthetic</b>. A screenshot or OCR candidate is never promoted
                to a verified balance automatically.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="section-title">Lock a verified baseline</div>
                <div className="section-sub">{can(user.role, "settings.manage", user.permissions) ? "Only lock after the stages above are evidenced." : "Requires settings.manage."}</div>
              </div>
            </div>
            <div className="card-body">
              {can(user.role, "settings.manage", user.permissions) ? (
                <ActionForm action={setReconstructionBaselineAction} submitLabel="Record baseline" className="grid" confirm="Record a new reconstruction baseline? The previous value stays in the audit trail.">
                  <div className="field">
                    <label className="label" htmlFor="version">Baseline version</label>
                    <input id="version" name="version" type="number" min={0} defaultValue={baseline + 1} required />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="note">What was verified?</label>
                    <textarea id="note" name="note" rows={3} required placeholder="e.g. Cash count of 2026-07-17 agreed to the cash box; NIC Asia statement to Ashadh end reconciled." />
                  </div>
                </ActionForm>
              ) : (
                <div className="tiny muted">Ask the Finance Manager to lock a baseline once the evidence is complete.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="section-title">Bulk import batches</div>
            <div className="section-sub">Every spreadsheet import is staged, previewed and row-accounted. Nothing is silently accepted.</div>
          </div>
          <span className="badge badge-gray">{batches.length}</span>
        </div>
        <div className="table-wrap">
          {batches.length ? (
            <table className="data">
              <thead><tr><th>Created</th><th>Kind</th><th>File</th><th className="right">Rows</th><th className="right">Imported</th><th>Status</th><th>Committed</th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td className="small nowrap">{formatTimestamp(b.created_at)}</td>
                    <td className="small">{b.kind}</td>
                    <td className="small">{b.filename}</td>
                    <td className="right mono">{b.rows}</td>
                    <td className="right mono">{b.imported}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="small nowrap">{b.committed_at ? formatTimestamp(b.committed_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No bulk import has been run"
              text="Statement imports are handled under Reconciliation. Spreadsheet reconstruction imports will appear here once a source file is supplied and previewed."
              action={<Link className="btn btn-sm" href="/reconciliation">Open reconciliation</Link>}
            />
          )}
        </div>
      </div>
    </>
  );
}
