"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth";
import { getDb, many, one } from "@/server/db";
import { getOrganization, saveSetting } from "@/server/settings";
import { recordAudit } from "@/server/audit";
import { parseMoney } from "@/lib/money";
import { PERMISSIONS, ROLES, type Permission, type Role } from "@/lib/permissions";
import { bool, fail, optional, str } from "@/server/action-utils";
import type { ActionResult } from "@/lib/action-result";
import { closePeriod, reopenPeriod } from "@/server/periods";

function parseNpr(fd: FormData, key: string): { ok: true; paisa: number } | { ok: false; error: string } {
  const raw = str(fd, key);
  if (!raw) return { ok: false, error: "An amount is required." };
  const parsed = parseMoney(raw);
  if (!parsed.ok) return { ok: false, error: `${key}: ${parsed.error}` };
  return { ok: true, paisa: parsed.paisa };
}

export async function saveOrganizationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const org = await getOrganization(db);
    if (!org) return { ok: false, error: "Organization record not found. Run the migrations first." };

    const name = str(fd, "name");
    const legalName = optional(fd, "legalName");
    const month = Number(str(fd, "fiscalYearStartMonth") || "4");
    if (name.length < 2) return { ok: false, error: "Organization name is required." };
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { ok: false, error: "Fiscal year start month must be between 1 and 12." };
    }

    await db.query(
      `UPDATE organizations SET name = $2, legal_name = $3, fiscal_year_start_month = $4 WHERE id = $1`,
      [org.id, name, legalName, month],
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "ORGANIZATION_UPDATED",
      entityType: "organization", entityId: org.id,
      summary: `Organization profile updated: ${name}`,
      before: { name: org.name, legal_name: org.legal_name, fiscal_year_start_month: org.fiscal_year_start_month },
      after: { name, legal_name: legalName, fiscal_year_start_month: month },
    });
    revalidatePath("/settings");
    return { ok: true, message: "Organization profile saved." };
  } catch (err) {
    return fail(err);
  }
}

export async function saveApprovalThresholdsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const standard = parseNpr(fd, "standard");
    const executive = parseNpr(fd, "executive");
    const committee = parseNpr(fd, "committee");
    if (!standard.ok) return { ok: false, error: `Standard threshold: ${standard.error}` };
    if (!executive.ok) return { ok: false, error: `Executive threshold: ${executive.error}` };
    if (!committee.ok) return { ok: false, error: `Committee threshold: ${committee.error}` };
    if (!(standard.paisa < executive.paisa && executive.paisa < committee.paisa)) {
      return { ok: false, error: "Thresholds must increase: standard < executive < committee." };
    }

    const before = await one<{ value: unknown }>(db, `SELECT value FROM settings WHERE key='approval_thresholds'`);
    await saveSetting(db, "approval_thresholds", {
      standard: standard.paisa, executive: executive.paisa, committee: committee.paisa,
    }, user.id);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "SETTINGS_UPDATED",
      entityType: "settings", entityId: "approval_thresholds",
      summary: `Approval thresholds set to NPR ${(standard.paisa / 100).toFixed(2)} / ${(executive.paisa / 100).toFixed(2)} / ${(committee.paisa / 100).toFixed(2)}`,
      before: before?.value ?? null,
      after: { standard: standard.paisa, executive: executive.paisa, committee: committee.paisa },
    });
    revalidatePath("/settings");
    revalidatePath("/approvals");
    return { ok: true, message: "Approval thresholds saved. They apply to new approvals immediately." };
  } catch (err) {
    return fail(err);
  }
}

export async function saveDisplayAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const numberGrouping = str(fd, "numberGrouping") === "western" ? "western" : "lakh";
    const dateCalendar = str(fd, "dateCalendar") === "BS" ? "BS" : "AD";
    const timezone = str(fd, "timezone") || "Asia/Kathmandu";
    if (!["Asia/Kathmandu", "UTC"].includes(timezone)) {
      return { ok: false, error: "Only Asia/Kathmandu and UTC are supported timezones in this build." };
    }
    await saveSetting(db, "display", { numberGrouping, dateCalendar, timezone }, user.id);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "SETTINGS_UPDATED",
      entityType: "settings", entityId: "display",
      summary: `Display preferences set to ${numberGrouping} grouping, ${dateCalendar} calendar`,
      after: { numberGrouping, dateCalendar, timezone },
    });
    revalidatePath("/settings");
    return { ok: true, message: "Display preferences saved." };
  } catch (err) {
    return fail(err);
  }
}

export async function saveDocumentationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const second = parseMoney(str(fd, "secondApprovalAbove") || "0");
    if (!second.ok) return { ok: false, error: `Second approval amount: ${second.error}` };
    const missingReceiptRequiresDeclaration = bool(fd, "missingReceiptRequiresDeclaration");
    await saveSetting(db, "documentation", {
      missingReceiptRequiresDeclaration,
      secondApprovalAbove: second.paisa,
    }, user.id);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "SETTINGS_UPDATED",
      entityType: "settings", entityId: "documentation",
      summary: `Evidence policy updated (declaration ${missingReceiptRequiresDeclaration ? "required" : "optional"})`,
      after: { missingReceiptRequiresDeclaration, secondApprovalAbove: second.paisa },
    });
    revalidatePath("/settings");
    revalidatePath("/expenses/new");
    return { ok: true, message: "Evidence policy saved." };
  } catch (err) {
    return fail(err);
  }
}

