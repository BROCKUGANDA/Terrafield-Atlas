import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';

/**
 * GET /api/v1/observations?farmId=…&lat=&lon=&variable=&from=&to=
 * Returns REAL stored observations only. Empty result = nothing ingested yet.
 */

const querySchema = z.object({
  farmId: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  variable: z.enum(POWER_VARIABLES.map((v) => v.key) as [VariableKey, ...VariableKey[]]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const q = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!q.success) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'invalid query parameters', details: q.error.issues, correlationId } }, { status: 400, correlationId });
  }
  const { farmId, lat, lon, variable, from, to } = q.data;

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

  // If farmId specified without lat/lon, use the farm centroid
  let effectiveLat = lat;
  let effectiveLon = lon;
  if (farmId && (effectiveLat === undefined || effectiveLon === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true } });
    if (farm) {
      effectiveLat ??= farm.centroidLat;
      effectiveLon ??= farm.centroidLon;
    }
  }

  const rows = await db.environmentalObservation.findMany({
    where: { ...where, ...(effectiveLat !== undefined && lat === undefined ? { lat: effectiveLat } : {}), ...(effectiveLon !== undefined && lon === undefined ? { lon: effectiveLon } : {}) },
    orderBy: { obsDate: 'asc' },
    take: 100_000,
  });

  // group by variable for a compact response
  const grouped: Record<string, { unit: string; points: { date: string; value: number | null }[] }> = {};
  for (const r of rows) {
    const g = (grouped[r.variable] ??= { unit: r.unit, points: [] });
    if (g.points.length === 0 || g.points[g.points.length - 1].date !== r.obsDate.toISOString().slice(0, 10)) {
      g.points.push({ date: r.obsDate.toISOString().slice(0, 10), value: r.value });
    }
  }

  const datasetVersions = [...new Set(rows.map((r) => r.datasetVersion))];
  const retrievedAts = rows.length ? new Date(rows[0].retrievedAt).toISOString() : null;

  return jsonResponse({
    count: rows.length,
    variables: Object.keys(grouped),
    datasetVersions,
    firstRetrievedAt: retrievedAts,
    provenanceNote: 'All values are real NASA POWER observations (MERRA-2 grid cell, LST time standard). Missing days are absent, never imputed.',
    series: grouped,
    ...(effectiveLat !== undefined ? { location: { lat: effectiveLat, lon: effectiveLon } } : {}),
  }, { correlationId });
});
