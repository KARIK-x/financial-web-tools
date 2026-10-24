import { randomUUID } from "node:crypto";
import { many, money, one, type Db, dateOnly, iso } from "./db";
import { recordAudit } from "./audit";
import { accountLedger, ACCOUNTS, postJournal } from "./journal";
import { parseMoney } from "@/lib/money";
import { isValidISODate } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { ExpenseError } from "./expenses";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

export type AccountRow = {
  id: string;
  name: string;
  type: string;
  institution: string | null;
  identifier_masked: string | null;
  opening_balance_paisa: number;
  is_active: boolean;
  balance_paisa: number;
  inflow_paisa: number;
  outflow_paisa: number;
  last_reconciled_at: Date | null;
  last_reconciled_balance_paisa: number | null;
  last_activity_on: string | null;
};

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  return many<AccountRow>(
    db,
    `SELECT a.id, a.name, a.type, a.institution, a.identifier_masked, a.opening_balance_paisa, a.is_active,
            a.opening_balance_paisa
              + COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='IN' AND p.status='RECORDED'),0)
              - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='OUT' AND p.status='RECORDED'),0)
              + COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.to_account_id=a.id AND p.type='TRANSFER' AND p.status='RECORDED'),0)
              - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.from_account_id=a.id AND p.type='TRANSFER' AND p.status='RECORDED'),0) AS balance_paisa,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='IN' AND p.status='RECORDED'),0) AS inflow_paisa,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='OUT' AND p.status='RECORDED'),0) AS outflow_paisa,
            (SELECT MAX(r.reconciled_at) FROM reconciliations r WHERE r.account_id=a.id AND r.status='RECONCILED') AS last_reconciled_at,
            (SELECT r.statement_balance_paisa FROM reconciliations r WHERE r.account_id=a.id AND r.status='RECONCILED' ORDER BY r.period_end DESC LIMIT 1) AS last_reconciled_balance_paisa,
            (SELECT to_char(MAX(p.date_ad),'YYYY-MM-DD') FROM payments p WHERE p.account_id=a.id OR p.to_account_id=a.id OR p.from_account_id=a.id) AS last_activity_on
       FROM financial_accounts a
      WHERE a.is_active = true
      ORDER BY a.type, a.name`,
  );
}

export async function createAccount(
  db: Db, user: CurrentUser,
  input: { name: string; type: "CASH" | "BANK" | "WALLET"; institution?: string; identifierMasked?: string; openingBalance: string; openedOn?: string; notes?: string },
) {
  if (!can(user.role, "account.manage", user.permissions)) throw new ExpenseError("You cannot manage accounts.");
  if (!input.name.trim()) throw new ExpenseError("Account name is required.");
  const opening = parseMoney(input.openingBalance || "0");
  if (!opening.ok) throw new ExpenseError(opening.error);
  if (input.openedOn && !isValidISODate(input.openedOn)) throw new ExpenseError("Opening date is invalid.");
  const id = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, institution, identifier_masked, opening_balance_paisa, opened_on, notes, is_synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, input.name.trim(), input.type, input.institution ?? null, input.identifierMasked ?? null, opening.paisa, input.openedOn ?? null, input.notes ?? null, user.isSynthetic],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "ACCOUNT_CREATED",
    entityType: "financial_account", entityId: id,
    summary: `${input.type} account "${input.name}" created with opening balance NPR ${(opening.paisa / 100).toFixed(2)}`,
    after: { opening_balance_paisa: opening.paisa },
  });
  return id;
}

