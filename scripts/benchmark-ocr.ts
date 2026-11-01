import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runExtraction } from "../src/server/ocr";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

async function main() {
  const dir = arg("dir");
  if (!dir) throw new Error("Usage: npm run ocr:benchmark -- --dir <directory> [--engine tesseract|unlimited-ocr|auto] [--out file.json]");
  const engine = (arg("engine") ?? "tesseract") as "tesseract" | "unlimited-ocr" | "auto";
  const out = arg("out");
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort();

  const results = [];
  for (const file of files) {
    const started = Date.now();
    const bytes = readFileSync(file);
    const outcome = await runExtraction(bytes, mimeFor(file), path.basename(file), engine);
    results.push({
      file: path.basename(file),
      engine: outcome.engine,
      status: outcome.status,
      durationMs: outcome.durationMs || Date.now() - started,
      fields: outcome.fields,
      confidence: outcome.confidence,
      error: outcome.error ?? null,
      textLength: outcome.rawText.length,
    });
  }

  const summary = {
    engine,
    files: results.length,
    succeeded: results.filter((r) => r.status === "SUCCEEDED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    averageDurationMs: results.length ? Math.round(results.reduce((sum, r) => sum + r.durationMs, 0) / results.length) : 0,
    results,
  };
  const json = JSON.stringify(summary, null, 2);
  if (out) {
    await (await import("node:fs/promises")).writeFile(out, json);
    console.log(`Wrote ${out}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
