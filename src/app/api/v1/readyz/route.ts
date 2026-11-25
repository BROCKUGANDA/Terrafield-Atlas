import { db, tenantConnectionRole } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEGRADED_STATUS = 503;

/** Traffic gate: schema, seed, Redis, scheduler leadership and worker health. */
export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = { ok: true, detail: 'reachable' };
  } catch {
    checks.database = { ok: false, detail: 'unavailable' };
  }

  try {
    const tenantConfigured = Boolean(process.env.TENANT_DATABASE_URL?.trim());
    if (!tenantConfigured) {
      checks.tenantRole = process.env.NODE_ENV === 'production'
        ? { ok: false, detail: 'tenant database role is not configured' }
        : { ok: true, detail: 'tenant role not required outside production' };
    } else {
      const role = await tenantConnectionRole();
      checks.tenantRole = role && role.user === 'terrafield_app' && !role.superuser && !role.bypassRls
        ? { ok: true, detail: 'request queries run as terrafield_app without RLS bypass' }
        : { ok: false, detail: 'tenant connection is not the restricted app role' };
    }
  } catch {
    checks.tenantRole = { ok: false, detail: 'tenant role could not be verified' };
  }

  try {
    const schema = await db.$queryRaw<Array<{ watchlists: string | null; receipts: string | null }>>`
      SELECT to_regclass('"FireWatchlist"')::text AS watchlists, to_regclass('"DeliveryReceipt"')::text AS receipts
    `;
    checks.schema = schema[0]?.watchlists && schema[0]?.receipts
      ? { ok: true, detail: 'required tables present' }
      : { ok: false, detail: 'required migrations are not deployed' };
  } catch {
    checks.schema = { ok: false, detail: 'schema could not be verified' };
  }

  try {
    const farms = await db.farm.count();
    checks.seedBaseline = { ok: farms > 0, detail: farms > 0 ? 'seed records present' : 'seed baseline is empty' };
  } catch {
    checks.seedBaseline = { ok: false, detail: 'seed baseline could not be verified' };
  }

  try {
    const { redisRuntime } = await import('@/lib/redis');
    await redisRuntime().ping();
    checks.redis = { ok: true, detail: 'reachable' };
  } catch {
    checks.redis = { ok: false, detail: 'unavailable' };
  }

  if (process.env.WATCH_SCHEDULER_OFF === '1') {
    checks.scheduler = { ok: true, detail: 'disabled by configuration' };
  } else {
    try {
      const { schedulerLeaseStatus } = await import('@/lib/scheduler');
      const lease = await schedulerLeaseStatus();
      const heartbeatAge = lease.heartbeatAt ? Date.now() - Date.parse(lease.heartbeatAt) : Infinity;
      checks.scheduler = lease.leader && heartbeatAge <= 90_000
        ? { ok: true, detail: 'leadership lease and heartbeat are fresh' }
        : { ok: false, detail: 'fresh scheduler leadership is unavailable' };
    } catch {
      checks.scheduler = { ok: false, detail: 'leadership could not be verified' };
    }
  }

  if (process.env.READINESS_REQUIRE_WORKERS === '0') {
    checks.workers = { ok: true, detail: 'worker requirement disabled by configuration' };
  } else {
    try {
      const { listWorkerHeartbeats } = await import('@/lib/jobs/runtime');
      const workers = await listWorkerHeartbeats();
      const fresh = workers.some((worker) => worker.ageSec <= 90);
      checks.workers = fresh ? { ok: true, detail: `${workers.length} worker heartbeat(s) visible` } : { ok: false, detail: 'no fresh worker heartbeat' };
    } catch (error) {
      console.error('[readyz] worker health check failed:', error instanceof Error ? error.message : error);
      checks.workers = { ok: false, detail: 'worker health could not be verified' };
    }
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return Response.json(
    { status: ok ? 'ready' : 'degraded', service: 'terrafield-atlas', probe: 'readiness', checks, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() },
    { status: ok ? 200 : DEGRADED_STATUS, headers: { 'cache-control': 'no-store' } },
  );
}
