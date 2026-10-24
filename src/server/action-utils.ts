import type { ActionResult } from "@/lib/action-result";

export function ok(message?: string, redirectTo?: string): ActionResult {
  return { ok: true, ...(message ? { message } : {}), ...(redirectTo ? { redirectTo } : {}) };
}

export function fail(err: unknown): ActionResult {
  if (err instanceof Error) {
    if (err.message === "UNAUTHENTICATED") return { ok: false, error: "Your session expired. Sign in again." };
    if (err.message.startsWith("FORBIDDEN")) return { ok: false, error: "You do not have permission to do that." };
    return { ok: false, error: err.message };
  }
  return { ok: false, error: "Something went wrong. Nothing was saved." };
}

export function str(fd: FormData, key: string): string {
  const value = fd.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function optional(fd: FormData, key: string): string | null {
  const value = str(fd, key);
  return value.length ? value : null;
}

export function bool(fd: FormData, key: string): boolean {
  const value = fd.get(key);
  return value === "on" || value === "true" || value === "1";
}

export function file(fd: FormData, key: string): File | null {
  const value = fd.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

/** Parse a repeatable indexed form field (`lines[0][amount]`) into rows. */
export function indexedRows(fd: FormData, prefix: string, fields: string[]): Array<Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  const pattern = new RegExp(`^${prefix}\\[(\\d+)\\]\\[([^\\]]+)\\]$`);
  for (const [key, value] of fd.entries()) {
    const match = key.match(pattern);
    if (!match || typeof value !== "string") continue;
    const index = Number(match[1]);
    const field = match[2]!;
    if (!fields.includes(field)) continue;
    const row = rows.get(index) ?? {};
    row[field] = value;
    rows.set(index, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
