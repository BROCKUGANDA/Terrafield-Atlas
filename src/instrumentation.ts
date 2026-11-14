/**
 * Next.js instrumentation hook — runs once per server process start.
 *
 * Boots, inside the single Node runtime:
 *   1. the in-process watchlist re-evaluation scheduler (lib/scheduler.ts);
 *   2. process-level async-safety nets (unhandledRejection / uncaughtException
 *      are LOGGED, never allowed to kill serving — an operator console that
 *      goes dark mid-shift is the one unacceptable failure);
 *   3. a watchdog interval (unref'd) that restarts a hung scheduler timer and
 *      keeps timers unref'd so they never hold the process open;
 *   4. graceful SIGTERM/SIGINT shutdown (Prisma disconnect before exit).
 *
 * No-ops on non-Node runtimes (edge) and when WATCH_SCHEDULER_OFF=1. Safe
 * under dev HMR: every step is idempotent.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const g = globalThis as unknown as { __terraInstrumented?: boolean };
  if (g.__terraInstrumented) return; // dev HMR / double register
  g.__terraInstrumented = true;

  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();

  // --- async-safety nets -------------------------------------------------
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandledRejection (logged, serving continues):', reason instanceof Error ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    // Deliberately NOT exiting: Node's guidance is to exit, but a monitoring
    // console that dies mid-shift is worse than one that logs and continues;
    // the fault-isolation boundaries (React + route handlers) contain the
    // blast radius, and the readiness probe reports degradation honestly.
    console.error('[process] uncaughtException (logged, serving continues):', err.stack ?? String(err));
  });

  // --- watchdog (unref'd: never holds the process open) -------------------
  const WATCHDOG_MS = 5 * 60_000;
  const watchdog = setInterval(async () => {
    try {
      const { ensureSchedulerAlive } = await import('@/lib/scheduler');
      ensureSchedulerAlive();
    } catch (err) {
      console.error('[watchdog] scheduler check failed:', err instanceof Error ? err.message : err);
    }
  }, WATCHDOG_MS);
  watchdog.unref?.();

  // --- graceful shutdown ---------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`[process] ${signal} received — closing cleanly`);
    try {
      const { db } = await import('@/lib/db');
      await db.$disconnect();
    } catch {
      // db already gone — exit anyway
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
