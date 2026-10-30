import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { canAccessDocument, getDocument } from "@/server/documents";
import { readDocument } from "@/server/storage";
import { malwareScanRequired } from "@/server/malware";

export const dynamic = "force-dynamic";

const INLINE_SAFE = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff", "application/pdf",
]);

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorised", { status: 401 });

  const db = await getDb();
  const doc = await getDocument(db, id);
  if (!doc) return new NextResponse("Not found", { status: 404 });

  if (!(await canAccessDocument(db, user, id))) return new NextResponse("Forbidden", { status: 403 });
  if (doc.scan_status === "INFECTED") {
    return new NextResponse("This file is quarantined because a malware signature matched. Contact the Finance Manager.", { status: 451 });
  }
  if (malwareScanRequired() && doc.scan_status !== "CLEAN") {
    return new NextResponse("This file has not completed the required malware scan and cannot be downloaded.", { status: 423 });
  }

  let bytes: Buffer;
  try {
    bytes = await readDocument(doc.storage_key);
  } catch {
    return new NextResponse("Stored file is unavailable. Restore it from the document backup.", { status: 410 });
  }

  const inline = INLINE_SAFE.has(doc.mime);
  const safeName = doc.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document";
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": inline ? doc.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=60, no-transform",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