export async function accountLedgerEntries(db: Db, accountId: string, limit = 200) {
  const rows = await many<{
    id: string; date_ad: string; kind: string; memo: string; amount_paisa: number; direction: string;
    ref: string; status: string; created_at: Date;
  }>(
    db,
    `SELECT p.id, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad, p.type AS kind,
            COALESCE(p.notes, p.payee_name, p.reference, p.type) AS memo,
            p.amount_paisa,
            CASE WHEN p.type='TRANSFER' AND p.to_account_id=$1 THEN 'IN' ELSE p.direction END AS direction,
            p.ref, p.status, p.created_at
       FROM payments p
      WHERE (p.account_id=$1 AND p.type<>'TRANSFER') OR p.from_account_id=$1 OR p.to_account_id=$1
      ORDER BY p.date_ad DESC, p.created_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

export async function recordTransfer(
  db: Db, user: CurrentUser,
  input: { fromAccountId: string; toAccountId: string; amount: string; date: string; reference?: string; notes?: string },
) {
  if (!can(user.role, "account.manage", user.permissions)) throw new ExpenseError("You cannot record transfers.");
  if (input.fromAccountId === input.toAccountId) throw new ExpenseError("Choose two different accounts.");
  if (!isValidISODate(input.date)) throw new ExpenseError("Transfer date is invalid.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  const accounts = await many<{ id: string; name: string; type: string }>(
    db, `SELECT id, name, type FROM financial_accounts WHERE id IN ($1,$2)`, [input.fromAccountId, input.toAccountId],
  );
  const from = accounts.find((a) => a.id === input.fromAccountId);
  const to = accounts.find((a) => a.id === input.toAccountId);
  if (!from || !to) throw new ExpenseError("Account not found.");
  const id = randomUUID();
  const ref = `TRF-${Date.now().toString().slice(-8)}`;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (id, ref, type, direction, from_account_id, to_account_id, amount_paisa, date_ad, reference, notes, created_by, status, is_synthetic)
       VALUES ($1,$2,'TRANSFER','OUT',$3,$4,$5,$6,$7,$8,$9,'RECORDED',$10)`,
      [id, ref, from.id, to.id, amount.paisa, input.date, input.reference ?? null, input.notes ?? null, user.id, user.isSynthetic],
    );
    const fl = accountLedger(from.type);
    const tl = accountLedger(to.type);
    await postJournal(tx, {
      date: input.date,
      memo: `Internal transfer ${from.name} → ${to.name}`,
      sourceType: "TRANSFER", sourceId: id, createdBy: user.id,
      lines: [
        { accountCode: tl.code, accountName: `${tl.name} — ${to.name}`, debit: amount.paisa },
        { accountCode: fl.code, accountName: `${fl.name} — ${from.name}`, credit: amount.paisa },
      ],
    });
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "TRANSFER_RECORDED",
    entityType: "payment", entityId: id,
    summary: `Transfer NPR ${(amount.paisa / 100).toFixed(2)}: ${from.name} → ${to.name}`,
  });
}

// ---------------------------------------------------------------------------
// Statement import & reconciliation
// ---------------------------------------------------------------------------

export type StatementLineCandidate = {
  date: string;
  description: string;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number | null;
  reference: string | null;
};

type RawGrid = unknown[][];

function parseCSV(text: string): RawGrid {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function gridFromFile(bytes: Buffer, filename: string): Promise<RawGrid> {
  if (filename.toLowerCase().endsWith(".csv") || filename.toLowerCase().endsWith(".txt")) {
    return parseCSV(bytes.toString("utf8"));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new ExpenseError("The workbook has no sheets.");
  const grid: RawGrid = [];
  sheet.eachRow((row) => {
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      if (v && typeof v === "object" && "result" in v) values.push((v as { result: unknown }).result);
      else if (v && typeof v === "object" && "text" in v) values.push((v as { text: unknown }).text);
      else values.push(v);
    });
    grid.push(values);
  });
  return grid;
}

export function normaliseDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]!.padStart(2, "0")}-${isoMatch[3]!.padStart(2, "0")}`;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    // Nepali statements normally use YYYY-MM-DD or DD/MM/YYYY. Ambiguous values are rejected rather than guessed.
    const day = Number(dmy[1]); const month = Number(dmy[2]);
    if (day > 12 && month <= 12) return `${dmy[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return null;
  }
  return null;
}

