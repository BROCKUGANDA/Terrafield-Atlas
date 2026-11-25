import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError, type ZodType } from 'zod';
import { Prisma } from '@prisma/client';
import { getCorrelationId } from '@/lib/correlation';
import { accountApiGuard, AccountAccessError, requireVerifiedWriter } from '@/lib/account-access';
import { BodyTooLargeError, IDEMPOTENCY_KEY_PATTERN, readBoundedText } from '@/lib/account-security';
import { canonicalJson, redisRuntime, RedisUnavailableError, stableHash } from '@/lib/redis';
import { db } from '@/lib/db';
import { withTenantContext } from '@/lib/tenant-db';
import { resolveTenantContext } from '@/lib/tenancy';
import { appMetrics, normalizeMetricPath } from '@/lib/metrics';

/**
 * Shared API plumbing: correlation IDs, structured errors, bounded validation,
 * durable idempotency, and Redis-backed rate limiting.
 */

export function jsonResponse(data: unknown, init?: { status?: number; correlationId?: string; headers?: Record<string, string> }) {
  const res = NextResponse.json(data, { status: init?.status ?? 200 });
  res.headers.set('Cache-Control', 'private, no-store');
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
    { status, headers: { 'X-Correlation-Id': correlationId, 'Cache-Control': 'private, no-store' } },
  );
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<
  { ok: true; data: T } | { ok: false; res: NextResponse }
> {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  let text: string;
  try {
    text = await readBoundedText(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { ok: false, res: errorResponse(413, 'PAYLOAD_TOO_LARGE', err.message, correlationId) };
    }
    return { ok: false, res: errorResponse(400, 'INVALID_JSON', 'request body is not valid UTF-8 JSON', correlationId) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, res: errorResponse(400, 'INVALID_JSON', 'request body is not valid JSON', correlationId) };
  }
  try {
    return { ok: true, data: schema.parse(raw) };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        res: errorResponse(400, 'VALIDATION_ERROR', 'request body failed validation', correlationId, err.issues),
      };
    }
    throw err;
  }
}

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'must be a real calendar date');

export const dateRangeSchema = z.object({ from: isoDateSchema, to: isoDateSchema })
  .refine((value) => value.from <= value.to, 'from must be on or before to');

/** Bound the raw array first, then remove duplicates while preserving order. */
export function dedupedBoundedArray<T>(item: z.ZodType<T>, max: number, min = 0) {
  return z.array(item).max(max).transform((values) => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const identity = typeof value === 'object' && value !== null ? canonicalJson(value) : JSON.stringify(value);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }).refine((values) => values.length >= min);
}

const CURSOR_PREFIX = 'v1.';
export function encodeCursor(id: string): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url')}`;
}

export function decodeCursor(cursor: string): string {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error('invalid cursor');
  const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || !('id' in decoded) || typeof decoded.id !== 'string' || !decoded.id || decoded.id.length > 128) {
    throw new Error('invalid cursor');
  }
  return decoded.id;
}

export function paginationSchema(maxLimit = 100, defaultLimit = 50) {
  return z.object({
    cursor: z.string().max(600).optional().refine((value) => {
      if (value === undefined) return true;
      try { decodeCursor(value); return true; } catch { return false; }
    }),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  });
}

export interface IdempotencyContext {
  userId: string;
  correlationId: string;
  key: string;
  requestHash: string;
}

export interface MutationPlan {
  commit: (tx: Prisma.TransactionClient) => Promise<NextResponse>;
}

export type IdempotencyHandler = (req: NextRequest, context: IdempotencyContext) => Promise<NextResponse | MutationPlan>;

export interface IdempotencyOptions {
  /** Revalidate live authorization before any stored response can be replayed. */
  authorize?: (req: NextRequest, userId: string) => Promise<NextResponse | void>;
  /** Persist a safe replay body while returning the full initial response once. */
  redactReplay?: (body: unknown) => unknown;
}

interface StoredResponse {
  status: number;
  body: unknown;
  correlationId: string;
}

class MutationResponseError extends Error {
  constructor(public readonly response: NextResponse) { super('mutation returned an error response'); }
}

export function redactOneTimeSecret(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('secret' in body)) return body;
  const { secret: _secret, ...safe } = body as Record<string, unknown>;
  return { ...safe, note: 'Secret was shown only on the initial creation response.' };
}

