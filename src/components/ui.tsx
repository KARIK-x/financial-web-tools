import type { ReactNode } from "react";
import { formatNPR, formatNPRShort } from "@/lib/money";

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  PAYMENT_PENDING: "Payment pending",
  REIMBURSED: "Reimbursed",
  SETTLED: "Settled",
  VERIFIED: "Verified",
  RECONCILED: "Reconciled",
  DISPUTED: "Disputed",
  REQUESTED: "Requested",
  OUTSTANDING: "Outstanding",
  PARTIALLY_SETTLED: "Partially settled",
  WRITTEN_OFF: "Written off",
  LEAD: "Lead",
  PROPOSED: "Proposed",
  NEGOTIATING: "Negotiating",
  COMMITTED: "Committed",
  INVOICED: "Invoiced",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  DELIVERABLES_PENDING: "Deliverables pending",
  CLOSED: "Closed",
  DECLINED: "Declined",
  UNVERIFIED: "Unverified",
  COMPLETE: "Complete",
  MISSING_DECLARED: "Missing (declared)",
  MISSING_UNDECLARED: "Missing (undeclared)",
  UNREVIEWED: "Unreviewed",
  IN_REVIEW: "In review",
  ACCEPTED: "Accepted",
  CORRECTED: "Corrected",
  NEEDS_REVIEW: "Needs review",
  EXTRACTED: "Extracted",
  REVIEWED: "Reviewed",
  UPLOADED: "Uploaded",
  FAILED: "Failed",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  SUCCEEDED: "Succeeded",
  SKIPPED: "Skipped",
  UNMATCHED: "Unmatched",
  SUGGESTED: "Suggested",
  MATCHED: "Matched",
  IGNORED: "Ignored",
  OPEN: "Open",
  IMPORTED: "Imported",
  PARTIALLY_MATCHED: "Partially matched",
  COMBINED: "Combined",
  SINGLE: "Single",
  PENDING: "Pending",
  DONE: "Done",
  WAIVED: "Waived",
  ACTIVE: "Active",
  PLANNED: "Planned",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
  RECORDED: "Recorded",
  VOID: "Void",
  POSTED: "Posted",
  REVERSED: "Reversed",
  PREVIEW: "Preview",
};

const TONES: Record<string, string> = {
  DRAFT: "gray",
  WITHDRAWN: "gray",
  ARCHIVED: "gray",
  IGNORED: "gray",
  VOID: "gray",
  CLOSED: "gray",
  SUBMITTED: "blue",
  IN_REVIEW: "blue",
  UPLOADED: "blue",
  PREVIEW: "blue",
  PROCESSING: "blue",
  EXTRACTED: "blue",
  OPEN: "blue",
  PROPOSED: "blue",
  LEAD: "blue",
  UNDER_REVIEW: "amber",
  PAYMENT_PENDING: "amber",
  REQUESTED: "amber",
  OUTSTANDING: "amber",
  PARTIALLY_SETTLED: "amber",
  PARTIALLY_RECEIVED: "amber",
  PARTIALLY_MATCHED: "amber",
  NEGOTIATING: "amber",
  PENDING: "amber",
  NEEDS_REVIEW: "amber",
  SUGGESTED: "amber",
  MISSING_DECLARED: "amber",
  UNVERIFIED: "amber",
  APPROVED: "green",
  REIMBURSED: "green",
  SETTLED: "green",
  VERIFIED: "green",
  RECONCILED: "green",
  COMPLETE: "green",
  ACCEPTED: "green",
  CORRECTED: "green",
  REVIEWED: "green",
  MATCHED: "green",
  RECEIVED: "green",
  COMMITTED: "green",
  INVOICED: "green",
  ACTIVE: "green",
  COMPLETED: "green",
  DONE: "green",
  RECORDED: "green",
  POSTED: "green",
  SUCCEEDED: "green",
  REJECTED: "red",
  DISPUTED: "red",
  FAILED: "red",
  DECLINED: "red",
  MISSING_UNDECLARED: "red",
  WRITTEN_OFF: "red",
  IMPORTED: "ink",
  DELIVERABLES_PENDING: "amber",
  SKIPPED: "gray",
  WAIVED: "gray",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = TONES[status] ?? "gray";
  return <span className={`badge badge-${tone}`}>{label ?? STATUS_LABELS[status] ?? status.replaceAll("_", " ").toLowerCase()}</span>;
}