export async function parseStatement(bytes: Buffer, filename: string): Promise<{ lines: StatementLineCandidate[]; detectedColumns: Record<string, string>; skipped: number; warnings: string[] }> {
  const grid = await gridFromFile(bytes, filename);
  const warnings: string[] = [];
  let headerRow = -1;
  let columns: Record<string, number> = {};
  for (let i = 0; i < Math.min(grid.length, 60); i++) {
    const row = (grid[i] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
    const find = (names: string[]) =>
      row.findIndex((c) => names.some((n) => (n.length <= 3 ? c === n : c.includes(n))));
    const dateIdx = find(["transaction date", "date"]);
    const descIdx = find(["description", "narration", "details", "particulars"]);
    if (dateIdx >= 0 && descIdx >= 0) {
      headerRow = i;
      columns = {
        date: dateIdx,
        description: descIdx,
        debit: find(["withdraw", "debit", "dr", "withdrawal"]),
        credit: find(["deposit", "credit", "cr"]),
        balance: find(["balance"]),
        reference: find(["reference", "ref no", "txn id", "transaction id", "id"]),
      };
      break;
    }
  }
  if (headerRow < 0) throw new ExpenseError("Could not find a statement header row (needs Date and Description columns).");
  const lines: StatementLineCandidate[] = [];
  let skipped = 0;
  const get = (row: RawGrid[number], idx: number) => (idx >= 0 ? row[idx] : undefined);
  const dateIdx = columns.date ?? -1;
  const descIdx = columns.description ?? -1;
  const debitIdx = columns.debit ?? -1;
  const creditIdx = columns.credit ?? -1;
  const balanceIdx = columns.balance ?? -1;
  const refIdx = columns.reference ?? -1;

  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const date = normaliseDate(get(row, dateIdx));
    const desc = String(get(row, descIdx) ?? "").trim();
    if (!date && !desc) { skipped++; continue; }
    if (!date) { skipped++; continue; }
    const parseCell = (v: unknown): number => {
      if (v == null || v === "") return 0;
      if (typeof v === "number") return Math.round(Math.abs(v) * 100);
      const parsed = parseMoney(String(v).replace(/-$/, ""));
      return parsed.ok ? parsed.paisa : 0;
    };
    const debit = parseCell(get(row, debitIdx));
    const credit = parseCell(get(row, creditIdx));
    if (debit === 0 && credit === 0) {
      warnings.push(`Row ${i + 1}: no debit or credit amount — skipped.`);
      skipped++;
      continue;
    }
    lines.push({
      date, description: desc || "(no description)",
      debitPaisa: debit, creditPaisa: credit,
      balancePaisa: balanceIdx >= 0 ? parseCell(get(row, balanceIdx)) : null,
      reference: refIdx >= 0 ? String(get(row, refIdx) ?? "").trim() || null : null,
    });
  }
  const detectedColumns: Record<string, string> = {};
  for (const [k, v] of Object.entries(columns)) {
    if (v >= 0) detectedColumns[k] = `column ${v + 1}`;
  }
  return { lines, detectedColumns, skipped, warnings: warnings.slice(0, 20) };
}

export function statementFingerprint(accountId: string, line: StatementLineCandidate, occurrence = 0): string {
  return createHash("sha256")
    .update([accountId, line.date, line.description.trim(), line.debitPaisa, line.creditPaisa, line.balancePaisa ?? "", occurrence].join("|"))
    .digest("hex");
}

