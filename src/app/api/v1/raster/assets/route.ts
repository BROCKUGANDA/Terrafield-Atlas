import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { resolveTenantContext } from '@/lib/tenancy';

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.userId) return jsonResponse({ assets: [] }, { correlationId });
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const rows = await db.rasterAsset.findMany({
    where: context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  return jsonResponse({
    assets: page.map((asset) => ({ ...asset, stats: JSON.parse(asset.statsJson), lineage: JSON.parse(asset.lineageJson) })),
    nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].id) : null,
  }, { correlationId });
});
