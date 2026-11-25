import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, decodeCursor, encodeCursor, isoDateSchema, jsonResponse, paginationSchema,
} from '@/lib/api/helpers';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';
import { visibleObservationScope, resolveTenantContext } from '@/lib/tenancy';

/**
 * GET /api/v1/observations?farmId=…&lat=&lon=&variable=&from=&to=
 * Returns REAL stored observations only. Empty result = nothing ingested yet.
 */

const querySchema = z.object({
  farmId: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  variable: z.enum(POWER_VARIABLES.map((value) => value.key) as [VariableKey, ...VariableKey[]]).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).merge(paginationSchema(10_000, 1_000))
  .refine((query) => !query.from || !query.to || query.from <= query.to, 'from must be on or before to');

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
  const { farmId, lat, lon, variable, from, to, cursor, limit } = query;

  const where: Record<string, unknown> = {};
  if (farmId) where.farmId = farmId;
  if (lat !== undefined) where.lat = lat;
  if (lon !== undefined) where.lon = lon;
  if (variable) where.variable = variable;
  if (from || to) {
    where.obsDate = {
      ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59Z`) } : {}),
    };
  }

  let effectiveLat = lat;
  let effectiveLon = lon;
  if (farmId && (effectiveLat === undefined || effectiveLon === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true } });
    if (farm) {
      effectiveLat ??= farm.centroidLat;
      effectiveLon ??= farm.centroidLon;
    }
  }

  const context = await resolveTenantContext(req);
  const rows = await db.environmentalObservation.findMany({
    where: {
      ...where,
      ...visibleObservationScope(context),
      ...(effectiveLat !== undefined && lat === undefined ? { lat: effectiveLat } : {}),
      ...(effectiveLon !== undefined && lon === undefined ? { lon: effectiveLon } : {}),
    },
    orderBy: [{ obsDate: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: decodeCursor(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].id) : null;

  const grouped: Record<string, { unit: string; points: { date: string; value: number | null }[] }> = {};
  for (const row of page) {
    const group = (grouped[row.variable] ??= { unit: row.unit, points: [] });
    const date = row.obsDate.toISOString().slice(0, 10);
    if (group.points.length === 0 || group.points[group.points.length - 1].date !== date) {
      group.points.push({ date, value: row.value });
    }
  }

  return jsonResponse({
    count: page.length,
    variables: Object.keys(grouped),
    datasetVersions: [...new Set(page.map((row) => row.datasetVersion))],
    firstRetrievedAt: page.length ? page[0].retrievedAt.toISOString() : null,
    nextCursor,
    provenanceNote: 'All values are real NASA POWER observations (MERRA-2 grid cell, LST time standard). Missing days are absent, never imputed.',
    series: grouped,
    ...(effectiveLat !== undefined ? { location: { lat: effectiveLat, lon: effectiveLon } } : {}),
  }, { correlationId });
});
