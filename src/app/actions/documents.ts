"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requestContext } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { createBatch, processDocumentOcr, saveDocumentCorrection, uploadOne } from "@/server/documents";
import { recordAudit } from "@/server/audit";
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
    revalidatePath("/receipts");
    revalidatePath("/overview");
    if (result.duplicate) {
      return {
        ok: true,
        message: `This exact file already exists as document ${result.duplicateOf?.slice(0, 8)}. The original was kept.`,
        redirectTo: `/receipts/${result.documentId}`,
      };
    }
    return {
      ok: true,
      message: `Uploaded ${result.filename}.`,
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
    await db.query(
      `UPDATE documents SET review_status = $2, reviewed_by = $3, reviewed_at = now(),
              status = CASE WHEN $2 = 'ACCEPTED' THEN 'REVIEWED' ELSE 'NEEDS_REVIEW' END
        WHERE id = $1`,
      [documentId, accept ? "ACCEPTED" : "REJECTED", user.id],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name,
      action: accept ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
      entityType: "document", entityId: documentId,
      summary: accept ? "Reviewer accepted the extracted fields" : "Reviewer rejected the extracted fields",
    });
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
    const claim = await one<{ id: string; claim_no: string; status: string }>(
      db, `SELECT id, claim_no, status FROM expense_claims WHERE upper(claim_no) = upper($1)`, [claimNo],
    );
    if (!claim) return { ok: false, error: `No claim found with number ${claimNo}.` };
    if (["REJECTED", "WITHDRAWN"].includes(claim.status)) return { ok: false, error: "This claim is closed; attach the receipt to a new claim instead." };

    const already = await one<{ id: string }>(db, `SELECT id FROM documents WHERE claim_id = $1 AND id <> $2`, [claim.id, documentId]);
    await db.query(`UPDATE documents SET claim_id = $2, doc_type = CASE WHEN doc_type='UNKNOWN' THEN 'RECEIPT' ELSE doc_type END WHERE id = $1`, [documentId, claim.id]);
    await db.query(
      `UPDATE expense_claims SET documentation_state = 'COMPLETE'
        WHERE id = $1 AND documentation_state <> 'COMPLETE'`,
      [claim.id],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "DOCUMENT_ATTACHED",
      entityType: "document", entityId: documentId,
      summary: `Receipt attached to ${claim.claim_no}${already ? " (claim already had other documents)" : ""}`,
    });
    revalidatePath(`/receipts/${documentId}`);
    revalidatePath(`/expenses/${claim.id}`);
    return { ok: true, message: `Attached to ${claim.claim_no}.` };
  } catch (err) {
    return fail(err);
  }
}
