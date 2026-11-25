import { createHash } from 'node:crypto';
import { db } from '@/lib/db';

/**
 * A/B testing — deterministic, honest, zero-pii.
 *
 * ASSIGNMENT (pure): a visitor's variant is a deterministic function of
 * (experiment key, unit id) — SHA-256 bucketed into [0, 1000) and mapped to
 * a variant by cumulative weight. Stable across processes, restarts and
 * devices holding the same unit id; no flicker, no sticky-session store, no
 * server round-trip needed to ASSIGN — the server round-trip exists to
 * RECORD the exposure.
 *
 * UNIT ID: a client-generated UUID persisted in localStorage (`tf_ab_unit`).
 * It never carries identity, location or any personal data — it is a random
 * label so a unit can be counted once.
 *
 * LEDGER: exposures and outcomes are AuditEvent rows (actor 'system:experiment')
 * — the same durable, inspectable ledger the rest of the console already
 * audits into. Metrics read them back per variant; exposure counting is
 * DISTINCT by unit so refreshes never inflate the split.
 *
 * HONESTY: an experiment whose variants are not all present in the registry
 * copy table is refused; unknown experiments refuse to assign; a paused
 * experiment refuses to assign. Nothing is fabricated — a variant with zero
 * exposures reports zero.
 */

// ---------------------------------------------------------------------------
// Pure: registry + deterministic bucketing
// ---------------------------------------------------------------------------

export interface ExperimentVariant {
  key: string;
  weight: number; // parts out of the total; 500/500 = 50/50
}

export interface Experiment {
  key: string;
  hypothesis: string;
  /** Where the variant is rendered — the UI reads copy from EXPERIMENT_COPY. */
  surface: string;
  unit: 'visitor';
  variants: ExperimentVariant[];
  /** The action whose rate the experiment measures. */
  outcomeAction: string;
  active: boolean;
}

export const EXPERIMENTS: Experiment[] = [
  {
    key: 'landing-hero-v1',
    hypothesis:
      'Which landing intro puts more operators into the console: the full mission brief (control) or a fire-intelligence-first brief that leads with the live detection stream and push-delivered digests (treatment)?',
    surface: 'landing hero intro + primary CTA label',
    unit: 'visitor',
    variants: [
      { key: 'control', weight: 500 },
      { key: 'fire-first', weight: 500 },
    ],
    outcomeAction: 'experiment.cta_enter_console',
    active: true,
  },
];

/** Variant copy — the single source of truth the UI renders. */
export const EXPERIMENT_COPY: Record<string, Record<string, { intro: string; cta: string }>> = {
  'landing-hero-v1': {
    control: {
      intro:
        'Earth-observation intelligence for agricultural resilience. See what NASA satellites observe about your land — rainfall, temperature, solar radiation, root-zone moisture, vegetation and fire history — understand whether changes are statistically meaningful, and compare evidence-supported crop-rotation options with every score explainable and every observation traceable to its source.',
      cta: 'Enter console',
    },
    'fire-first': {
      intro:
        'Live fire intelligence for the people who work the land. The VIIRS 375 m detection stream, scheduled regional watchlists and cadence-aware digests — pushed to the console, a signed webhook and email the moment an evaluation lands. Plus the full NASA POWER climate record with honest trend statistics, where every observation is traceable to its source and every gap is reported as a gap.',
      cta: 'Open the fire console',
    },
  },
};

export const ASSIGNMENT_BUCKETS = 1000;

/** Deterministic bucket for (experiment, unit) in [0, ASSIGNMENT_BUCKETS). Pure. */
export function assignmentBucket(experimentKey: string, unitId: string): number {
  const hex = createHash('sha256').update(`${experimentKey}:${unitId}`, 'utf8').digest('hex');
  return parseInt(hex.slice(0, 12), 16) % ASSIGNMENT_BUCKETS;
}

/** Map a bucket to a variant by cumulative weight. Pure. */
export function bucketToVariant(bucket: number, variants: ExperimentVariant[]): string | null {
  const total = variants.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return null;
  const point = (bucket / ASSIGNMENT_BUCKETS) * total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (point < acc) return v.key;
  }
  return variants[variants.length - 1].key;
}

export type AssignResult = {
  assigned: boolean;
  variant: string | null;
  bucket: number | null;
  refusal: 'unknown-experiment' | 'paused' | 'copy-missing' | null;
};

/**
 * Assign a unit to a variant — or refuse, honestly. Pure (no I/O): the
 * refusals are the A/B analogue of the exits' not-configured states.
 */
