import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';
import { parseSchedulerAuditRow } from '@/lib/fires/watchlist-runs';
import { buildDigest, digestHoursFor, digestWindows, failuresFromParsed, type DigestWindowSource } from '@/lib/fires/watchlist-digest';

/**
 * GET /api/v1/fires/watchlists/[id]/digest — cadence-aware alert digest for
 * ONE watchlist.
 *
 * The window DERIVES from the watchlist's own re-evaluation cadence when one
 * is set (6 h / 12 h / 24 h list → 6 h / 12 h / 24 h digest); manual lists
 * default to 24 h. `?hours=1..720` overrides explicitly — the response's
 * `windowSource` always says which of the three produced the window.
 *
 * The digest compares the current window with the EQUAL-LENGTH window before
 * it: status path and transitions, peak qualifying detections (with delta),
 * alert entries/exits, failed scheduled runs (audit ledger — they write no
 * evaluation event) and archive-gap days. Read-only, no provider traffic.
 * Digests are generated on demand; this topology has no push/delivery channel.
 */

type WatchCtx = { params: Promise<{ id: string }> };

const querySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional(),
});

const DIGEST_EVENT_TAKE = 200;
const DIGEST_FAILURE_TAKE = 20;

export const GET = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = rateLimit(clientKey(req, 'watchlists:digest'), { capacity: 30, refillPerMinute: 20 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }

  const parsedQuery = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsedQuery.success) {
    return jsonResponse(
      { error: { code: 'VALIDATION_ERROR', message: 'hours must be an integer between 1 and 720', correlationId, details: parsedQuery.error.issues } },
      { status: 400, correlationId },
    );
  }
  const requestedHours = parsedQuery.data.hours ?? null;

  const now = new Date();
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

  return jsonResponse(
    {
      ...digest,
      watchlist: serializeWatchlist(w),
      note: 'Digest generated on demand from recorded evaluations and the scheduler audit ledger — nothing interpolated, archive gaps never zero-filled. No push/delivery channel exists in this topology.',
      correlationId,
    },
    { correlationId },
  );
});
