import { randomUUID } from "node:crypto";
/** Anything that can run queries: the database or an open transaction. */
export type Executor = {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type JournalLineInput = {
  accountCode: string;
  accountName: string;
  debit?: number;
  credit?: number;
  memo?: string;
};

export const ACCOUNTS = {
  CASH: { code: "1000", name: "Cash on hand" },
  BANK: { code: "1010", name: "Bank account" },
  WALLET: { code: "1020", name: "Digital wallet" },
  ADVANCE: { code: "1100", name: "Advances receivable" },
  MEMBER_PAYABLE: { code: "2000", name: "Member reimbursements payable" },
  CLEARING: { code: "2100", name: "Expense clearing" },
  SPONSOR_INCOME: { code: "3000", name: "Sponsorship income" },
  OPENING_EQUITY: { code: "3100", name: "Opening balance equity" },
  OTHER_INCOME: { code: "3900", name: "Other income" },
  BANK_FEES: { code: "5900", name: "Bank charges" },
} as const;

export function accountLedger(type: string) {
  if (type === "BANK") return ACCOUNTS.BANK;
  if (type === "WALLET") return ACCOUNTS.WALLET;
  return ACCOUNTS.CASH;
}

async function nextValue(db: Executor, sequence: string): Promise<number> {
  const res = await db.query<{ value: string | number | bigint }>(`SELECT nextval($1) AS value`, [sequence]);
  return Number(res.rows[0]?.value ?? 0);
}

export async function claimNumber(db: Executor): Promise<string> {
  return `LOC-${new Date().getFullYear()}-${String(await nextValue(db, "claim_seq")).padStart(4, "0")}`;
}
export async function paymentNumber(db: Executor): Promise<string> {
  return `PAY-${String(await nextValue(db, "payment_seq")).padStart(5, "0")}`;
}
export async function advanceNumber(db: Executor): Promise<string> {
  return `ADV-${String(await nextValue(db, "advance_seq")).padStart(4, "0")}`;
}
export async function agreementNumber(db: Executor): Promise<string> {
  return `SPN-${String(await nextValue(db, "agreement_seq")).padStart(4, "0")}`;
}

export class JournalError extends Error {}

/**
 * Post a balanced double-entry journal entry. Must be called inside a transaction
 * when part of a larger financial change. The database additionally enforces
 * balance with a deferred constraint trigger.
 */
export async function postJournal(
  db: Executor,
  input: {
    date: string;
    memo: string;
    sourceType: string;
    sourceId?: string | null;
    lines: JournalLineInput[];
    createdBy: string;
  },
): Promise<string> {
  const lines = input.lines
    .map((l) => ({ ...l, debit: Math.trunc(l.debit ?? 0), credit: Math.trunc(l.credit ?? 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  if (lines.length < 2) throw new JournalError("A journal entry needs at least two lines.");
  if (debit !== credit) throw new JournalError(`Unbalanced journal entry: debit ${debit} vs credit ${credit}.`);
  if (lines.some((l) => l.debit < 0 || l.credit < 0)) throw new JournalError("Journal amounts cannot be negative.");

  const seq = await nextValue(db, "journal_seq");
  const id = randomUUID();
  const entryNo = `JE-${String(seq).padStart(6, "0")}`;

  await db.query(
    `INSERT INTO journal_entries (id, entry_no, entry_date, memo, source_type, source_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7)`,
    [id, entryNo, input.date, input.memo, input.sourceType, input.sourceId ?? null, input.createdBy],
  );
  for (const line of lines) {
    await db.query(
      `INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit_paisa, credit_paisa, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), id, line.accountCode, line.accountName, line.debit, line.credit, line.memo ?? null],
    );
  }
  await db.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [id]);
  return id;
}
