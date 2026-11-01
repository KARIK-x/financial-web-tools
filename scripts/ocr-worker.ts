import { getDb } from "../src/server/db";
import { processNextOcrJob } from "../src/server/ocr-queue";

async function main() {
  const db = await getDb();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const result = await processNextOcrJob("worker", db);
      if (!result) await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      console.error("OCR worker error:", err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
