/**
 * GET /api/v1/healthz — LIVENESS probe (kubernetes/load-balancer contract).
 *
 * Answers from process state ONLY: no database, no providers, no seeding.
 * If this returns non-200 the process cannot serve HTTP at all and should be
 * restarted. Readiness (dependencies) is /api/v1/readyz; deep diagnostics is
 * /api/v1/health.
 */

let startedAtMs: number | null = null;
const bootAt = Date.now();

export async function GET() {
  startedAtMs ??= bootAt;
  const uptimeSec = Math.round((Date.now() - bootAt) / 1000);
  return Response.json(
    {
      status: 'ok',
      service: 'terrafield-atlas',
      probe: 'liveness',
      pid: process.pid,
      uptimeSec,
      checkedAt: new Date().toISOString(),
      memory: {
        rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
