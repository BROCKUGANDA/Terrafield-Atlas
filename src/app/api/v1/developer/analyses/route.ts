import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { developerGuard, meterDeveloperRequest } from '@/lib/developer';
import { visibleTrendScope } from '@/lib/tenancy';

export const GET = apiHandler(async (req, { correlationId }) => {
  const guard = await developerGuard(req, 'analyses.read');
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const rows = await db.trendAnalysis.findMany({
    where: visibleTrendScope(guard.tenant),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  await meterDeveloperRequest(guard, correlationId);
  return jsonResponse({ analyses: page.map((row) => ({ ...row, result: JSON.parse(row.resultJson) })), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].id) : null }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining) } });
});
