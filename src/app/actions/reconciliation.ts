"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, requestContext } from "@/server/auth";
import { getDb, one } from "@/server/db";
import {
  confirmStatementMatch, createReconciliation, importStatement, unmatchStatementLine,
} from "@/server/accounts";
import { createBatch, uploadOne } from "@/server/documents";
import { can } from "@/lib/permissions";
import { fail, file, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

export async function importStatementAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("recon.manage");
    const db = await getDb();
    const ctx = await requestContext();
    const accountId = str(fd, "accountId");
    const upload = file(fd, "file");
    if (!accountId) return { ok: false, error: "Choose the account this statement belongs to." };
    if (!upload) return { ok: false, error: "Choose a CSV or XLSX statement." };
    if (upload.size > MAX_STATEMENT_BYTES) return { ok: false, error: "Statements are limited to 10 MB." };
    if (!/\.(csv|xlsx|xls|txt)$/i.test(upload.name)) {
      return { ok: false, error: "Use a CSV, XLSX or text statement. PDF statements must be exported to CSV by the bank first." };
    }

    const bytes = Buffer.from(await upload.arrayBuffer());
    const account = await one<{ id: string; name: string }>(db, `SELECT id, name FROM financial_accounts WHERE id=$1`, [accountId]);
    if (!account) return { ok: false, error: "Account not found." };

    let documentId: string | null = null;
    if (can(user.role, "document.upload", user.permissions)) {
      const batchId = await createBatch(db, user, `Statement — ${account.name} — ${new Date().toISOString().slice(0, 10)}`, "BANK_STATEMENT");
      const stored = await uploadOne(db, user, {
        filename: upload.name,
        mime: upload.type || (upload.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        bytes,
        batchId,
        docType: "BANK_STATEMENT",
      }, ctx);
      documentId = stored.documentId;
    }

    const result = await importStatement(db, user, {
      accountId,
      bytes,
      filename: upload.name,
      documentId,
      sourceLabel: optional(fd, "sourceLabel") ?? upload.name,
    });

    revalidatePath("/reconciliation");
    revalidatePath("/accounts");
    revalidatePath("/overview");
    revalidatePath("/receipts");
    return {
      ok: true,
      message: `${result.lines} statement line${result.lines === 1 ? "" : "s"} imported for ${account.name}.`,
      warning: result.duplicate > 0
        ? `${result.duplicate} line${result.duplicate === 1 ? " was" : "s were"} skipped because an identical line already exists.`
        : result.warnings.length
          ? result.warnings.slice(0, 3).join(" ")
          : undefined,
      redirectTo: `/reconciliation?import=${result.importId}`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function confirmMatchAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("recon.manage");
    const db = await getDb();
    const lineId = str(fd, "lineId");
    const paymentId = optional(fd, "paymentId");
    await confirmStatementMatch(db, user, lineId, paymentId);
    revalidatePath("/reconciliation");
    revalidatePath("/overview");
    return { ok: true, message: paymentId ? "Statement line matched." : "Statement line ignored." };
  } catch (err) {
    return fail(err);
  }
}

export async function unmatchAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("recon.manage");
    const db = await getDb();
    await unmatchStatementLine(db, user, str(fd, "lineId"));
    revalidatePath("/reconciliation");
    revalidatePath("/overview");
    return { ok: true, message: "Match removed; the line is back in the unmatched queue." };
  } catch (err) {
    return fail(err);
  }
}

export async function runReconciliationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("recon.manage");
    const db = await getDb();
    const result = await createReconciliation(db, user, {
      accountId: str(fd, "accountId"),
      importId: str(fd, "importId"),
      periodStart: str(fd, "periodStart"),
      periodEnd: str(fd, "periodEnd"),
      statementBalance: str(fd, "statementBalance"),
      notes: optional(fd, "notes") ?? undefined,
    });
    revalidatePath("/reconciliation");
    revalidatePath("/accounts");
    revalidatePath("/overview");
    const npr = (value: number) => `NPR ${(value / 100).toFixed(2)}`;
    return {
      ok: true,
      message: result.difference === 0
        ? `Reconciled exactly at ${npr(result.statement)}.`
        : `Saved as open. Computed ${npr(result.computed)} vs statement ${npr(result.statement)} — difference ${npr(result.difference)}.`,
      warning: result.difference === 0 ? undefined : "A non-zero difference stays open until the missing or duplicated payments are found. Do not overwrite the balance.",
    };
  } catch (err) {
    return fail(err);
  }
}