export function assignVariant(experimentKey: string, unitId: string): AssignResult {
  const exp = EXPERIMENTS.find((e) => e.key === experimentKey);
  if (!exp) return { assigned: false, variant: null, bucket: null, refusal: 'unknown-experiment' };
  if (!exp.active) return { assigned: false, variant: null, bucket: null, refusal: 'paused' };
  const bucket = assignmentBucket(exp.key, unitId);
  const variant = bucketToVariant(bucket, exp.variants);
  const copy = EXPERIMENT_COPY[exp.key];
  if (!variant || !copy || !copy[variant]) {
    return { assigned: false, variant: null, bucket, refusal: 'copy-missing' };
  }
  return { assigned: true, variant, bucket, refusal: null };
}

/** Pure aggregation of ledger rows → per-variant exposure/outcome counts. */
export function countByVariant(
  rows: { action: string; targetId: string | null; detail: string | null }[],
  experimentKey: string,
): { variant: string; exposures: number; outcomes: number }[] {
  const exposures = new Map<string, Set<string>>(); // variant → distinct unit ids
  const outcomes = new Map<string, number>();
  for (const row of rows) {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(row.detail ?? '{}');
    } catch {
      continue;
    }
    if (d.experiment !== experimentKey || typeof d.variant !== 'string') continue;
    if (row.action === 'experiment.exposure') {
      const set = exposures.get(d.variant) ?? new Set<string>();
      // Distinct by unit: targetId IS the unit id on exposure rows.
      if (row.targetId) set.add(row.targetId);
      exposures.set(d.variant, set);
    } else if (row.action.endsWith('.cta_enter_console') || row.action.startsWith('experiment.outcome')) {
      outcomes.set(d.variant, (outcomes.get(d.variant) ?? 0) + 1);
    }
  }
  const variants = new Set<string>([...exposures.keys(), ...outcomes.keys()]);
  return [...variants].map((variant) => ({
    variant,
    exposures: exposures.get(variant)?.size ?? 0,
    outcomes: outcomes.get(variant) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Runtime: ledger writes + metrics (never throw — an A/B hiccup must never
// take the landing page or the console down)
// ---------------------------------------------------------------------------

export async function recordExposure(input: {
  experimentKey: string;
  unitId: string;
  variant: string;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actor: 'system:experiment',
        action: 'experiment.exposure',
        targetId: input.unitId.slice(0, 120),
        detail: JSON.stringify({
          experiment: input.experimentKey,
          variant: input.variant,
          recordedAt: new Date().toISOString(),
        }),
      },
    });
  } catch (err) {
    console.error('[experiments] exposure ledger write failed:', err instanceof Error ? err.message : err);
  }
}

export async function recordOutcome(input: {
  experimentKey: string;
  unitId: string;
  variant: string;
  outcome: string;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actor: 'system:experiment',
        action: input.outcome,
        targetId: input.unitId.slice(0, 120),
        detail: JSON.stringify({
          experiment: input.experimentKey,
          variant: input.variant,
          outcome: input.outcome,
          recordedAt: new Date().toISOString(),
        }),
      },
    });
  } catch (err) {
    console.error('[experiments] outcome ledger write failed:', err instanceof Error ? err.message : err);
  }
}

export interface ExperimentMetric {
  key: string;
  hypothesis: string;
  surface: string;
  active: boolean;
  variants: { variant: string; exposures: number; outcomes: number }[];
  note: string;
}

/** Live metrics for the status surface: distinct exposures + outcomes per variant. */
export async function experimentMetrics(): Promise<ExperimentMetric[]> {
  try {
    const rows = await db.auditEvent.findMany({
      where: { action: { in: ['experiment.exposure', ...EXPERIMENTS.map((experiment) => experiment.outcomeAction)] } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    return EXPERIMENTS.map((exp) => {
      const variants = countByVariant(
        rows.map((r) => ({ action: r.action, targetId: r.targetId, detail: r.detail })),
        exp.key,
      );
      const filled = exp.variants.map(
        (v) => variants.find((x) => x.variant === v.key) ?? { variant: v.key, exposures: 0, outcomes: 0 },
      );
      return {
        key: exp.key,
        hypothesis: exp.hypothesis,
        surface: exp.surface,
        active: exp.active,
        variants: filled,
        note:
          'Deterministic SHA-256 bucketing of the anonymous visitor unit id (no PII); exposures are DISTINCT units from the experiment.exposure audit rows; outcomes are the CTA action the hypothesis names. A variant with no traffic reports zero — nothing is imputed.',
      };
    });
  } catch (err) {
    console.error('[experiments] metrics read failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
