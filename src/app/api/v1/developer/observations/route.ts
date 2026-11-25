import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, isoDateSchema, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { meterDeveloperRequest, runDeveloper } from '@/lib/developer';
import { visibleObservationScope } from '@/lib/tenancy';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';

const querySchema = z.object({
  farmId: z.string().max(128).optional(),
  variable: z.enum(POWER_VARIABLES.map((value) => value.key) as [VariableKey, ...VariableKey[]]).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).merge(paginationSchema(10_000, 1_000)).refine((value) => !value.from || !value.to || value.from <= value.to);

export const GET = apiHandler((req, { correlationId }) => runDeveloper(req, 'observations.read', async (guard) => {
  const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const rows = await db.environmentalObservation.findMany({
    where: {
      ...visibleObservationScope(guard.tenant),
      ...(query.farmId ? { farmId: query.farmId } : {}),
      ...(query.variable ? { variable: query.variable } : {}),
      ...(query.from || query.to ? { obsDate: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59Z`) } : {}) } } : {}),
    },
    orderBy: [{ obsDate: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  await meterDeveloperRequest(guard, correlationId);
  return jsonResponse({
    observations: page.map((row) => ({ id: row.id, farmId: row.farmId, lat: row.lat, lon: row.lon, variable: row.variable, date: row.obsDate.toISOString().slice(0, 10), value: row.value, unit: row.unit, sourceProvider: row.sourceProvider, datasetVersion: row.datasetVersion, retrievedAt: row.retrievedAt })),
    count: page.length,
    nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].id) : null,
  }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining) } });
}));
