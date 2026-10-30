import { createDatabase, databaseConfigFromEnv, describeDatabaseTarget } from "../src/server/db";
import { dispatchQueuedNotifications, getEmailConfig } from "../src/server/email";

async function main() {
  const config = getEmailConfig();
  const db = await createDatabase(databaseConfigFromEnv());
  try {
    if (!config.configured) {
      console.log("Email delivery is BLOCKED:", config.errors.join(" ") || "EMAIL_PROVIDER is not set.");
      console.log("Notifications remain queued in notification_outbox; no message was sent.");
      return;
    }
    const result = await dispatchQueuedNotifications(db);
    console.log(`Notification dispatch: attempted=${result.attempted} sent=${result.sent} failed=${result.failed} blocked=${result.blocked}`);
    if (result.blocked) console.log("Some notifications were blocked by provider configuration.");
    if (result.failed) console.log("Some notifications failed; they will retry with backoff.");
    console.log("Target:", describeDatabaseTarget(databaseConfigFromEnv()));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
