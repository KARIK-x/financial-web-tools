import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { getDb, one } from "@/server/db";
import { getDocument } from "@/server/documents";
import { readDocument } from "@/server/storage";
import { can } from "@/lib/permissions";

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

  const access = await one<{ uploaded_by: string | null; claimant: string | null }>(
    db,
    `SELECT d.uploaded_by, c.claimant_user_id AS claimant
       FROM documents d LEFT JOIN expense_claims c ON c.id = d.claim_id WHERE d.id = $1`,
    [id],
  );
  const allowed = can(user.role, "document.view.all", user.permissions)
    || access?.uploaded_by === user.id
    || (access?.claimant != null && access.claimant === user.id);
  if (!allowed) return new NextResponse("Forbidden", { status: 403 });

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
