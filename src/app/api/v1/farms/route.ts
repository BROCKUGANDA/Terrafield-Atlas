import { z } from 'zod';
import { db } from '@/lib/db';
import { parseBoundaryGeoJson } from '@/lib/geo';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { ensureSeeded } from '@/lib/seeds';

/**
 * POST /api/v1/farms — create a farm (name + centroid; optional boundary GeoJSON)
 * GET  /api/v1/farms — list farms
 */

const createSchema = z.object({
  name: z.string().min(1).max(120),
  country: z.string().max(80).optional(),
  region: z.string().max(120).optional(),
  centroidLat: z.number().min(-90).max(90),
  centroidLon: z.number().min(-180).max(180),
  boundaryGeoJson: z.string().max(60_000).optional(),
  areaHa: z.number().positive().max(50_000).optional(),
  notes: z.string().max(2000).optional(),
  ownerLabel: z.string().max(120).optional(),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'farms:list'), { capacity: 60, refillPerMinute: 60 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  await ensureSeeded();
  const farms = await db.farm.findMany({
    select: {
      id: true, name: true, country: true, region: true,
      centroidLat: true, centroidLon: true, areaHa: true,
      createdAt: true, updatedAt: true,
      _count: { select: { soilTests: true, scenarios: true, trendAnalyses: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return jsonResponse({ farms, count: farms.length }, { correlationId });
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'farms:create'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let centroidLat = body.centroidLat;
  let centroidLon = body.centroidLon;
  let areaHa = body.areaHa ?? null;
  let boundary: string | undefined;

  if (body.boundaryGeoJson) {
    const geo = parseBoundaryGeoJson(body.boundaryGeoJson);
    if (!geo.ok) {
      return jsonResponse(
        { error: { code: 'INVALID_BOUNDARY', message: geo.reason, correlationId } },
        { status: 400, correlationId },
      );
    }
    boundary = JSON.stringify(geo.geometry);
    centroidLat = geo.centroid.lat;
    centroidLon = geo.centroid.lon;
    areaHa = geo.areaHa;
  }

  const farm = await db.farm.create({
    data: {
      name: body.name,
      country: body.country ?? null,
      region: body.region ?? null,
      centroidLat,
      centroidLon,
      boundaryGeoJson: boundary ?? null,
      areaHa,
      notes: body.notes ?? null,
      ownerLabel: body.ownerLabel ?? 'demo-user',
    },
  });
  await db.auditEvent.create({
    data: { actor: 'demo-user', action: 'farm.create', targetId: farm.id, detail: `${body.name} @ ${centroidLat.toFixed(3)},${centroidLon.toFixed(3)}` },
  });
  return jsonResponse({ farm }, { status: 201, correlationId });
});
