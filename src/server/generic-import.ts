import { randomUUID, createHash } from "node:crypto";
import type { Db } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { ExpenseError } from "./expenses";

function parseCsv(bytes: Buffer): { header: string[]; rows: Record<string, string>[] } {
  const text = bytes.toString("utf8").replace(/^\ufeff/, "");
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); records.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { header: [], rows: [] };
  const header = nonEmpty[0]!.map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? "").trim(); });
    return obj;
  });
  return { header, rows };
}

export type GenericPreview = {
  batchId: string;
  filename: string;
  totalRows: number;
  duplicateRows: number;
  detectedColumns: string[];
};

export async function previewGenericSpreadsheet(
  db: Db, user: CurrentUser, input: { filename: string; bytes: Buffer },
): Promise<GenericPreview> {
  if (!can(user.role, "import.run", user.permissions)) throw new ExpenseError("You cannot stage imports.");
  const parsed = parseCsv(input.bytes);
  if (!parsed.header.length) throw new ExpenseError("The file has no header row.");
  if (!parsed.rows.length) throw new ExpenseError("The file has no data rows.");

  const batchId = randomUUID();
  const seen = new Set<string>();
  let duplicateRows = 0;

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (id, kind, filename, sha256, status, mapping, stats, created_by)
       VALUES ($1,'OTHER',$2,$3,'PREVIEW',$4::jsonb,$5::jsonb,$6)`,
      [batchId, input.filename, null, JSON.stringify({ columns: parsed.header }), JSON.stringify({ total: parsed.rows.length }), user.id],
    );

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const fingerprint = createHash("sha256").update(JSON.stringify(row)).digest("hex");
      const duplicate = seen.has(fingerprint);
      if (duplicate) duplicateRows++;
      seen.add(fingerprint);
      await tx.query(
        `INSERT INTO import_rows (id, batch_id, row_no, raw, status, errors)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
        [randomUUID(), batchId, i + 1, JSON.stringify({ ...row, _fingerprint: fingerprint }), duplicate ? "DUPLICATE" : "VALID", JSON.stringify(duplicate ? ["Duplicate of another row in this file"] : [])],
      );
    }

    await tx.query(
      `UPDATE import_batches SET stats=$2::jsonb WHERE id=$1`,
      [batchId, JSON.stringify({ total: parsed.rows.length, duplicate: duplicateRows })],
    );
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "GENERIC_SPREADSHEET_PREVIEWED",
    entityType: "import_batch", entityId: batchId,
    summary: `Spreadsheet ${input.filename}: ${parsed.rows.length} rows staged for review (${duplicateRows} duplicate)`,
  });

  return {
    batchId,
    filename: input.filename,
    totalRows: parsed.rows.length,
    duplicateRows,
    detectedColumns: parsed.header,
  };
}

export async function commitGenericSpreadsheet(
  db: Db, user: CurrentUser, input: { batchId: string; confirm: boolean },
): Promise<{ batchId: string; committed: number }> {
  if (!can(user.role, "import.run", user.permissions)) throw new ExpenseError("You cannot commit imports.");
  if (!input.confirm) throw new ExpenseError("Explicit confirmation is required.");
  const batch = await db.query<{ id: string; kind: string; status: string }>(
    `SELECT id, kind, status FROM import_batches WHERE id=$1`, [input.batchId],
  );
  if (!batch.rows.length) throw new ExpenseError("Import batch not found.");
  if (batch.rows[0]!.kind !== "OTHER") throw new ExpenseError("This batch is not a generic spreadsheet import.");
  if (batch.rows[0]!.status !== "PREVIEW") throw new ExpenseError("Only preview batches can be committed.");

  await db.transaction(async (tx) => {
    await tx.query(`UPDATE import_rows SET status='IMPORTED' WHERE batch_id=$1 AND status='VALID'`, [input.batchId]);
    await tx.query(`UPDATE import_batches SET status='COMMITTED', committed_at=now() WHERE id=$1`, [input.batchId]);
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "GENERIC_SPREADSHEET_COMMITTED",
    entityType: "import_batch", entityId: input.batchId,
    summary: "Generic spreadsheet staged rows marked as reviewed/imported. No financial totals were changed.",
  });

  const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM import_rows WHERE batch_id=$1 AND status='IMPORTED'`, [input.batchId]);
  return { batchId: input.batchId, committed: Number(count.rows[0]?.n ?? 0) };
}
