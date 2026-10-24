const NEPALI_DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

export const MAX_PAISA = 1_000_000_000_000_000; // NPR 10 trillion

export function normalizeDigits(input: string): string {
  return input.replace(/[०-९]/g, (d) => NEPALI_DIGITS[d] ?? d);
}

/** Convert a decimal NPR string ("3500.50") to integer paisa without float math. */
export function decimalToPaisa(value: string): number | null {
  const cleaned = normalizeDigits(value).replace(/[,\s_]/g, "").trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".");
  const padded = (frac + "000").slice(0, 3);
  // round half-up at the third decimal
  const npr = BigInt(whole);
  let paisa = npr * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2] ?? "0") >= 5) paisa += 1n;
  if (paisa > BigInt(MAX_PAISA)) return null;
  return Number(negative ? -paisa : paisa);
}

export function paisaToDecimal(paisa: number): string {
  const negative = paisa < 0;
  const abs = Math.abs(Math.trunc(paisa));
  const rupees = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${negative ? "-" : ""}${rupees}.${String(cents).padStart(2, "0")}`;
}

export type MoneyParseResult =
  | { ok: true; paisa: number; note?: string }
  | { ok: false; error: string };

/**
 * Parse amounts as they appear on Nepali receipts and spreadsheets.
 * Handles: "Rs. 3,500", "NPR 3500.50", "रु ५००", "1,50,000/-", "2.5 lakh", "1 lakh 50 thousand".
 */
export function parseMoney(input: string): MoneyParseResult {
  if (input == null) return { ok: false, error: "Amount is required." };
  const raw = normalizeDigits(String(input)).trim();
  if (!raw) return { ok: false, error: "Amount is required." };

  let text = raw
    .replace(/^(npr|rs\.?|r\.?|np\.?|रु\.?|रू\.?)\s*/i, "")
    .replace(/\s*(npr|rs\.?|\/-|only)\s*$/i, "")
    .replace(/[०-९]/g, (d) => NEPALI_DIGITS[d] ?? d)
    .trim();

  const croreMatch = text.match(/^([\d,.]+)\s*(crore|करोड)$/i);
  const lakhMatch = text.match(/^([\d,.]+)\s*(lakh|lac|lacs|लाख)$/i);
  const thousandMatch = text.match(/^([\d,.]+)\s*(thousand|hajar|हजार)$/i);

  // Compound shorthand such as "1 lakh 50 thousand" or "2 crore 25 lakh".
  // Parsed in full; nothing is silently dropped.
  const compound = text.match(
    /^([\d,.]+)\s*(crore|करोड)\s*(?:([\d,.]+)\s*(lakh|lac|lacs|लाख))?$/i,
  ) ?? text.match(
    /^([\d,.]+)\s*(lakh|lac|lacs|लाख)\s*(?:([\d,.]+)\s*(thousand|hajar|हजार))?$/i,
  );
  if (compound?.[1]) {
    const majorUnit = /crore|करोड/i.test(compound[2] ?? "") ? 10_000_000 : 100_000;
    const minorUnit = /lakh|lac|लाख/i.test(compound[4] ?? "") ? 100_000 : 1_000;
    const major = decimalToPaisa(compound[1]!);
    const minor = compound[3] ? decimalToPaisa(compound[3]) : 0;
    if (major == null || minor == null) return { ok: false, error: "Amount must be a positive number, e.g. 3,500.50." };
    const paisa = major * majorUnit + minor * minorUnit;
    if (paisa <= 0) return { ok: false, error: "Amount must be greater than zero." };
    if (paisa > MAX_PAISA) return { ok: false, error: "Amount is too large." };
    return { ok: true, paisa };
  }

  let multiplier = 1;
  if (lakhMatch?.[1]) {
    text = lakhMatch[1];
    multiplier = 100_000;
  } else if (croreMatch?.[1]) {
    text = croreMatch[1];
    multiplier = 10_000_000;
  } else if (thousandMatch?.[1]) {
    text = thousandMatch[1];
    multiplier = 1_000;
  }

  const normalized = text.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, error: "Amount must be a positive number, e.g. 3,500.50." };
  }
  const base = decimalToPaisa(normalized);
  if (base == null) return { ok: false, error: "Amount is too large." };
  const paisa = base * multiplier;
  if (paisa <= 0) return { ok: false, error: "Amount must be greater than zero." };
  if (paisa > MAX_PAISA) return { ok: false, error: "Amount is too large." };

  if (normalized.includes(".") && normalized.split(".")[1]!.length > 2) {
    return { ok: true, paisa, note: "Amount was rounded to paisa (2 decimals)." };
  }
  return { ok: true, paisa };
}

/** Strict parse for form fields — no shorthand multipliers. */
export function parseStrictMoney(input: string): MoneyParseResult {
  const result = parseMoney(input);
  if (!result.ok) return result;
  return result;
}

/** Nepali lakh/crore grouping: 1,50,000.50 */
export function groupLakh(value: string): string {
  const [whole = "0", frac] = value.split(".");
  const negative = whole.startsWith("-");
  const digits = whole.replace("-", "");
  if (digits.length <= 3) return `${negative ? "-" : ""}${digits}${frac ? "." + frac : ""}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  return `${negative ? "-" : ""}${grouped}${frac ? "." + frac : ""}`;
}

export function groupWestern(value: string): string {
  const [whole = "0", frac] = value.split(".");
  const negative = whole.startsWith("-");
  const digits = whole.replace("-", "");
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? "." + frac : ""}`;
}

export function formatNPR(paisa: number, opts: { grouping?: "lakh" | "western"; symbol?: boolean; decimals?: boolean } = {}): string {
  const { grouping = "lakh", symbol = true, decimals = true } = opts;
  const decimal = paisaToDecimal(paisa);
  const [whole = "0", frac] = decimal.split(".");
  const grouped = grouping === "lakh" ? groupLakh(whole) : groupWestern(whole);
  const tail = decimals ? `.${frac}` : "";
  return `${symbol ? "NPR " : ""}${grouped}${tail}`;
}

/** Short display for KPI cards: NPR 1.5 lakh */
export function formatNPRShort(paisa: number): string {
  const npr = paisa / 100;
  if (Math.abs(npr) >= 10_000_000) return `NPR ${(npr / 10_000_000).toFixed(2)} crore`;
  if (Math.abs(npr) >= 100_000) return `NPR ${(npr / 100_000).toFixed(2)} lakh`;
  if (Math.abs(npr) >= 1_000) return `NPR ${(npr / 1_000).toFixed(1)}k`;
  return formatNPR(paisa, { decimals: false });
}

export function sumPaisa(values: Array<number | string | bigint | null | undefined>): number {
  return values.reduce<number>((acc, v) => acc + toPaisa(v), 0);
}

export function toPaisa(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
