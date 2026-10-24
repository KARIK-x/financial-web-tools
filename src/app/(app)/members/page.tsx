import { requirePagePermission } from "@/server/page-auth";
import { getDb, many } from "@/server/db";
import { memberAccountability } from "@/server/advances";
import { formatNPR, formatNPRShort } from "@/lib/money";
import { formatTimestamp } from "@/lib/nepali-date";
import { ROLES, ROLE_LABELS } from "@/lib/permissions";
import { PageHeader, Stat, StatusBadge } from "@/components/ui";
import { ActionForm, QuickAction } from "@/components/ActionForm";
import {
  createMemberAction, createUserAction, resetPasswordAction, toggleUserActiveAction,
} from "@/app/actions/members";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  await requirePagePermission("member.manage");
  const db = await getDb();
  const [members, users, freeMembers] = await Promise.all([
    memberAccountability(db),
    many<{ id: string; name: string; email: string; role: string; is_active: boolean; last_login_at: Date | null; member_id: string | null; must_change_password: boolean; is_synthetic: boolean }>(
      db,
      `SELECT id, name, email, role, is_active, last_login_at, member_id, must_change_password, is_synthetic FROM users ORDER BY is_active DESC, name`,
    ),
    many<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM members WHERE is_active AND user_id IS NULL ORDER BY name`,
    ),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="People & access"
        title="Members"
        sub="A member is a person who can owe or be owed money. An account is a login with a role. They are linked but separate, so someone can appear in the ledger without being able to sign in."
      />

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Active members" value={members.length} foot="Appear in the financial ledger" />
        <Stat label="Logins" value={users.length} foot={`${users.filter((u) => !u.is_active).length} deactivated`} />
        <Stat label="Owed to members" value={formatNPRShort(members.reduce((s, m) => s + Number(m.reimbursements_owed_paisa), 0))} foot="Approved reimbursements unpaid" tone="warn" />
        <Stat label="Advances outstanding" value={formatNPRShort(members.reduce((s, m) => s + Number(m.advances_outstanding_paisa), 0))} foot="Across all members" />
      </section>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head"><div className="section-title">Member accountability</div><span className="tiny muted">{members.length} members</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Member</th><th className="right">Submitted</th><th className="right">Approved</th><th className="right">Awaiting</th><th className="right">Missing docs</th><th className="right">Advance open</th><th className="right">Owed</th><th className="right">Reimbursed</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id}>
                  <td><div className="row-title">{m.name}</div><div className="row-sub">{m.submitted_count} claims</div></td>
                  <td className="right mono">{formatNPR(Number(m.submitted_paisa))}</td>
                  <td className="right mono">{formatNPR(Number(m.approved_paisa))}</td>
                  <td className="right mono">{formatNPR(Number(m.awaiting_paisa))}</td>
                  <td className="right mono">{Number(m.missing_docs_paisa) > 0 ? <span style={{ color: "var(--danger)" }}>{formatNPR(Number(m.missing_docs_paisa))}</span> : "—"}</td>
                  <td className="right mono">{formatNPR(Number(m.advances_outstanding_paisa))}</td>
                  <td className="right mono">{formatNPR(Number(m.reimbursements_owed_paisa))}</td>
                  <td className="right mono">{formatNPR(Number(m.reimbursed_paisa))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)" }}>
        <div className="card">
          <div className="card-head"><div className="section-title">Logins & roles</div></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><div className="row-title">{u.name}{u.is_synthetic ? <span className="src" style={{ marginLeft: 5 }}>Demo</span> : null}</div><div className="row-sub">{u.email}</div></td>
                    <td>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS] ?? u.role}</td>
                    <td>
                      <span className={`badge ${u.is_active ? "badge-green" : "badge-gray"}`}>{u.is_active ? "Active" : "Disabled"}</span>
                      {u.must_change_password ? <div className="row-sub">Password change pending</div> : null}
                    </td>
                    <td className="muted nowrap">{formatTimestamp(u.last_login_at)}</td>
                    <td>
                      <details>
                        <summary className="link small" style={{ cursor: "pointer" }}>Reset password</summary>
                        <div style={{ marginTop: 8, minWidth: 240 }}>
                          <ActionForm action={resetPasswordAction} submitLabel="Reset & sign out" submitClass="btn btn-sm btn-danger" hideStatus>
                            <input type="hidden" name="userId" value={u.id} />
                            <input name="password" type="password" required minLength={12} placeholder="New password" style={{ marginBottom: 6 }} />
                          </ActionForm>
                        </div>
                      </details>
                      <div style={{ marginTop: 4 }}>
                        <QuickAction
                          action={toggleUserActiveAction}
                          label={u.is_active ? "Deactivate" : "Reactivate"}
                          fields={{ userId: u.id }}
                          className="btn btn-xs"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div className="card">
            <div className="card-head"><div className="section-title">Create login</div></div>
            <div className="card-body">
              <ActionForm action={createUserAction} submitLabel="Create account">
                <div className="grid" style={{ gap: 10 }}>
                  <div className="field"><label className="label">Full name</label><input name="name" required /></div>
                  <div className="field"><label className="label">Email</label><input name="email" type="email" required /></div>
                  <div className="field">
                    <label className="label">Role</label>
                    <select name="role" defaultValue="MEMBER">
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">Link to member record</label>
                    <select name="memberId" defaultValue="">
                      <option value="">No member record (cannot claim)</option>
                      {freeMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <span className="hint">A login needs a linked member to submit expense claims.</span>
                  </div>
                  <div className="field"><label className="label">Temporary password</label><input name="password" type="password" required minLength={12} /><span className="hint">12+ characters, letter and number. Must be changed at first sign-in.</span></div>
                </div>
              </ActionForm>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="section-title">Add member record</div></div>
            <div className="card-body">
              <ActionForm action={createMemberAction} submitLabel="Add member" resetOnSuccess>
                <div className="grid" style={{ gap: 10 }}>
                  <div className="field"><label className="label">Name</label><input name="name" required /></div>
                  <div className="field"><label className="label">Email</label><input name="email" type="email" /></div>
                  <div className="field"><label className="label">Phone</label><input name="phone" /></div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div className="field"><label className="label">Program</label><input name="program" /></div>
                    <div className="field"><label className="label">Batch</label><input name="batch" /></div>
                  </div>
                  <div className="field"><label className="label">LOCUS role</label><input name="roleTitle" placeholder="e.g. Treasurer" /></div>
                  <div className="field"><label className="label">Notes</label><textarea name="notes" /></div>
                </div>
              </ActionForm>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
