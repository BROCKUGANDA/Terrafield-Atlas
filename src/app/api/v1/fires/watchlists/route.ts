import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { FIRE_ARCHIVE_START } from '@/lib/fires/watchlist-engine';
import { isReevaluateInterval, nextRunAfter, REEVALUATE_INTERVALS } from '@/lib/schedule-core';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';

/**
 * GET  /api/v1/fires/watchlists — list watchlists with last evaluation state
 * POST /api/v1/fires/watchlists — create a regional fire watchlist
 *
 * The list read is database-only (no provider traffic): it reports the LAST
 * recorded evaluation. Live re-evaluation happens via
 * POST /api/v1/fires/watchlists/[id]/evaluate; a watchlist can also opt into
 * scheduled re-evaluation (reevaluateIntervalMin, in-process scheduler).
 */

// null (or absent) = manual only; otherwise one of the supported cadences.
const reevaluateSchema = z
  .union([z.null(), z.number().int()])
  .refine((v) => v === null || isReevaluateInterval(v), {
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

// Serializers live in lib/fires/watchlist-serialize.ts (shared with the
// evaluation core); re-exported here for backward-compatible import paths.
export { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';

export const GET = apiHandler(async (_req, { correlationId }) => {
  const lists = await db.fireWatchlist.findMany({ orderBy: { createdAt: 'asc' } });
  const ids = lists.map((w) => w.id);
  const lastEvents = ids.length
    ? await db.fireWatchEvent.findMany({
        where: { watchlistId: { in: ids } },
        orderBy: { evaluatedAt: 'desc' },
      })
    : [];
  const latestByWatch = new Map<string, (typeof lastEvents)[number]>();
  const eventCountByWatch = new Map<string, number>();
  for (const e of lastEvents) {
    if (!latestByWatch.has(e.watchlistId)) latestByWatch.set(e.watchlistId, e);
    eventCountByWatch.set(e.watchlistId, (eventCountByWatch.get(e.watchlistId) ?? 0) + 1);
  }
  const rows = lists.map((w) => ({
    ...serializeWatchlist(w),
    eventCount: eventCountByWatch.get(w.id) ?? 0,
    lastEvent: latestByWatch.has(w.id) ? serializeEvent(latestByWatch.get(w.id)!) : null,
  }));
  const summary = {
    total: rows.length,
    alerting: rows.filter((r) => r.lastStatus === 'alert').length,
    watch: rows.filter((r) => r.lastStatus === 'watch').length,
    clear: rows.filter((r) => r.lastStatus === 'clear').length,
    unverified: rows.filter((r) => r.lastStatus === 'unverified').length,
  };
  return jsonResponse(
    {
      watchlists: rows,
      summary,
      note: `Statuses reflect the last recorded evaluation only (database read, no provider traffic). Live check: POST /api/v1/fires/watchlists/{id}/evaluate (body { end } backtests any historical window). Watchlists with reevaluateIntervalMin set are re-evaluated automatically by the in-process scheduler. VIIRS archive starts ${FIRE_ARCHIVE_START}.`,
      correlationId,
    },
    { correlationId },
  );
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'watchlists:create'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const duplicate = await db.fireWatchlist.findFirst({ where: { name: body.name } });
  if (duplicate) {
    return jsonResponse(
      { error: { code: 'VALIDATION_ERROR', message: `a watchlist named “${body.name}” already exists`, correlationId } },
      { status: 400, correlationId },
    );
  }

  const interval = body.reevaluateIntervalMin === undefined ? null : body.reevaluateIntervalMin;
  const created = await db.fireWatchlist.create({
    data: {
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
    },
  });
  await db.auditEvent.create({
    data: {
      actor: 'demo-user',
      action: 'watchlist.create',
      targetId: created.id,
      detail: JSON.stringify({ name: created.name, lat: created.lat, lon: created.lon, radiusKm: created.radiusKm, minConfidence: created.minConfidence, lookbackDays: created.lookbackDays, detectionThreshold: created.detectionThreshold, reevaluateIntervalMin: interval }),
    },
  });
  return jsonResponse(
    {
      watchlist: serializeWatchlist(created),
      note: interval
        ? `Created as unverified — the first scheduled re-evaluation runs at ${created.nextReevaluateAt?.toISOString().slice(0, 16).replace('T', ' ')}Z; evaluate manually any time before that.`
        : 'Created as unverified — evaluate it to query the real GIBS VIIRS record for the window.',
    },
    { status: 201, correlationId },
  );
});
