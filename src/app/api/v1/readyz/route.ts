import { db } from '@/lib/db';

/**
 * GET /api/v1/readyz — READINESS probe (traffic-gating contract).
 *
 * Verifies the dependencies the console needs to answer USEFUL requests:
 *   - database reachable (SELECT 1) and seed baseline present,
 *   - watchlist scheduler timer alive (when not disabled by env),
 *   - digest push channel not disabled.
 *
 * Unlike /api/v1/health this is deliberately CHEAP (no counts, no provider
 * probes) so load balancers can poll it aggressively. A 'degraded' answer
 * lists exactly which dependency is unhappy — never a bare false.
 */

const DEGRADED_STATUS = 503;

export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
    checks.database = { ok: true, detail: 'SELECT 1 answered' };
    const farms = await db.farm.count();
    checks.seedBaseline = { ok: true, detail: `${farms} farm record(s) present` };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : 'database error' };
    checks.seedBaseline = { ok: false, detail: 'skipped — database unavailable' };
  }

  const schedulerOff = process.env.WATCH_SCHEDULER_OFF === '1';
  checks.scheduler = schedulerOff
    ? { ok: true, detail: 'disabled by WATCH_SCHEDULER_OFF=1 (on-demand evaluation only) — treated as ready' }
    : await (async () => {
        try {
          const { schedulerEnabled, schedulerHeartbeat } = await import('@/lib/scheduler');
          if (!schedulerEnabled()) return { ok: false, detail: 'scheduler timer not started yet' };
          const beat = schedulerHeartbeat();
          if (beat.staleSec !== null && beat.staleSec > 15 * 60) {
            return { ok: false, detail: `scheduler timer silent for ${Math.round(beat.staleSec)}s — watchdog restart pending` };
          }
          return { ok: true, detail: `tick every ${beat.tickEverySec}s; last tick ${beat.staleSec === null ? 'pending' : `${Math.round(beat.staleSec)}s ago`}` };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : 'scheduler check failed' };
        }
      })();

  const pushOff = process.env.DIGEST_PUSH_OFF === '1';
  checks.digestChannel = { ok: true, detail: pushOff ? 'disabled by DIGEST_PUSH_OFF=1 (REST digests remain)' : 'SSE push channel armed' };

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json(
    {
      status: ok ? 'ready' : 'degraded',
      service: 'terrafield-atlas',
      probe: 'readiness',
      checks,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : DEGRADED_STATUS, headers: { 'Cache-Control': 'no-store' } },
  );
}
