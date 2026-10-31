import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit + integration tests run against an in-memory PGlite instance with the real
 * migrations applied, so database triggers are exercised, not mocked.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // PGlite runs WASM + a worker per instance; run files sequentially to keep memory predictable.
    pool: "forks",
    fileParallelism: false,
    env: {
      TZ: "Asia/Kathmandu",
      DOCUMENT_DIR: path.join(os.tmpdir(), `finance-tracker-test-documents-${process.pid}`),
    },
  },
});
