import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, one } from "@/server/db";
import { formatTimestamp } from "@/lib/nepali-date";
import { PageHeader, Stat, Pagination, EmptyState, StatusBadge } from "@/components/ui";
import { ShieldCheck, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; entity?: string; action?: string; actor?: string; from?: string; to?: string; page?: string }>;
}) {
  await requirePagePermission("audit.view");
  const db = await getDb();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const params: unknown[] = [];
  const clauses: string[] = [];
  if (sp.q) {
    params.push(`%${sp.q.toLowerCase()}%`);
    clauses.push(`(lower(a.summary) LIKE $${params.length} OR lower(a.action) LIKE $${params.length} OR lower(a.actor_name) LIKE $${params.length} OR lower(COALESCE(a.entity_id,'')) LIKE $${params.length})`);
  }
  if (sp.entity) { params.push(sp.entity); clauses.push(`a.entity_type = $${params.length}`); }
  if (sp.action) { params.push(sp.action); clauses.push(`a.action = $${params.length}`); }
  if (sp.actor) { params.push(sp.actor); clauses.push(`a.actor_user_id = $${params.length}`); }
  if (sp.from) { params.push(sp.from); clauses.push(`a.created_at::date >= $${params.length}::date`); }
  if (sp.to) { params.push(sp.to); clauses.push(`a.created_at::date <= $${params.length}::date`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [events, total, entityTypes, actions, actors, integrity] = await Promise.all([
    many<{
      id: string; actor_name: string; action: string; entity_type: string; entity_id: string | null;
      summary: string; created_at: Date; before: unknown; after: unknown; ip: string | null;
    }>(
      db,
      `SELECT a.id, a.actor_name, a.action, a.entity_type, a.entity_id, a.summary, a.created_at,
              a.before, a.after, a.ip
         FROM audit_events a ${where}
        ORDER BY a.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params,
    ),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM audit_events a ${where}`, params),
    many<{ entity_type: string; n: number }>(db, `SELECT entity_type, COUNT(*)::int AS n FROM audit_events GROUP BY 1 ORDER BY n DESC`),
    many<{ action: string; n: number }>(db, `SELECT action, COUNT(*)::int AS n FROM audit_events GROUP BY 1 ORDER BY n DESC LIMIT 60`),
    many<{ id: string; name: string }>(db, `SELECT DISTINCT u.id, u.name FROM audit_events a JOIN users u ON u.id=a.actor_user_id ORDER BY u.name`),
    one<{ unbalanced: number; entries: number; debits: number; credits: number }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM journal_entries e WHERE e.status='POSTED' AND
          COALESCE((SELECT SUM(l.debit_paisa) FROM journal_lines l WHERE l.entry_id=e.id),0)
          <> COALESCE((SELECT SUM(l.credit_paisa) FROM journal_lines l WHERE l.entry_id=e.id),0)) AS unbalanced,
        (SELECT COUNT(*)::int FROM journal_entries) AS entries,
        COALESCE((SELECT SUM(debit_paisa) FROM journal_lines),0) AS debits,
        COALESCE((SELECT SUM(credit_paisa) FROM journal_lines),0) AS credits`,
    ),
  ]);

  const totalCount = total?.n ?? 0;
  const filtered = Boolean(sp.q || sp.entity || sp.action || sp.actor || sp.from || sp.to);
  const qs = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, entity: sp.entity, action: sp.action, actor: sp.actor, from: sp.from, to: sp.to, ...extra })) {
      if (v) q.set(k, v);
    }
    return `/audit?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Audit trail"
        title="Who did what, and when"
        sub="Append-only by database trigger: audit rows cannot be edited or deleted, not even by an administrator. Payloads show the before and after values where a financial field changed."
        actions={<a className="btn" href={`/api/export/audit?from=${sp.from ?? ""}&to=${sp.to ?? ""}`}>Export CSV</a>}
      />

      <section className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Audit events" value={totalCount} foot={filtered ? "Matching the current filters" : "All time"} />
        <Stat label="Posted journal entries" value={integrity?.entries ?? 0} foot={`${formatNPRPaisa(integrity?.debits ?? 0)} debits`} />
        <Stat
          label="Unbalanced entries"
          value={integrity?.unbalanced ?? 0}
          foot={(integrity?.unbalanced ?? 0) === 0 ? "Database constraint holding" : "Investigate immediately"}
          tone={(integrity?.unbalanced ?? 0) === 0 ? "accent" : "danger"}
        />
        <Stat label="Ledger state" value={(integrity?.debits ?? 0) === (integrity?.credits ?? 0) ? "Balanced" : "Broken"} foot={`Credits ${formatNPRPaisa(integrity?.credits ?? 0)}`} tone={(integrity?.debits ?? 0) === (integrity?.credits ?? 0) ? "accent" : "danger"} />
      </section>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <form method="get" style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) repeat(4, minmax(0,1fr))", gap: 10, alignItems: "end" }}>
            <div className="field">
              <label className="label" htmlFor="q">Search</label>
              <input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="Summary, action, actor or entity id" />
            </div>
            <div className="field">
              <label className="label" htmlFor="entity">Entity</label>
              <select id="entity" name="entity" defaultValue={sp.entity ?? ""}>
                <option value="">All entities</option>
                {entityTypes.map((e) => <option key={e.entity_type} value={e.entity_type}>{e.entity_type} ({e.n})</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="action">Action</label>
              <select id="action" name="action" defaultValue={sp.action ?? ""}>
                <option value="">All actions</option>
                {actions.map((a) => <option key={a.action} value={a.action}>{a.action} ({a.n})</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={sp.from ?? ""} />
            </div>
            <div className="field">
              <label className="label" htmlFor="to">To</label>
              <input id="to" name="to" type="date" defaultValue={sp.to ?? ""} />
            </div>
            <div className="field">
              <label className="label" htmlFor="actor">Actor</label>
              <select id="actor" name="actor" defaultValue={sp.actor ?? ""}>
                <option value="">Anyone</option>
                {actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn">Filter</button>
              {filtered ? <Link className="btn btn-ghost" href="/audit">Clear</Link> : null}
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="section-title">Event log</div>
            <div className="section-sub">Newest first. IP addresses are stored as recorded; no attempt is made to geolocate them.</div>
          </div>
          <span className="badge badge-gray">{totalCount}</span>
        </div>
        <div className="table-wrap">
          {events.length ? (
            <table className="data">
              <thead>
                <tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th><th>Entity</th><th /></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="small nowrap">{formatTimestamp(e.created_at)}</td>
                    <td className="small">{e.actor_name}</td>
                    <td><span className="badge badge-ink mono" style={{ textTransform: "none", letterSpacing: 0 }}>{e.action}</span></td>
                    <td className="small" style={{ maxWidth: 440 }}>{e.summary}</td>
                    <td className="small">
                      <div className="mono">{e.entity_type}</div>
                      {e.entity_id ? <div className="tiny faint mono">{e.entity_id.slice(0, 8)}…</div> : null}
                    </td>
                    <td className="right">
                      {e.entity_type === "expense_claim" && e.entity_id ? <Link className="btn btn-xs" href={`/expenses/${e.entity_id}`}>Open <ArrowRight size={10} /></Link> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No audit events match" text="Adjust the filters, or clear them to see the full append-only history." />
          )}
        </div>
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} baseHref="/audit" query={{ q: sp.q, entity: sp.entity, action: sp.action, actor: sp.actor, from: sp.from, to: sp.to }} />
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="info-box">
          <b>Integrity note.</b> {integrity?.unbalanced === 0
            ? "Every posted journal entry balances to the paisa. The deferred constraint trigger would refuse an unbalanced entry."
            : `${integrity?.unbalanced} posted entries do not balance. Stop entering data and investigate before trusting any report.`}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head"><div className="section-title">Entities tracked</div><ShieldCheck size={15} className="muted" /></div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {entityTypes.slice(0, 10).map((e) => (
              <div className="list-row" key={e.entity_type}>
                <span className="small mono" style={{ flex: 1 }}>{e.entity_type}</span>
                <span className="badge badge-gray">{e.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div className="section-title">Action vocabulary</div></div>
          <div className="card-body" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {actions.slice(0, 24).map((a) => <span key={a.action} className="chip mono" style={{ fontSize: 10 }}>{a.action} · {a.n}</span>)}
          </div>
        </div>
      </div>
    </>
  );
}

function formatNPRPaisa(paisa: number) {
  return `NPR ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
