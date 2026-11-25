import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { meterDeveloperRequest, runDeveloper } from '@/lib/developer';

export const GET = apiHandler((req, { correlationId }) => runDeveloper(req, 'sources.read', async (guard) => {
  const sources = await db.dataSource.findMany({ orderBy: { datasetName: 'asc' }, take: 500 });
  await meterDeveloperRequest(guard, correlationId);
  return jsonResponse({ sources }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining) } });
}));
