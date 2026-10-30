"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requestContext } from "@/server/auth";
import { getDb } from "@/server/db";
import {
  createExpense, decideClaim, flagDispute, recordClaimPayment, submitClaim, verifyClaim, withdrawClaim,
} from "@/server/expenses";
import { createBatch, uploadOne } from "@/server/documents";
import { bool, fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff", "application/pdf", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"];

function revalidateClaim(id?: string) {
  revalidatePath("/overview");
  revalidatePath("/expenses");
  revalidatePath("/my-expenses");
  revalidatePath("/approvals");
  revalidatePath("/receipts");
  if (id) revalidatePath(`/expenses/${id}`);
}

export async function createExpenseAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const ctx = await requestContext();

    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    const documentIds: string[] = [];
    let batchId: string | null = null;

    if (files.length > 6) return { ok: false, error: "Attach at most 6 files per claim. Add more from the receipts page afterwards." };

    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) return { ok: false, error: `${f.name} is larger than 10 MB.` };
      if (f.type && !ALLOWED.includes(f.type)) {
        return { ok: false, error: `${f.name}: ${f.type || "unknown type"} is not an accepted receipt format (image, PDF, CSV or XLSX).` };
      }
      if (!batchId) batchId = await createBatch(db, user, `Expense claim upload ${new Date().toISOString().slice(0, 10)}`, "UPLOAD");
      const bytes = Buffer.from(await f.arrayBuffer());
      const uploaded = await uploadOne(db, user, { filename: f.name, mime: f.type, bytes, batchId }, ctx);
      documentIds.push(uploaded.documentId);
    }

    const result = await createExpense(
      db,
      user,
      {
        date: str(fd, "date"),
        vendorName: str(fd, "vendorName"),
        description: str(fd, "description"),
        businessPurpose: optional(fd, "businessPurpose"),
        amount: str(fd, "amount"),
        categoryId: str(fd, "categoryId"),
        items: (() => {
          const descs = fd.getAll("itemDescription").map((v) => String(v).trim()).filter(Boolean);
          const qtys = fd.getAll("itemQty").map((v) => String(v));
          const units = fd.getAll("itemUnit").map((v) => String(v));
          const prices = fd.getAll("itemUnitPrice").map((v) => String(v));
          const discounts = fd.getAll("itemDiscount").map((v) => String(v));
          const taxes = fd.getAll("itemTax").map((v) => String(v));
          const out: Array<{ description: string; quantity: string; unit?: string | null; unitPrice: string; discount?: string | null; tax?: string | null }> = [];
          for (let i = 0; i < descs.length; i++) {
            out.push({
              description: descs[i]!,
              quantity: qtys[i] || "1",
              unit: units[i] || null,
              unitPrice: prices[i] || "0",
              discount: discounts[i] || null,
              tax: taxes[i] || null,
            });
          }
          return out.length ? out : undefined;
        })(),
        eventId: optional(fd, "eventId"),
        departmentId: optional(fd, "departmentId"),
        fundingSource: (str(fd, "fundingSource") || "PERSONAL") as "PERSONAL" | "LOCUS_CASH" | "LOCUS_BANK",
        paymentMethod: optional(fd, "paymentMethod"),
        invoiceNo: optional(fd, "invoiceNo"),
        sellerPan: optional(fd, "sellerPan"),
        notes: optional(fd, "notes"),
        missingReceiptDeclaration: optional(fd, "missingReceiptDeclaration"),
        advanceId: optional(fd, "advanceId"),
        submitNow: bool(fd, "submitNow"),
        calendar: "AD",
      },
      documentIds,
      ctx,
    );
    revalidateClaim(result.id);
    return {
      ok: true,
      message: result.status === "SUBMITTED" ? `Claim ${result.claimNo} submitted for approval.` : `Draft ${result.claimNo} saved.`,
      redirectTo: `/expenses/${result.id}`,
      warning: documentIds.length === 0 ? "No receipt attached. If a receipt is required, submit a missing-receipt declaration or attach evidence before approval." : undefined,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function submitClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    await submitClaim(db, user, str(fd, "claimId"));
    revalidateClaim(str(fd, "claimId"));
    return { ok: true, message: "Claim submitted for approval." };
  } catch (err) {
    return fail(err);
  }
}

export async function withdrawClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    await withdrawClaim(db, user, str(fd, "claimId"));
    revalidateClaim(str(fd, "claimId"));
    return { ok: true, message: "Claim withdrawn." };
  } catch (err) {
    return fail(err);
  }
}

export async function decideClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const ctx = await requestContext();
    const decision = str(fd, "decision");
    if (!["APPROVE", "REJECT", "REQUEST_CHANGES"].includes(decision)) return { ok: false, error: "Unknown decision." };
    const claimId = str(fd, "claimId");
    const result = await decideClaim(
      db, user, claimId,
      decision as "APPROVE" | "REJECT" | "REQUEST_CHANGES",
      optional(fd, "reason"),
      { ip: ctx.ip },
    );
    revalidateClaim(claimId);
    const messages: Record<string, string> = {
      APPROVED: "Approved and posted to the ledger.",
      UNDER_REVIEW: decision === "APPROVE" ? "Approval recorded. Another approver is still required." : "Changes requested.",
      REJECTED: "Claim rejected.",
    };
    return { ok: true, message: messages[result.status] ?? `Status is now ${result.status}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function recordPaymentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const ctx = await requestContext();
    const claimId = str(fd, "claimId");
    const result = await recordClaimPayment(db, user, {
      claimId,
      accountId: str(fd, "accountId"),
      amount: str(fd, "amount"),
      date: str(fd, "date"),
      method: optional(fd, "method") ?? undefined,
      reference: optional(fd, "reference") ?? undefined,
      notes: optional(fd, "notes") ?? undefined,
    }, { ip: ctx.ip });
    revalidateClaim(claimId);
    revalidatePath("/accounts");
    return { ok: true, message: `Payment recorded. Claim status: ${result.status.replaceAll("_", " ").toLowerCase()}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function verifyClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const claimId = str(fd, "claimId");
    await verifyClaim(db, user, claimId, optional(fd, "note") ?? undefined);
    revalidateClaim(claimId);
    return { ok: true, message: "Evidence verified." };
  } catch (err) {
    return fail(err);
  }
}

export async function disputeClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const claimId = str(fd, "claimId");
    await flagDispute(db, user, claimId, str(fd, "reason"));
    revalidateClaim(claimId);
    return { ok: true, message: "Claim flagged as disputed." };
  } catch (err) {
    return fail(err);
  }
}
