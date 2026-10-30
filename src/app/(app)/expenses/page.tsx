import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, many } from "@/server/db";
import { countClaims, listClaims, summarizeClaims, EXPENSE_STATUSES } from "@/server/expenses";
import { formatNPR } from "@/lib/money";
import { formatDateLong } from "@/lib/nepali-date";
import { PageHeader, StatusBadge, EmptyState, Pagination, SourceTag } from "@/components/ui";
import { Search, Download } from "lucide-react";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;
const pick = (sp: SearchParams, key: string) => {
  const v = sp[key];
  return typeof v === "string" && v.length ? v : undefined;
};

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();

  const page = Math.max(1, Number(pick(sp, "page") ?? 1) || 1);
  const filters = {
    status: pick(sp, "status"),
    q: pick(sp, "q"),
    from: pick(sp, "from"),
    to: pick(sp, "to"),
    verification: pick(sp, "verification"),
    documentation: pick(sp, "documentation"),
    eventId: pick(sp, "eventId"),
    categoryId: pick(sp, "categoryId"),
  };

  const [rows, total, categories, events, sums] = await Promise.all([
    listClaims(db, user, { ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countClaims(db, user, filters),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM expense_categories WHERE is_active ORDER BY sort_order`),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM events ORDER BY starts_on DESC NULLS LAST LIMIT 100`),
    summarizeClaims(db, user, filters),
  ]);
  const summary = sums;

  const query: Record<string, string | undefined> = {
    status: filters.status, q: filters.q, from: filters.from, to: filters.to,
    verification: filters.verification, documentation: filters.documentation,
    eventId: filters.eventId, categoryId: filters.categoryId,
  };

  return (
    <>
      <PageHeader
        eyebrow="Spend register"
        title="Expenses"
        sub="Every claim, its evidence state and its verification state. Amounts are recorded in NPR paisa and never edited after approval."
        actions={
          <>
            <Link className="btn" href={`/api/export/claims?format=csv&${new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString()}`}>
              <Download size={14} /> Export CSV
            </Link>
            <Link className="btn btn-primary" href="/expenses/new">New expense</Link>
          </>
        }
      />

      <div className="card" style={{ marginBottom: 16 }}>
        <form method="get" className="card-body" style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(4, minmax(0,1fr)) auto", gap: 10, alignItems: "end" }}>
          <div className="field">
            <label className="label" htmlFor="q">Search</label>
            <div style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: 10, top: 11, opacity: 0.5 }} />
              <input id="q" name="q" defaultValue={filters.q} placeholder="Claim no, description, vendor" style={{ paddingLeft: 30 }} />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={filters.status ?? ""}>
              <option value="">All statuses</option>
              {EXPENSE_STATUSES.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ").toLowerCase()}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="categoryId">Category</label>
            <select id="categoryId" name="categoryId" defaultValue={filters.categoryId ?? ""}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={filters.from} />
          </div>
          <div className="field">
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={filters.to} />
          </div>
          <button className="btn btn-primary" type="submit">Filter</button>
        </form>
        <div className="card-foot" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: "var(--muted)" }}>
          <span><b style={{ color: "var(--ink)" }}>{summary.n}</b> claims in filter</span>
          <span>Total <b style={{ color: "var(--ink)" }} className="num">{formatNPR(Number(summary.total))}</b></span>
          <span>Verified <b style={{ color: "var(--accent-ink)" }} className="num">{formatNPR(Number(summary.verified))}</b></span>
          <span>Unverified <b style={{ color: "var(--amber)" }} className="num">{formatNPR(Number(summary.total) - Number(summary.verified))}</b></span>
          <span style={{ marginLeft: "auto" }}><Link className="link" href="/expenses">Clear filters</Link></span>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {rows.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Date</th>
                  <th>Paid by</th>
                  <th>Category</th>
                  <th>Event</th>
                  <th className="right">Amount</th>
                  <th>Evidence</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className="row-title link-quiet" href={`/expenses/${row.id}`}>{row.claim_no}</Link>
                      <div className="row-sub" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.vendor_name ?? "—"} <SourceTag synthetic={row.is_synthetic} sourceType={row.source_type} />
                      </div>
                    </td>
                    <td className="nowrap">{formatDateLong(row.date_ad)}</td>
                    <td>{row.paid_by_name}</td>
                    <td>{row.category_name}</td>
                    <td className="muted">{row.event_name ?? "—"}</td>
                    <td className="right mono">{formatNPR(Number(row.amount_paisa))}</td>
                    <td>
                      <StatusBadge status={row.documentation_state} />
                      <div className="row-sub">{row.docs} file{row.docs === 1 ? "" : "s"}</div>
                    </td>
                    <td><StatusBadge status={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No claims match this view"
              text="Adjust the filters, or record the first expense. A claim can be saved as a draft before it is submitted."
              action={<Link className="btn btn-primary btn-sm" href="/expenses/new">New expense</Link>}
            />
          )}
        </div>
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} baseHref="/expenses" query={query} />
      </div>
    </>
  );
}
