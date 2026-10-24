import Link from "next/link";
import { requirePagePermission } from "@/server/page-auth";
import { getDb, many, one } from "@/server/db";
import { getOrganization, getSettings } from "@/server/settings";
import { ocrCapability } from "@/server/ocr";
import { PERMISSIONS, ROLES, ROLE_LABELS, type Permission, type Role } from "@/lib/permissions";
import { paisaToDecimal } from "@/lib/money";
import { DOCUMENT_ROOT } from "@/server/storage";
import { PageHeader, StatusBadge } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import {
  saveApprovalThresholdsAction, saveComplianceAction, saveDisplayAction,
  saveDocumentationAction, saveOrganizationAction, saveRolePermissionsAction,
} from "@/app/actions/settings";
import { Database, HardDrive, ScanText, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

const PERMISSION_HINTS: Record<Permission, string> = {
  "expense.submit": "Create and submit own claims",
  "expense.view.all": "See every claim, not only their own",
  "expense.approve": "Approve or reject claims (never their own)",
  "expense.pay": "Record payments from an account",
  "expense.verify": "Verify evidence after payment",
  "advance.manage": "Issue, settle and write off advances",
  "document.upload": "Upload receipts and statements",
  "document.view.all": "Open documents attached to any claim",
  "document.review": "Accept or correct extracted receipt fields",
  "sponsor.manage": "Create agreements and record receipts",
  "budget.manage": "Create events, budgets and revisions",
  "account.manage": "Create accounts and record transfers",
  "recon.manage": "Import statements and reconcile balances",
  "report.view": "Open reports and analytics",
  "export.run": "Download CSV/JSON extracts",
  "audit.view": "Read the append-only audit trail",
  "settings.manage": "Change this page, roles and organisation profile",
  "member.manage": "Create members and sign-in accounts",
  "import.run": "Run bulk imports",
};

export default async function SettingsPage() {
  const user = await requirePagePermission("settings.manage");
  const db = await getDb();
  const [settings, org, rolePermissions, counts, version, capability] = await Promise.all([
    getSettings(db),
    getOrganization(db),
    many<{ role: string; permission: string }>(db, `SELECT role, permission FROM role_permissions ORDER BY role, permission`),
    one<{ claims: number; users: number; documents: number; journal: number; audit: number; synthetic: number; real: number }>(
      db,
      `SELECT
        (SELECT COUNT(*)::int FROM expense_claims) AS claims,
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM journal_entries) AS journal,
        (SELECT COUNT(*)::int FROM audit_events) AS audit,
        (SELECT COUNT(*)::int FROM expense_claims WHERE is_synthetic) AS synthetic,
        (SELECT COUNT(*)::int FROM expense_claims WHERE NOT is_synthetic) AS real`,
    ),
    one<{ version: string }>(db, `SELECT version() AS version`),
    ocrCapability(),
  ]);

  const granted = new Map<Role, Set<string>>();
  for (const role of ROLES) granted.set(role, new Set());
  for (const row of rolePermissions) {
    if (granted.has(row.role as Role)) granted.get(row.role as Role)!.add(row.permission);
  }

  const dataState = (counts?.claims ?? 0) === 0
    ? "Empty ledger"
    : (counts?.real ?? 0) === 0
      ? "Synthetic demo only"
      : (counts?.synthetic ?? 0) > 0
        ? "Mixed real + synthetic"
        : "Real records only";

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        sub="Thresholds, evidence policy, display defaults, compliance notes and the role permission matrix. Every change on this page is written to the audit trail with the previous value."
        actions={<Link className="btn" href="/reconstruction">Reconstruction baseline</Link>}
      />

      {user.role !== "ADMIN" ? (
        <div className="warn-box" style={{ marginBottom: 18 }}>
          You hold <b>settings.manage</b> through the permission matrix rather than the ADMIN role. Check that somebody
          else can still administer the workspace before you change roles.
        </div>
      ) : null}

      <div className="grid grid-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Approval thresholds</div>
              <div className="section-sub">Stored in paisa; shown in NPR. A claim above a threshold needs the additional approvals.</div>
            </div>
            <ShieldCheck size={17} className="muted" />
          </div>
          <div className="card-body">
            <ActionForm action={saveApprovalThresholdsAction} submitLabel="Save thresholds" className="form-grid">
              <div className="field">
                <label className="label" htmlFor="standard">Standard ceiling (NPR)</label>
                <input id="standard" name="standard" defaultValue={paisaToDecimal(settings.approval.standard)} inputMode="decimal" required />
                <span className="hint">One finance / executive approval up to this amount.</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="executive">Executive ceiling (NPR)</label>
                <input id="executive" name="executive" defaultValue={paisaToDecimal(settings.approval.executive)} inputMode="decimal" required />
                <span className="hint">Finance + executive approval between the two ceilings.</span>
              </div>
              <div className="field span-2">
                <label className="label" htmlFor="committee">Committee ceiling (NPR)</label>
                <input id="committee" name="committee" defaultValue={paisaToDecimal(settings.approval.committee)} inputMode="decimal" required />
                <span className="hint">Above this amount a committee resolution reference is also required on the claim.</span>
              </div>
            </ActionForm>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Organisation profile</div>
              <div className="section-sub">Identifies the workspace. It does not assert tax registration.</div>
            </div>
          </div>
          <div className="card-body">
            <ActionForm action={saveOrganizationAction} submitLabel="Save profile" className="form-grid">
              <div className="field">
                <label className="label" htmlFor="name">Short name</label>
                <input id="name" name="name" defaultValue={org?.name ?? "LOCUS"} required />
              </div>
              <div className="field">
                <label className="label" htmlFor="legalName">Legal name</label>
                <input id="legalName" name="legalName" defaultValue={org?.legal_name ?? ""} placeholder="As registered, if any" />
              </div>
              <div className="field span-2">
                <label className="label" htmlFor="fiscalYearStartMonth">Fiscal year start month</label>
                <select id="fiscalYearStartMonth" name="fiscalYearStartMonth" defaultValue={String(org?.fiscal_year_start_month ?? 4)}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{m === 4 ? "4 — Shrawan (Nepali fiscal year)" : `Month ${m}`}</option>
                  ))}
                </select>
                <span className="hint">Nepal’s fiscal year starts 1 Shrawan (BS month 4); the reporting engine converts BS dates to AD.</span>
              </div>
            </ActionForm>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Display defaults</div>
              <div className="section-sub">Number grouping and calendar preference for new screens.</div>
            </div>
          </div>
          <div className="card-body">
            <ActionForm action={saveDisplayAction} submitLabel="Save display" className="form-grid">
              <div className="field">
                <label className="label" htmlFor="numberGrouping">Number grouping</label>
                <select id="numberGrouping" name="numberGrouping" defaultValue={settings.display.numberGrouping}>
                  <option value="lakh">Lakh / crore (1,50,000)</option>
                  <option value="western">Western (150,000)</option>
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="dateCalendar">Primary calendar</label>
                <select id="dateCalendar" name="dateCalendar" defaultValue={settings.display.dateCalendar}>
                  <option value="AD">AD (Gregorian)</option>
                  <option value="BS">BS (Bikram Sambat)</option>
                </select>
              </div>
              <div className="field span-2">
                <label className="label" htmlFor="timezone">Timezone for “today”</label>
                <select id="timezone" name="timezone" defaultValue={settings.display.timezone}>
                  <option value="Asia/Kathmandu">Asia/Kathmandu (UTC+05:45)</option>
                  <option value="UTC">UTC</option>
                </select>
                <span className="hint">Storage is always UTC; this only decides which date counts as today.</span>
              </div>
            </ActionForm>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Evidence policy</div>
              <div className="section-sub">Receipts are required unless a written declaration explains the gap.</div>
            </div>
          </div>
          <div className="card-body">
            <ActionForm action={saveDocumentationAction} submitLabel="Save policy" className="grid">
              <label className="check">
                <input type="checkbox" name="missingReceiptRequiresDeclaration" defaultChecked={settings.documentation.missingReceiptRequiresDeclaration} />
                <span>Block a claim without a receipt unless a missing-receipt declaration is provided.</span>
              </label>
              <div className="field">
                <label className="label" htmlFor="secondApprovalAbove">Second approval above (NPR)</label>
                <input id="secondApprovalAbove" name="secondApprovalAbove" defaultValue={paisaToDecimal(settings.documentation.secondApprovalAbove)} inputMode="decimal" />
                <span className="hint">Advisory flag used on review screens. The hard approval rule is the threshold table.</span>
              </div>
            </ActionForm>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="section-title">Compliance profile</div>
              <div className="section-sub">Recorded, not assumed. Leave unverified until documents support it.</div>
            </div>
          </div>
          <div className="card-body">
            <ActionForm action={saveComplianceAction} submitLabel="Save compliance" className="form-grid">
              <div className="field">
                <label className="label" htmlFor="pan">PAN</label>
                <input id="pan" name="pan" defaultValue={settings.compliance.pan ?? ""} inputMode="numeric" placeholder="Nine digits, if registered" />
              </div>
              <div className="field">
                <label className="label" htmlFor="legalStatus">Legal status</label>
                <select id="legalStatus" name="legalStatus" defaultValue={settings.compliance.legalStatus}>
                  <option value="UNVERIFIED">Unverified</option>
                  <option value="NGO">NGO</option>
                  <option value="NON_PROFIT">Non-profit</option>
                  <option value="COMPANY">Company</option>
                  <option value="GOVERNMENT_BODY">Government body</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <label className="check span-2">
                <input type="checkbox" name="vatRegistered" defaultChecked={settings.compliance.vatRegistered} />
                <span>VAT registered (only tick if a VAT certificate exists).</span>
              </label>
              <div className="field span-2">
                <label className="label" htmlFor="note">Note</label>
                <textarea id="note" name="note" defaultValue={settings.compliance.note} rows={3} />
                <span className="hint">This note is shown to auditors; it is not a substitute for professional tax advice.</span>
              </div>
            </ActionForm>
          </div>
        </div>

        <div className="card" style={{ background: "var(--surface-alt)" }}>
          <div className="card-head">
            <div>
              <div className="section-title">System status</div>
              <div className="section-sub">What this build can and cannot do, without pretending otherwise.</div>
            </div>
          </div>
          <div className="card-body grid" style={{ gap: 14 }}>
            <div className="list-row" style={{ paddingTop: 0 }}>
              <span className="icon-box badge-green"><Database size={14} /></span>
              <div>
                <div className="small" style={{ fontWeight: 500 }}>Embedded PostgreSQL (PGlite)</div>
                <div className="tiny muted">{String(version?.version ?? "").split(" ").slice(0, 2).join(" ")} · local single-writer database</div>
              </div>
            </div>
            <div className="list-row">
              <span className="icon-box badge-blue"><HardDrive size={14} /></span>
              <div>
                <div className="small" style={{ fontWeight: 500 }}>Private document store</div>
                <div className="tiny muted" style={{ wordBreak: "break-all" }}>{DOCUMENT_ROOT}</div>
              </div>
            </div>
            <div className="list-row">
              <span className={`icon-box ${capability.available ? "badge-green" : "badge-amber"}`}><ScanText size={14} /></span>
              <div>
                <div className="small" style={{ fontWeight: 500 }}>
                  OCR · {capability.available ? capability.engineVersion : "unavailable"}
                </div>
                <div className="tiny muted">{capability.note}</div>
              </div>
            </div>
            <div className="hairline" />
            <div className="kv" style={{ gridTemplateColumns: "140px 1fr" }}>
              <dt>Data state</dt><dd><StatusBadge status={(counts?.real ?? 0) === 0 ? "UNVERIFIED" : "ACTIVE"} label={dataState} /></dd>
              <dt>Claims</dt><dd className="num">{counts?.claims ?? 0} ({counts?.synthetic ?? 0} synthetic)</dd>
              <dt>Users</dt><dd className="num">{counts?.users ?? 0}</dd>
              <dt>Documents</dt><dd className="num">{counts?.documents ?? 0}</dd>
              <dt>Journal entries</dt><dd className="num">{counts?.journal ?? 0}</dd>
              <dt>Audit events</dt><dd className="num">{counts?.audit ?? 0}</dd>
            </div>
            <div className="info-box">
              Backups must capture both the database directory and the document store. See
              <Link className="link" href="/import-export"> Import &amp; export</Link> for a data extract before any reset.
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="section-title">Role permission matrix</div>
            <div className="section-sub">ADMIN always holds every permission and cannot be edited here. Server actions re-check these lists on every call.</div>
          </div>
          <span className="badge badge-gray">ADMIN locked</span>
        </div>
        <ActionForm action={saveRolePermissionsAction} submitLabel="Save permission matrix" footer={
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="tiny muted">Removing a permission takes effect on the next request for signed-in users.</span>
            <button type="submit" className="btn btn-primary">Save permission matrix</button>
          </div>
        }>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ minWidth: 250 }}>Permission</th>
                  {ROLES.map((role) => <th key={role} className="right">{ROLE_LABELS[role]}</th>)}
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((permission) => (
                  <tr key={permission}>
                    <td>
                      <div className="row-title mono" style={{ fontSize: 11.5 }}>{permission}</div>
                      <div className="row-sub">{PERMISSION_HINTS[permission]}</div>
                    </td>
                    {ROLES.map((role) => {
                      const checked = role === "ADMIN" || (granted.get(role)?.has(permission) ?? false);
                      return (
                        <td key={role} className="right">
                          <input
                            type="checkbox"
                            name={`perm_${role}_${permission}`}
                            defaultChecked={checked}
                            disabled={role === "ADMIN"}
                            aria-label={`${role}: ${permission}`}
                            style={{ width: 16, height: 16 }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ActionForm>
      </div>
    </>
  );
}
