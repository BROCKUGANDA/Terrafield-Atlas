import { NextRequest, NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { getCorrelationId } from '@/lib/correlation';

/**
 * Shared API plumbing: correlation IDs, structured errors, validation,
 * in-memory rate limiting.
 *
 * Rate limiting note (documented deviation): a single-process deployment uses
 * an in-memory token bucket. In a multi-instance deployment this must be
 * replaced by a shared store (e.g. Redis) — the interface stays identical.
 */

export function jsonResponse(data: unknown, init?: { status?: number; correlationId?: string; headers?: Record<string, string> }) {
  const res = NextResponse.json(data, { status: init?.status ?? 200 });
  if (init?.correlationId) res.headers.set('X-Correlation-Id', init.correlationId);
  for (const [k, v] of Object.entries(init?.headers ?? {})) res.headers.set(k, v);
  return res;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
) {
  return NextResponse.json(
    { error: { code, message, correlationId, ...(details !== undefined ? { details } : {}) } },
    { status, headers: { 'X-Correlation-Id': correlationId } },
  );
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<
  { ok: true; data: T } | { ok: false; res: NextResponse }
> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: errorResponse(400, 'INVALID_JSON', 'request body is not valid JSON', getCorrelationId(req.headers.get('x-correlation-id'))) };
  }
  try {
    return { ok: true, data: schema.parse(raw) };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        res: errorResponse(400, 'VALIDATION_ERROR', 'request body failed validation', getCorrelationId(req.headers.get('x-correlation-id')), err.issues),
      };
    }
    throw err;
  }
}

// --- rate limiting: token bucket per key ---
interface Bucket {
  tokens: number;
  lastRefill: number;
}
const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: { capacity: number; refillPerMinute: number },
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: limit.capacity, lastRefill: now };
  const elapsedMin = (now - b.lastRefill) / 60_000;
  b.tokens = Math.min(limit.capacity, b.tokens + elapsedMin * limit.refillPerMinute);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
  }
  buckets.set(key, b);
  const waitSec = Math.ceil((1 - b.tokens) / limit.refillPerMinute * 60);
  return { allowed: false, remaining: 0, retryAfterSec: waitSec };
}

export function clientKey(req: NextRequest, route: string): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  return `${ip}:${route}`;
}

export function rateLimitResponse(retryAfterSec: number, correlationId: string): NextResponse {
  const res = errorResponse(429, 'RATE_LIMITED', `too many requests; retry after ${retryAfterSec}s`, correlationId);
  res.headers.set('Retry-After', String(retryAfterSec));
  return res;
}

export function apiHandler<C = Record<string, unknown>>(
  fn: (req: NextRequest, ctx: { correlationId: string } & C) => Promise<NextResponse>,
) {
  return async (req: NextRequest, ctx?: C) => {
    const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
    try {
      return await fn(req, { ...(ctx as C), correlationId });
    } catch (err) {
      if (err instanceof ZodError) {
        return errorResponse(400, 'VALIDATION_ERROR', 'request failed validation', correlationId, err.issues);
      }
      const msg = err instanceof Error ? err.message : 'unexpected error';
      console.error(`[api:${req.nextUrl.pathname}]`, err);
      return errorResponse(500, 'INTERNAL_ERROR', msg, correlationId);
    }
  };
}
