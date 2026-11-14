/**
 * Next.js instrumentation hook — runs once per server process start.
 *
 * Boots the in-process watchlist re-evaluation scheduler (lib/scheduler.ts)
 * inside the single Node runtime. No-ops on non-Node runtimes (edge) and when
 * WATCH_SCHEDULER_OFF=1. Safe under dev HMR: startScheduler is idempotent.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();
}
