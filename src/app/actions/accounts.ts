"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { ACCOUNTS, accountLedger, postJournal } from "@/server/journal";
import { createAccount, recordTransfer } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { parseMoney } from "@/lib/money";
import { fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function createAccountAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("account.manage");
    const db = await getDb();
    const id = await createAccount(db, user, {
      name: str(fd, "name"),
      type: (str(fd, "type") || "CASH") as "CASH" | "BANK" | "WALLET",
      institution: optional(fd, "institution") ?? undefined,
      identifierMasked: optional(fd, "identifierMasked") ?? undefined,
      openingBalance: str(fd, "openingBalance") || "0",
      openedOn: optional(fd, "openedOn") ?? undefined,
      notes: optional(fd, "notes") ?? undefined,
    });
    revalidatePath("/accounts");
    return { ok: true, message: "Account created. Opening balances should come from a counted cash box or a verified statement.", redirectTo: `/accounts?account=${id}` };
  } catch (err) {
    return fail(err);
  }
}

export async function recordTransferAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("account.manage");
    const db = await getDb();
    await recordTransfer(db, user, {
      fromAccountId: str(fd, "fromAccountId"),
      toAccountId: str(fd, "toAccountId"),
      amount: str(fd, "amount"),
      date: str(fd, "date"),
      reference: optional(fd, "reference") ?? undefined,
      notes: optional(fd, "notes") ?? undefined,
    });
    revalidatePath("/accounts");
    return { ok: true, message: "Transfer recorded. Internal transfers do not count as income or expenditure." };
  } catch (err) {
    return fail(err);
  }
}

export async function setOpeningBalanceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("account.manage");
    const db = await getDb();
    const accountId = str(fd, "accountId");
    const reason = str(fd, "reason");
    if (!reason) return { ok: false, error: "Explain where this opening balance comes from." };
    const parsed = parseMoney(str(fd, "openingBalance"));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const account = await one<{ id: string; name: string; opening_balance_paisa: number }>(
      db, `SELECT id, name, opening_balance_paisa FROM financial_accounts WHERE id = $1`, [accountId],
    );
    if (!account) return { ok: false, error: "Account not found." };
    const movement = await one<{ n: number }>(
      db, `SELECT COUNT(*)::int AS n FROM payments WHERE (account_id=$1 OR from_account_id=$1 OR to_account_id=$1) AND status='RECORDED'`,
      [accountId],
    );
    if ((movement?.n ?? 0) > 0) {
      return { ok: false, error: "This account already has recorded movements. Changing the opening balance would rewrite history; record an adjustment instead." };
    }
    const accountType = await one<{ type: string }>(db, `SELECT type FROM financial_accounts WHERE id=$1`, [accountId]);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE financial_accounts SET opening_balance_paisa = $2 WHERE id = $1`, [accountId, parsed.paisa]);
      if (parsed.paisa > 0) {
        const ledger = accountLedger(accountType?.type ?? "CASH");
        await postJournal(tx, {
          date: new Date().toISOString().slice(0, 10),
          memo: `Opening balance — ${account.name}`,
          sourceType: "OPENING_BALANCE",
          sourceId: accountId,
          createdBy: user.id,
          lines: [
            { accountCode: ledger.code, accountName: `${ledger.name} — ${account.name}`, debit: parsed.paisa },
            { accountCode: ACCOUNTS.OPENING_EQUITY.code, accountName: ACCOUNTS.OPENING_EQUITY.name, credit: parsed.paisa },
          ],
        });
      }
    });
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "OPENING_BALANCE_SET",
      entityType: "financial_account", entityId: accountId,
      summary: `${account.name}: opening balance set to NPR ${(parsed.paisa / 100).toFixed(2)} — ${reason}`,
      before: { opening_balance_paisa: Number(account.opening_balance_paisa) },
      after: { opening_balance_paisa: parsed.paisa, reason },
    });
    revalidatePath("/accounts");
    return { ok: true, message: "Opening balance recorded with the reason in the audit trail." };
  } catch (err) {
    return fail(err);
  }
}
