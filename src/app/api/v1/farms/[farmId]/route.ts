import { z } from 'zod';
import { db } from '@/lib/db';
import { parseBoundaryGeoJson } from '@/lib/geo';
import {
  apiHandler, dedupedBoundedArray, errorResponse, jsonResponse, paginationSchema,
  parseBody, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * GET   /api/v1/farms/{farmId}
 * PATCH /api/v1/farms/{farmId} — update profile, boundary, crop history
 */

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  country: z.string().max(80).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  boundaryGeoJson: z.string().max(60_000).optional(),
  cropHistory: dedupedBoundedArray(z.object({
    season: z.string().max(40),
    crop: z.string().max(80),
    family: z.string().max(80).optional(),
  }), 40).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

type FarmCtx = { params: Promise<{ farmId: string }> };

export const GET = apiHandler<FarmCtx>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const farm = await db.farm.findUnique({
    where: { id: farmId },
    include: {
      soilTests: { orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }], take: 50 },
      _count: { select: { scenarios: true, trendAnalyses: true, observations: true } },
    },
  });
  if (!farm) {
    return errorResponse(404, 'NOT_FOUND', `farm ${farmId} not found`, correlationId);
  }
  return jsonResponse({ farm }, { correlationId });
});

export const PATCH = apiHandler<FarmCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/farms/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { farmId } = await params;
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.write');

  const existing = await db.farm.findUnique({ where: { id: farmId } });
  if (!existing) {
    return errorResponse(404, 'NOT_FOUND', `farm ${farmId} not found`, correlationId);
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.country !== undefined) data.country = body.country;
  if (body.region !== undefined) data.region = body.region;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.cropHistory !== undefined) {
    // Only crop names/families are stored; the catalogue supplies agronomic rules.
    data.cropHistory = JSON.stringify(body.cropHistory);
  }
  if (body.boundaryGeoJson !== undefined) {
    if (body.boundaryGeoJson === '') {
      data.boundaryGeoJson = null;
    } else {
      const geo = parseBoundaryGeoJson(body.boundaryGeoJson);
      if (!geo.ok) return errorResponse(400, 'INVALID_BOUNDARY', geo.reason, correlationId);
      data.boundaryGeoJson = JSON.stringify(geo.geometry);
      data.centroidLat = geo.centroid.lat;
      data.centroidLon = geo.centroid.lon;
      data.areaHa = geo.areaHa;
    }
  }

  return {
    commit: async (tx) => {
      const farm = await tx.farm.update({ where: { id: farmId }, data });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'farm.update',
        targetId: farmId,
        detail: `fields: ${Object.keys(data).join(',')}`,
        organizationId: context.organizationId,
        aggregateType: 'Farm',
        aggregateId: farmId,
        eventType: 'farm.updated',
        payload: { farmId, ownerId: userId, fields: Object.keys(data) },
      });
      return jsonResponse({ farm }, { correlationId });
    },
  };
}));
