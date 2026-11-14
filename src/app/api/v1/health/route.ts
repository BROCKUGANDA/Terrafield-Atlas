import { db } from '@/lib/db';
import { ensureSeeded } from '@/lib/seeds';
import { cacheStats } from '@/lib/cache';
import { circuitStatus } from '@/lib/http';
import { firmsConfigured } from '@/lib/adapters/firms';

/**
 * GET /api/v1/health
 * Service health: database, seeding, data-source status, circuit breakers,
 * cache metrics, environment flags. Never calls external providers (cheap).
 */
export async function GET() {
  const started = Date.now();
  let dbOk = false;
  let dbError: string | null = null;
  let seeded = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
    await ensureSeeded();
    seeded = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  const sources = dbOk
    ? await db.dataSource.findMany({
        select: { datasetName: true, provider: true, status: true, authRequired: true },
      })
    : [];
  return Response.json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'terrafield-atlas',
    checkedAt: new Date().toISOString(),
    database: { ok: dbOk, seeded, error: dbError },
    dataSources: sources,
    circuitBreakers: circuitStatus(),
    cache: cacheStats(),
    environment: {
      firmsMapKeyConfigured: firmsConfigured(),
      earthdataCredentialsConfigured: false,
    },
    latencyMs: Date.now() - started,
  });
}
