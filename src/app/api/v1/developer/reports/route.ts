import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { developerGuard, meterDeveloperRequest } from '@/lib/developer';

export const GET = apiHandler(async (req, { correlationId }) => {
  const guard = await developerGuard(req, 'reports.read');
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const rows = await db.reportRecord.findMany({
    where: guard.principal.organizationId ? { organizationId: guard.principal.organizationId } : { ownerId: guard.principal.userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  await meterDeveloperRequest(guard, correlationId);
  return jsonResponse({ reports: page.map((row) => ({ ...row, content: JSON.parse(row.contentJson), provenance: JSON.parse(row.provenanceJson) })), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].id) : null }, { correlationId, headers: { 'X-RateLimit-Remaining': String(guard.remaining) } });
});
