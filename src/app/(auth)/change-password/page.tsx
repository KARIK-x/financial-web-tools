import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { ActionForm } from "@/components/ActionForm";
import { changePasswordAction, logoutAction } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const forced = user.mustChangePassword;

  return (
    <>
      <section className="auth-art">
        <div>
          <div className="auth-kicker">FINANCE TRACKER · IOE Pulchowk Campus</div>
          <h2 className="auth-headline">
            Keep the books
            <br />
            under lock.
          </h2>
          <p className="auth-copy">
            Passwords are stored only as scrypt hashes. Changing yours signs out every other
            device that is using this account.
          </p>
          <div className="auth-points">
            <div className="auth-point"><span className="tick">✓</span><span>At least 12 characters, with a letter and a number.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>Do not reuse a password from another service.</span></div>
            <div className="auth-point"><span className="tick">✓</span><span>Finance and Executive sessions expire after 12 hours.</span></div>
          </div>
        </div>
        <div className="auth-kicker">Signed in as {user.email}</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-card">
          <div className="eyebrow">{forced ? "Password change required" : "Account security"}</div>
          <h1 className="page-title">Choose a new password</h1>
          <p className="page-sub">
            {forced
              ? "An administrator issued this account. Set your own password before continuing."
              : "Enter your current password, then choose a new one."}
          </p>

          <div style={{ marginTop: 24 }}>
            <ActionForm action={changePasswordAction} submitLabel="Change password" className="grid">
              <div className="field">
                <label className="label" htmlFor="currentPassword">Current password</label>
                <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="newPassword">New password</label>
                <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
              </div>
              <div className="field">
                <label className="label" htmlFor="confirmPassword">Confirm new password</label>
                <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required />
              </div>
            </ActionForm>
          </div>

          <p className="tiny muted" style={{ marginTop: 16 }}>
            {forced ? (
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="link"
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
                >
                  Sign out
                </button>
              </form>
            ) : (
              <Link href="/overview">Back to dashboard</Link>
            )}
          </p>
        </div>
      </section>
    </>
  );
}
