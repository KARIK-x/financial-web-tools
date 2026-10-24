import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { getDocument } from "@/server/documents";
import { can } from "@/lib/permissions";
import { formatTimestamp } from "@/lib/nepali-date";
import { formatNPR } from "@/lib/money";
import { PageHeader, StatusBadge, DefRow, Attention } from "@/components/ui";
import { ActionForm, QuickAction } from "@/components/ActionForm";
import { attachDocumentAction, reviewDocumentAction, runOcrAction, saveCorrectionAction } from "@/app/actions/documents";
import { FileText, ScanLine, ShieldAlert, Check } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();

  const doc = await getDocument(db, id);
  if (!doc) notFound();

  const access = await one<{ uploaded_by: string | null; claimant: string | null }>(
    db,
    `SELECT d.uploaded_by, c.claimant_user_id AS claimant
       FROM documents d LEFT JOIN expense_claims c ON c.id = d.claim_id WHERE d.id = $1`,
    [id],
  );
  const allowed = can(user.role, "document.view.all", user.permissions)
    || access?.uploaded_by === user.id
    || (access?.claimant != null && access.claimant === user.id);
  if (!allowed) notFound();

  const canReview = can(user.role, "document.review", user.permissions);
  const isImage = doc.mime.startsWith("image/");
  const extracted = (doc.extracted ?? {}) as Record<string, unknown>;
  const totalPaisa = typeof extracted.totalPaisa === "number" ? extracted.totalPaisa : null;

  return (
    <>
      <PageHeader
        eyebrow="Document"
        title={doc.filename}
        sub={<>
          {doc.doc_type.replaceAll("_", " ")} · {(Number(doc.size_bytes) / 1024).toFixed(0)} KB · uploaded by {doc.uploader ?? "unknown"} on {formatTimestamp(doc.uploaded_at)}
        </>}
        actions={<><Link className="btn" href="/receipts">All documents</Link><a className="btn btn-primary" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">Open original</a></>}
      />

      {doc.duplicate_of ? (
        <div className="warn-box" style={{ marginBottom: 16 }}>
          <ShieldAlert size={13} style={{ verticalAlign: -2 }} /> This image looks like an existing document (perceptual hash). Compare them before relying on this copy. Exact byte-identical uploads are blocked; this one is a near-duplicate.
        </div>
      ) : null}
      {doc.review_status === "UNREVIEWED" && Object.keys(extracted).length ? (
        <div className="info-box" style={{ marginBottom: 16 }}>
          Extracted fields are <b>candidates only</b>. Check each one against the original before accepting them, or correct them below.
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Original</div><span className="tiny muted">Immutable bytes</span></div>
            <div className="card-body">
              {isImage ? (
                <a href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/documents/${doc.id}`} alt={doc.filename} style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--line)" }} />
                </a>
              ) : (
                <div style={{ padding: 28, textAlign: "center", border: "1px dashed var(--line-strong)", borderRadius: 8 }}>
                  <FileText size={28} style={{ color: "var(--muted)", margin: "0 auto 8px" }} />
                  <div className="small">{doc.mime === "application/pdf" ? "PDF document" : doc.mime}</div>
                  <div className="tiny muted" style={{ marginBottom: 10 }}>Open the original in a new tab to inspect it.</div>
                  <a className="btn btn-sm" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">Open file</a>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div className="section-title">Extracted fields</div>
              {canReview ? (
                <QuickAction action={runOcrAction} label="Run extraction" className="btn btn-sm" fields={{ documentId: doc.id }} />
              ) : null}
            </div>
            <div className="card-body">
              {Object.keys(extracted).length ? (
                <dl className="kv">
                  {typeof extracted.merchant === "string" ? <DefRow label="Merchant">{extracted.merchant}</DefRow> : null}
                  {typeof extracted.date === "string" ? <DefRow label="Date">{extracted.date}</DefRow> : null}
                  {totalPaisa != null ? <DefRow label="Total">{formatNPR(totalPaisa)}</DefRow> : null}
                  {typeof extracted.totalRaw === "string" ? <DefRow label="Total (raw)">{extracted.totalRaw}</DefRow> : null}
                  {typeof extracted.invoiceNo === "string" ? <DefRow label="Invoice no.">{extracted.invoiceNo}</DefRow> : null}
                  {typeof extracted.sellerPan === "string" ? <DefRow label="Seller PAN">{extracted.sellerPan}</DefRow> : null}
                  {extracted.corrected ? <DefRow label="Status"><span className="badge badge-blue">Reviewer corrected</span></DefRow> : null}
                </dl>
              ) : (
                <div className="tiny muted">No fields have been extracted yet. Run extraction, or enter the fields manually below.</div>
              )}

              {canReview ? (
                <>
                  <hr className="divider" />
                  <ActionForm action={saveCorrectionAction} submitLabel="Save corrections" hideStatus>
                    <input type="hidden" name="documentId" value={doc.id} />
                    <div className="form-grid">
                      <div className="field"><label className="label">Merchant</label><input name="merchant" defaultValue={typeof extracted.merchant === "string" ? extracted.merchant : ""} /></div>
                      <div className="field"><label className="label">Date (YYYY-MM-DD)</label><input name="date" defaultValue={typeof extracted.date === "string" ? extracted.date : ""} /></div>
                      <div className="field"><label className="label">Total (NPR)</label><input name="total" defaultValue={typeof extracted.totalRaw === "string" ? extracted.totalRaw : totalPaisa != null ? (totalPaisa / 100).toFixed(2) : ""} /></div>
                      <div className="field"><label className="label">Invoice no.</label><input name="invoiceNo" defaultValue={typeof extracted.invoiceNo === "string" ? extracted.invoiceNo : ""} /></div>
                      <div className="field"><label className="label">Seller PAN</label><input name="sellerPan" defaultValue={typeof extracted.sellerPan === "string" ? extracted.sellerPan : ""} /></div>
                    </div>
                  </ActionForm>
                </>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Extraction history</div><span className="tiny muted">{doc.extractions.length} runs</span></div>
            <div className="table-wrap">
              {doc.extractions.length ? (
                <table className="data">
                  <thead><tr><th>Engine</th><th>Status</th><th>Duration</th><th>Started</th><th>Error</th></tr></thead>
                  <tbody>
                    {doc.extractions.map((ex) => (
                      <tr key={ex.id}>
                        <td>{ex.engine} <span className="faint tiny">{ex.engine_version}</span></td>
                        <td><StatusBadge status={ex.status} /></td>
                        <td className="muted">{ex.duration_ms ? `${ex.duration_ms} ms` : "—"}</td>
                        <td className="muted nowrap">{formatTimestamp(ex.started_at)}</td>
                        <td className="muted small">{ex.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="table-empty">No extraction runs recorded.</div>}
            </div>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><div className="section-title">Record</div></div>
            <div className="card-body">
              <dl className="kv">
                <DefRow label="Status"><StatusBadge status={doc.status} /></DefRow>
                <DefRow label="Review"><StatusBadge status={doc.review_status} /></DefRow>
                <DefRow label="Type">{doc.doc_type}</DefRow>
                <DefRow label="MIME">{doc.mime}</DefRow>
                <DefRow label="SHA-256"><span className="mono tiny" style={{ wordBreak: "break-all" }}>{doc.sha256}</span></DefRow>
                <DefRow label="Claim">{doc.claim_no ? <Link className="link" href={`/expenses/${doc.claim_id}`}>{doc.claim_no}</Link> : "Unattached"}</DefRow>
                <DefRow label="Notes">{doc.notes ?? "—"}</DefRow>
              </dl>
            </div>
          </div>

          {canReview ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head"><div className="section-title">Review</div></div>
              <div className="card-body" style={{ display: "grid", gap: 10 }}>
                <ActionForm action={reviewDocumentAction} submitLabel="Accept extracted fields" submitClass="btn btn-accent" hideStatus>
                  <input type="hidden" name="documentId" value={doc.id} />
                  <input type="hidden" name="accept" value="true" />
                </ActionForm>
                <ActionForm action={reviewDocumentAction} submitLabel="Needs rework" submitClass="btn btn-danger" hideStatus>
                  <input type="hidden" name="documentId" value={doc.id} />
                  <input type="hidden" name="accept" value="false" />
                </ActionForm>
                <div className="hairline" />
                <div className="label">Attach to a claim</div>
                <ActionForm action={attachDocumentAction} submitLabel="Attach" hideStatus>
                  <input type="hidden" name="documentId" value={doc.id} />
                  <input name="claimNo" placeholder="LOC-2026-0001" required />
                  <span className="hint">Attaching marks the claim&apos;s documentation as complete. It does not verify the claim.</span>
                </ActionForm>
              </div>
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-body">
                <Attention icon={<ScanLine size={12} />} text="You can view this document but not change its review state. Ask the finance team to review or correct extracted fields." />
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><div className="section-title">Privacy</div></div>
            <div className="card-body tiny muted" style={{ lineHeight: 1.7 }}>
              The original is stored under a content hash in private storage. This page and the file route both check
              your permission before serving bytes. Documents cannot be deleted through the application; supersede them
              with a corrected copy so the evidence trail stays intact.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
