import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { listNotifications, markAllNotificationsRead } from "@/server/notifications-center";
import { PageHeader, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { markAllNotificationsReadAction } from "@/app/actions/notifications";
import Link from "next/link";
import { Bell } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const db = await getDb();
  const notifications = await listNotifications(db, user.id);
  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        sub="In-app notices for submitted, approved, paid, and verified claims."
        actions={
          <ActionForm action={markAllNotificationsReadAction} submitLabel="Mark all read"><span /></ActionForm>
        }
      />
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          {notifications.length ? notifications.map((n) => (
            <div key={n.id} className="list-row" style={{ padding: "14px 20px" }}>
              <span className="icon-box badge-blue"><Bell size={13} /></span>
              <div style={{ flex: 1 }}>
                <div className="small" style={{ fontWeight: 600 }}>{n.title}</div>
                {n.body ? <div className="tiny muted" style={{ marginTop: 3 }}>{n.body}</div> : null}
                <div className="tiny muted" style={{ marginTop: 4 }}>{n.created_at.toISOString()}</div>
              </div>
              {n.link ? <Link className="btn btn-xs" href={n.link}>Open</Link> : null}
            </div>
          )) : <EmptyState title="No notifications" text="You will see claim and finance updates here." />}
        </div>
      </div>
    </>
  );
}
