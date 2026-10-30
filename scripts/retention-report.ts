import { createDatabase, databaseConfigFromEnv } from "../src/server/db";

async function main() {
  const db = await createDatabase(databaseConfigFromEnv());
  try {
    const expired = await db.query<{ id: string; filename: string; retention_until: string; legal_hold: boolean }>(
      `SELECT id, filename, to_char(retention_until,'YYYY-MM-DD') AS retention_until, legal_hold
         FROM documents
        WHERE retention_until IS NOT NULL AND retention_until < CURRENT_DATE
        ORDER BY retention_until`,
    );
    const held = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents WHERE legal_hold=true`);
    console.log(`Expired retention records: ${expired.rows.length}`);
    for (const row of expired.rows) {
      console.log(`${row.legal_hold ? "HOLD" : "EXPIRED"} ${row.id} ${row.filename} until=${row.retention_until}`);
    }
    console.log(`Documents on legal hold: ${held.rows[0]?.n ?? 0}`);
    console.log("No files are deleted automatically; review before any action.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
