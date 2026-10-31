import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/ActionForm";
import { setupAction } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const db = await getDb();
  const counts = await one<{ users: number }>(db, `SELECT COUNT(*)::int AS users FROM users`);
  const firstRun = (counts?.users ?? 0) === 0;
  const current = await getCurrentUser();

  if (!firstRun) {
    const allowed = current && can(current.role, "settings.manage", current.permissions);
    return (
      <section className="auth-form-wrap" style={{ gridColumn: "1 / -1" }}>
        <div className="auth-card">
          <div className="eyebrow">Setup complete</div>
          <h1 className="page-title">This workspace already exists</h1>
          <p className="page-sub">
            {allowed
              ? "Add team members from Members → Add account, or reset a password from the member record."
              : "Ask the Finance Manager to create your account or reset your password."}
          </p>
          <div style={{ marginTop: 22, display: "flex", gap: 8 }}>
            <Link className="btn btn-primary" href={current ? "/overview" : "/login"}>{current ? "Go to dashboard" : "Sign in"}</Link>
            {allowed ? <Link className="btn" href="/members">Manage members</Link> : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="auth-art">
        <div>
          <div className="auth-kicker">First-time setup</div>
          <h2 className="auth-headline">
            Start with a
            <br />
            clean ledger.
          </h2>
          <p className="auth-copy">
            This creates the first administrator account. No financial records, sponsor amounts or balances are
            invented — the ledger starts at zero until verified data is entered or imported.
          </p>
          <div className="auth-points">
            <div className="auth-point"><span className="tick">✓</span><span><b>Nothing is pre-filled.</b> Cash, bank and sponsorship balances remain unverified until you set them.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span><b>You can add the team later.</b> Roles control what each person can see and approve.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span><b>Back up after setup.</b> The database and document store live under <code>.data/</code>.</span></div>
          </div>
        </div>
        <div className="auth-kicker">Finance Tracker Intelligence Platform</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-card">
          <div className="eyebrow">Administrator account</div>
          <h1 className="page-title">Create your workspace</h1>
          <p className="page-sub">Use a real email address you control. You will be signed in immediately.</p>

          <div style={{ marginTop: 24 }}>
            <ActionForm action={setupAction} submitLabel="Create workspace" className="grid">
              <div className="field">
                <label className="label" htmlFor="name">Full name <span className="req">*</span></label>
                <input id="name" name="name" required autoComplete="name" placeholder="e.g. Aashish Sharma" />
              </div>
              <div className="field">
                <label className="label" htmlFor="email">Email <span className="req">*</span></label>
                <input id="email" name="email" type="email" required autoComplete="username" placeholder="finance@finance-tracker.org.np" />
              </div>
              <div className="field">
                <label className="label" htmlFor="memberName">Member record name</label>
                <input id="memberName" name="memberName" placeholder="Defaults to your full name" />
                <span className="hint">Used when you pay for something personally and claim reimbursement.</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="password">Password <span className="req">*</span></label>
                <input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
                <span className="hint">At least 12 characters, with a letter and a number.</span>
              </div>
              <div className="field span-2">
                <label className="label" htmlFor="confirmPassword">Confirm password <span className="req">*</span></label>
                <input id="confirmPassword" name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" />
              </div>
            </ActionForm>
          </div>

          <div className="auth-foot">
            Already set up? <Link className="link" href="/login">Sign in</Link>. Passwords are stored as salted scrypt
            hashes; sessions are httpOnly cookies.
          </div>
        </div>
      </section>
    </>
  );
}