export async function saveComplianceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const pan = optional(fd, "pan");
    if (pan && !/^\d{9}$/.test(pan)) return { ok: false, error: "A Nepali PAN is nine digits." };
    const legalStatus = str(fd, "legalStatus") || "UNVERIFIED";
    const allowed = ["UNVERIFIED", "NGO", "NON_PROFIT", "COMPANY", "GOVERNMENT_BODY", "OTHER"];
    if (!allowed.includes(legalStatus)) return { ok: false, error: "Unknown legal status." };
    const note = optional(fd, "note") ?? "";
    const vatRegistered = bool(fd, "vatRegistered");
    await saveSetting(db, "compliance", { pan, vatRegistered, legalStatus, note }, user.id);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "SETTINGS_UPDATED",
      entityType: "settings", entityId: "compliance",
      summary: `Compliance profile updated (status ${legalStatus}${vatRegistered ? ", VAT registered" : ""})`,
      after: { legalStatus, vatRegistered, panRecorded: Boolean(pan) },
    });
    revalidatePath("/settings");
    return { ok: true, message: "Compliance profile saved. Tax fields are informational until confirmed by an accountant." };
  } catch (err) {
    return fail(err);
  }
}

/** Update role permissions. ADMIN is immutable so the workspace cannot lock itself out. */
export async function saveRolePermissionsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const known = new Set<string>(PERMISSIONS);
    const changes: Array<{ role: Role; permissions: Permission[] }> = [];

    for (const role of ROLES) {
      if (role === "ADMIN") continue;
      const list: Permission[] = [];
      for (const [key, value] of fd.entries()) {
        if (value !== "on") continue;
        const match = key.match(/^perm_([A-Z_]+)_(.+)$/);
        if (!match) continue;
        if (match[1] !== role) continue;
        if (!known.has(match[2]!)) continue;
        list.push(match[2] as Permission);
      }
      if (!list.length) return { ok: false, error: `${role} must keep at least one permission.` };
      changes.push({ role, permissions: [...new Set(list)] });
    }

    await db.transaction(async (tx) => {
      for (const change of changes) {
        await tx.query(`DELETE FROM role_permissions WHERE role = $1`, [change.role]);
        for (const permission of change.permissions) {
          await tx.query(`INSERT INTO role_permissions (role, permission) VALUES ($1,$2)`, [change.role, permission]);
        }
      }
    });

    const rolePermissionRows = await many<{ role: string; permission: string }>(
      db, `SELECT role, permission FROM role_permissions ORDER BY role, permission`,
    );
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "PERMISSIONS_UPDATED",
      entityType: "role_permissions", entityId: "matrix",
      summary: "Role permission matrix updated (ADMIN unchanged)",
      after: rolePermissionRows,
    });
    revalidatePath("/settings");
    revalidatePath("/overview");
    return { ok: true, message: "Permission matrix saved. Changes take effect on the next request for each signed-in user." };
  } catch (err) {
    return fail(err);
  }
}

export async function closePeriodAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const result = await closePeriod(db, user, {
      fiscalYear: str(fd, "fiscalYear"),
      periodStart: str(fd, "periodStart"),
      periodEnd: str(fd, "periodEnd"),
      reason: str(fd, "reason"),
    });
    revalidatePath("/settings");
    revalidatePath("/reports");
    return { ok: true, message: `Period closed. New postings dated inside it are blocked until it is reopened. (${result.id})` };
  } catch (err) {
    return fail(err);
  }
}

export async function reopenPeriodAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const result = await reopenPeriod(db, user, {
      periodId: str(fd, "periodId"),
      reason: str(fd, "reason"),
    });
    revalidatePath("/settings");
    revalidatePath("/reports");
    return { ok: true, message: `Period reopened with an audited reason. (${result.id})` };
  } catch (err) {
    return fail(err);
  }
}

export async function setReconstructionBaselineAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings.manage");
    const db = await getDb();
    const version = Number(str(fd, "version"));
    const note = str(fd, "note");
    if (!Number.isInteger(version) || version < 0) return { ok: false, error: "Baseline version must be a whole number." };
    if (!note) return { ok: false, error: "Explain what was verified before moving the baseline." };
    const current = await one<{ value: unknown }>(db, `SELECT value FROM settings WHERE key='reconstruction'`);
    await saveSetting(db, "reconstruction", { baselineVersion: version, note, setAt: new Date().toISOString() }, user.id);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "RECONSTRUCTION_BASELINE_SET",
      entityType: "settings", entityId: "reconstruction",
      summary: `Historical reconstruction baseline set to v${version}: ${note}`,
      before: current?.value ?? null,
      after: { baselineVersion: version, note },
    });
    revalidatePath("/reconstruction");
    return { ok: true, message: `Baseline v${version} recorded with an audit trail.` };
  } catch (err) {
    return fail(err);
  }
}
