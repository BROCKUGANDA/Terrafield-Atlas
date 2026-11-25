import { z } from 'zod';
import { db } from '@/lib/db';
import { parseBoundaryGeoJson } from '@/lib/geo';
import {
  apiHandler, clientKey, decodeCursor, encodeCursor, errorResponse, jsonResponse,
  paginationSchema, parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { ensureSeeded } from '@/lib/seeds';
import { requirePermission, resolveTenantContext, visibleFarmScope } from '@/lib/tenancy';
import { assertEntitlement } from '@/lib/commercial';

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
  organizationId: z.string().max(128).optional(),
  workspaceId: z.string().max(128).optional(),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const rl = await rateLimit(clientKey(req, 'farms:list'), { capacity: 60, refillPerMinute: 60 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  await ensureSeeded();
  const context = await resolveTenantContext(req);
  const farms = await db.farm.findMany({
    where: visibleFarmScope(context),
    select: {
      id: true, name: true, country: true, region: true,
      centroidLat: true, centroidLon: true, areaHa: true,
      createdAt: true, updatedAt: true,
      _count: { select: { soilTests: true, scenarios: true, trendAnalyses: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = farms.slice(0, query.limit);
  const nextCursor = farms.length > query.limit ? encodeCursor(page[page.length - 1].id) : null;
  return jsonResponse({ farms: page, count: page.length, nextCursor }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/farms', async (req, { userId }) => {
  const rl = await rateLimit(clientKey(req, 'farms:create'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.write');
  await assertEntitlement(context, 'farms');
  if (body.organizationId && body.organizationId !== context.organizationId) {
    return errorResponse(403, 'ORGANIZATION_MISMATCH', 'organization does not match the active workspace', correlationId);
  }
  if (body.workspaceId) {
    if (!context.organizationId) return errorResponse(400, 'WORKSPACE_REQUIRES_ORGANIZATION', 'select an organization workspace', correlationId);
    const workspace = await db.workspace.findUnique({ where: { id: body.workspaceId }, select: { organizationId: true } });
    if (!workspace || workspace.organizationId !== context.organizationId) return errorResponse(404, 'NOT_FOUND', 'workspace not found', correlationId);
  }

  let centroidLat = body.centroidLat;
  let centroidLon = body.centroidLon;
  let areaHa = body.areaHa ?? null;
  let boundary: string | undefined;

  if (body.boundaryGeoJson) {
    const geo = parseBoundaryGeoJson(body.boundaryGeoJson);
    if (!geo.ok) {
      return errorResponse(400, 'INVALID_BOUNDARY', geo.reason, correlationId);
    }
    boundary = JSON.stringify(geo.geometry);
    centroidLat = geo.centroid.lat;
    centroidLon = geo.centroid.lon;
    areaHa = geo.areaHa;
  }

  return {
    commit: async (tx) => {
      const farm = await tx.farm.create({
        data: {
          ownerId: userId,
          organizationId: context.organizationId,
          workspaceId: body.workspaceId ?? null,
          name: body.name,
          country: body.country ?? null,
          region: body.region ?? null,
          centroidLat,
          centroidLon,
          boundaryGeoJson: boundary ?? null,
          areaHa,
          notes: body.notes ?? null,
          ownerLabel: body.ownerLabel ?? 'verified-user',
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'farm.create',
        targetId: farm.id,
        detail: `${body.name} @ ${centroidLat.toFixed(3)},${centroidLon.toFixed(3)}`,
        organizationId: context.organizationId,
        aggregateType: 'Farm',
        aggregateId: farm.id,
        eventType: 'farm.created',
        payload: { farmId: farm.id, ownerId: userId },
      });
      return jsonResponse({ farm }, { status: 201, correlationId });
    },
  };
}));
