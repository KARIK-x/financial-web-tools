import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { generateTotpSecret, otpauthUri } from "@/server/mfa";
import { enableMfaAction } from "@/app/actions/auth";
import { MfaSetupForm } from "@/components/MfaSetupForm";

export const dynamic = "force-dynamic";

export default async function MfaSetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.mfaEnabled) redirect("/overview");

  const db = await getDb();
  const row = await one<{ mfa_secret: string | null }>(db, `SELECT mfa_secret FROM users WHERE id=$1`, [user.id]);
  if (!row) redirect("/login");
  let secret = row.mfa_secret;
  if (!secret) {
    secret = generateTotpSecret();
    await db.query(`UPDATE users SET mfa_secret=$2 WHERE id=$1 AND mfa_enabled=false AND mfa_secret IS NULL`, [user.id, secret]);
  }
  const uri = otpauthUri({ secret, email: user.email });
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;

  return (
    <section className="auth-form-wrap" style={{ maxWidth: 620 }}>
      <div className="auth-card">
        <div className="eyebrow">Account security</div>
        <h1 className="page-title">Set up two-factor authentication</h1>
        <p className="page-sub">
          Privileged roles must use an authenticator app in addition to a password. This protects approvals, payments and settings.
        </p>

        <div className="info-box" style={{ marginTop: 18 }}>
          Open your authenticator app, add an account manually, and enter this secret:
          <div className="mono" style={{ marginTop: 8, fontSize: 17, letterSpacing: 1, wordBreak: "break-all" }}>{grouped}</div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            Or open <a className="link" href={uri}>this otpauth link</a> on the device with your authenticator. Do not share this secret.
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <MfaSetupForm action={enableMfaAction} />
        </div>

        <p className="tiny muted" style={{ marginTop: 18 }}>
          Recovery codes are shown once after verification. Store them offline; each code works once if you lose the authenticator.
        </p>
      </div>
    </section>
  );
}
