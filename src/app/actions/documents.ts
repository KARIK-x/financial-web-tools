"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requestContext } from "@/server/auth";
import { getDb } from "@/server/db";
import { attachDocumentToClaim, createBatch, processDocumentOcr, reviewDocument, saveDocumentCorrection, uploadOne } from "@/server/documents";
import { queueDocumentOcr, processNextOcrJob } from "@/server/ocr-queue";
import { requestedOcrEngine } from "@/server/ocr-engine";
import { rebuildDocumentSearchIndex } from "@/server/document-search";
import { bool, fail, file, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function uploadDocumentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const ctx = await requestContext();
    const upload = file(fd, "file");
    if (!upload) return { ok: false, error: "Choose a file to upload." };
    if (upload.size > MAX_FILE_BYTES) return { ok: false, error: "Files are limited to 10 MB." };

    const batchId = await createBatch(db, user, str(fd, "label") || `Upload ${new Date().toISOString().slice(0, 10)}`, "UPLOAD");
    const bytes = Buffer.from(await upload.arrayBuffer());
    const result = await uploadOne(
      db, user,
      {
        filename: upload.name,
        mime: upload.type,
        bytes,
        batchId,
        docType: optional(fd, "docType") ?? undefined,
      },
      ctx,
    );
    await rebuildDocumentSearchIndex(db, result.documentId);
    let queuedStatus = "queued";
    try {
      const queued = await queueDocumentOcr(db, user, result.documentId, { engine: requestedOcrEngine() });
      queuedStatus = queued.status.toLowerCase();
      if (process.env.OCR_AUTO_PROCESS !== "false") {
        void processNextOcrJob("upload").catch(() => {});
      }
    } catch (err) {
      queuedStatus = "not queued";
    }
    revalidatePath("/receipts");
    revalidatePath("/overview");
    if (result.duplicate) {
      return {
        ok: true,
        message: `This exact file already exists as document ${result.duplicateOf?.slice(0, 8)}. The original was kept. OCR ${queuedStatus}.`,
        redirectTo: `/receipts/${result.documentId}`,
      };
    }
    return {
      ok: true,
      message: `Uploaded ${result.filename}. OCR ${queuedStatus}.`,
      warning: result.nearDuplicateOf ? "A visually similar image already exists. Review the duplicate flag before using this receipt." : undefined,
      redirectTo: `/receipts/${result.documentId}`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function runOcrAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const documentId = str(fd, "documentId");
    const ctx = await requestContext();
    const outcome = await processDocumentOcr(db, user, documentId, { ip: ctx.ip });
    revalidatePath(`/receipts/${documentId}`);
    revalidatePath("/receipts");
    if (outcome.status === "FAILED") {
      return { ok: false, error: `Extraction failed: ${outcome.error ?? "unknown error"}. You can still review and enter fields manually.` };
    }
    if (outcome.status === "SKIPPED") {
      return { ok: true, message: `Extraction skipped: ${outcome.error ?? "unsupported file type"}. Enter fields manually.` };
    }
    return { ok: true, message: `Extraction finished with ${outcome.engine}. Treat all fields as candidates and check them against the image.` };
  } catch (err) {
    return fail(err);
  }
}

export async function saveCorrectionAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const documentId = str(fd, "documentId");
    const fields: Record<string, unknown> = {};
    for (const key of ["merchant", "date", "invoiceNo", "sellerPan"]) {
      const value = optional(fd, key);
      if (value) fields[key] = value;
    }
    const total = optional(fd, "total");
    if (total) fields.totalRaw = total;
    if (!Object.keys(fields).length) return { ok: false, error: "Enter at least one corrected field." };
    await saveDocumentCorrection(db, user, documentId, fields);
    revalidatePath(`/receipts/${documentId}`);
    return { ok: true, message: "Corrections saved. The candidate fields are now marked as reviewer-corrected." };
  } catch (err) {
    return fail(err);
  }
}

export async function reviewDocumentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const documentId = str(fd, "documentId");
    const accept = bool(fd, "accept");
    await reviewDocument(db, user, { documentId, accept });
    revalidatePath(`/receipts/${documentId}`);
    revalidatePath("/receipts");
    return { ok: true, message: accept ? "Document marked reviewed." : "Document marked as needing rework." };
  } catch (err) {
    return fail(err);
  }
}

export async function attachDocumentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const documentId = str(fd, "documentId");
    const claimNo = str(fd, "claimNo");
    if (!claimNo) return { ok: false, error: "Enter the claim number, e.g. LOC-2026-0001." };

    const result = await attachDocumentToClaim(db, user, { documentId, claimNo });
    revalidatePath(`/receipts/${documentId}`);
    revalidatePath(`/expenses/${result.claimId}`);
    return { ok: true, message: `Attached to ${result.claimNo}.` };
  } catch (err) {
    return fail(err);
  }
}
