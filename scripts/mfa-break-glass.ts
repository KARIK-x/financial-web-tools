import { createDatabase, databaseConfigFromEnv, describeDatabaseTarget } from "../src/server/db";
import { breakGlassResetSoleAdminMfa } from "../src/server/mfa";

async function main() {
  const email = process.argv[2];
  const token = process.env.MFA_BREAK_GLASS_TOKEN ?? "";
  const confirm = process.env.MFA_BREAK_GLASS_CONFIRM ?? "";
  if (!email) throw new Error("Usage: npm run mfa:break-glass -- admin@example.org");
  if (!token) throw new Error("Set MFA_BREAK_GLASS_TOKEN in the operator environment; do not put it in shell history.");
  if (confirm !== email) throw new Error("Set MFA_BREAK_GLASS_CONFIRM to the exact administrator email to confirm.");
  if (!process.env.MFA_BREAK_GLASS_TOKEN_HASH) throw new Error("Set MFA_BREAK_GLASS_TOKEN_HASH to the SHA-256 hex digest of the token.");
  const db = await createDatabase(databaseConfigFromEnv());
  try {
    const result = await breakGlassResetSoleAdminMfa(db, { targetEmail: email, token });
    console.log(`MFA disabled for sole administrator ${result.email}; all sessions revoked.`);
    console.log("Target:", describeDatabaseTarget(databaseConfigFromEnv()));
    console.log("Re-enrol MFA immediately after signing in. This action is recorded in the audit log.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
