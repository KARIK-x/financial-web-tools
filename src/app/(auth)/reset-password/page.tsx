import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { completePasswordResetAction } from "@/app/actions/password-reset";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;

  return (
    <>
      <section className="auth-art">
        <div>
          <div className="auth-kicker">LOCUS · IOE Pulchowk Campus</div>
          <h2 className="auth-headline">
            Set a new password.
            <br />
            Close the old sessions.
          </h2>
          <p className="auth-copy">
            This link is single-use and expires 30 minutes after it was requested. Completing the reset revokes every
            active session for the account.
          </p>
          <div className="auth-points">
            <div className="auth-point"><span className="tick">✓</span><span>Use at least 12 characters with a letter and a number.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>Do not reuse a password from another service.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>Contact the Finance Manager if this link has expired.</span></div>
          </div>
        </div>
        <div className="auth-kicker">Account recovery · one-time link</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-card">
          <div className="eyebrow">Account recovery</div>
          <h1 className="page-title">Choose a new password</h1>
          {token ? (
            <>
              <p className="page-sub">The reset link is valid for one use.</p>
              <div style={{ marginTop: 24 }}>
                <ActionForm action={completePasswordResetAction} submitLabel="Update password and sign out everywhere" className="grid">
                  <input type="hidden" name="token" value={token} />
                  <div className="field">
                    <label className="label" htmlFor="password">New password</label>
                    <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="confirmPassword">Confirm new password</label>
                    <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required />
                  </div>
                </ActionForm>
              </div>
            </>
          ) : (
            <div className="error-box" role="alert">
              This reset link is missing its token. Request a new link from the <Link className="link" href="/forgot-password">forgot-password page</Link>.
            </div>
          )}
          <div className="auth-foot">
            <Link className="link" href="/login">Back to sign in</Link>
          </div>
        </div>
      </section>
    </>
  );
}
