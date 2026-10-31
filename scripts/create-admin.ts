/**
 * Create (or reset) an administrator account without the web UI.
 *
 *   npm run db:create-admin -- --email=finance@example.org --name="Finance Manager"
 *
 * If --password is omitted, a random password is generated and written to
 * .data/initial-admin-credentials.txt with owner-only permissions. The script
 * never prints the password to the terminal.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDatabase, databaseConfigFromEnv, one } from "../src/server/db";
import { hashPassword, passwordIssues } from "../src/server/password";
import { recordAudit } from "../src/server/audit";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    if (!key) continue;
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

function randomPassword(): string {
  return `${randomBytes(18).toString("base64url")}9a`;
}

async function writeCredentials(email: string, password: string) {
  const file = path.join(process.cwd(), ".data", "initial-admin-credentials.txt");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      "Finance Tracker — initial administrator credentials",
      "Generated locally. Delete this file after the first sign-in.",
      "",
      `Email:    ${email}`,
      `Password: ${password}`,
      "",
      "Sign in at /login. Change the password after signing in.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email ?? process.env.FINANCE_TRACKER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = String(args.name ?? process.env.FINANCE_TRACKER_ADMIN_NAME ?? "").trim();
  const reset = Boolean(args["reset-password"]);
  let password = String(args.password ?? process.env.FINANCE_TRACKER_ADMIN_PASSWORD ?? "");
  const generated = !password;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Provide a valid email: npm run db:create-admin -- --email=you@example.org --name=\"Your Name\"");
    process.exit(1);
  }
  if (!name) {
    console.error("Provide the administrator's name with --name=\"…\".");
    process.exit(1);
  }
  if (generated) password = randomPassword();
  const issues = passwordIssues(password);
  if (issues.length) {
    console.error(`Password rejected: ${issues.join(" ")}`);
    process.exit(1);
  }

  const db = await createDatabase(databaseConfigFromEnv());

  try {
    const existing = await one<{ id: string; role: string; member_id: string | null }>(
      db, `SELECT id, role, member_id FROM users WHERE lower(email) = $1`, [email],
    );

    if (existing && !reset) {
      console.error(`An account already exists for ${email}. Use --reset-password to replace its password.`);
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(password);

    if (existing) {
      await db.query(`UPDATE users SET password_hash=$2, is_active=true, must_change_password=true, failed_logins=0, locked_until=NULL WHERE id=$1`, [existing.id, passwordHash]);
      await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [existing.id]);
      await recordAudit(db, {
        actorUserId: null, actorName: "CLI",
        action: "PASSWORD_RESET_CLI", entityType: "user", entityId: existing.id,
        summary: `Password reset from the command line for ${email}; existing sessions revoked.`,
      });
      console.log(`Password reset for ${email}. Existing sessions were revoked.`);
    } else {
      const memberId = randomUUID();
      const userId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO members (id, name, email, role_title) VALUES ($1,$2,$3,'Finance Manager')`,
          [memberId, name, email],
        );
        await tx.query(
          `INSERT INTO users (id, email, name, password_hash, role, member_id, is_active, must_change_password)
           VALUES ($1,$2,$3,$4,'ADMIN',$5,true,true)`,
          [userId, email, name, passwordHash, memberId],
        );
        await tx.query(`UPDATE members SET user_id=$2 WHERE id=$1`, [memberId, userId]);
      });
      await recordAudit(db, {
        actorUserId: null, actorName: "CLI",
        action: "USER_CREATED", entityType: "user", entityId: userId,
        summary: `Administrator account created from the command line for ${email}.`,
        after: { role: "ADMIN", email },
      });
      console.log(`Administrator created for ${email}.`);
    }

    if (generated) {
      const file = await writeCredentials(email, password);
      console.log(`Generated password written to ${path.relative(process.cwd(), file)} (mode 0600).`);
      console.log("Read it, sign in, then delete the file.");
    } else {
      console.log("Password set from the supplied value. It was not written to disk.");
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
