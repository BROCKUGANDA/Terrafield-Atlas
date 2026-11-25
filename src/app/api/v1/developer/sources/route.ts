import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { developerGuard, meterDeveloperRequest } from '@/lib/developer';

export const GET = apiHandler(async (req, { correlationId }) => {
  const guard = await developerGuard(req, 'sources.read');
  const sources = await db.dataSource.findMany({ orderBy: { datasetName: 'asc' }, take: 500 });
  await meterDeveloperRequest(guard, correlationId);
  return jsonResponse({ sources }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining) } });
});
