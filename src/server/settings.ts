import { type Db, one } from "./db";

export type Settings = {
  approval: { standard: number; executive: number; committee: number };
  display: { numberGrouping: "lakh" | "western"; dateCalendar: "AD" | "BS"; timezone: string };
  documentation: { missingReceiptRequiresDeclaration: boolean; secondApprovalAbove: number };
  compliance: { pan: string | null; vatRegistered: boolean; legalStatus: string; note: string };
  reconstruction: { baselineVersion: number };
};

const DEFAULTS: Settings = {
  approval: { standard: 200_000, executive: 2_500_000, committee: 10_000_000 },
  display: { numberGrouping: "lakh", dateCalendar: "AD", timezone: "Asia/Kathmandu" },
  documentation: { missingReceiptRequiresDeclaration: true, secondApprovalAbove: 500_000 },
  compliance: { pan: null, vatRegistered: false, legalStatus: "UNVERIFIED", note: "" },
  reconstruction: { baselineVersion: 0 },
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = (await db.query<{ key: string; value: Record<string, unknown> }>(`SELECT key, value FROM settings`)).rows;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const approval = { ...DEFAULTS.approval, ...(map.get("approval_thresholds") ?? {}) } as Settings["approval"];
  const display = { ...DEFAULTS.display, ...(map.get("display") ?? {}) } as Settings["display"];
  const documentation = { ...DEFAULTS.documentation, ...(map.get("documentation") ?? {}) } as Settings["documentation"];
  const compliance = { ...DEFAULTS.compliance, ...(map.get("compliance") ?? {}) } as Settings["compliance"];
  const reconstruction = { ...DEFAULTS.reconstruction, ...(map.get("reconstruction") ?? {}) } as Settings["reconstruction"];
  return { approval, display, documentation, compliance, reconstruction };
}

export async function saveSetting(db: Db, key: string, value: unknown, userId: string) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1,$2::jsonb,now(),$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId],
  );
}

export async function getOrganization(db: Db) {
  return one<{ id: string; name: string; legal_name: string | null; currency: string; fiscal_year_start_month: number; is_synthetic: boolean }>(
    db,
    `SELECT id, name, legal_name, currency, fiscal_year_start_month, is_synthetic FROM organizations ORDER BY created_at LIMIT 1`,
  );
}

export function approvalTier(amountPaisa: number, s: Settings): "STANDARD" | "EXECUTIVE" | "COMMITTEE" {
  if (amountPaisa > s.approval.committee) return "COMMITTEE";
  if (amountPaisa > s.approval.standard) return "EXECUTIVE";
  return "STANDARD";
}

export function requiredApprovals(amountPaisa: number, s: Settings): Array<"FINANCE" | "EXECUTIVE"> {
  if (amountPaisa > s.approval.standard) return ["FINANCE", "EXECUTIVE"];
  return ["FINANCE"];
}