export async function importStatement(
  db: Db, user: CurrentUser,
  input: { accountId: string; bytes: Buffer; filename: string; documentId?: string | null; sourceLabel?: string },
) {
  if (!can(user.role, "recon.manage", user.permissions)) throw new ExpenseError("You cannot import bank statements.");
  const account = await one<{ id: string; name: string }>(db, `SELECT id, name FROM financial_accounts WHERE id=$1`, [input.accountId]);
  if (!account) throw new ExpenseError("Account not found.");
  const parsed = await parseStatement(input.bytes, input.filename);
  if (!parsed.lines.length) throw new ExpenseError("No statement lines were parsed.");

  const importId = randomUUID();
  const counts = new Map<string, number>();
  let duplicate = 0;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO statement_imports (id, account_id, document_id, source_label, period_start, period_end, status, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,'IMPORTED',$7)`,
      [
        importId, account.id, input.documentId ?? null, input.sourceLabel ?? input.filename,
        parsed.lines[0]?.date ?? null, parsed.lines[parsed.lines.length - 1]?.date ?? null, user.id,
      ],
    );
    for (const line of parsed.lines) {
      const base = statementFingerprint(account.id, line);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      const fp = n === 0 ? base : statementFingerprint(account.id, line, n);
      // ON CONFLICT keeps a re-import from aborting the transaction; duplicates are counted instead.
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO bank_statement_lines
          (id, statement_import_id, account_id, txn_date, description, debit_paisa, credit_paisa, balance_paisa, external_ref, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (fingerprint) DO NOTHING
         RETURNING id`,
        [randomUUID(), importId, account.id, line.date, line.description, line.debitPaisa, line.creditPaisa, line.balancePaisa, line.reference, fp],
      );
      if (!inserted.rows.length) duplicate++;
    }
    const lastWithBalance = [...parsed.lines].reverse().find((l) => l.balancePaisa != null);
    if (lastWithBalance?.balancePaisa != null) {
      await tx.query(`UPDATE statement_imports SET closing_balance_paisa=$2 WHERE id=$1`, [importId, lastWithBalance.balancePaisa]);
    }
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "STATEMENT_IMPORTED",
    entityType: "statement_import", entityId: importId,
    summary: `${parsed.lines.length} lines imported for ${account.name} from ${input.filename}${duplicate ? ` (${duplicate} duplicate lines skipped)` : ""}`,
  });
  await suggestMatches(db, importId);
  return { importId, lines: parsed.lines.length, duplicate, warnings: parsed.warnings, columns: parsed.detectedColumns };
}

export async function suggestMatches(db: Db, importId: string) {
  const lines = await many<{ id: string; txn_date: string; debit_paisa: number; credit_paisa: number; description: string }>(
    db,
    `SELECT id, to_char(txn_date,'YYYY-MM-DD') AS txn_date, debit_paisa, credit_paisa, description
       FROM bank_statement_lines WHERE statement_import_id=$1 AND match_status='UNMATCHED'`,
    [importId],
  );
  let suggested = 0;
  for (const line of lines) {
    const isOut = Number(line.debit_paisa) > 0;
    const amount = isOut ? Number(line.debit_paisa) : Number(line.credit_paisa);
    const candidates = await many<{ id: string; ref: string; payee_name: string | null; date_ad: string }>(
      db,
      `SELECT id, ref, payee_name, to_char(date_ad,'YYYY-MM-DD') AS date_ad FROM payments
        WHERE status='RECORDED' AND amount_paisa=$1
          AND ((direction='OUT' AND $2=true) OR (direction='IN' AND $2=false))
          AND date_ad BETWEEN $3::date - 3 AND $3::date + 3
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_payment_id=payments.id AND b.match_status='MATCHED')`,
      [amount, isOut, line.txn_date],
    );
    if (candidates.length === 1) {
      await db.query(
        `UPDATE bank_statement_lines SET match_status='SUGGESTED', matched_payment_id=$2, match_confidence=0.8 WHERE id=$1`,
        [line.id, candidates[0]!.id],
      );
      suggested++;
    } else if (candidates.length > 1) {
      await db.query(
        `UPDATE bank_statement_lines SET match_status='SUGGESTED', match_confidence=0.4, notes=$2 WHERE id=$1`,
        [line.id, `${candidates.length} possible payments match amount/date — manual choice required: ${candidates.map((c) => c.ref).join(", ")}`],
      );
      suggested++;
    }
  }
  return suggested;
}

