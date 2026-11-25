import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { buildRunHistory } from '@/lib/fires/watchlist-runs';

/**
 * GET /api/v1/fires/watchlists/[id]/runs — scheduler-run history for ONE
 * watchlist.
 *
 * Sources (read-only, no provider traffic):
 *  - the audit ledger, where lib/scheduler.ts records EVERY scheduled run:
 *    'watchlist.schedule.run' (success: status + detection count) and
 *    'watchlist.schedule.fail' (error message). Failed runs write NO
 *    FireWatchEvent — the ledger is the only place they exist.
 *  - FireWatchEvent rows matched BY correlationId, which enrich successful
 *    entries with the full evaluation record (window, per-day counts,
 *    rationale…).
 *
 * Counts cover the whole ledger for this watchlist; entries are capped at the
 * newest 50 (`cap`) with `showing` reporting how many were returned.
 */

type WatchCtx = { params: Promise<{ id: string }> };

const RUN_HISTORY_CAP = 50;
const LEDGER_ACTIONS = ['watchlist.schedule.run', 'watchlist.schedule.fail'] as const;

export const GET = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = await rateLimit(clientKey(req, 'watchlists:runs'), { capacity: 30, refillPerMinute: 20 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }

  const ledgerWhere = {
    actor: 'system:scheduler',
    targetId: id,
    action: { in: [...LEDGER_ACTIONS] },
  };

  const [ledgerRows, countGroups] = await Promise.all([
    db.auditEvent.findMany({ where: ledgerWhere, orderBy: { createdAt: 'desc' }, take: RUN_HISTORY_CAP }),
    db.auditEvent.groupBy({ by: ['action'], where: ledgerWhere, _count: { _all: true } }),
  ]);

  // Match evaluation events for the returned ledger entries by correlationId.
  const corrIds = [
    ...new Set(
      ledgerRows
        .map((r) => {
          try {
            const d = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {};
            return typeof d.correlationId === 'string' ? d.correlationId : null;
          } catch {
            return null;
          }
        })
        .filter((c): c is string => c !== null),
    ),
  ];
  const events = corrIds.length
    ? await db.fireWatchEvent.findMany({
        where: { watchlistId: id, correlationId: { in: corrIds } },
        orderBy: { evaluatedAt: 'desc' },
      })
    : [];

  const runs = buildRunHistory(
    ledgerRows.map((r) => ({ action: r.action, createdAt: r.createdAt, detail: r.detail })),
    events.map(serializeEvent),
    RUN_HISTORY_CAP,
  );

  const counts = {
    total: countGroups.reduce((s, g) => s + g._count._all, 0),
    ok: countGroups.find((g) => g.action === 'watchlist.schedule.run')?._count._all ?? 0,
    failed: countGroups.find((g) => g.action === 'watchlist.schedule.fail')?._count._all ?? 0,
  };

  return jsonResponse(
    {
      watchlist: serializeWatchlist(w),
      runs,
      counts,
      showing: runs.length,
      cap: RUN_HISTORY_CAP,
      note: `Every scheduled run is recorded here by the database-leased scheduler: successes as ledger rows plus a matching FireWatchEvent (joined on correlationId), failures as ledger rows only — a failed run never writes a status. Counts cover the whole ledger; entries show the newest ${RUN_HISTORY_CAP}. Live scheduler state (ticks, budget, next due) is in /api/v1/system/status.`,
      correlationId,
    },
    { correlationId },
  );
});
