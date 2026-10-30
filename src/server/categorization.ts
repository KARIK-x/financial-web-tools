import { one, type Db } from "./db";

const RULES: Array<{ keywords: string[]; code: string }> = [
  { keywords: ["print", "photocopy", "xerox", "stationery", "paper", "ink", "cartridge"], code: "PRINTING" },
  { keywords: ["bulb", "tube light", "led", "wire", "socket", "switch", "electrical", "fan", "light"], code: "EQUIPMENT" },
  { keywords: ["software", "subscription", "domain", "hosting", "license", "saas"], code: "SOFTWARE" },
  { keywords: ["travel", "taxi", "bus", "fuel", "petrol", "diesel", "pathao", "uber", "ticket"], code: "TRAVEL" },
  { keywords: ["food", "lunch", "dinner", "snack", "tea", "coffee", "restaurant", "catering"], code: "FOOD" },
  { keywords: ["venue", "hall", "room", "rent", "logistics"], code: "VENUE" },
  { keywords: ["prize", "award", "gift", "trophy", "certificate"], code: "PRIZES" },
  { keywords: ["marketing", "design", "poster", "banner", "social media", "advertis"], code: "MARKETING" },
  { keywords: ["service", "consult", "labour", "repair", "maintenance", "cleaning"], code: "SERVICES" },
  { keywords: ["utility", "internet", "wifi", "electricity", "water", "phone", "mobile recharge"], code: "UTILITIES" },
  { keywords: ["bank", "charge", "fee", "commission", "interest"], code: "BANK" },
];

export function inferCategoryCode(text: string): string {
  const lower = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) return rule.code;
  }
  return "OTHER";
}

export async function inferCategoryId(db: Db, text: string): Promise<string> {
  const code = inferCategoryCode(text);
  const row = await one<{ id: string }>(db, `SELECT id FROM expense_categories WHERE code=$1 AND is_active=true LIMIT 1`, [code]);
  if (row?.id) return row.id;
  const fallback = await one<{ id: string }>(db, `SELECT id FROM expense_categories WHERE code='OTHER' AND is_active=true LIMIT 1`);
  if (fallback?.id) return fallback.id;
  const any = await one<{ id: string }>(db, `SELECT id FROM expense_categories WHERE is_active=true ORDER BY name LIMIT 1`);
  if (!any?.id) throw new Error("No expense categories configured.");
  return any.id;
}
