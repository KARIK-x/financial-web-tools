import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { requirePagePermission } from "@/server/page-auth";
import { PageHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const user = await requirePagePermission();
  const { permission } = await searchParams;

  return (
    <>
      <PageHeader
        title="Access restricted"
        sub="Your role does not include the permission this page requires."
      />
      <div className="card">
        <EmptyState
          title="You do not have access to this page"
          text={
            permission
              ? `Your role (${user.roleLabel}) does not include the “${permission}” permission. Ask an administrator if you need it.`
              : `Your role (${user.roleLabel}) cannot open this page. Ask an administrator if you need access.`
          }
          action={
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <Link className="btn btn-primary" href="/overview">Back to dashboard</Link>
              <Link className="btn" href="/my-expenses">My claims</Link>
            </div>
          }
        />
        <div style={{ display: "flex", justifyContent: "center", paddingBottom: 18 }}>
          <span className="tiny muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ShieldAlert size={13} /> Access is enforced on the server, not only in the menu.
          </span>
        </div>
      </div>
    </>
  );
}
