"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { createAdvance, disburseAdvance, returnAdvanceFunds, writeOffAdvance } from "@/server/advances";
import { fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

function refresh(id?: string) {
  revalidatePath("/advances");
  revalidatePath("/overview");
  revalidatePath("/my-expenses");
  if (id) revalidatePath(`/advances/${id}`);
}

export async function createAdvanceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const result = await createAdvance(db, user, {
      memberId: str(fd, "memberId") || user.memberId || "",
      purpose: str(fd, "purpose"),
      amount: str(fd, "amount"),
      eventId: optional(fd, "eventId"),
      dueOn: optional(fd, "dueOn"),
      notes: optional(fd, "notes"),
    });
    refresh(result.id);
    return { ok: true, message: `Advance ${result.ref} requested. It is not funded until a disbursement is recorded.`, redirectTo: `/advances/${result.id}` };
  } catch (err) {
    return fail(err);
  }
}

export async function disburseAdvanceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const advanceId = str(fd, "advanceId");
    await disburseAdvance(db, user, {
      advanceId,
      accountId: str(fd, "accountId"),
      date: str(fd, "date"),
      method: optional(fd, "method") ?? undefined,
      reference: optional(fd, "reference") ?? undefined,
    });
    refresh(advanceId);
    revalidatePath("/accounts");
    return { ok: true, message: "Advance disbursed and posted to advances receivable." };
  } catch (err) {
    return fail(err);
  }
}

export async function returnAdvanceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const advanceId = str(fd, "advanceId");
    await returnAdvanceFunds(db, user, {
      advanceId,
      accountId: str(fd, "accountId"),
      amount: str(fd, "amount"),
      date: str(fd, "date"),
      notes: optional(fd, "notes") ?? undefined,
    });
    refresh(advanceId);
    revalidatePath("/accounts");
    return { ok: true, message: "Unused advance funds recorded as returned." };
  } catch (err) {
    return fail(err);
  }
}

export async function writeOffAdvanceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const advanceId = str(fd, "advanceId");
    await writeOffAdvance(db, user, advanceId, str(fd, "reason"));
    refresh(advanceId);
    return { ok: true, message: "Advance written off. The reason is in the audit trail." };
  } catch (err) {
    return fail(err);
  }
}
