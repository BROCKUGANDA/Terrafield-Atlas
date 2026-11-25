import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, errorResponse, jsonResponse, paginationSchema,
  parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { isReevaluateInterval, nextRunAfter, REEVALUATE_INTERVALS } from '@/lib/schedule-core';
import { canReadResource, requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * GET    /api/v1/fires/watchlists/[id]
 * PATCH  /api/v1/fires/watchlists/[id]
 * DELETE /api/v1/fires/watchlists/[id]
 */

type WatchCtx = { params: Promise<{ id: string }> };

const reevaluateSchema = z.union([z.null(), z.number().int()])
  .refine((value) => value === null || isReevaluateInterval(value), {
    message: `reevaluateIntervalMin must be null or one of ${REEVALUATE_INTERVALS.join(' | ')} minutes`,
  });

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  label: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(5).max(25).optional(),
  minConfidence: z.enum(['low', 'nominal', 'high']).optional(),
  lookbackDays: z.number().int().min(3).max(30).optional(),
  detectionThreshold: z.number().int().min(1).max(500).optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  reevaluateIntervalMin: reevaluateSchema.optional(),
});

export const GET = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  paginationSchema(100, 25).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const context = await resolveTenantContext(req);
  const watchlist = await db.fireWatchlist.findUnique({ where: { id } });
  if (!watchlist || !canReadResource(context, watchlist)) return errorResponse(404, 'NOT_FOUND', `watchlist ${id} not found`, correlationId);
  const events = await db.fireWatchEvent.findMany({ where: { watchlistId: id }, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }], take: 25 });
  return jsonResponse({ watchlist: serializeWatchlist(watchlist), events: events.map(serializeEvent), correlationId }, { correlationId });
});

export const PATCH = apiHandler<WatchCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/fires/watchlists/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const rl = await rateLimit(clientKey(req, 'watchlists:update'), { capacity: 15, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.write');
  if (Object.keys(body).length === 0) return errorResponse(400, 'VALIDATION_ERROR', 'no editable fields supplied', correlationId);
  const existing = await db.fireWatchlist.findUnique({ where: { id } });
  if (!existing) return errorResponse(404, 'NOT_FOUND', `watchlist ${id} not found`, correlationId);
  if (body.name && body.name !== existing.name) {
    const duplicate = await db.fireWatchlist.findFirst({ where: { name: body.name, ownerId: existing.ownerId, organizationId: existing.organizationId, id: { not: id } } });
    if (duplicate) return errorResponse(400, 'VALIDATION_ERROR', `a watchlist named “${body.name}” already exists`, correlationId);
  }
  const scheduleData = body.reevaluateIntervalMin === undefined
    ? {}
    : body.reevaluateIntervalMin === null
      ? { reevaluateIntervalMin: null, nextReevaluateAt: null }
      : { reevaluateIntervalMin: body.reevaluateIntervalMin, nextReevaluateAt: nextRunAfter(Date.now(), body.reevaluateIntervalMin) };
  return {
    commit: async (tx) => {
      const updated = await tx.fireWatchlist.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.label !== undefined ? { label: body.label ?? null } : {}),
          ...(body.lat !== undefined ? { lat: body.lat } : {}),
          ...(body.lon !== undefined ? { lon: body.lon } : {}),
          ...(body.radiusKm !== undefined ? { radiusKm: body.radiusKm } : {}),
          ...(body.minConfidence !== undefined ? { minConfidence: body.minConfidence } : {}),
          ...(body.lookbackDays !== undefined ? { lookbackDays: body.lookbackDays } : {}),
          ...(body.detectionThreshold !== undefined ? { detectionThreshold: body.detectionThreshold } : {}),
          ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
          ...scheduleData,
          ...(body.minConfidence !== undefined || body.lookbackDays !== undefined || body.detectionThreshold !== undefined || body.lat !== undefined || body.lon !== undefined || body.radiusKm !== undefined
            ? { lastStatus: 'unverified', lastDetectionCount: null }
            : {}),
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'watchlist.update',
        targetId: id,
        detail: JSON.stringify(body),
        organizationId: context.organizationId,
        aggregateType: 'FireWatchlist',
        aggregateId: id,
        eventType: 'watchlist.updated',
        payload: { watchlistId: id, ownerId: userId, fields: Object.keys(body) },
      });
      return jsonResponse({ watchlist: serializeWatchlist(updated), correlationId }, { correlationId });
    },
  };
}));

export const DELETE = apiHandler<WatchCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/fires/watchlists/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const rl = await rateLimit(clientKey(req, 'watchlists:delete'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const existing = await db.fireWatchlist.findUnique({ where: { id } });
  if (!existing) return errorResponse(404, 'NOT_FOUND', `watchlist ${id} not found`, correlationId);
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.write');
  return {
    commit: async (tx) => {
      await tx.fireWatchlist.delete({ where: { id } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'watchlist.delete',
        targetId: id,
        detail: JSON.stringify({ name: existing.name }),
        organizationId: context.organizationId,
        aggregateType: 'FireWatchlist',
        aggregateId: id,
        eventType: 'watchlist.deleted',
        payload: { watchlistId: id, ownerId: userId, name: existing.name },
      });
      return jsonResponse({ deleted: { id, name: existing.name }, correlationId }, { correlationId });
    },
  };
}));
