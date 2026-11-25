/**
 * Test-fixture clock nudge for the scheduled-push e2e check:
 * arms the given watchlist's cadence slot to be due NOW (nextReevaluateAt
 * 90 s in the past) via Prisma — the documented-safe write path. The real
 * in-process scheduler then claims and runs it on its next 60 s tick.
 *
 * Usage: bun scripts/nudge-next-run.ts <watchlistId> <intervalMin>
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const [, , id, intervalMinRaw] = process.argv as [string, string, string, string];
const intervalMin = Number(intervalMinRaw);

async function main() {
  if (!id || !Number.isFinite(intervalMin)) {
    throw new Error('usage: bun scripts/nudge-next-run.ts <watchlistId> <intervalMin>');
  }
  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) throw new Error(`watchlist ${id} not found`);
  const due = new Date(Date.now() - 90_000); // 90 s in the past → due on the next tick
  await db.fireWatchlist.update({
    where: { id },
    data: { reevaluateIntervalMin: intervalMin, nextReevaluateAt: due },
  });
  console.log(`[nudge] ${w.name}: cadence ${intervalMin} min, nextReevaluateAt ${due.toISOString()} (due now)`);
  console.log('[nudge] waiting for the real scheduler tick (<=60 s) to claim and run it');
}

main()
  .catch((err) => {
    console.error('[nudge] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
