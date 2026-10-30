import { money, one, type Executor } from "./db";

export class FundsError extends Error {}

export function negativeBalancesAllowed(): boolean {
  return (process.env.ALLOW_NEGATIVE_ACCOUNT_BALANCE ?? "").toLowerCase() === "true";
}

/** Balance of a cash/bank/wallet account at the end of a date, inside a transaction. */
export async function accountBalanceAt(db: Executor, accountId: string, asOf: string): Promise<number> {
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

/**
 * Serialise writes against one account and enforce a non-negative balance.
 * This must be called inside the same transaction as the payment insert.
 * Existing databases that legitimately carry a negative legacy balance can be
 * migrated with ALLOW_NEGATIVE_ACCOUNT_BALANCE=true, but each new write is then
 * still visible in reports and cannot be hidden.
 */
export async function lockAndAssertFunds(
  db: Executor,
  accountId: string,
  asOf: string,
  amountPaisa: number,
  accountLabel: string,
): Promise<number> {
  const locked = await one<{ id: string }>(db, `SELECT id FROM financial_accounts WHERE id=$1 FOR UPDATE`, [accountId]);
  if (!locked) throw new FundsError("The selected account no longer exists.");
  const balance = await accountBalanceAt(db, accountId, asOf);
  if (!negativeBalancesAllowed() && amountPaisa > balance) {
    throw new FundsError(
      `Insufficient funds in ${accountLabel}: available NPR ${(Math.max(0, balance) / 100).toFixed(2)}, required NPR ${(amountPaisa / 100).toFixed(2)}. ` +
      "Record an opening balance, a transfer or a receipt first, or have the Finance Manager review the policy override.",
    );
  }
  return balance;
}
