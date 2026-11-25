import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { developerGuard, meterDeveloperRequest } from '@/lib/developer';
import { visibleFarmScope } from '@/lib/tenancy';

export const GET = apiHandler(async (req, { correlationId }) => {
  const guard = await developerGuard(req, 'farms.read');
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const farms = await db.farm.findMany({
    where: visibleFarmScope(guard.tenant),
    select: { id: true, name: true, country: true, region: true, centroidLat: true, centroidLon: true, areaHa: true, workspaceId: true, createdAt: true, updatedAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = farms.slice(0, query.limit);
  await meterDeveloperRequest(guard, correlationId);
  const res = jsonResponse({ farms: page, count: page.length, nextCursor: farms.length > query.limit ? encodeCursor(page[page.length - 1].id) : null }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining), 'X-RateLimit-Retry-After': String(guard.retryAfterSec) } });
  return res;
});