export async function confirmStatementMatch(db: Db, user: CurrentUser, lineId: string, paymentId: string | null) {
  if (!can(user.role, "recon.manage", user.permissions)) throw new ExpenseError("You cannot confirm matches.");
  const line = await one<{ id: string; match_status: string; description: string; debit_paisa: number; credit_paisa: number; txn_date: string }>(
    db,
    `SELECT id, match_status, description, debit_paisa, credit_paisa, to_char(txn_date,'YYYY-MM-DD') AS txn_date
       FROM bank_statement_lines WHERE id=$1`,
    [lineId],
  );
  if (!line) throw new ExpenseError("Statement line not found.");
  if (line.match_status === "MATCHED" && paymentId) throw new ExpenseError("This statement line is already matched. Unmatch it first.");
  if (paymentId === null) {
    await db.query(`UPDATE bank_statement_lines SET match_status='IGNORED', matched_payment_id=NULL, match_confidence=NULL WHERE id=$1`, [lineId]);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "STATEMENT_LINE_IGNORED",
      entityType: "bank_statement_line", entityId: lineId,
      summary: `Statement line ignored: ${line.description.slice(0, 120)}`,
    });
    return;
  }
  const payment = await one<{ id: string; ref: string; amount_paisa: number; direction: string; claim_id: string | null }>(
    db, `SELECT id, ref, amount_paisa, direction, claim_id FROM payments WHERE id=$1 AND status='RECORDED'`, [paymentId],
  );
  if (!payment) throw new ExpenseError("Payment not found.");
  const amount = Number(line.debit_paisa) + Number(line.credit_paisa);
  const isOut = Number(line.debit_paisa) > 0;
  if (Number(payment.amount_paisa) !== amount || payment.direction !== (isOut ? "OUT" : "IN")) {
    throw new ExpenseError("That payment’s amount or direction does not match this statement line.");
  }
  const claimed = await one<{ id: string }>(
    db,
    `SELECT id FROM bank_statement_lines WHERE matched_payment_id=$1 AND match_status='MATCHED' AND id<>$2`,
    [paymentId, lineId],
  );
  if (claimed) throw new ExpenseError("That payment is already matched to another statement line.");
  await db.query(
    `UPDATE bank_statement_lines SET match_status='MATCHED', matched_payment_id=$2, match_confidence=1.0 WHERE id=$1`,
    [lineId, paymentId],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "STATEMENT_LINE_MATCHED",
    entityType: "bank_statement_line", entityId: lineId,
    summary: `Statement line matched to payment ${payment.ref}`,
  });

  // A verified claim becomes reconciled once its bank movement is confirmed.
  if (payment.claim_id) {
    const claim = await one<{ id: string; claim_no: string; status: string; verification_state: string }>(
      db, `SELECT id, claim_no, status, verification_state FROM expense_claims WHERE id=$1`, [payment.claim_id],
    );
    if (claim && claim.status === "VERIFIED" && claim.verification_state === "VERIFIED") {
      await db.query(`UPDATE expense_claims SET status='RECONCILED' WHERE id=$1`, [claim.id]);
      await recordAudit(db, {
        actorUserId: user.id, actorName: user.name, action: "EXPENSE_RECONCILED",
        entityType: "expense_claim", entityId: claim.id,
        summary: `${claim.claim_no} reconciled against the bank statement`,
        after: { status: "RECONCILED", payment_ref: payment.ref },
      });
    }
  }
}

