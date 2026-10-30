import { createDatabase, databaseConfigFromEnv } from "../src/server/db";
import { queueOutstandingReminders } from "../src/server/notifications";

async function main() {
  const db = await createDatabase(databaseConfigFromEnv());
  try {
    const result = await queueOutstandingReminders(db);
    console.log(`Queued ${result.queued} operational reminder(s). Run npm run email:send to deliver them.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
