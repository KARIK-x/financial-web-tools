"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { createSponsorship, recordSponsorReceipt, updateAgreementState } from "@/server/sponsors";
import { recordAudit } from "@/server/audit";
import { fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";

export async function createSponsorshipAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const inKind = fd.get("inKind") === "on";
    const result = await createSponsorship(db, user, {
      sponsorName: str(fd, "sponsorName"),
      title: str(fd, "title"),
      packageTier: optional(fd, "packageTier") ?? undefined,
      state: str(fd, "state") || "LEAD",
      promised: str(fd, "promised") || "0",
      inKind,
      inKindDescription: optional(fd, "inKindDescription") ?? undefined,
      inKindValue: optional(fd, "inKindValue") ?? undefined,
      eventId: optional(fd, "eventId") ?? undefined,
      earmarkNote: optional(fd, "earmarkNote") ?? undefined,
      signedOn: optional(fd, "signedOn") ?? undefined,
      contactName: optional(fd, "contactName") ?? undefined,
      email: optional(fd, "email") ?? undefined,
      phone: optional(fd, "phone") ?? undefined,
      deliverables: optional(fd, "deliverables") ?? undefined,
    });
    revalidatePath("/sponsors");
    revalidatePath("/overview");
    return { ok: true, message: `Agreement ${result.ref} created.`, redirectTo: `/sponsors/${result.id}` };
  } catch (err) {
    return fail(err);
  }
}

export async function recordSponsorReceiptAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const agreementId = str(fd, "agreementId");
    const result = await recordSponsorReceipt(db, user, {
      agreementId,
      accountId: str(fd, "accountId"),
      amount: str(fd, "amount"),
      date: str(fd, "date"),
      method: optional(fd, "method") ?? undefined,
      reference: optional(fd, "reference") ?? undefined,
      notes: optional(fd, "notes") ?? undefined,
    });
    revalidatePath("/sponsors");
    revalidatePath(`/sponsors/${agreementId}`);
    revalidatePath("/accounts");
    revalidatePath("/overview");
    return { ok: true, message: `Receipt ${result.ref} recorded.` };
  } catch (err) {
    return fail(err);
  }
}

export async function updateAgreementStateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const agreementId = str(fd, "agreementId");
    await updateAgreementState(db, user, agreementId, str(fd, "state"));
    revalidatePath("/sponsors");
    revalidatePath(`/sponsors/${agreementId}`);
    return { ok: true, message: "State updated." };
  } catch (err) {
    return fail(err);
  }
}

export async function completeDeliverableAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const deliverableId = str(fd, "deliverableId");
    const deliverable = await one<{ id: string; agreement_id: string; description: string; status: string }>(
      db, `SELECT id, agreement_id, description, status FROM sponsor_deliverables WHERE id = $1`, [deliverableId],
    );
    if (!deliverable) return { ok: false, error: "Deliverable not found." };
    const waive = fd.get("waive") === "true";
    await db.query(
      `UPDATE sponsor_deliverables SET status = $2, completed_at = now() WHERE id = $1`,
      [deliverableId, waive ? "WAIVED" : "DONE"],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name,
      action: waive ? "SPONSOR_DELIVERABLE_WAIVED" : "SPONSOR_DELIVERABLE_DONE",
      entityType: "sponsor_deliverable", entityId: deliverableId,
      summary: `${deliverable.description} marked ${waive ? "waived" : "done"}`,
    });
    revalidatePath(`/sponsors/${deliverable.agreement_id}`);
    return { ok: true, message: waive ? "Deliverable waived." : "Deliverable completed." };
  } catch (err) {
    return fail(err);
  }
}

export async function addDeliverableAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const db = await getDb();
    const agreementId = str(fd, "agreementId");
    const description = str(fd, "description");
    if (!description) return { ok: false, error: "Describe the deliverable." };
    const dueOn = optional(fd, "dueOn");
    await db.query(
      `INSERT INTO sponsor_deliverables (id, agreement_id, description, due_on) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), agreementId, description.slice(0, 300), dueOn],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "SPONSOR_DELIVERABLE_ADDED",
      entityType: "sponsorship_agreement", entityId: agreementId,
      summary: `Deliverable added: ${description}`,
    });
    revalidatePath(`/sponsors/${agreementId}`);
    return { ok: true, message: "Deliverable added." };
  } catch (err) {
    return fail(err);
  }
}
