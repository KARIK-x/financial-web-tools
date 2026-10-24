import NepaliDateModule from "nepali-date-converter";

type NepaliDateLike = {
  format: (pattern: string) => string;
  toJsDate: () => Date;
  getYear: () => number;
  getMonth: () => number;
  getDate: () => number;
};

type NepaliDateCtor = new (...args: unknown[]) => NepaliDateLike;
const NepaliDate = ((NepaliDateModule as unknown as { default?: NepaliDateCtor }).default ??
  (NepaliDateModule as unknown as NepaliDateCtor)) as NepaliDateCtor;

export const BS_MONTHS = [
  "Baishakh", "Jestha", "Ashadh", "Shrawan", "Bhadra", "Ashwin",
  "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
];

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayISO(timezone = "Asia/Kathmandu"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

export function adToBs(iso: string): string | null {
  if (!isValidISODate(iso)) return null;
  try {
    const nd = new NepaliDate(new Date(`${iso}T12:00:00+05:45`));
    return nd.format("YYYY-MM-DD");
  } catch {
    return null;
  }
}

export function bsToAd(bs: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bs)) return null;
  const [y, m, d] = bs.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12) return null;
  try {
    const nd = new NepaliDate(y, m - 1, d);
    const js = nd.toJsDate();
    if (Number.isNaN(js.getTime())) return null;
    return `${js.getFullYear()}-${String(js.getMonth() + 1).padStart(2, "0")}-${String(js.getDate()).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function formatBsLong(bs: string | null | undefined): string {
  if (!bs || !/^\d{4}-\d{2}-\d{2}$/.test(bs)) return bs ?? "—";
  const [y, m, d] = bs.split("-").map(Number) as [number, number, number];
  return `${BS_MONTHS[m - 1] ?? m} ${d}, ${y} BS`;
}

export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Kathmandu", hour12: false,
  });
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Nepali fiscal year label (Shrawan 1 – Ashadh end), e.g. "2083/84". */
export function fiscalYearBsFor(iso: string): string {
  const bs = adToBs(iso);
  if (!bs) return "";
  const year = Number(bs.slice(0, 4));
  const month = Number(bs.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

export function fiscalYearFor(iso: string, startMonth = 7): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}
