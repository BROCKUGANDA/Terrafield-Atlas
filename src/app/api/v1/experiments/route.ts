import { jsonResponse } from '@/lib/api/helpers';
import {
  EXPERIMENTS,
  EXPERIMENT_COPY,
  assignVariant,
  recordExposure,
  recordOutcome,
} from '@/lib/experiments';

/**
 * GET  /api/v1/experiments?exp=<key>&unit=<visitor-uuid>
 *      → deterministic variant + the copy the UI renders; the exposure is
 *        recorded server-side (distinct-unit ledger; refreshes never inflate).
 * POST /api/v1/experiments  { exp, unit, outcome }
 *      → records the outcome action for the assigned variant.
 *
 * The unit id is a client-generated UUID (localStorage `tf_ab_unit`) — a
 * random label, no identity, no PII. Unknown or paused experiments refuse
 * with 404/409 rather than fabricating an assignment.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const expKey = url.searchParams.get('exp') ?? '';
  const unit = (url.searchParams.get('unit') ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(unit)) {
    return jsonResponse(
      { error: { code: 'INVALID_UNIT', message: 'unit must be 8-120 chars of [A-Za-z0-9_-] (client UUID, no PII)' } },
      { status: 400 },
    );
  }
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
  await recordExposure({ experimentKey: expKey, unitId: unit, variant: result.variant });
  const exp = EXPERIMENTS.find((e) => e.key === expKey)!;
  return jsonResponse({
    experiment: exp.key,
    surface: exp.surface,
    unitHashedBucket: result.bucket,
    variant: result.variant,
    copy: EXPERIMENT_COPY[expKey][result.variant],
  });
}

const OUTCOME_ACTIONS = new Set(EXPERIMENTS.map((e) => e.outcomeAction));

export async function POST(req: Request) {
  let body: { exp?: string; unit?: string; outcome?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: { code: 'INVALID_JSON', message: 'body must be JSON' } }, { status: 400 });
  }
  const expKey = (body.exp ?? '').trim();
  const unit = (body.unit ?? '').trim();
  const outcome = (body.outcome ?? '').trim();
  if (!OUTCOME_ACTIONS.has(outcome)) {
    return jsonResponse(
      { error: { code: 'UNKNOWN_OUTCOME', message: `allowed: ${[...OUTCOME_ACTIONS].join(', ')}` } },
      { status: 400 },
    );
  }
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(unit)) {
    return jsonResponse({ error: { code: 'INVALID_UNIT', message: 'unit must be 8-120 chars of [A-Za-z0-9_-]' } }, { status: 400 });
  }
  const result = assignVariant(expKey, unit);
  if (!result.assigned || !result.variant) {
    return jsonResponse({ error: { code: 'ASSIGNMENT_REFUSED', message: result.refusal ?? 'refused' } }, { status: 409 });
  }
  await recordOutcome({ experimentKey: expKey, unitId: unit, variant: result.variant, outcome });
  return jsonResponse({ recorded: true, experiment: expKey, variant: result.variant, outcome });
}
