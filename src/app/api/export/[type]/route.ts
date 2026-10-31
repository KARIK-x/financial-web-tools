import { requirePermission, requestContext } from "@/server/auth";
import { getDb } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { resolvePeriod } from "@/server/reports";
import { buildExport, type ExportType } from "@/server/exports";
import { toCsv } from "@/lib/csv";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { todayISO } from "@/lib/nepali-date";

export const dynamic = "force-dynamic";

const TYPES = new Set<ExportType>([
  "claims", "payments", "journal", "trial-balance", "cashflow", "categories",
  "events", "sponsors", "budgets", "advances", "accounts", "audit", "bank-lines",
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type: rawType } = await params;
  const type = rawType as ExportType;
  if (!TYPES.has(type)) return json({ error: "Unknown export type." }, 404);

  let user;
  try {
    user = await requirePermission("export.run");
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "UNAUTHENTICATED") return json({ error: "Sign in to export data." }, 401);
    if (message.startsWith("FORBIDDEN")) return json({ error: "You do not have permission to export data." }, 403);
    return json({ error: "Export failed authorisation." }, 500);
  }

  const url = new URL(request.url);
  const rawFormat = url.searchParams.get("format") ?? "csv";
  const format = rawFormat === "json" ? "json" : rawFormat === "xlsx" ? "xlsx" : rawFormat === "pdf" ? "pdf" : "csv";
  const db = await getDb();
  const period = await resolvePeriod(db, url.searchParams.get("from"), url.searchParams.get("to"));
  const status = url.searchParams.get("status") ?? undefined;
  const documentation = url.searchParams.get("documentation") ?? undefined;

  try {
    const result = await buildExport(db, type, period, { status, documentation });
    const ctx = await requestContext();
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "EXPORT_RUN",
      entityType: "export", entityId: type,
      summary: `Exported ${result.records.length} ${type} row${result.records.length === 1 ? "" : "s"} as ${format.toUpperCase()} for ${period.from} → ${period.to}${result.truncated ? " (truncated at 20,000 rows)" : ""}`,
      after: { type, format, from: period.from, to: period.to, rows: result.records.length, truncated: result.truncated },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });

    const stamp = todayISO();
    if (format === "json") {
      const body = {
        manifest: {
          type,
          generatedAt: new Date().toISOString(),
          generatedBy: { name: user.name, role: user.role },
          period,
          rowCount: result.records.length,
          truncated: result.truncated,
          currency: "NPR",
          amountEncoding: "Money is emitted as integer paisa in *_paisa fields; *_npr is a decimal-string convenience view of the same value.",
          syntheticRecordsPresent: result.records.some((r) => r.is_synthetic === true),
          note: "This extract reflects records at generation time. It is not a substitute for a database backup.",
        },
        records: result.records,
      };
      return new Response(JSON.stringify(body, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="finance-tracker-${type}-${stamp}.json"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(type.slice(0, 31));
      sheet.addRow(result.headers);
      for (const record of result.records) {
        sheet.addRow(result.headers.map((h) => record[h]));
      }
      sheet.getRow(1).font = { bold: true };
      const buffer = await workbook.xlsx.writeBuffer();
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="finance-tracker-${type}-${stamp}.xlsx"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (format === "pdf") {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([842, 595]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const margin = 40;
      let y = 555;
      page.drawText(`Finance Tracker — ${type} export`, { x: margin, y, size: 16, font: bold, color: rgb(0.04, 0.04, 0.04) });
      y -= 20;
      page.drawText(`Period: ${period.from} to ${period.to} · Rows: ${result.records.length}${result.truncated ? " (truncated)" : ""}`, { x: margin, y, size: 10, font, color: rgb(0.35, 0.35, 0.35) });
      y -= 24;
      const cols = result.headers.slice(0, 6);
      const colWidth = (842 - margin * 2) / cols.length;
      cols.forEach((h, i) => {
        page.drawText(String(h).slice(0, 24), { x: margin + i * colWidth, y, size: 9, font: bold, color: rgb(0.04, 0.04, 0.04) });
      });
      y -= 14;
      const rows = result.records.slice(0, 45);
      for (const record of rows) {
        cols.forEach((h, i) => {
          page.drawText(String(record[h] ?? "").slice(0, 24), { x: margin + i * colWidth, y, size: 8, font, color: rgb(0.15, 0.15, 0.15) });
        });
        y -= 12;
        if (y < 40) return; // stop if page full
      }
      const bytes = await pdfDoc.save();
      return new Response(Buffer.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="finance-tracker-${type}-${stamp}.pdf"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new Response(toCsv(result.headers, result.records), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="finance-tracker-${type}-${stamp}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed.";
    return json({ error: message }, 500);
  }
}
