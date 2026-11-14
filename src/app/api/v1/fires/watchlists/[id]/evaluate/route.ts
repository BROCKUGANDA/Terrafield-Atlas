import { z } from 'zod';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { runWatchlistEvaluation } from '@/lib/fires/watchlist-evaluate';

/**
 * POST /api/v1/fires/watchlists/[id]/evaluate — LIVE evaluation or BACKTEST.
 *
 * Body: { end?: 'YYYY-MM-DD' }
 *  - omitted: LIVE evaluation ending on the most recent fully observed VIIRS
 *    day — the standing-alert check (the "Evaluate now" action).
 *  - any explicit end date: BACKTEST — the exact same pipeline is re-run with
 *    the window anchored to that historical date (the Evaluate date picker,
 *    which always sends `end`). The result is stored as a normal
 *    FireWatchEvent flagged trigger=backtest.
 *
 * All validation (future dates, archive start, full-window-inside-archive) and
 * the evaluation itself live in lib/fires/watchlist-evaluate.ts, shared with
 * the scheduled re-evaluation trigger so every path behaves identically.
 */

type WatchCtx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const POST = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = rateLimit(clientKey(req, 'watchlists:evaluate'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;

  // An explicit end date is a backtest: the trigger records the ACTION taken
  // (the date picker always sends end), even when the chosen date happens to
  // equal the live default.
  const trigger = parsed.data.end ? 'backtest' : 'manual';

  const outcome = await runWatchlistEvaluation({
    watchlistId: id,
    trigger,
    end: parsed.data.end,
    correlationId,
    actor: 'demo-user',
  });

  if (!outcome.ok) {
    const failure = outcome.failure;
    const details = failure.details as Record<string, unknown> | undefined;
    const status = failure.code === 'NOT_FOUND' ? 404 : failure.code === 'VALIDATION_ERROR' ? 400 : 502;
    return jsonResponse(
      {
        error: {
          code: failure.code,
          message: failure.message,
          ...(details?.providerMessage !== undefined ? { providerMessage: details.providerMessage } : {}),
          correlationId,
        },
      },
      { status, correlationId },
    );
  }

  return jsonResponse({ ...outcome.result, correlationId }, { status: 201, correlationId });
});
