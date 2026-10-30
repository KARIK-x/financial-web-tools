"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth";
import { getDb } from "@/server/db";
import { previewGenericSpreadsheet, commitGenericSpreadsheet } from "@/server/generic-import";
import { fail, file } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

const MAX_BYTES = 10 * 1024 * 1024;

export async function importGenericSpreadsheetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("import.run");
    const db = await getDb();
    const upload = file(fd, "file");
    if (!upload) return { ok: false, error: "Choose a CSV file." };
    if (upload.size > MAX_BYTES) return { ok: false, error: "Imports are limited to 10 MB." };
    const bytes = Buffer.from(await upload.arrayBuffer());
    const preview = await previewGenericSpreadsheet(db, user, { filename: upload.name, bytes });
    const confirmed = fd.get("confirm") === "on";
    if (!confirmed) {
      revalidatePath("/import-export");
      return {
        ok: true,
        message: `Previewed ${preview.totalRows} row(s) with columns: ${preview.detectedColumns.join(", ")}. ${preview.duplicateRows} duplicate row(s). Batch ${preview.batchId} staged; check “Commit staged rows” to mark them reviewed. No financial totals were changed.`,
      };
    }
    const result = await commitGenericSpreadsheet(db, user, { batchId: preview.batchId, confirm: true });
    revalidatePath("/import-export");
    return {
      ok: true,
      message: `Marked ${result.committed} staged row(s) as reviewed. Financial totals were not changed; map reviewed rows to claims, sponsors or accounts as evidence is verified.`,
    };
  } catch (err) {
    return fail(err);
  }
}
