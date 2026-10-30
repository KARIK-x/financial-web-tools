import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Unzip, UnzipInflate } from "fflate";

// Resolved at runtime only; kept out of the build trace so app source is not bundled as assets.
export const DOCUMENT_ROOT =
  process.env.DOCUMENT_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "documents");

export type StoredFile = {
  bytes: Buffer;
  filename: string;
  mime: string;
};

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function storageKeyFor(hash: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(0, 10).replace(/[^.a-z0-9]/g, "");
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${ext}`;
}

export async function writeDocument(hash: string, filename: string, bytes: Buffer): Promise<string> {
  const key = storageKeyFor(hash, filename);
  const full = path.join(DOCUMENT_ROOT, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  try {
    await fs.writeFile(full, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return key;
}

export async function readDocument(storageKey: string): Promise<Buffer> {
  const root = path.resolve(DOCUMENT_ROOT);
  const full = path.resolve(root, storageKey);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid storage key");
  return fs.readFile(full);
}

export async function documentExists(storageKey: string): Promise<boolean> {
  try {
    const root = path.resolve(DOCUMENT_ROOT);
    const full = path.resolve(root, storageKey);
    if (full !== root && !full.startsWith(root + path.sep)) return false;
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

/** 64-bit average hash; used to flag re-photographed duplicates (never auto-merge). */
export async function perceptualHash(bytes: Buffer): Promise<string | null> {
  try {
    const { data } = await sharp(bytes)
      .rotate()
      .resize(8, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    let bits = "";
    for (const v of data) bits += v >= avg ? "1" : "0";
    return bits;
  } catch {
    return null;
  }
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function classifyFile(filename: string, mime: string): "RECEIPT" | "INVOICE" | "BANK_STATEMENT" | "PAYMENT_CONFIRMATION" | "AGREEMENT" | "SPONSORSHIP" | "SPREADSHEET" | "OTHER" | "UNKNOWN" {
  const name = filename.toLowerCase();
  if (mime.includes("spreadsheet") || /\.(xlsx?|csv|numbers)$/.test(name)) return "SPREADSHEET";
  if (/bank|statement|esewa_statement|khalti_statement/.test(name)) return "BANK_STATEMENT";
  if (/invoice|bill|tax invoice/.test(name)) return "INVOICE";
  if (/mou|agreement|contract|sponsor|proposal/.test(name)) return "AGREEMENT";
  if (/receipt|bill|voucher|purchase/.test(name)) return "RECEIPT";
  if (/payment|transaction|confirmation|transfer/.test(name)) return "PAYMENT_CONFIRMATION";
  if (mime.startsWith("image/")) return "RECEIPT";
  if (mime === "application/pdf") return "UNKNOWN";
  return "OTHER";
}

export function safeFilename(name: string): string {
  return path.basename(name).replace(/[^\w.\- ()\u0900-\u097F]/g, "_").slice(0, 180) || "document";
}

export async function extractZip(bytes: Buffer): Promise<StoredFile[]> {
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
  const MAX_FILES = 500;

  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    const out: StoredFile[] = [];
    let totalBytes = 0;
    let pendingFiles = 0;
    let inputFinished = false;
    let settled = false;

    const finish = () => {
      if (!settled && inputFinished && pendingFiles === 0) {
        settled = true;
        resolve(out);
      }
    };
    const fail = (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    unzip.onfile = (file) => {
      if (file.name.endsWith("/") || file.name.includes("__MACOSX") || file.name.startsWith(".") || file.name.includes("/.")) {
        return;
      }
      if (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES) {
        fail(new Error("Zip member expands to more than 40 MB"));
        return;
      }

      pendingFiles++;
      const chunks: Buffer[] = [];
      let fileSize = 0;

      file.ondata = (err, chunk, final) => {
        if (err) {
          file.terminate();
          fail(err);
          return;
        }
        fileSize += chunk.length;
        totalBytes += chunk.length;
        if (fileSize > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
          file.terminate();
          fail(new Error(fileSize > MAX_FILE_BYTES ? "Zip member expands to more than 40 MB" : "Zip archive expands to more than 100 MB"));
          return;
        }
        chunks.push(Buffer.from(chunk));
        if (!final) return;

        pendingFiles--;
        if (fileSize > 0 && out.length < MAX_FILES) {
          const data = Buffer.concat(chunks);
          const base = safeFilename(file.name);
          out.push({ bytes: data, filename: base, mime: mimeForFilename(base) });
        }
        if (pendingFiles === 0 && inputFinished) finish();
      };

      try {
        file.start();
      } catch (err) {
        pendingFiles--;
        fail(err);
      }
    };

    try {
      unzip.push(new Uint8Array(bytes), true);
      inputFinished = true;
      if (pendingFiles === 0) finish();
    } catch (err) {
      fail(err);
    }
  });
}


export function mimeForFilename(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", heic: "image/heic", gif: "image/gif",
    csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel", txt: "text/plain", zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

export function newBatchLabel(): string {
  return `Batch ${new Date().toISOString().slice(0, 19).replace("T", " ")} ${randomUUID().slice(0, 6)}`;
}
