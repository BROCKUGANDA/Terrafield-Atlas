import { z } from 'zod';
import { db } from '@/lib/db';
import { parseBoundaryGeoJson } from '@/lib/geo';
import { apiHandler, jsonResponse, parseBody } from '@/lib/api/helpers';

/**
 * GET   /api/v1/farms/{farmId}
 * PATCH /api/v1/farms/{farmId} — update profile, boundary, crop history
 */

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  country: z.string().max(80).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  boundaryGeoJson: z.string().max(60_000).optional(),
  cropHistory: z
    .array(
      z.object({
        season: z.string().max(40),
        crop: z.string().max(80),
        family: z.string().max(80).optional(),
      }),
    )
    .max(40)
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

type FarmCtx = { params: Promise<{ farmId: string }> };

export const GET = apiHandler<{ params: Promise<{ farmId: string }> }>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  const farm = await db.farm.findUnique({
    where: { id: farmId },
    include: {
      soilTests: { orderBy: { measuredAt: 'desc' }, take: 50 },
      _count: { select: { scenarios: true, trendAnalyses: true, observations: true } },
    },
  });
  if (!farm) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
  }
  return jsonResponse({ farm }, { correlationId });
});

export const PATCH = apiHandler<FarmCtx>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const existing = await db.farm.findUnique({ where: { id: farmId } });
  if (!existing) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.country !== undefined) data.country = body.country;
  if (body.region !== undefined) data.region = body.region;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.cropHistory !== undefined) {
    // only crop names/families are stored; family is free text, the engine uses the catalogue for rules
    data.cropHistory = JSON.stringify(body.cropHistory);
  }
  if (body.boundaryGeoJson !== undefined) {
    if (body.boundaryGeoJson === '') {
      data.boundaryGeoJson = null;
    } else {
      const geo = parseBoundaryGeoJson(body.boundaryGeoJson);
      if (!geo.ok) {
        return jsonResponse({ error: { code: 'INVALID_BOUNDARY', message: geo.reason, correlationId } }, { status: 400, correlationId });
      }
      data.boundaryGeoJson = JSON.stringify(geo.geometry);
      data.centroidLat = geo.centroid.lat;
      data.centroidLon = geo.centroid.lon;
      data.areaHa = geo.areaHa;
    }
  }

  const farm = await db.farm.update({ where: { id: farmId }, data });
  await db.auditEvent.create({
    data: { actor: 'demo-user', action: 'farm.update', targetId: farmId, detail: `fields: ${Object.keys(data).join(',')}` },
  });
  return jsonResponse({ farm }, { correlationId });
});
