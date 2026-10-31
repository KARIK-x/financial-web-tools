import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { ActionForm } from "@/components/ActionForm";
import { loginAction } from "@/app/actions/auth";
import { fiscalYearBsFor, todayISO } from "@/lib/nepali-date";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/change-password" : user.mfaPending ? "/mfa-setup" : "/overview");

  const db = await getDb();
  const counts = await one<{ users: number; synthetic: number }>(
    db,
    `SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE is_synthetic)::int AS synthetic FROM users`,
  );
  if (!counts?.users) redirect("/setup");

  const showDemoHint = counts.synthetic > 0 && process.env.NODE_ENV !== "production";

  return (
    <>
      <section className="auth-art">
        <div>
          <div className="auth-kicker">FINANCE TRACKER · IOE Pulchowk Campus</div>
          <h2 className="auth-headline">
            Every rupee,
            <br />
            accounted for.
          </h2>
          <p className="auth-copy">
            One ledger for claims, receipts, advances, sponsorships and reconciliations — with evidence attached
            and an audit trail that cannot be rewritten.
          </p>
          <div className="auth-points">
            <div className="auth-point"><span className="tick">✓</span><span><b>Evidence first.</b> Receipts are hashed, deduplicated and reviewed before a claim is verified.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span><b>Real double-entry.</b> Approvals, payments and receipts post balanced journal entries.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span><b>Nothing hidden.</b> Unverified spend, missing documents and unreconciled lines stay visible.</span></div>
          </div>

          <div className="auth-ledger">
            <div className="auth-ledger-row"><span>Cash on hand</span><span className="num">NPR 1,24,500.00</span></div>
            <div className="auth-ledger-row"><span>Verified spend</span><span className="num">NPR 86,320.00</span></div>
            <div className="auth-ledger-row"><span>Awaiting approval</span><span className="num">NPR 14,200.00</span></div>
            <div className="auth-ledger-foot">Sample ledger · live data stays private</div>
          </div>
        </div>
        <div className="auth-kicker">Financial year {fiscalYearBsFor(todayISO())} · NPR</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-card">
          <div className="eyebrow">Welcome back</div>
          <h1 className="page-title">Sign in</h1>
          <p className="page-sub">Use the account issued by the Finance Tracker finance team.</p>

          <div style={{ marginTop: 24 }}>
            <ActionForm action={loginAction} submitLabel="Sign in" className="grid">
              <div className="field">
                <label className="label" htmlFor="email">Email</label>
                <input id="email" name="email" type="email" autoComplete="username" required placeholder="you@finance-tracker.org.np" />
              </div>
              <div className="field">
                <label className="label" htmlFor="password">Password</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required minLength={8} />
              </div>
              <div className="field">
                <label className="label" htmlFor="mfaCode">Authenticator or recovery code <span className="muted">(if enabled)</span></label>
                <input id="mfaCode" name="mfaCode" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or ABCD-EFGHI" />
                <span className="hint">Privileged accounts can enroll an authenticator after signing in.</span>
              </div>
            </ActionForm>
          </div>

          {showDemoHint ? (
            <div className="info-box" style={{ marginTop: 16 }}>
              <b>Demo data is loaded in this database.</b> Demo accounts and their password are documented in
              <code style={{ marginLeft: 4 }}>docs/DEPLOYMENT_GUIDE.md</code>. Do not reuse demo credentials for real records.
            </div>
          ) : null}

          <div className="auth-foot">
            Sessions are server-side and expire automatically. <Link className="link" href="/forgot-password">Forgot password?</Link>{" "}
            Contact the Finance Manager if you need an account. <Link className="link" href="/setup">First-time setup</Link>
          </div>
        </div>
      </section>
    </>
  );
}
