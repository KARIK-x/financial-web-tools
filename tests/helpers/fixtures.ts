import { randomUUID } from "node:crypto";
import { createDatabase, type Db } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { DEFAULT_ROLE_PERMISSIONS, type Role } from "@/lib/permissions";

/** Fresh in-memory Postgres (PGlite) with the real migrations applied. */
export async function createTestDb(): Promise<Db> {
  return createDatabase({});
}

export type PersonSpec = {
  role: Role;
  name: string;
  email?: string;
  /** Members are created for claimants; pass false for logins that are not members. */
  member?: boolean;
  synthetic?: boolean;
};

export async function createPerson(db: Db, spec: PersonSpec): Promise<CurrentUser> {
  const id = randomUUID();
  const memberId = randomUUID();
  const email = spec.email ?? `${id.slice(0, 8)}@test.local`;
  if (spec.member !== false) {
    await db.query(`INSERT INTO members (id, name, email, is_synthetic) VALUES ($1,$2,$3,$4)`, [
      memberId,
      spec.name,
      email,
      spec.synthetic ?? false,
    ]);
  }
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role, member_id, is_synthetic)
     VALUES ($1,$2,$3,'not-a-real-hash',$4,$5,$6)`,
    [id, email, spec.name, spec.role, spec.member === false ? null : memberId, spec.synthetic ?? false],
  );
  return {
    id,
    name: spec.name,
    email,
    role: spec.role,
    roleLabel: spec.role,
    memberId: spec.member === false ? null : memberId,
    isSynthetic: spec.synthetic ?? false,
    mustChangePassword: false,
    sessionId: "test-session",
    permissions: [...DEFAULT_ROLE_PERMISSIONS[spec.role]],
  };
}

export async function createBankAccount(db: Db, openingPaisa = 0): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO financial_accounts (id, name, type, institution, opening_balance_paisa)
     VALUES ($1,'Test bank','BANK','Test Bank',$2)`,
    [id, openingPaisa],
  );
  return id;
}

export async function journalTotals(db: Db): Promise<{ debit: number; credit: number; entries: number }> {
  const res = await db.query<{ debit: string; credit: string; entries: string }>(
    `SELECT COALESCE(SUM(debit_paisa),0) AS debit, COALESCE(SUM(credit_paisa),0) AS credit,
            (SELECT COUNT(*) FROM journal_entries WHERE status='POSTED') AS entries
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.status='POSTED'`,
  );
  const row = res.rows[0];
  return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0), entries: Number(row?.entries ?? 0) };
}

export async function accountCodeBalance(db: Db, code: string): Promise<number> {
  const res = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_paisa - credit_paisa),0) AS balance FROM journal_lines WHERE account_code=$1`,
    [code],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

/** A simple CSV statement; debit = money leaving the bank. */
export function statementCsv(rows: Array<{ date: string; description: string; debit?: string; credit?: string; balance?: string }>): Buffer {
  const header = "Transaction Date,Description,Debit,Credit,Balance,Reference";
  const body = rows
    .map((r, i) => [r.date, r.description, r.debit ?? "", r.credit ?? "", r.balance ?? "", `REF-${i + 1}`].join(","))
    .join("\n");
  return Buffer.from(`${header}\n${body}\n`, "utf8");
}
