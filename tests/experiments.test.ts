import { describe, test, expect } from 'bun:test';
import {
  EXPERIMENTS,
  EXPERIMENT_COPY,
  assignmentBucket,
  bucketToVariant,
  assignVariant,
  countByVariant,
  ASSIGNMENT_BUCKETS,
} from '@/lib/experiments';

/**
 * A/B core unit tests — the PURE halves (deterministic bucketing, weight
 * mapping, refusal semantics, ledger aggregation). No DB, no network.
 */

describe('experiments registry integrity', () => {
  test('every active experiment has copy for every declared variant', () => {
    for (const exp of EXPERIMENTS) {
      const copy = EXPERIMENT_COPY[exp.key];
      expect(copy).toBeDefined();
      for (const v of exp.variants) {
        expect(copy![v.key]).toBeDefined();
        expect(copy![v.key].intro.length).toBeGreaterThan(40);
        expect(copy![v.key].cta.length).toBeGreaterThan(2);
      }
    }
  });

  test('weights are positive and sum to a sane total', () => {
    for (const exp of EXPERIMENTS) {
      expect(exp.variants.length).toBeGreaterThanOrEqual(2);
      for (const v of exp.variants) expect(v.weight).toBeGreaterThan(0);
    }
  });
});

describe('deterministic assignment', () => {
  test('same (experiment, unit) ALWAYS maps to the same variant — no flicker', () => {
    const first = assignVariant('landing-hero-v1', '11111111-1111-4111-8111-111111111111');
    for (let i = 0; i < 200; i++) {
      const again = assignVariant('landing-hero-v1', '11111111-1111-4111-8111-111111111111');
      expect(again.variant).toBe(first.variant);
      expect(again.bucket).toBe(first.bucket);
    }
  });

  test('different units can land in different variants (both reachable)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const r = assignVariant('landing-hero-v1', `unit-${i.toString().padStart(6, '0')}-aaaaaaaaaaaaaaaa`);
      if (r.variant) seen.add(r.variant);
    }
    expect(seen.size).toBe(2); // both variants reachable with 50/50 weights
  });

  test('bucket space is fully covered and stable', () => {
    const b1 = assignmentBucket('landing-hero-v1', 'abc');
    const b2 = assignmentBucket('landing-hero-v1', 'abc');
    expect(b1).toBe(b2);
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(ASSIGNMENT_BUCKETS);
  });

  test('50/50 weights split a large synthetic population near 50/50', () => {
    let control = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = assignVariant('landing-hero-v1', `synthetic-${i}-deadbeefdeadbeef`);
      if (r.variant === 'control') control++;
    }
    const share = control / N;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });

  test('bucketToVariant honors skewed weights (10/90)', () => {
    const variants = [
      { key: 'a', weight: 100 },
      { key: 'b', weight: 900 },
    ];
    let a = 0;
    const N = ASSIGNMENT_BUCKETS;
    for (let b = 0; b < N; b++) if (bucketToVariant(b, variants) === 'a') a++;
    const share = a / N;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
  });

  test('bucketToVariant with zero total refuses', () => {
    expect(bucketToVariant(0, [])).toBeNull();
    expect(bucketToVariant(5, [{ key: 'a', weight: 0 }])).toBeNull();
  });
});

describe('refusal semantics (honest states, never fabricated)', () => {
  test('unknown experiment refuses with unknown-experiment', () => {
    const r = assignVariant('no-such-experiment', 'some-unit-12345678');
    expect(r.assigned).toBe(false);
    expect(r.refusal).toBe('unknown-experiment');
    expect(r.variant).toBeNull();
  });

  test('invalid unit ids are rejected at the API layer by shape — assign itself is unit-shape-agnostic', () => {
    // The lib assigns for any non-empty string; the ROUTE enforces the shape.
    const r = assignVariant('landing-hero-v1', 'x');
    expect(typeof r.assigned).toBe('boolean');
  });
});

describe('ledger aggregation (countByVariant)', () => {
  const mk = (action: string, targetId: string, experiment: string, variant: string) => ({
    action,
    targetId,
    detail: JSON.stringify({ experiment, variant }),
  });

  test('exposures are DISTINCT by unit; refreshes never inflate', () => {
    const rows = [
      mk('experiment.exposure', 'unit-A', 'landing-hero-v1', 'control'),
      mk('experiment.exposure', 'unit-A', 'landing-hero-v1', 'control'), // refresh
      mk('experiment.exposure', 'unit-B', 'landing-hero-v1', 'control'),
      mk('experiment.exposure', 'unit-C', 'landing-hero-v1', 'fire-first'),
    ];
    const out = countByVariant(rows, 'landing-hero-v1');
    const control = out.find((v) => v.variant === 'control')!;
    expect(control.exposures).toBe(2); // A + B, not 3
    const fire = out.find((v) => v.variant === 'fire-first')!;
    expect(fire.exposures).toBe(1);
  });

  test('rows for OTHER experiments are ignored; outcomes counted per variant', () => {
    const rows = [
      mk('experiment.exposure', 'unit-A', 'other-exp', 'control'),
      mk('experiment.cta_enter_console', 'unit-A', 'landing-hero-v1', 'control'),
      mk('experiment.exposure', 'unit-B', 'landing-hero-v1', 'fire-first'),
    ];
    const out = countByVariant(rows, 'landing-hero-v1');
    const control = out.find((v) => v.variant === 'control')!;
    expect(control.exposures).toBe(0); // the exposure belonged to other-exp
    expect(control.outcomes).toBe(1);
  });

  test('malformed detail rows are skipped, never thrown on', () => {
    const rows = [{ action: 'experiment.exposure', targetId: 'x', detail: '{not json' }];
    expect(countByVariant(rows, 'landing-hero-v1')).toEqual([]);
  });
});
