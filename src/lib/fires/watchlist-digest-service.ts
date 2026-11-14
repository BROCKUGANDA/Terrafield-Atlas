import { db } from '@/lib/db';
import { parseSchedulerAuditRow } from '@/lib/fires/watchlist-runs';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { buildDigest, digestHoursFor, digestWindows, failuresFromParsed, type DigestWindowSource } from '@/lib/fires/watchlist-digest';

/**
 * Digest computation service — ONE code path for every digest consumer:
 *
 *  - the REST route (`GET /api/v1/fires/watchlists/[id]/digest`, the pull side)
 *  - the push channel (`lib/fires/digest-push.ts`, which recomputes the exact
 *    same cadence-aware digest and writes it onto open SSE connections the
 *    moment a new digest-relevant fact lands — an evaluation event or a
 *    failed scheduled run)
 *
 * Read-only and bounded: at most 200 evaluation events + 20 failure ledger
 * rows per call, exactly the same bounds the REST route always used.
 */

const DIGEST_EVENT_TAKE = 200;
const DIGEST_FAILURE_TAKE = 20;

export interface ComputedDigest {
  /** Serialized watchlist the digest was built from. */
  watchlist: ReturnType<typeof serializeWatchlist>;
  /** Full cadence-aware digest (windows, summaries, comparison, prose). */
  digest: ReturnType<typeof buildDigest>;
  /** Trigger of the NEWEST evaluation inside the window — null when there is none. */
  newestEventTrigger: 'manual' | 'backtest' | 'scheduled' | null;
  /** Evaluation rows actually read (drives the `truncated` flag upstream). */
  eventRowsRead: number;
}

export type DigestServiceResult =
  | { ok: true; result: ComputedDigest }
  | { ok: false; failure: { code: 'NOT_FOUND'; message: string } };

/**
 * Compute the cadence-aware digest for one watchlist.
 *
 * `requestedHours` mirrors the REST query parameter: null → the window derives
 * from the watchlist's own cadence (or the 24 h default for manual lists);
 * an explicit number → the caller chose the window length. The returned
 * `windowSource` always says which of the three produced the window.
 */
export async function computeWatchlistDigest(
  id: string,
  opts: { requestedHours?: number | null; now?: Date } = {},
): Promise<DigestServiceResult> {
  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) {
    return { ok: false, failure: { code: 'NOT_FOUND', message: `watchlist ${id} not found` } };
  }

  const requestedHours = opts.requestedHours ?? null;
  const now = opts.now ?? new Date();
  const hours = requestedHours ?? digestHoursFor(w);
  const windowSource: DigestWindowSource =
    requestedHours !== null ? 'request' : w.reevaluateIntervalMin !== null ? 'cadence' : 'default';

  // Both windows come from ONE bounded read (current + previous span).
  const { previous } = digestWindows(now, hours);
  const since = new Date(previous.start);

  const [rawEvents, failRows] = await Promise.all([
    db.fireWatchEvent.findMany({
      where: { watchlistId: id, evaluatedAt: { gte: since } },
      orderBy: { evaluatedAt: 'asc' },
      take: DIGEST_EVENT_TAKE,
    }),
    db.auditEvent.findMany({
      where: { actor: 'system:scheduler', targetId: id, action: 'watchlist.schedule.fail', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: DIGEST_FAILURE_TAKE,
    }),
  ]);

  const digest = buildDigest({
    name: w.name,
    now,
    hours,
    cadenceMin: w.reevaluateIntervalMin,
    windowSource,
    events: rawEvents.map(serializeEvent),
    failures: failuresFromParsed(
      failRows.map((r) => parseSchedulerAuditRow({ action: r.action, createdAt: r.createdAt, detail: r.detail })),
    ),
    nextRunAt: w.nextReevaluateAt,
    truncated: rawEvents.length === DIGEST_EVENT_TAKE,
  });

  // Rows are ordered ascending — the last one is the newest evaluation, and
  // its serialized trigger says what kind of evaluation most recently landed.
  const serializedEvents = rawEvents.map(serializeEvent);

  return {
    ok: true,
    result: {
      watchlist: serializeWatchlist(w),
      digest,
      newestEventTrigger: serializedEvents.length > 0 ? serializedEvents[serializedEvents.length - 1].trigger : null,
      eventRowsRead: rawEvents.length,
    },
  };
}
