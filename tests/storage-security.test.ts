import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import type { Db } from "@/server/db";
import type { OrphanFile } from "@/server/storage-cleanup";
import { createTestDb } from "./helpers/fixtures";

describe("storage security", () => {
  let root: string;
  let storage: typeof import("@/server/storage");
  let cleanup: typeof import("@/server/storage-cleanup");

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "locus-storage-"));
    process.env.DOCUMENT_DIR = root;
    storage = await import("@/server/storage");
    cleanup = await import("@/server/storage-cleanup");
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("reads a document only when its resolved path stays inside the root", async () => {
    const key = "aa/bb/test.txt";
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "aa", "bb"), { recursive: true });
    await writeFile(path.join(root, "aa", "bb", "test.txt"), Buffer.from("ok"));
    await expect(storage.readDocument(key)).resolves.toEqual(Buffer.from("ok"));
    await rm(path.join(root, "aa"), { recursive: true, force: true });
    await expect(storage.readDocument("/etc/passwd")).rejects.toThrow("Invalid storage key");
    await expect(storage.readDocument("../../etc/passwd")).rejects.toThrow("Invalid storage key");
    await expect(storage.documentExists("/etc/passwd")).resolves.toBe(false);
    await expect(storage.documentExists("../../etc/passwd")).resolves.toBe(false);
  });

  it("rejects zip members larger than 40 MB", async () => {
    const zip = Buffer.from(zipSync({ "big.bin": new Uint8Array(41 * 1024 * 1024) }));
    await expect(storage.extractZip(zip)).rejects.toThrow(/more than 40 MB/);
  });

  it("rejects zip archives expanding beyond 100 MB in total", async () => {
    const zip = Buffer.from(zipSync({
      "a.bin": new Uint8Array(35 * 1024 * 1024).fill(1),
      "b.bin": new Uint8Array(35 * 1024 * 1024).fill(2),
      "c.bin": new Uint8Array(35 * 1024 * 1024).fill(3),
    }));
    await expect(storage.extractZip(zip)).rejects.toThrow(/more than 100 MB/);
  });

  it("extracts a normal zip and preserves safe filenames", async () => {
    const zip = Buffer.from(zipSync({ "folder/report.txt": Buffer.from("hello") }));
    const files = await storage.extractZip(zip);
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("report.txt");
    expect(files[0]?.bytes.toString()).toBe("hello");
  });

  it("refuses orphan deletion when a key resolves outside the root", async () => {
    const db: Db = await createTestDb();
    try {
      const outside = path.join(os.tmpdir(), `locus-outside-${Date.now()}.txt`);
      await writeFile(outside, Buffer.from("do not delete"));
      const orphan: OrphanFile = { key: "../" + path.basename(outside), bytes: 16, modifiedAt: new Date(0) };
      const result = await cleanup.deleteOrphanDocumentFiles(db, [orphan], { root, actorName: "test" });
      expect(result).toEqual({ deleted: 0, refused: 1 });
      await expect(readFile(outside)).resolves.toEqual(Buffer.from("do not delete"));
      await rm(outside, { force: true });
    } finally {
      await db.close();
    }
  });

  it("deletes only unreferenced orphan files inside the root", async () => {
    const db: Db = await createTestDb();
    try {
      const nested = path.join(root, "zz");
      await (await import("node:fs/promises")).mkdir(nested, { recursive: true });
      const orphanPath = path.join(nested, "orphan.txt");
      await writeFile(orphanPath, Buffer.from("orphan"));
      const report = await cleanup.findOrphanDocumentFiles(db, { root, graceMs: 0, now: new Date(Date.now() + 1000) });
      const orphan = report.orphans.find((o) => o.key === "zz/orphan.txt");
      expect(orphan).toBeTruthy();
      const result = await cleanup.deleteOrphanDocumentFiles(db, orphan ? [orphan] : [], { root, actorName: "test" });
      expect(result.deleted).toBe(1);
      await expect(access(orphanPath)).rejects.toBeTruthy();
    } finally {
      await db.close();
    }
  });
});
