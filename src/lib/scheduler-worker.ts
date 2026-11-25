import { db } from '@/lib/db';
import { ensureSchedulerAlive, schedulerLeaseStatus, startScheduler } from '@/lib/scheduler';

async function main(): Promise<void> {
  if (process.env.WATCH_SCHEDULER_OFF === '1') throw new Error('scheduler service cannot start with WATCH_SCHEDULER_OFF=1');
  startScheduler();
  console.log('[scheduler-worker] database-leased scheduler service started');
  const watchdog = setInterval(() => void ensureSchedulerAlive(), 60_000);
  watchdog.unref?.();
  const shutdown = async () => {
    clearInterval(watchdog);
    console.log('[scheduler-worker] shutting down', await schedulerLeaseStatus());
    await db.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  // The scheduler timer is intentionally unref'd inside web replicas. This
  // dedicated service must remain alive even while no watchlist is due.
  setInterval(() => undefined, 60_000);
}

void main();
