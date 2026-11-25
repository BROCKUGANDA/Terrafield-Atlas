import { NextResponse } from 'next/server';

/**
 * Enforced Content-Security-Policy.
 *
 * The console is pre-rendered (App Router static output), so Next's inline
 * flight/bootstrap scripts cannot carry a per-request nonce: middleware headers
 * do not reach the static HTML. A nonce policy in enforcement mode would block
 * every script. The enforced policy therefore allows inline scripts
 * (`'unsafe-inline'`) while locking down every other vector: external script and
 * style origins, objects, base-uri, form targets, framing, workers and image
 * origins. JSON/telemetry violations still flow to `/api/v1/csp-report`.
 *
 * Tightening to a nonce policy requires opting the console into dynamic
 * rendering, which trades static delivery for a stronger script source list.
 */

export function middleware() {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
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

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|mjs|txt|xml|json|webmanifest)$).*)',
  ],
};
