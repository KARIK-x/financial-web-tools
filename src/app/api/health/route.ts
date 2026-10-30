import { NextResponse } from "next/server";
import { getDb, one } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    const row = await one<{ ok: number }>(db, `SELECT 1 AS ok`);
    return NextResponse.json({ status: "ok", database: row?.ok === 1, timestamp: new Date().toISOString() }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ status: "error", error: err instanceof Error ? err.message : "unknown", timestamp: new Date().toISOString() }, { status: 503 });
  }
}
