"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth";
import { getDb } from "@/server/db";
import { previewHistoricalClaimsCsv, commitHistoricalClaimsImport } from "@/server/historical-import";
import { fail, file } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

const MAX_BYTES = 10 * 1024 * 1024;

export async function importHistoricalClaimsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("import.run");
    const db = await getDb();
    const upload = file(fd, "file");
    if (!upload) return { ok: false, error: "Choose a CSV file." };
    if (upload.size > MAX_BYTES) return { ok: false, error: "Historical imports are limited to 10 MB." };
    const bytes = Buffer.from(await upload.arrayBuffer());
    const preview = await previewHistoricalClaimsCsv(db, user, { filename: upload.name, bytes });
    const confirmed = fd.get("confirm") === "on";
    if (!confirmed) {
      revalidatePath("/import-export");
      return {
        ok: true,
        message: `Previewed ${preview.totalRows} row(s): ${preview.validRows} valid, ${preview.invalidRows} invalid, ${preview.duplicateRows} duplicate. Batch ${preview.batchId} is staged; check “Commit staged rows” and submit again to import the valid rows. No claim has been written yet.`,
      };
    }
    const result = await commitHistoricalClaimsImport(db, user, { batchId: preview.batchId, confirm: true });
    revalidatePath("/import-export");
    revalidatePath("/expenses");
    return {
      ok: true,
      message: `Imported ${result.imported} historical claim(s); ${result.skipped} row(s) skipped. Imported rows remain unverified until evidence is attached.`,
    };
  } catch (err) {
    return fail(err);
  }
}
