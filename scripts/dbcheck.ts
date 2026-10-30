import { PGlite } from "@electric-sql/pglite";

async function main() {
  const db = new PGlite();
  await db.waitReady;
  const r = await db.query("SELECT version() AS version");
  console.log(JSON.stringify(r.rows));
  await db.close();
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
