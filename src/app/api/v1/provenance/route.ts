import { db } from '@/lib/db';
import { jsonResponse } from '@/lib/api/helpers';

/**
 * GET /api/v1/provenance?analysisId=
 * The evidence ledger: every external API request the platform has made
 * (success or failure), the data-source register, and recent analyses with
 * their input references. This is what makes every number in the product
 * traceable to a source and a retrieval timestamp.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50);
  const providerFilter = url.searchParams.get('provider') ?? undefined;

  const logs = await db.apiRequestLog.findMany({
    where: providerFilter ? { provider: providerFilter } : undefined,
    orderBy: { retrievedAt: 'desc' },
    take: limit,
  });
  const sources = await db.dataSource.findMany({ orderBy: { datasetName: 'asc' } });
  const recentTrends = await db.trendAnalysis.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, variable: true, lat: true, lon: true, farmId: true,
      periodStart: true, periodEnd: true, sampleCount: true, method: true,
      direction: true, significant: true, ruleVersion: true, createdAt: true,
    },
  });
  const recentJobs = await db.processingJob.findMany({
    orderBy: { startedAt: 'desc' },
    take: 10,
    select: { id: true, type: true, status: true, progressNote: true, error: true, startedAt: true, finishedAt: true },
  });

  const okCount = logs.filter((l) => l.ok).length;
  const byProvider: Record<string, { total: number; ok: number; failed: number; lastStatus: number | null; lastRetrievedAt: string | null }> = {};
  for (const l of logs) {
    const p = (byProvider[l.provider] ??= { total: 0, ok: 0, failed: 0, lastStatus: null, lastRetrievedAt: null });
    p.total++;
    if (l.ok) p.ok++;
    else p.failed++;
    p.lastStatus = l.status;
    p.lastRetrievedAt = l.retrievedAt.toISOString();
  }

  return jsonResponse({
    summary: {
      requestsLogged: logs.length,
      ok: okCount,
      failed: logs.length - okCount,
      byProvider,
    },
    requestLog: logs.map((l) => ({
      id: l.id,
      provider: l.provider,
      datasetId: l.datasetId,
      operation: l.operation,
      requestUrl: l.requestUrl,
      status: l.status,
      latencyMs: l.latencyMs,
      responseBytes: l.responseBytes,
      ok: l.ok,
      errorDetail: l.errorDetail,
      correlationId: l.correlationId,
      retrievedAt: l.retrievedAt,
    })),
    sources,
    recentTrendAnalyses: recentTrends,
    recentJobs,
    methodologyPointer:
      'Trend methodology: seasonal Mann-Kendall (Hirsch-Slack 1984) + Theil-Sen slope with Sen-rank CI; Hamed-Rao (1998) lag-1 variance inflation when the deseasonalized series shows significant autocorrelation; Benjamini-Hochberg FDR across variables; ≥ 8 full years required before any significance claim. Full text: /api/v1/system/status → methodology.',
  });
}
