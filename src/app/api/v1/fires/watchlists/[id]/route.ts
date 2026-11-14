import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { isReevaluateInterval, nextRunAfter, REEVALUATE_INTERVALS } from '@/lib/schedule-core';

/**
 * GET    /api/v1/fires/watchlists/[id] — one watchlist + full event history
 * PATCH  /api/v1/fires/watchlists/[id] — edit rule parameters (name, radius,
 *         confidence floor, lookback, threshold, notes; location can move) and
 *         the scheduled re-evaluation cadence (reevaluateIntervalMin)
 * DELETE /api/v1/fires/watchlists/[id] — remove the watchlist (events cascade)
 */

type WatchCtx = { params: Promise<{ id: string }> };

// null = scheduled re-evaluation off; otherwise one of the supported cadences.
const reevaluateSchema = z
  .union([z.null(), z.number().int()])
  .refine((v) => v === null || isReevaluateInterval(v), {
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

export const GET = apiHandler<WatchCtx>(async (_req, { correlationId, params }) => {
  const { id } = await params;
  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }
  const events = await db.fireWatchEvent.findMany({ where: { watchlistId: id }, orderBy: { evaluatedAt: 'desc' }, take: 25 });
  return jsonResponse(
    { watchlist: serializeWatchlist(w), events: events.map(serializeEvent), correlationId },
    { correlationId },
  );
});

export const PATCH = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = rateLimit(clientKey(req, 'watchlists:update'), { capacity: 15, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (Object.keys(body).length === 0) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'no editable fields supplied', correlationId } }, { status: 400, correlationId });
  }
  const existing = await db.fireWatchlist.findUnique({ where: { id } });
  if (!existing) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }
  if (body.name && body.name !== existing.name) {
    const dupe = await db.fireWatchlist.findFirst({ where: { name: body.name } });
    if (dupe) {
      return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `a watchlist named “${body.name}” already exists`, correlationId } }, { status: 400, correlationId });
    }
  }
  // Cadence change: (re)arm the scheduler clock when enabling/changing, clear
  // it when switching off. Not a rule parameter — the stored status stays.
  const scheduleData =
    body.reevaluateIntervalMin === undefined
      ? {}
      : body.reevaluateIntervalMin === null
        ? { reevaluateIntervalMin: null, nextReevaluateAt: null }
        : { reevaluateIntervalMin: body.reevaluateIntervalMin, nextReevaluateAt: nextRunAfter(Date.now(), body.reevaluateIntervalMin) };
  const updated = await db.fireWatchlist.update({
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
      // rule parameters changed → the stored status no longer describes the rule
      ...(body.minConfidence !== undefined || body.lookbackDays !== undefined || body.detectionThreshold !== undefined || body.lat !== undefined || body.lon !== undefined || body.radiusKm !== undefined
        ? { lastStatus: 'unverified', lastDetectionCount: null }
        : {}),
    },
  });
  await db.auditEvent.create({
    data: { actor: 'demo-user', action: 'watchlist.update', targetId: id, detail: JSON.stringify(body) },
  });
  return jsonResponse({ watchlist: serializeWatchlist(updated), correlationId }, { correlationId });
});

export const DELETE = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = rateLimit(clientKey(req, 'watchlists:delete'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const existing = await db.fireWatchlist.findUnique({ where: { id } });
  if (!existing) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }
  await db.fireWatchlist.delete({ where: { id } }); // events cascade
  await db.auditEvent.create({
    data: { actor: 'demo-user', action: 'watchlist.delete', targetId: id, detail: JSON.stringify({ name: existing.name }) },
  });
  return jsonResponse({ deleted: { id, name: existing.name }, correlationId }, { correlationId });
});