export async function unmatchStatementLine(db: Db, user: CurrentUser, lineId: string) {
  if (!can(user.role, "recon.manage", user.permissions)) throw new ExpenseError("You cannot change matches.");
  const line = await one<{ id: string; matched_payment_id: string | null }>(
    db, `SELECT id, matched_payment_id FROM bank_statement_lines WHERE id=$1`, [lineId],
  );
  if (!line) throw new ExpenseError("Statement line not found.");
  await db.query(
    `UPDATE bank_statement_lines SET match_status='UNMATCHED', matched_payment_id=NULL, match_confidence=NULL WHERE id=$1`,
    [lineId],
  );
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "STATEMENT_LINE_UNMATCHED",
    entityType: "bank_statement_line", entityId: lineId,
    summary: "Statement line match removed",
    before: { matched_payment_id: line.matched_payment_id },
  });
}

/** Payments that could plausibly belong to the import's period, fetched once for the review screen. */
export async function paymentCandidatesForImport(db: Db, importId: string) {
  const imp = await one<{ id: string; account_id: string; period_start: string | null; period_end: string | null }>(
    db,
    `SELECT id, account_id, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end
       FROM statement_imports WHERE id=$1`,
    [importId],
  );
  if (!imp) return [];
  return many<{
    id: string; ref: string; type: string; direction: string; amount_paisa: number;
    date_ad: string; payee_name: string | null; account_id: string | null;
  }>(
    db,
    `SELECT p.id, p.ref, p.type, p.direction, p.amount_paisa, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad,
            COALESCE(p.payee_name, m.name) AS payee_name, p.account_id
       FROM payments p LEFT JOIN members m ON m.id = p.counterparty_member_id
      WHERE p.status='RECORDED'
        AND p.date_ad BETWEEN COALESCE($1::date, CURRENT_DATE) - 7 AND COALESCE($2::date, CURRENT_DATE) + 7
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_payment_id=p.id AND b.match_status='MATCHED')
      ORDER BY p.date_ad DESC LIMIT 500`,
    [imp.period_start, imp.period_end],
  );
}


export async function statementLines(db: Db, importId: string) {
  return many<{
    id: string; txn_date: string; description: string; debit_paisa: number; credit_paisa: number;
    balance_paisa: number | null; match_status: string; matched_payment_id: string | null;
    match_confidence: number | null; notes: string | null; payment_ref: string | null;
  }>(
    db,
    `SELECT b.id, to_char(b.txn_date,'YYYY-MM-DD') AS txn_date, b.description, b.debit_paisa, b.credit_paisa,
            b.balance_paisa, b.match_status, b.matched_payment_id, b.match_confidence, b.notes, p.ref AS payment_ref
       FROM bank_statement_lines b LEFT JOIN payments p ON p.id=b.matched_payment_id
      WHERE b.statement_import_id=$1 ORDER BY b.txn_date, b.description`,
    [importId],
  );
}

export async function listStatementImports(db: Db) {
  return many<{
    id: string; account_id: string; account_name: string; source_label: string; period_start: string | null;
    period_end: string | null; closing_balance_paisa: number | null; status: string; created_at: Date;
    total: number; matched: number; suggested: number; unmatched: number;
  }>(
    db,
    `SELECT si.id, si.account_id, a.name AS account_name, si.source_label,
            to_char(si.period_start,'YYYY-MM-DD') AS period_start, to_char(si.period_end,'YYYY-MM-DD') AS period_end,
            si.closing_balance_paisa, si.status, si.created_at,
            (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id) AS total,
            (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id AND b.match_status='MATCHED') AS matched,
            (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id AND b.match_status='SUGGESTED') AS suggested,
            (SELECT COUNT(*)::int FROM bank_statement_lines b WHERE b.statement_import_id=si.id AND b.match_status='UNMATCHED') AS unmatched
       FROM statement_imports si JOIN financial_accounts a ON a.id=si.account_id
      ORDER BY si.created_at DESC`,
  );
}