export function Money({ paisa, short, muted, className }: { paisa: number | string | bigint | null; short?: boolean; muted?: boolean; className?: string }) {
  const value = Number(paisa ?? 0);
  return (
    <span className={`num ${muted ? "muted" : ""} ${className ?? ""}`}>
      {short ? formatNPRShort(value) : formatNPR(value)}
    </span>
  );
}

export function PageHeader({ eyebrow, title, sub, actions }: { eyebrow?: string; title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{actions}</div> : null}
    </header>
  );
}

export function Stat({
  label, value, foot, tone, href,
}: { label: string; value: ReactNode; foot?: ReactNode; tone?: "accent" | "warn" | "danger"; href?: string }) {
  const className = `stat${tone ? ` stat-${tone}` : ""}`;
  const body = (
    <>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </>
  );
  return href ? <a className={className} href={href}>{body}</a> : <div className={className}>{body}</div>;
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <p className="empty-text">{text}</p>
      {action}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(value * 100, 100));
  const cls = value > 1 ? "red" : value >= 0.8 ? "amber" : "";
  return (
    <div className="meter">
      <div className="bar-track">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      {label ? <div className="tiny muted">{label}</div> : null}
    </div>
  );
}

export function SourceTag({ sourceType, synthetic }: { sourceType?: string | null; synthetic?: boolean }) {
  if (synthetic) return <span className="src" title="Generated demo data — not a real LOCUS record">Synthetic</span>;
  if (sourceType === "HISTORICAL_IMPORT") return <span className="src">Imported</span>;
  if (sourceType === "OCR_CANDIDATE") return <span className="src">OCR candidate</span>;
  return null;
}

export function Attention({ icon, text, tone = "amber" }: { icon?: ReactNode; text: ReactNode; tone?: "amber" | "red" | "blue" }) {
  return (
    <div className="attention">
      <span className={`icon-box badge-${tone}`} style={{ width: 24, height: 24 }}>{icon ?? "!"}</span>
      <span>{text}</span>
    </div>
  );
}

export function Pagination({ page, pageSize, total, baseHref, query }: { page: number; pageSize: number; total: number; baseHref: string; query?: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const link = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v) params.set(k, v);
    params.set("page", String(p));
    return `${baseHref}?${params.toString()}`;
  };
  return (
    <div className="pagination">
      <span>{total} records · page {page} of {pages}</span>
      {page > 1 ? <a className="btn btn-xs" href={link(page - 1)}>Previous</a> : null}
      {page < pages ? <a className="btn btn-xs" href={link(page + 1)}>Next</a> : null}
    </div>
  );
}

export function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function BarChart({ data, height = 120 }: { data: Array<{ label: string; total: number; verified?: number }>; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div>
      <div className="chart-bars" style={{ height }}>
        {data.map((d) => {
          const totalPct = Math.max(2, (d.total / max) * 100);
          const verifiedPct = d.total > 0 && d.verified != null ? (d.verified / d.total) * totalPct : totalPct;
          return (
            <div className="chart-col" key={d.label} title={`${d.label}: ${formatNPR(d.total)}`}>
              <div className="chart-bar claimed" style={{ height: `${totalPct}%` }}>
                <div className="chart-bar" style={{ height: `${(verifiedPct / totalPct) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {data.map((d) => (
          <div key={d.label} className="tiny faint" style={{ flex: 1, textAlign: "center", minWidth: 8 }}>
            {d.label.slice(2)}
          </div>
        ))}
      </div>
    </div>
  );
}
