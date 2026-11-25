import { z } from 'zod';
import { apiHandler, errorResponse, jsonResponse, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import {
  EXPERIMENTS,
  EXPERIMENT_COPY,
  assignVariant,
} from '@/lib/experiments';

/**
 * GET  /api/v1/experiments?exp=<key>&unit=<visitor-uuid>
 *      → deterministic variant + the copy the UI renders. Public and read-only.
 * POST /api/v1/experiments  { exp, unit, outcome }
 *      → records an exposure/outcome for a verified, same-origin writer.
 *
 * The unit id is a client-generated UUID (localStorage `tf_ab_unit`) — a
 * random label, no identity, no PII. Unknown or paused experiments refuse
 * with 404/409 rather than fabricating an assignment.
 */
const unitSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{8,120}$/);
const assignmentSchema = z.object({ exp: z.string().trim().min(1), unit: unitSchema });
const persistenceSchema = assignmentSchema.extend({
  outcome: z.string().trim().min(1).refine((value) => value === 'experiment.exposure' || EXPERIMENTS.some((experiment) => experiment.outcomeAction === value), 'unknown outcome'),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const parsed = assignmentSchema.safeParse({
    exp: url.searchParams.get('exp') ?? '',
    unit: url.searchParams.get('unit') ?? '',
  });
  if (!parsed.success) {
    return errorResponse(400, 'INVALID_UNIT', 'unit must be 8-120 chars of [A-Za-z0-9_-] (client UUID, no PII)', correlationId);
  }
  const { exp: expKey, unit } = parsed.data;
  const result = assignVariant(expKey, unit);
  if (result.refusal === 'unknown-experiment') {
    return jsonResponse({ error: { code: 'UNKNOWN_EXPERIMENT', message: `no experiment '${expKey}'` } }, { status: 404 });
  }
  if (result.refusal === 'paused') {
    return jsonResponse({ error: { code: 'EXPERIMENT_PAUSED', message: `'${expKey}' is not active` } }, { status: 409 });
  }
  if (!result.assigned || !result.variant) {
    return jsonResponse({ error: { code: 'ASSIGNMENT_REFUSED', message: result.refusal ?? 'refused' } }, { status: 409 });
  }
  const exp = EXPERIMENTS.find((experiment) => experiment.key === expKey)!;
  return jsonResponse({
    experiment: exp.key,
    surface: exp.surface,
    unitHashedBucket: result.bucket,
    variant: result.variant,
    copy: EXPERIMENT_COPY[expKey][result.variant],
  });
});

export const POST = apiHandler(async (req, { correlationId }) => {
  return withIdempotency(req, '/api/v1/experiments', async (req, { userId }) => {
    const parsed = persistenceSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const outcomeIssue = parsed.error.issues.find((issue) => issue.path[0] === 'outcome');
      return errorResponse(400, outcomeIssue ? 'UNKNOWN_OUTCOME' : 'VALIDATION_ERROR', outcomeIssue ? 'unknown experiment outcome' : 'request body failed validation', correlationId);
    }
    const { exp: expKey, unit, outcome } = parsed.data;
    const result = assignVariant(expKey, unit);
    if (!result.assigned || !result.variant) {
      return errorResponse(409, 'ASSIGNMENT_REFUSED', result.refusal ?? 'refused', correlationId);
    }
    const limit = await rateLimit(`experiments:write:${userId}`, { capacity: 12, refillPerMinute: 2 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSec, correlationId);
    return {
      commit: async (tx) => {
        await writeMutationEffects(tx, {
          actor: `account:${userId}`,
          action: outcome,
          targetId: unit,
          detail: JSON.stringify({ experiment: expKey, variant: result.variant, outcome, recordedAt: new Date().toISOString() }),
          aggregateType: 'Experiment',
          aggregateId: expKey,
          eventType: outcome,
          payload: { experiment: expKey, variant: result.variant, outcome },
        });
        return jsonResponse({ recorded: true, experiment: expKey, variant: result.variant, outcome }, { correlationId });
      },
    };
  });
});
