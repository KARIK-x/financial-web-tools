import { randomUUID } from "node:crypto";
import { parseMoney } from "@/lib/money";
import { isValidISODate } from "@/lib/nepali-date";
import type { Db } from "./db";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { ExpenseError } from "./expenses";

type CsvRow = Record<string, string>;

function parseCsv(bytes: Buffer): { header: string[]; rows: CsvRow[] } {
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
      else if (c === "\r") {
        // ignore; \n handles the record
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { header: [], rows: [] };
  const header = nonEmpty[0]!.map((h) => h.trim().toLowerCase());
  const rows = nonEmpty.slice(1).map((cells) => {
    const obj: CsvRow = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? "").trim(); });
    return obj;
  });
  return { header, rows };
}

const FUNDING = new Set(["PERSONAL", "FINANCE_TRACKER_CASH", "FINANCE_TRACKER_BANK"]);
const DOCUMENTATION = new Set(["MISSING", "PARTIAL", "COMPLETE"]);

function get(row: CsvRow, names: string[]): string {
  for (const name of names) {
    const key = Object.keys(row).find((k) => k === name || k.replace(/[^a-z0-9]/g, "") === name);
    if (key && row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

export type HistoricalPreview = {
  batchId: string;
  filename: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  detectedColumns: Record<string, string>;
};

export async function previewHistoricalClaimsCsv(
  db: Db, user: CurrentUser, input: { filename: string; bytes: Buffer },
): Promise<HistoricalPreview> {
  if (!can(user.role, "import.run", user.permissions)) throw new ExpenseError("You cannot stage imports.");
  const parsed = parseCsv(input.bytes);
  if (!parsed.header.length) throw new ExpenseError("The CSV has no header row.");
  const required = ["date", "member", "vendor", "description", "amount"];
  const aliases: Record<string, string[]> = {
    date: ["date", "claimdate", "claimedon", "expense_date"],
    member: ["member", "member_email", "membername", "claimant", "email"],
    vendor: ["vendor", "vendorname", "supplier"],
    description: ["description", "details", "purpose", "memo"],
    amount: ["amount", "amountnpr", "amount_paisa", "total", "totalnpr"],
  };
  for (const field of required) {
    if (!(aliases[field] ?? []).some((a) => parsed.header.includes(a))) {
      throw new ExpenseError(`Missing required column for ${field}. Expected one of: ${(aliases[field] ?? []).join(", ")}.`);
    }
  }

  const batchId = randomUUID();
  const mapping: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const found = names.find((n) => parsed.header.includes(n));
    if (found) mapping[field] = found;
  }
  const optional = ["claim_no", "event", "funding_source", "documentation_status", "missing_receipt_declaration", "notes"];
  const optionalAliases: Record<string, string[]> = {
    claim_no: ["claim_no", "claimno", "claim_number", "ref", "reference"],
    event: ["event", "event_code", "eventcode", "event_name"],
    funding_source: ["funding_source", "fundingsource", "funding"],
    documentation_status: ["documentation_status", "documentation", "receipt_status", "evidence_status"],
    missing_receipt_declaration: ["missing_receipt_declaration", "missingreceipt", "declaration"],
    notes: ["notes", "note", "remarks"],
  };
  for (const field of optional) {
    const found = (optionalAliases[field] ?? []).find((n) => parsed.header.includes(n));
    if (found) mapping[field] = found;
  }

  let validRows = 0;
  let invalidRows = 0;
  let duplicateRows = 0;

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (id, kind, filename, sha256, status, mapping, stats, created_by)
       VALUES ($1,'EXPENSES',$2,$3,'PREVIEW',$4::jsonb,$5::jsonb,$6)`,
      [batchId, input.filename, null, JSON.stringify(mapping), JSON.stringify({ total: parsed.rows.length }), user.id],
    );

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i]!;
      const rowNo = i + 1;
      const errors: string[] = [];
      const date = get(row, aliases.date!);
      const memberValue = get(row, aliases.member!);
      const vendor = get(row, aliases.vendor!);
      const description = get(row, aliases.description!) || `${vendor} expense`;
      const amountText = get(row, aliases.amount!);
      const amount = parseMoney(amountText);
      const claimNo = get(row, optionalAliases.claim_no!);
      const eventValue = get(row, optionalAliases.event!);
      const fundingRaw = get(row, optionalAliases.funding_source!).toUpperCase() || "PERSONAL";
      const funding = fundingRaw === "FINANCE_TRACKER_BANK" ? "FINANCE_TRACKER_BANK" : fundingRaw === "FINANCE_TRACKER_CASH" ? "FINANCE_TRACKER_CASH" : "PERSONAL";
      const documentation = get(row, optionalAliases.documentation_status!).toUpperCase() || "MISSING";
      const declaration = get(row, optionalAliases.missing_receipt_declaration!) || null;
      const documentationState = documentation === "COMPLETE" ? "COMPLETE" : (declaration ? "MISSING_DECLARED" : "MISSING_UNDECLARED");
      const notes = get(row, optionalAliases.notes!) || null;

      if (!isValidISODate(date)) errors.push("invalid date");
      if (!memberValue) errors.push("missing member");
      if (!vendor) errors.push("missing vendor");
      if (!amount.ok || amount.paisa <= 0) errors.push("invalid amount");
      if (!FUNDING.has(funding)) errors.push("invalid funding source");
      if (!DOCUMENTATION.has(documentation)) errors.push("invalid documentation status");

      const member = memberValue
        ? await tx.query<{ id: string; user_id: string | null }>(
            `SELECT m.id, u.id AS user_id
               FROM members m LEFT JOIN users u ON u.member_id=m.id
              WHERE lower(m.email)=lower($1) OR lower(m.name)=lower($1)
              LIMIT 1`,
            [memberValue],
          )
        : { rows: [] as { id: string; user_id: string | null }[] };
      if (memberValue && !member.rows.length) errors.push("member not found");
      const memberId = member.rows[0]?.id ?? null;
      const claimantUserId = member.rows[0]?.user_id ?? null;
      if (memberValue && member.rows.length && !claimantUserId) errors.push("member has no login user");

      const category = await tx.query<{ id: string }>(
        `SELECT id FROM expense_categories WHERE id='cat_printing' OR code='PRINTING' LIMIT 1`,
      );
      // Historical rows are deliberately not auto-categorised beyond a safe default.
      const categoryId = category.rows[0]?.id ?? null;
      if (!categoryId) errors.push("default category missing");

      let eventId: string | null = null;
      if (eventValue) {
        const event = await tx.query<{ id: string }>(
          `SELECT id FROM events WHERE code=$1 OR name=$1 LIMIT 1`, [eventValue],
        );
        if (!event.rows.length) errors.push("event not found");
        else eventId = event.rows[0]!.id;
      }

      const memberFound = memberId;
      let duplicate = false;
      if (!errors.length) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM expense_claims
            WHERE ($1::text IS NOT NULL AND claim_no=$1)
               OR (paid_by_member_id=$2 AND date_ad=$3::date AND amount_paisa=$4 AND vendor_name_raw=$5)`,
          [claimNo || null, memberFound, date, amount.ok ? amount.paisa : 0, vendor],
        );
        if (existing.rows.length) duplicate = true;
      }

      const status = errors.length
        ? "INVALID"
        : duplicate
          ? "DUPLICATE"
          : "VALID";
      if (status === "VALID") validRows++;
      else if (status === "INVALID") invalidRows++;
      else duplicateRows++;

      await tx.query(
        `INSERT INTO import_rows (id, batch_id, row_no, raw, status, errors)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
        [
          randomUUID(),
          batchId,
          rowNo,
          JSON.stringify({
            ...row,
            _parsed: { date, member: memberValue, vendor, description, amount_paisa: amount.ok ? amount.paisa : 0, claim_no: claimNo, event: eventValue, funding_source: funding, documentation_status: documentation, missing_receipt_declaration: declaration, notes, member_id: memberId, paid_by_member_id: memberId, claimant_user_id: claimantUserId, category_id: categoryId, event_id: eventId, documentation_state: documentationState },
          }),
          status,
          JSON.stringify(errors.length ? errors : duplicate ? ["Duplicate of an existing claim"] : []),
        ],
      );
    }

    await tx.query(
      `UPDATE import_batches SET stats=$2::jsonb WHERE id=$1`,
      [batchId, JSON.stringify({ total: parsed.rows.length, valid: validRows, invalid: invalidRows, duplicate: duplicateRows })],
    );
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "HISTORICAL_IMPORT_PREVIEWED",
    entityType: "import_batch", entityId: batchId,
    summary: `Historical claims CSV ${input.filename}: ${parsed.rows.length} rows, ${validRows} valid, ${invalidRows} invalid, ${duplicateRows} duplicate`,
  });

  return {
    batchId,
    filename: input.filename,
    totalRows: parsed.rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    detectedColumns: mapping,
  };
}

export async function commitHistoricalClaimsImport(
  db: Db, user: CurrentUser, input: { batchId: string; confirm: boolean },
): Promise<{ batchId: string; imported: number; skipped: number }> {
  if (!can(user.role, "import.run", user.permissions)) throw new ExpenseError("You cannot commit imports.");
  if (!input.confirm) throw new ExpenseError("Explicit confirmation is required before importing historical claims.");
  const batch = await db.query<{ id: string; kind: string; status: string }>(
    `SELECT id, kind, status FROM import_batches WHERE id=$1`, [input.batchId],
  );
  if (!batch.rows.length) throw new ExpenseError("Import batch not found.");
  if (batch.rows[0]!.kind !== "EXPENSES") throw new ExpenseError("This batch is not a historical claims import.");
  if (batch.rows[0]!.status !== "PREVIEW") throw new ExpenseError("Only preview batches can be committed.");

  const rows = await db.query<{ id: string; row_no: number; raw: Record<string, unknown>; status: string }>(
    `SELECT id, row_no, raw, status FROM import_rows WHERE batch_id=$1 ORDER BY row_no`, [input.batchId],
  );
  let imported = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const row of rows.rows) {
      const parsed = (row.raw as { _parsed?: Record<string, unknown> } | null)?._parsed;
      if (row.status !== "VALID" || !parsed) { skipped++; continue; }
      const claimNo = (parsed.claim_no as string) || `HIST-${input.batchId.slice(0, 8)}-${row.row_no}`;
      const existing = await tx.query<{ id: string }>(`SELECT id FROM expense_claims WHERE claim_no=$1`, [claimNo]);
      if (existing.rows.length) { skipped++; continue; }
      await tx.query(
        `INSERT INTO expense_claims
          (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, vendor_name_raw, description, amount_paisa, category_id, event_id,
           funding_source, status, documentation_state, missing_receipt_declaration, notes, source_type, is_synthetic,
           verification_state, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,'SUBMITTED',$12,$13,$14,'HISTORICAL_IMPORT',false,'UNVERIFIED',$15)`,
        [
          randomUUID(),
          claimNo,
          parsed.claimant_user_id,
          parsed.paid_by_member_id,
          parsed.date,
          parsed.vendor,
          parsed.description,
          parsed.amount_paisa,
          parsed.category_id,
          parsed.event_id,
          (parsed.funding_source as string) || "PERSONAL",
          (parsed.documentation_state as string) || "MISSING_UNDECLARED",
          parsed.missing_receipt_declaration,
          parsed.notes,
          user.id,
        ],
      );
      await tx.query(`UPDATE import_rows SET status='IMPORTED' WHERE id=$1`, [row.id]);
      imported++;
    }
    await tx.query(
      `UPDATE import_batches SET status='COMMITTED', committed_at=now(), stats=$2::jsonb WHERE id=$1`,
      [input.batchId, JSON.stringify({ imported, skipped, total: rows.rows.length })],
    );
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "HISTORICAL_IMPORT_COMMITTED",
    entityType: "import_batch", entityId: input.batchId,
    summary: `Historical claims import committed: ${imported} imported, ${skipped} skipped`,
    after: { imported, skipped },
  });
  return { batchId: input.batchId, imported, skipped };
}
