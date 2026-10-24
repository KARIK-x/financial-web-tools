import { createDatabase } from "../src/server/db";
import path from "node:path";

async function main() {
  const dataDir = process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  console.log("Applying migrations to", dataDir);
  const db = await createDatabase({ dataDir });
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
