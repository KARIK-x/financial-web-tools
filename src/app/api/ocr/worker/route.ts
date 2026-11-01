import { NextResponse } from "next/server";
import { processNextOcrJob } from "@/server/ocr-queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = process.env.OCR_WORKER_TOKEN;
  if (token) {
    const authorization = request.headers.get("authorization");
    if (authorization !== `Bearer ${token}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "OCR_WORKER_TOKEN is required in production." }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "1"), 1), 10);
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await processNextOcrJob("api");
    if (!result) break;
    results.push({ status: result.status, engine: result.engine });
  }
  return NextResponse.json({ processed: results.length, results });
}
