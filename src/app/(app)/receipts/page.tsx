import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { listDocuments } from "@/server/documents";
import { searchDocuments } from "@/server/document-search";
import { ocrCapability } from "@/server/ocr";
import { malwareScanCapability, malwareScanRequired } from "@/server/malware";
import { formatTimestamp } from "@/lib/nepali-date";
import { PageHeader, StatusBadge, EmptyState, SourceTag } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { uploadDocumentAction } from "@/app/actions/documents";
import { Upload } from "lucide-react";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const pick = (sp: SearchParams, key: string) => {
  const v = sp[key];
  return typeof v === "string" && v.length ? v : undefined;
};

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const q = pick(sp, "q");
  const status = pick(sp, "status");

  const amountMin = pick(sp, "amountMin") ? Number(pick(sp, "amountMin")) : undefined;
  const amountMax = pick(sp, "amountMax") ? Number(pick(sp, "amountMax")) : undefined;
  const dateFrom = pick(sp, "dateFrom");
  const dateTo = pick(sp, "dateTo");
  const sort = (pick(sp, "sort") as "relevance" | "newest" | "oldest" | "amount" | undefined) ?? (q ? "relevance" : "newest");

  const [search, summary, capability, scanCapability] = await Promise.all([
    searchDocuments(db, user, {
      query: q,
      status,
      docType: pick(sp, "type"),
      dateFrom,
      dateTo,
      amountMin: Number.isFinite(amountMin) ? amountMin : undefined,
      amountMax: Number.isFinite(amountMax) ? amountMax : undefined,
      sort,
      pageSize: 100,
    }),
    one<{ total: number; review: number; duplicates: number; failed: number; extracted: number }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE d.status IN ('NEEDS_REVIEW','EXTRACTED'))::int AS review,
              COUNT(*) FILTER (WHERE d.duplicate_of IS NOT NULL)::int AS duplicates,
              COUNT(*) FILTER (WHERE d.status='FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE d.status IN ('EXTRACTED','REVIEWED'))::int AS extracted
         FROM documents d
         LEFT JOIN expense_claims c ON c.id = d.claim_id
        WHERE ${can(user.role, "document.view.all", user.permissions) ? "TRUE" : "(d.uploaded_by = $1 OR c.claimant_user_id = $1)"}`,
      can(user.role, "document.view.all", user.permissions) ? [] : [user.id],
    ),
    ocrCapability(),
    malwareScanCapability(),
  ]);
  const documents = search.rows;

  return (
    <>
      <PageHeader
        eyebrow="Document vault"
        title="Receipts & evidence"
        sub="Private, content-addressed storage. The same file cannot be uploaded twice; near-identical photographs are flagged for a human decision rather than merged automatically."
      />

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.65fr) minmax(0,1fr)", marginBottom: 16 }}>
        <div className="grid grid-4" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
          <div className="stat"><div className="stat-label">Documents</div><div className="stat-value">{summary?.total ?? 0}</div><div className="stat-foot">Stored originals</div></div>
          <div className="stat"><div className="stat-label">Needs review</div><div className="stat-value">{summary?.review ?? 0}</div><div className="stat-foot">Extracted fields unchecked</div></div>
          <div className="stat"><div className="stat-label">Duplicates flagged</div><div className="stat-value">{summary?.duplicates ?? 0}</div><div className="stat-foot">Near-duplicate images</div></div>
          <div className="stat"><div className="stat-label">Failed</div><div className="stat-value">{summary?.failed ?? 0}</div><div className="stat-foot">Extraction errors</div></div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Upload evidence</div>
              <div className="section-sub">Images, PDFs or spreadsheets · 10 MB max</div>
            </div>
            <Upload size={16} className="muted" />
          </div>
          <div className="card-body">
            <ActionForm action={uploadDocumentAction} submitLabel="Upload document">
              <div className="field" style={{ marginBottom: 10 }}>
                <label className="label" htmlFor="file">File</label>
                <input id="file" name="file" type="file" required accept="image/*,application/pdf,text/csv,.xlsx,.xls" capture="environment" />
              </div>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div className="field">
                  <label className="label" htmlFor="docType">Type</label>
                  <select id="docType" name="docType" defaultValue="RECEIPT">
                    <option value="RECEIPT">Receipt</option>
                    <option value="INVOICE">Invoice</option>
                    <option value="BANK_STATEMENT">Bank statement</option>
                    <option value="PAYMENT_CONFIRMATION">Payment confirmation</option>
                    <option value="AGREEMENT">Agreement</option>
                    <option value="SPONSORSHIP">Sponsorship</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="label">Batch label</label>
                  <input id="label" name="label" placeholder="e.g. Orientation receipts" />
                </div>
              </div>
            </ActionForm>
            <div className="tiny muted">
              OCR engine: {capability.engine} ({capability.available ? capability.languages.join(", ") || "no languages" : "unavailable"}).
              {!capability.nepaliSupported ? " Nepali/Devanagari text extraction is not available in this environment; enter those fields manually." : ""}
              <br />
              Malware scan: {scanCapability.available ? `${scanCapability.version} available` : "unavailable"}.
              {scanCapability.available ? "" : " Files are stored as UNAVAILABLE, never as clean."}
              {malwareScanRequired() ? " Required policy is ON; unscanned files cannot be processed or downloaded." : ""}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <form method="get" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input name="q" defaultValue={q} placeholder="Search bill text, merchant, invoice, amount, date..." style={{ minWidth: 260, flex: 1 }} />
            <select name="status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              <option value="UPLOADED">Uploaded</option>
              <option value="EXTRACTED">Extracted</option>
              <option value="NEEDS_REVIEW">Needs review</option>
              <option value="REVIEWED">Reviewed</option>
              <option value="FAILED">Failed</option>
            </select>
            <select name="type" defaultValue={pick(sp, "type") ?? ""}>
              <option value="">All types</option>
              <option value="RECEIPT">Receipt</option>
              <option value="INVOICE">Invoice</option>
              <option value="BANK_STATEMENT">Bank statement</option>
              <option value="PAYMENT_CONFIRMATION">Payment confirmation</option>
              <option value="OTHER">Other</option>
            </select>
            <input name="dateFrom" type="date" defaultValue={dateFrom} />
            <input name="dateTo" type="date" defaultValue={dateTo} />
            <input name="amountMin" type="number" step="0.01" placeholder="Min NPR" defaultValue={pick(sp, "amountMin")} style={{ width: 110 }} />
            <input name="amountMax" type="number" step="0.01" placeholder="Max NPR" defaultValue={pick(sp, "amountMax")} style={{ width: 110 }} />
            <select name="sort" defaultValue={sort}>
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="amount">Amount</option>
            </select>
            <button className="btn btn-sm" type="submit">Search</button>
            {q || status || pick(sp, "type") || dateFrom || dateTo || pick(sp, "amountMin") || pick(sp, "amountMax") ? <Link className="link small" href="/receipts">Clear</Link> : null}
          </form>
          <span className="tiny muted">{documents.length} shown{search.total ? ` of ${search.total}` : ""}</span>
        </div>
        <div className="table-wrap">
          {documents.length ? (
            <table className="data">
              <thead><tr><th>File</th><th>Type</th><th>Claim</th><th>Status</th><th>Scan</th><th>Review</th><th>Uploaded by</th><th>Size</th><th>Uploaded</th></tr></thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <Link className="row-title link-quiet" href={`/receipts/${doc.id}`}>{doc.filename}</Link>
                      {doc.duplicate_of ? <div className="row-sub">Possible duplicate of {doc.duplicate_of.slice(0, 8)}</div> : null}
                      {doc.snippet ? <div className="row-sub search-snippet" dangerouslySetInnerHTML={{ __html: doc.snippet }} /> : null}
                    </td>
                    <td className="muted">{doc.doc_type.replaceAll("_", " ")}</td>
                    <td>{doc.claim_no ? <Link className="link" href={`/expenses/${doc.claim_id}`}>{doc.claim_no}</Link> : <span className="faint">Unattached</span>}</td>
                    <td><StatusBadge status={doc.status} /></td>
                    <td><StatusBadge status={doc.scan_status} /></td>
                    <td><StatusBadge status={doc.review_status} /></td>
                    <td className="muted">{doc.uploader ?? "—"}</td>
                    <td className="muted">{(Number(doc.size_bytes) / 1024).toFixed(0)} KB</td>
                    <td className="muted nowrap">{formatTimestamp(doc.uploaded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No documents yet" text="Upload a receipt to begin building the evidence archive. Files are stored privately and never listed publicly." />
          )}
        </div>
      </div>
    </>
  );
}
