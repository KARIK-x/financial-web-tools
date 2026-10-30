import { createDatabase, databaseConfigFromEnv, describeDatabaseTarget } from "../src/server/db";

async function main() {
  const config = databaseConfigFromEnv();
  console.log("Applying migrations to", describeDatabaseTarget(config));
  const db = await createDatabase(config);
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  console.log(`OK — ${tables.rows.length} tables:`, tables.rows.map((r) => r.tablename).join(", "));
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
