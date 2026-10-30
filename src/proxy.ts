import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce for Next.js inline bootstrap scripts. Styles deliberately
 * retain 'unsafe-inline' because the existing UI uses inline style attributes,
 * which a style nonce cannot authorise. Report-only mode exists for rollout
 * verification; production enforcement is the default.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestId = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === "development";
  const reportOnly = (process.env.CSP_REPORT_ONLY ?? "").toLowerCase() === "true";
  const reportUri = process.env.CSP_REPORT_URI?.trim();
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (process.env.NODE_ENV === "production") directives.push("upgrade-insecure-requests");
  if (reportUri) directives.push(`report-uri ${reportUri}`);
  const value = directives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("Content-Security-Policy", value);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", value);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
