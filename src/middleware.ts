import { NextResponse, type NextRequest } from 'next/server';

/**
 * Nonce-based Content-Security-Policy in REPORT-ONLY mode.
 *
 * Next injects the nonce into its inline flight/bootstrap scripts when the
 * incoming request carries a `content-security-policy` header (the documented
 * App Router pattern). We issue the violation-reporting header only, so a
 * directive that is still too narrow cannot break serving while the reports
 * collected by `/api/v1/csp-report` prove the policy out.
 *
 * Promotion to enforcing is a separate, evidence-backed step: watch the
 * violation ledger in production, fix the directives it names, then switch the
 * response header from `Content-Security-Policy-Report-Only` to
 * `Content-Security-Policy`.
 */

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function middleware(request: NextRequest) {
  const value = nonce();
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${value}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://gibs.earthdata.nasa.gov https://eonet.gsfc.nasa.gov",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/v1/csp-report",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', value);
  // Next reads this request header to stamp its inline scripts with the nonce.
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy-Report-Only', policy);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|mjs|txt|xml|json|webmanifest)$).*)',
  ],
};
