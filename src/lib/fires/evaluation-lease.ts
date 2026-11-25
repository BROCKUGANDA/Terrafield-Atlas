import { db } from '@/lib/db';

export const WATCHLIST_EVALUATION_LEASE_MS = 20 * 60_000;

export function watchlistEvaluationLeaseKey(watchlistId: string): string {
  return `watchlist-evaluation:${watchlistId}`;
}

/** One provider evaluation per watchlist across all web/worker/scheduler replicas. */
export async function acquireWatchlistEvaluationLease(
  watchlistId: string,
  holder: string,
  ttlMs = WATCHLIST_EVALUATION_LEASE_MS,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const key = watchlistEvaluationLeaseKey(watchlistId);
  const claimed = await db.jobLease.updateMany({
    where: { key, OR: [{ expiresAt: { lte: now } }, { holder }] },
    data: { holder, expiresAt, heartbeatAt: now },
  });
  if (claimed.count === 1) return true;
  const inserted = await db.jobLease.createMany({
    data: [{ key, holder, expiresAt, heartbeatAt: now }],
    skipDuplicates: true,
  });
  return inserted.count === 1;
}

export async function releaseWatchlistEvaluationLease(watchlistId: string, holder: string): Promise<void> {
  await db.jobLease.deleteMany({
    where: { key: watchlistEvaluationLeaseKey(watchlistId), holder },
  }).catch(() => undefined);
}
