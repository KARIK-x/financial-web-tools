import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser, mfaRequiredForRole } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { unreadNotificationCount } from "@/server/notifications-center";
import { currentFiscalPeriod } from "@/server/reports";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

const COUNTED = `('SUBMITTED','UNDER_REVIEW','APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')`;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.mfaPending || (mfaRequiredForRole(user.role) && !user.mfaEnabled)) redirect("/mfa-setup");

  const db = await getDb();
  const period = await currentFiscalPeriod(db);
  const unreadNotifications = await unreadNotificationCount(db, user.id);
  const [pending, unreconciled, missingDocs] = await Promise.all([
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM expense_claims WHERE status IN ('SUBMITTED','UNDER_REVIEW')`),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM bank_statement_lines WHERE match_status IN ('UNMATCHED','SUGGESTED')`),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM expense_claims WHERE documentation_state <> 'COMPLETE' AND status IN ${COUNTED}`),
  ]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Sidebar
        user={{ name: user.name, roleLabel: user.roleLabel, permissions: user.permissions }}
        pendingApprovals={pending?.n ?? 0}
        unreconciled={unreconciled?.n ?? 0}
        missingDocs={missingDocs?.n ?? 0}
      />
      <div className="main">
        <header className="app-topbar no-print">
          <div className="app-topbar-left">
            <span className="app-topbar-kicker">Finance Tracker</span>
            <span className="app-topbar-title">Operations console</span>
          </div>
          <div className="app-topbar-right">
            <span className="badge badge-blue">{period.label}</span>
            <Link className="btn btn-sm" href="/reports">Reports</Link>
            <Link className="btn btn-sm btn-accent" href="/expenses/new">New expense</Link>
            <Link className="btn btn-sm" href="/notifications">Inbox{unreadNotifications ? ` (${unreadNotifications})` : ""}</Link>
            <span className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
          </div>
        </header>
        <div className="content" id="main-content">{children}</div>
      </div>
    </div>
  );
}
