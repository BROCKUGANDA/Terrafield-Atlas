import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, decodeCursor, encodeCursor, errorResponse, jsonResponse,
  paginationSchema, parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { FIRE_ARCHIVE_START } from '@/lib/fires/watchlist-engine';
import { isReevaluateInterval, nextRunAfter, REEVALUATE_INTERVALS } from '@/lib/schedule-core';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { resolveTenantContext, requirePermission, visibleWatchlistScope } from '@/lib/tenancy';

/**
 * GET  /api/v1/fires/watchlists — list watchlists with last evaluation state
 * POST /api/v1/fires/watchlists — create a regional fire watchlist
 */

const reevaluateSchema = z.union([z.null(), z.number().int()])
  .refine((value) => value === null || isReevaluateInterval(value), {
    message: `reevaluateIntervalMin must be null or one of ${REEVALUATE_INTERVALS.join(' | ')} minutes`,
  });

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  label: z.string().trim().max(120).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radiusKm: z.number().min(5).max(25).default(15),
  minConfidence: z.enum(['low', 'nominal', 'high']).default('nominal'),
  lookbackDays: z.number().int().min(3).max(30).default(7),
  detectionThreshold: z.number().int().min(1).max(500).default(5),
  notes: z.string().trim().max(300).optional(),
  reevaluateIntervalMin: reevaluateSchema.optional(),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const context = await resolveTenantContext(req);
  const lists = await db.fireWatchlist.findMany({
    where: visibleWatchlistScope(context),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = lists.slice(0, query.limit);
  const nextCursor = lists.length > query.limit ? encodeCursor(page[page.length - 1].id) : null;
  const ids = page.map((watchlist) => watchlist.id);
  const [lastEvents, counts] = ids.length
    ? await Promise.all([
        db.fireWatchEvent.findMany({
          where: { watchlistId: { in: ids } },
          orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
          distinct: ['watchlistId'],
        }),
        db.fireWatchEvent.groupBy({ by: ['watchlistId'], where: { watchlistId: { in: ids } }, _count: { _all: true } }),
      ])
    : [[], []];
  const latestByWatch = new Map(lastEvents.map((event) => [event.watchlistId, event]));
  const eventCountByWatch = new Map(counts.map((group) => [group.watchlistId, group._count._all]));
  const rows = page.map((watchlist) => ({
    ...serializeWatchlist(watchlist),
    eventCount: eventCountByWatch.get(watchlist.id) ?? 0,
    lastEvent: latestByWatch.has(watchlist.id) ? serializeEvent(latestByWatch.get(watchlist.id)!) : null,
  }));
  const summary = {
    total: rows.length,
    alerting: rows.filter((row) => row.lastStatus === 'alert').length,
    watch: rows.filter((row) => row.lastStatus === 'watch').length,
    clear: rows.filter((row) => row.lastStatus === 'clear').length,
    unverified: rows.filter((row) => row.lastStatus === 'unverified').length,
  };
  return jsonResponse({
    watchlists: rows,
    summary,
    nextCursor,
    note: `Statuses reflect the last recorded evaluation only. Live check: POST /api/v1/fires/watchlists/{id}/evaluate. VIIRS archive starts ${FIRE_ARCHIVE_START}.`,
    correlationId,
  }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/fires/watchlists', async (req, { userId }) => {
  const rl = await rateLimit(clientKey(req, 'watchlists:create'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.write');
  const duplicate = await db.fireWatchlist.findFirst({ where: { name: body.name, ownerId: userId, organizationId: context.organizationId } });
  if (duplicate) return errorResponse(400, 'VALIDATION_ERROR', `a watchlist named “${body.name}” already exists`, correlationId);

  const interval = body.reevaluateIntervalMin === undefined ? null : body.reevaluateIntervalMin;
  return {
    commit: async (tx) => {
      const created = await tx.fireWatchlist.create({ data: {
        ownerId: userId,
        organizationId: context.organizationId,
        name: body.name,
        label: body.label,
        lat: body.lat,
        lon: body.lon,
        radiusKm: body.radiusKm,
        minConfidence: body.minConfidence,
        lookbackDays: body.lookbackDays,
        detectionThreshold: body.detectionThreshold,
        notes: body.notes,
        lastStatus: 'unverified',
        reevaluateIntervalMin: interval,
        nextReevaluateAt: interval ? nextRunAfter(Date.now(), interval) : null,
      } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'watchlist.create',
        targetId: created.id,
        detail: JSON.stringify({ name: created.name, lat: created.lat, lon: created.lon, radiusKm: created.radiusKm, reevaluateIntervalMin: interval }),
        organizationId: context.organizationId,
        aggregateType: 'FireWatchlist',
        aggregateId: created.id,
        eventType: 'watchlist.created',
        payload: { watchlistId: created.id, ownerId: userId },
      });
      return jsonResponse({
        watchlist: serializeWatchlist(created),
        note: interval
          ? `Created as unverified — the first scheduled re-evaluation runs at ${created.nextReevaluateAt?.toISOString().slice(0, 16).replace('T', ' ')}Z.`
          : 'Created as unverified — evaluate it to query the real GIBS VIIRS record.',
      }, { status: 201, correlationId });
    },
  };
}));
