import { db } from '@/lib/db';
import { apiHandler, decodeCursor, encodeCursor, jsonResponse, paginationSchema } from '@/lib/api/helpers';
import { resolveTenantContext, visibleTrendScope } from '@/lib/tenancy';
import type { ApiRequestLog } from '@prisma/client';

/**
 * GET /api/v1/provenance?analysisId=&limit=&cursor=
 * Evidence ledger. Unattributed provider logs remain withheld because they can
 * contain private coordinates; tenant-attributed trends are cursor paginated.
 */
export const GET = apiHandler(async (req, { correlationId }) => {
  const query = paginationSchema(100, 20).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const context = await resolveTenantContext(req);
  const logs: ApiRequestLog[] = context.organizationId
    ? await db.apiRequestLog.findMany({ where: { organizationId: context.organizationId }, orderBy: { retrievedAt: 'desc' }, take: 100 })
    : [];
  const sources = await db.dataSource.findMany({ orderBy: { datasetName: 'asc' }, take: 500 });
  const recentTrends = await db.trendAnalysis.findMany({
    where: visibleTrendScope(context),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
    select: {
      id: true, variable: true, lat: true, lon: true, farmId: true,
      periodStart: true, periodEnd: true, sampleCount: true, method: true,
      direction: true, significant: true, ruleVersion: true, createdAt: true,
    },
  });
  const page = recentTrends.slice(0, query.limit);
  const nextCursor = recentTrends.length > query.limit ? encodeCursor(page[page.length - 1].id) : null;
  const okCount = logs.filter((log) => log.ok).length;
  const byProvider: Record<string, { total: number; ok: number; failed: number; lastStatus: number | null; lastRetrievedAt: string | null }> = {};
  for (const log of logs) {
    const provider = (byProvider[log.provider] ??= { total: 0, ok: 0, failed: 0, lastStatus: null, lastRetrievedAt: null });
    provider.total++;
    if (log.ok) provider.ok++; else provider.failed++;
    provider.lastStatus = log.status;
    provider.lastRetrievedAt = log.retrievedAt.toISOString();
  }

  return jsonResponse({
    summary: { requestsLogged: logs.length, ok: okCount, failed: logs.length - okCount, byProvider },
    requestLog: logs.map((log) => ({
      id: log.id, provider: log.provider, datasetId: log.datasetId, operation: log.operation,
      requestUrl: log.requestUrl, status: log.status, responseBytes: log.responseBytes,
      ok: log.ok, errorDetail: log.errorDetail, correlationId: log.correlationId, retrievedAt: log.retrievedAt,
    })),
    sources,
    privacyNote: 'Unattributed request logs and job details are withheld until tenant ownership is supported.',
    recentTrendAnalyses: page,
    recentJobs: [],
    nextCursor,
    correlationId,
    methodologyPointer: 'Trend methodology: Seasonal Mann-Kendall + Theil-Sen slope with Sen-rank CI; Hamed-Rao correction; Benjamini-Hochberg FDR; ≥8 full years. Full text: /api/v1/system/status → methodology.',
  }, { correlationId });
});
