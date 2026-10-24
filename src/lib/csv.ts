/** CSV generation with spreadsheet-injection protection. Unit-tested in tests/csv.test.ts. */

function textOf(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return String(value);
}

export function csvCell(value: unknown): string {
  let text = textOf(value);
  // A string beginning with these characters can execute as a formula in Excel/Sheets.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/["\n\r,]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
