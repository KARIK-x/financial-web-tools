import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { requestPasswordResetAction } from "@/app/actions/password-reset";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <>
      <section className="auth-art">
        <div>
          <div className="auth-kicker">LOCUS · IOE Pulchowk Campus</div>
          <h2 className="auth-headline">
            Recover access
            <br />
            without weakening the books.
          </h2>
          <p className="auth-copy">
            Reset links are single-use, expire after 30 minutes, and are stored only as hashes. Completing a reset
            signs out every existing session for the account.
          </p>
          <div className="auth-points">
            <div className="auth-point"><span className="tick">✓</span><span>The response never reveals whether an address is registered.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>Requests are rate-limited per address and per network address.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>If delivery is not configured, an administrator must reset the account.</span></div>
          </div>
        </div>
        <div className="auth-kicker">Account recovery · 30 minute link</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-card">
          <div className="eyebrow">Account recovery</div>
          <h1 className="page-title">Forgot password</h1>
          <p className="page-sub">Enter the email address issued by the LOCUS finance team.</p>

          <div style={{ marginTop: 24 }}>
            <ActionForm action={requestPasswordResetAction} submitLabel="Send reset link" className="grid">
              <div className="field">
                <label className="label" htmlFor="email">Email</label>
                <input id="email" name="email" type="email" autoComplete="username" required placeholder="you@locus.org.np" />
              </div>
            </ActionForm>
          </div>

          <div className="auth-foot">
            <Link className="link" href="/login">Back to sign in</Link>
          </div>
        </div>
      </section>
    </>
  );
}