function replayResponse(record: { responseRef: string; requestHash: string }, requestHash: string, correlationId: string): NextResponse {
  if (record.requestHash !== requestHash) {
    return errorResponse(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different request', correlationId);
  }
  const stored = JSON.parse(record.responseRef) as StoredResponse;
  const response = jsonResponse(stored.body, { status: stored.status, correlationId: stored.correlationId });
  response.headers.set('Idempotency-Replayed', 'true');
  return response;
}

/**
 * Durable tenant/route/key replay boundary. Preparation (including provider
 * calls) happens before the transaction. A MutationPlan commits domain writes,
 * audit/outbox effects, and the response reference in one serializable transaction.
 */
export async function withIdempotency(req: NextRequest, route: string, handler: IdempotencyHandler, options: IdempotencyOptions = {}): Promise<NextResponse> {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  const userId = await requireVerifiedWriter(req);
  const key = req.headers.get('idempotency-key')?.trim();
  if (!key) return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', correlationId);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–128 URL-safe characters', correlationId);
  }
  const denied = await options.authorize?.(req, userId);
  if (denied) return denied;
  let rawBody: string;
  try {
    rawBody = await readBoundedText(req.clone());
  } catch (err) {
    if (err instanceof BodyTooLargeError) return errorResponse(413, 'PAYLOAD_TOO_LARGE', err.message, correlationId);
    return errorResponse(400, 'INVALID_JSON', 'request body is not valid UTF-8 JSON', correlationId);
  }
  let fingerprintBody: unknown = rawBody;
  try { fingerprintBody = rawBody ? JSON.parse(rawBody) : null; } catch { /* hash malformed bytes for conflict detection */ }
  const url = new URL(req.url);
  const requestHash = stableHash(canonicalJson({
    method: req.method,
    path: url.pathname,
    query: [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    body: fingerprintBody,
  }));
  const where = { ownerId_route_key: { ownerId: userId, route, key } };
  const existing = await db.idempotencyRecord.findUnique({ where });
  if (existing) return replayResponse(existing, requestHash, correlationId);

  const outcome = await handler(req, { userId, correlationId, key, requestHash });
  if (outcome instanceof NextResponse) {
    if (!outcome.ok) return outcome;
    const body = await outcome.clone().json();
    const stored: StoredResponse = { status: outcome.status, body: options.redactReplay ? options.redactReplay(body) : body, correlationId };
    try {
      await db.idempotencyRecord.create({ data: { ownerId: userId, route, key, requestHash, responseRef: JSON.stringify(stored) } });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      const raced = await db.idempotencyRecord.findUniqueOrThrow({ where });
      return replayResponse(raced, requestHash, correlationId);
    }
    return outcome;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const raced = await tx.idempotencyRecord.findUnique({ where });
        if (raced) return replayResponse(raced, requestHash, correlationId);
        const response = await outcome.commit(tx);
        if (!response.ok) throw new MutationResponseError(response);
        const body = await response.clone().json();
        const stored: StoredResponse = { status: response.status, body: options.redactReplay ? options.redactReplay(body) : body, correlationId };
        await tx.idempotencyRecord.create({ data: { ownerId: userId, route, key, requestHash, responseRef: JSON.stringify(stored) } });
        return response;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof MutationResponseError) return error.response;
      if ((error as { code?: string })?.code === 'P2034' && attempt < 2) continue;
      if ((error as { code?: string })?.code === 'P2002') {
        const raced = await db.idempotencyRecord.findUnique({ where });
        if (raced) return replayResponse(raced, requestHash, correlationId);
      }
      throw error;
    }
  }
  throw new Error('serializable mutation retry exhausted');
}

/** Audit and outbox are always written through the same transaction client as the domain row. */
export async function writeMutationEffects(
  tx: Prisma.TransactionClient,
  input: {
    actor: string;
    action: string;
    targetId: string;
    detail?: string;
    organizationId?: string | null;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload?: unknown;
  },
): Promise<void> {
  await tx.auditEvent.create({ data: {
    actor: input.actor,
    action: input.action,
    targetId: input.targetId,
    detail: input.detail,
    organizationId: input.organizationId ?? null,
  } });
  await tx.outboxEvent.create({ data: {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: JSON.stringify({ ...(input.payload && typeof input.payload === 'object' ? input.payload : {}), organizationId: input.organizationId ?? null }),
  } });
}

// --- rate limiting: atomic Redis token bucket per canonical key ---
export async function rateLimit(
  key: string,
  limit: { capacity: number; refillPerMinute: number },
): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  return redisRuntime().tokenBucket(`rate:${key}`, limit);
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

export function apiHandler<C = { params: Promise<Record<string, string | string[] | undefined>> }>(
  fn: (req: NextRequest, ctx: { correlationId: string } & C) => Promise<NextResponse>,
) {
  return async (req: NextRequest, ctx: C = {} as C) => {
    const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
    const startedAt = Date.now();
    let measuredStatus = 500;
    try {
      return await withTenantContext(await resolveTenantContext(req).catch(() => null), async () => {
        const params = await (ctx as { params?: Promise<Record<string, unknown>> } | undefined)?.params;
        await accountApiGuard(req, params);
        const response = await fn(req, { ...(ctx as C), correlationId });
        if (!response.headers.has('X-Correlation-Id')) response.headers.set('X-Correlation-Id', correlationId);
        const cacheControl = response.headers.get('Cache-Control');
        if (!cacheControl) {
          response.headers.set('Cache-Control', 'private, no-store');
        } else if (!cacheControl.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store')) {
          response.headers.set('Cache-Control', `${cacheControl}, no-store`);
        }
        measuredStatus = response.status;
        return response;
      });
    } catch (err) {
      let response: NextResponse;
      if (err instanceof AccountAccessError) response = errorResponse(err.status, err.code, err.message, correlationId);
      else if (err instanceof BodyTooLargeError) response = errorResponse(413, 'PAYLOAD_TOO_LARGE', err.message, correlationId);
      else if (err instanceof RedisUnavailableError) response = errorResponse(503, 'RUNTIME_UNAVAILABLE', 'shared runtime is temporarily unavailable', correlationId);
      else if (err instanceof ZodError) response = errorResponse(400, 'VALIDATION_ERROR', 'request failed validation', correlationId, err.issues);
      else if ((err as { code?: string })?.code === 'P2002') response = errorResponse(409, 'CONFLICT', 'the requested state conflicts with an existing record', correlationId);
      else {
        console.error(`[api:${req.nextUrl.pathname}]`, err);
        response = errorResponse(500, 'INTERNAL_ERROR', 'unexpected server error', correlationId);
      }
      measuredStatus = response.status;
      return response;
    } finally {
      const labels = { method: req.method, route: normalizeMetricPath(req.nextUrl.pathname), status: String(measuredStatus) };
      appMetrics.increment('terrafield_http_requests_total', labels);
      appMetrics.observe('terrafield_http_request_duration_ms', Date.now() - startedAt, labels);
    }
  };
}
