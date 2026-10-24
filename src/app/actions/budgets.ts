"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { createBudget, reviseBudgetLine } from "@/server/budgets";
import { recordAudit } from "@/server/audit";
import { fail, indexedRows, optional, str } from "@/server/action-utils";
import { can } from "@/lib/permissions";
import { isValidISODate } from "@/lib/nepali-date";
import type { ActionResult } from "@/lib/action-result";

export async function createEventAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!can(user.role, "budget.manage", user.permissions)) return { ok: false, error: "You cannot manage events." };
    const db = await getDb();
    const name = str(fd, "name");
    const code = str(fd, "code").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!name) return { ok: false, error: "Event name is required." };
    if (code.length < 2) return { ok: false, error: "Event code must be at least 2 characters (A–Z, 0–9)." };
    const startsOn = optional(fd, "startsOn");
    const endsOn = optional(fd, "endsOn");
    if (startsOn && !isValidISODate(startsOn)) return { ok: false, error: "Start date is invalid." };
    if (endsOn && !isValidISODate(endsOn)) return { ok: false, error: "End date is invalid." };
    if (startsOn && endsOn && endsOn < startsOn) return { ok: false, error: "End date cannot be before the start date." };
    const exists = await one<{ id: string }>(db, `SELECT id FROM events WHERE code = $1`, [code]);
    if (exists) return { ok: false, error: `Event code ${code} is already in use.` };

    const id = randomUUID();
    await db.query(
      `INSERT INTO events (id, name, code, starts_on, ends_on, status, notes, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, name, code, startsOn, endsOn, str(fd, "status") || "PLANNED", optional(fd, "notes"), user.isSynthetic],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "EVENT_CREATED",
      entityType: "event", entityId: id, summary: `Event ${name} (${code}) created`,
    });
    revalidatePath("/events");
    return { ok: true, message: `Event ${name} created.`, redirectTo: `/events/${id}` };
  } catch (err) {
    return fail(err);
  }
}

export async function createBudgetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const rows = indexedRows(fd, "lines", ["categoryId", "amount"]);
    const id = await createBudget(db, user, {
      name: str(fd, "name"),
      scope: (str(fd, "scope") || "EVENT") as "ORG" | "EVENT" | "DEPARTMENT",
      eventId: optional(fd, "eventId"),
      departmentId: optional(fd, "departmentId"),
      fiscalYear: str(fd, "fiscalYear"),
      lines: rows.map((r) => ({ categoryId: r.categoryId ?? "", amount: r.amount ?? "" })),
    });
    revalidatePath("/events");
    revalidatePath("/overview");
    return { ok: true, message: "Budget created.", redirectTo: `/events?budget=${id}` };
  } catch (err) {
    return fail(err);
  }
}

export async function reviseBudgetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    await reviseBudgetLine(db, user, {
      lineId: str(fd, "lineId"),
      amount: str(fd, "amount"),
      reason: str(fd, "reason"),
    });
    revalidatePath("/events");
    return { ok: true, message: "Budget line revised. The old amount is kept in the revision history." };
  } catch (err) {
    return fail(err);
  }
}