export async function accountBalanceAsOf(db: Db, accountId: string, asOf: string): Promise<number> {
  const row = await one<{ balance: number }>(
    db,
    `SELECT a.opening_balance_paisa
      + COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='IN' AND p.status='RECORDED' AND p.date_ad <= $2),0)
      - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.account_id=a.id AND p.type<>'TRANSFER' AND p.direction='OUT' AND p.status='RECORDED' AND p.date_ad <= $2),0)
      + COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.to_account_id=a.id AND p.type='TRANSFER' AND p.status='RECORDED' AND p.date_ad <= $2),0)
      - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.from_account_id=a.id AND p.type='TRANSFER' AND p.status='RECORDED' AND p.date_ad <= $2),0)
      AS balance
      FROM financial_accounts a WHERE a.id=$1`,
    [accountId, asOf],
  );
  return money(row?.balance);
}

export async function createReconciliation(
  db: Db, user: CurrentUser,
  input: { accountId: string; importId: string; periodStart: string; periodEnd: string; statementBalance: string; notes?: string },
) {
  if (!can(user.role, "recon.manage", user.permissions)) throw new ExpenseError("You cannot reconcile accounts.");
  if (!isValidISODate(input.periodStart) || !isValidISODate(input.periodEnd)) throw new ExpenseError("Reconciliation period is invalid.");
  const statementBalance = parseMoney(input.statementBalance);
  if (!statementBalance.ok) throw new ExpenseError(statementBalance.error);
  const computed = await accountBalanceAsOf(db, input.accountId, input.periodEnd);
  const difference = statementBalance.paisa - computed;
  const status = difference === 0 ? "RECONCILED" : "OPEN";
  const id = randomUUID();
  await db.query(
    `INSERT INTO reconciliations (id, account_id, period_start, period_end, statement_import_id, computed_balance_paisa,
       statement_balance_paisa, difference_paisa, status, notes, reconciled_by, reconciled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id, input.accountId, input.periodStart, input.periodEnd, input.importId, computed,
      statementBalance.paisa, difference, status, input.notes ?? null,
      difference === 0 ? user.id : null, difference === 0 ? new Date() : null,
    ],
  );
  await db.query(`UPDATE statement_imports SET status=$2 WHERE id=$1`, [input.importId, status === "RECONCILED" ? "RECONCILED" : "PARTIALLY_MATCHED"]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "RECONCILIATION_RUN",
    entityType: "reconciliation", entityId: id,
    summary: `Reconciliation for period ${input.periodStart}–${input.periodEnd}: difference NPR ${(difference / 100).toFixed(2)} (${status})`,
    after: { computed, statement: statementBalance.paisa, difference, status },
  });
  return { id, computed, statement: statementBalance.paisa, difference, status };
}

export async function listReconciliations(db: Db) {
  return many<{
    id: string; account_name: string; period_start: string; period_end: string;
    computed_balance_paisa: number; statement_balance_paisa: number | null; difference_paisa: number | null;
    status: string; created_at: Date; reconciled_by_name: string | null;
  }>(
    db,
    `SELECT r.id, a.name AS account_name, to_char(r.period_start,'YYYY-MM-DD') AS period_start,
            to_char(r.period_end,'YYYY-MM-DD') AS period_end, r.computed_balance_paisa, r.statement_balance_paisa,
            r.difference_paisa, r.status, r.created_at, u.name AS reconciled_by_name
       FROM reconciliations r JOIN financial_accounts a ON a.id=r.account_id
       LEFT JOIN users u ON u.id=r.reconciled_by
      ORDER BY r.created_at DESC`,
  );
}

export async function unreconciledSummary(db: Db) {
  const row = await one<{ unmatched: number; matched: number; imports: number }>(
    db,
    `SELECT
      (SELECT COUNT(*)::int FROM bank_statement_lines WHERE match_status IN ('UNMATCHED','SUGGESTED')) AS unmatched,
      (SELECT COUNT(*)::int FROM bank_statement_lines WHERE match_status='MATCHED') AS matched,
      (SELECT COUNT(*)::int FROM statement_imports) AS imports`,
  );
  return { unmatched: row?.unmatched ?? 0, matched: row?.matched ?? 0, imports: row?.imports ?? 0 };
}

export { dateOnly, iso };
