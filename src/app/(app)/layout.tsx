import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

const COUNTED = `('SUBMITTED','UNDER_REVIEW','APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')`;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");

  const db = await getDb();
  const [pending, unreconciled, missingDocs] = await Promise.all([
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM expense_claims WHERE status IN ('SUBMITTED','UNDER_REVIEW')`),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM bank_statement_lines WHERE match_status IN ('UNMATCHED','SUGGESTED')`),
    one<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM expense_claims WHERE documentation_state <> 'COMPLETE' AND status IN ${COUNTED}`),
  ]);

  return (
    <div className="shell">
      <Sidebar
        user={{ name: user.name, roleLabel: user.roleLabel, permissions: user.permissions }}
        pendingApprovals={pending?.n ?? 0}
        unreconciled={unreconciled?.n ?? 0}
        missingDocs={missingDocs?.n ?? 0}
      />
      <div className="main">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
