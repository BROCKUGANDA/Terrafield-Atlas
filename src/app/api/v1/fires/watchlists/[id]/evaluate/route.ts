import { z } from 'zod';
import {
  apiHandler, clientKey, errorResponse, isoDateSchema, jsonResponse, parseBody,
  rateLimit, rateLimitResponse, withIdempotency,
} from '@/lib/api/helpers';
import { db } from '@/lib/db';
import { createDurableJob, dispatchJob, jobUrl } from '@/lib/queue';
import type { DurableJob } from '@/lib/queue';
import { validateEvalEnd } from '@/lib/fires/watchlist-engine';
import { canReadResource, requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement } from '@/lib/commercial';

/**
 * POST /api/v1/fires/watchlists/[id]/evaluate — LIVE evaluation or BACKTEST.
 *
 * The evaluation fetches real VIIRS archive coverage and decodes vector tiles,
 * so it runs as a durable job instead of inside the request:
 *
 *  - the durable job row and its outbox event are created inside the SAME
 *    transaction as the idempotency record (one commit → one logical job),
 *  - the queue pointer is pushed after that transaction committed,
 *  - the client receives 202 with the durable job id and the job URL.
 */

type WatchCtx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ end: isoDateSchema.optional() });

export const POST = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const route = `/api/v1/fires/watchlists/${id}/evaluate`;
  const pending: { job?: DurableJob } = {};

  const response = await withIdempotency(req, route, async (req, { userId, key }) => {
    const rl = await rateLimit(clientKey(req, 'watchlists:evaluate'), { capacity: 6, refillPerMinute: 3 });
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
    const parsed = await parseBody(req, bodySchema);
    if (!parsed.ok) return parsed.res;

    const watchlist = await db.fireWatchlist.findUnique({
      where: { id },
      select: { id: true, ownerId: true, organizationId: true, lookbackDays: true },
    });
    const context = await resolveTenantContext(req);
    if (!watchlist || !canReadResource(context, watchlist)) {
      return errorResponse(404, 'NOT_FOUND', `watchlist ${id} not found`, correlationId);
    }
    requirePermission(context, 'analysis.run');
    await assertEntitlement(context, 'processing_jobs_per_month');

    const end = parsed.data.end;
    if (end) {
      const today = new Date().toISOString().slice(0, 10);
      const invalid = validateEvalEnd(end, watchlist.lookbackDays, today);
      if (invalid) return errorResponse(400, 'VALIDATION_ERROR', invalid, correlationId);
    }

    const trigger = end ? 'backtest' : 'manual';
    return {
      commit: async (tx) => {
        pending.job = await createDurableJob({
          type: 'fires-watch-eval',
          ownerId: userId,
          organizationId: context.organizationId,
          params: { watchlistId: id, trigger, end: end ?? null, ownerId: userId, organizationId: context.organizationId },
          correlationId,
          idempotencyKey: key,
          route,
        }, tx);
        const url = jobUrl(pending.job.jobId);
        return jsonResponse(
          {
            jobId: pending.job.jobId,
            jobUrl: url,
            type: pending.job.type,
            status: pending.job.status,
            duplicate: !pending.job.created,
            deadlineAt: pending.job.deadlineAt,
            trigger,
            correlationId,
            message: 'Watchlist evaluation is queued as a durable job. Poll the job URL for the result.',
          },
          { status: 202, correlationId, headers: { Location: url } },
        );
      },
    };
  });

  if (pending.job) await dispatchJob(pending.job.jobId);
  return response;
});
