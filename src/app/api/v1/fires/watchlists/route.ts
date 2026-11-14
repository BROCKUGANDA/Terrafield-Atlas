import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { FIRE_ARCHIVE_START } from '@/lib/adapters/gibsFires';
import { watchThresholdFor, type WatchConfidence } from '@/lib/fires/watchlist-engine';

/**
 * GET  /api/v1/fires/watchlists — list watchlists with last evaluation state
 * POST /api/v1/fires/watchlists — create a regional fire watchlist
 *
 * The list read is database-only (no provider traffic): it reports the LAST
 * recorded evaluation. Live re-evaluation happens via
 * POST /api/v1/fires/watchlists/[id]/evaluate.
 */

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
});

export function serializeEvent(e: {
  id: string;
  evaluatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  status: string;
  detectionCount: number;
  highConfidenceCount: number;
  nominalCount: number;
  lowCount: number;
  maxFrpMW: number | null;
  daysWithDetections: number;
  daysChecked: number;
  daysNoData: number;
  triggeredAlert: boolean;
  detailJson: string;
}) {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(e.detailJson) as Record<string, unknown>;
  } catch {
    detail = {};
  }
  return {
    id: e.id,
    evaluatedAt: e.evaluatedAt.toISOString(),
    windowStart: e.windowStart.toISOString().slice(0, 10),
    windowEnd: e.windowEnd.toISOString().slice(0, 10),
    status: e.status,
    detectionCount: e.detectionCount,
    highConfidenceCount: e.highConfidenceCount,
    nominalCount: e.nominalCount,
    lowCount: e.lowCount,
    maxFrpMW: e.maxFrpMW,
    daysWithDetections: e.daysWithDetections,
    daysChecked: e.daysChecked,
    daysNoData: e.daysNoData,
    triggeredAlert: e.triggeredAlert,
    rationale: (detail.rationale as string) ?? '',
    daysNoDataList: (detail.daysNoData as string[]) ?? [],
    daysUnchecked: (detail.daysUnchecked as string[]) ?? [],
    perDay: (detail.perDay as { date: string; total: number; qualifying: number }[]) ?? [],
  };
}

export function serializeWatchlist(w: {
  id: string;
  name: string;
  label: string | null;
  lat: number;
  lon: number;
  radiusKm: number;
  minConfidence: string;
  lookbackDays: number;
  detectionThreshold: number;
  notes: string | null;
  lastStatus: string;
  lastDetectionCount: number | null;
  lastEvaluatedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: w.id,
    name: w.name,
    label: w.label,
    lat: w.lat,
    lon: w.lon,
    radiusKm: w.radiusKm,
    minConfidence: w.minConfidence as WatchConfidence,
    lookbackDays: w.lookbackDays,
    detectionThreshold: w.detectionThreshold,
    watchThreshold: watchThresholdFor(w.detectionThreshold),
    notes: w.notes,
    lastStatus: w.lastStatus,
    lastDetectionCount: w.lastDetectionCount,
    lastEvaluatedAt: w.lastEvaluatedAt ? w.lastEvaluatedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
  };
}

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
      note: `Statuses reflect the last recorded evaluation only (database read, no provider traffic). Live check: POST /api/v1/fires/watchlists/{id}/evaluate. VIIRS archive starts ${FIRE_ARCHIVE_START}.`,
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
    },
  });
  await db.auditEvent.create({
    data: {
      actor: 'demo-user',
      action: 'watchlist.create',
      targetId: created.id,
      detail: JSON.stringify({ name: created.name, lat: created.lat, lon: created.lon, radiusKm: created.radiusKm, minConfidence: created.minConfidence, lookbackDays: created.lookbackDays, detectionThreshold: created.detectionThreshold }),
    },
  });
  return jsonResponse(
    { watchlist: serializeWatchlist(created), note: 'Created as unverified — evaluate it to query the real GIBS VIIRS record for the window.' },
    { status: 201, correlationId },
  );
});
