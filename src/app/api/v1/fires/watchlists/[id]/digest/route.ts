import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { computeWatchlistDigest } from '@/lib/fires/watchlist-digest-service';
import { accountUserId } from '@/lib/auth';

/**
 * GET /api/v1/fires/watchlists/[id]/digest — cadence-aware alert digest for
 * ONE watchlist (the PULL side; the push side is the SSE digest-stream route,
 * which recomputes the identical digest through the same service module).
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
 */

type WatchCtx = { params: Promise<{ id: string }> };

const querySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional(),
});

export const GET = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = await rateLimit(clientKey(req, 'watchlists:digest'), { capacity: 30, refillPerMinute: 20 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const w = await db.fireWatchlist.findUnique({ where: { id }, select: { id: true } });
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

  const computed = await computeWatchlistDigest(id, { requestedHours: parsedQuery.data.hours ?? null, ownerId: await accountUserId(req) });
  if (!computed.ok) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: computed.failure.message, correlationId } }, { status: 404, correlationId });
  }

  return jsonResponse(
    {
      ...computed.result.digest,
      watchlist: computed.result.watchlist,
      note: 'Digest generated from recorded evaluations and the scheduler audit ledger — nothing interpolated, archive gaps never zero-filled. Private digests are owner-only on demand; shared SSE, email and webhook delivery is disabled for private watchlists.',
      correlationId,
    },
    { correlationId },
  );
});
