import { describe, test, expect } from 'bun:test';
import {
  evaluateWatchlist,
  watchThresholdFor,
  windowFor,
  bboxForRadiusKm,
  isQualifying,
  confidenceRank,
  addDaysIso,
  minBacktestEndIso,
  validateEvalEnd,
  yesterdayIso,
  FIRE_ARCHIVE_START,
  type WatchDay,
  type WatchDetection,
} from '@/lib/fires/watchlist-engine';
import {
  isReevaluateInterval,
  isDue,
  nextRunAfter,
  runSchedulerTick,
  selectDueWatchlists,
  REEVALUATE_INTERVALS,
  type SchedulableWatch,
  type TickDeps,
} from '@/lib/schedule-core';

/**
 * Watchlist engine unit tests — pure logic, no network.
 * Status semantics under honest coverage rules:
 *   alert  ≥ threshold | watch ≥ ceil(threshold/2) or partial coverage with
 *   detections | clear only on complete coverage | unverified when unchecked.
 */

const base = {
  windowStart: '2026-10-09',
  windowEnd: '2026-10-15',
  lookbackDays: 7,
};

function days(checked: boolean, n = 7, end = '2026-10-15'): WatchDay[] {
  // windowFor(end, lookback) builds BACKWARD from the end date.
  const { days: list } = windowFor(end, n);
  return list.map((date) => ({ date, checked, dataAvailable: true }));
}

function detections(spec: [string, string, number | null][]): WatchDetection[] {
  return spec.map(([date, confidence, frp]) => ({ date, confidence, frp }));
}

describe('threshold helpers', () => {
  test('watch level is ceil(threshold/2), minimum 1', () => {
    expect(watchThresholdFor(1)).toBe(1);
    expect(watchThresholdFor(3)).toBe(2);
    expect(watchThresholdFor(5)).toBe(3);
    expect(watchThresholdFor(10)).toBe(5);
  });

  test('windowFor covers exactly lookback days inclusive', () => {
    const w = windowFor('2026-10-15', 7);
    expect(w.start).toBe('2026-10-09');
    expect(w.end).toBe('2026-10-15');
    expect(w.days).toHaveLength(7);
    expect(w.days[0]).toBe('2026-10-09');
    expect(w.days[6]).toBe('2026-10-15');
  });

  test('bboxForRadiusKm grows with radius and is capped', () => {
    const small = bboxForRadiusKm(0, 10, 5);
    const large = bboxForRadiusKm(0, 10, 25);
    expect(large.east - large.west).toBeGreaterThan(small.east - small.west);
    const capped = bboxForRadiusKm(0, 10, 100);
    expect(capped.east - capped.west).toBeCloseTo(0.6, 6);
    expect(capped.north - capped.south).toBeCloseTo(0.6, 6);
  });

  test('confidence rank orders low < nominal < high', () => {
    expect(confidenceRank('low')).toBeLessThan(confidenceRank('nominal'));
    expect(confidenceRank('nominal')).toBeLessThan(confidenceRank('high'));
    expect(isQualifying('low', 'nominal')).toBe(false);
    expect(isQualifying('nominal', 'nominal')).toBe(true);
    expect(isQualifying('high', 'high')).toBe(true);
    expect(isQualifying('low', 'low')).toBe(true);
  });
});

describe('status semantics', () => {
  test('alert when qualifying detections reach the threshold', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([
        ['2026-10-09', 'nominal', 3],
        ['2026-10-10', 'high', 9],
        ['2026-10-11', 'nominal', null],
        ['2026-10-12', 'high', 12],
        ['2026-10-14', 'high', 18.3],
        ['2026-10-14', 'low', 0.5],
      ]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('alert');
    expect(ev.detectionCount).toBe(5);
    expect(ev.byConfidence.low).toBe(1);
    expect(ev.byConfidence.high).toBe(3);
    expect(ev.maxFrpMW).toBe(18.3);
    expect(ev.daysWithDetections).toBe(5);
    expect(ev.coverageComplete).toBe(true);
    expect(ev.rationale).toContain('ALERT');
  });

  test('watch at half the threshold with complete coverage', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([
        ['2026-10-10', 'high', 2],
        ['2026-10-11', 'nominal', 1],
        ['2026-10-12', 'high', 2],
      ]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('watch');
    expect(ev.watchThreshold).toBe(3);
  });

  test('clear requires complete coverage and low counts', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([['2026-10-10', 'low', 1]]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('clear');
    expect(ev.detectionCount).toBe(0);
    expect(ev.perDay.find((d) => d.date === '2026-10-10')?.total).toBe(1);
  });

  test('unverified when no day was ever checked', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(false),
      detections: [],
      minConfidence: 'low',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('unverified');
    expect(ev.daysChecked).toBe(0);
    expect(ev.rationale).toContain('UNVERIFIED');
  });

  test('zero detections with partial coverage stays unverified, not clear', () => {
    const partial = days(true).map((d, i) => ({ ...d, checked: i < 2 }));
    const ev = evaluateWatchlist({
      ...base,
      days: partial,
      detections: [],
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('unverified');
    expect(ev.daysUnchecked).toHaveLength(5);
    expect(ev.coverageComplete).toBe(false);
  });

  test('real detections with partial coverage escalate honestly to alert/watch', () => {
    const partial = days(true).map((d, i) => ({ ...d, checked: i < 2 }));
    const ev = evaluateWatchlist({
      ...base,
      days: partial,
      detections: detections([
        ['2026-10-09', 'nominal', 1],
        ['2026-10-10', 'high', 2],
        ['2026-10-11', 'high', 2], // unchecked day detection still counted (stored row)
      ]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    // 3 qualifying ≥ watch level 3 → but coverage incomplete: detections seen
    // keep it honest at watch-or-above; below threshold it must be watch, not clear.
    expect(['watch', 'alert']).toContain(ev.status);
  });

  test('alert fires regardless of coverage gaps (real detections seen)', () => {
    const partial = days(true).map((d, i) => ({ ...d, checked: i < 1 }));
    const ev = evaluateWatchlist({
      ...base,
      days: partial,
      detections: detections([
        ['2026-10-09', 'nominal', 1],
        ['2026-10-10', 'nominal', 2],
        ['2026-10-11', 'high', 3],
        ['2026-10-12', 'nominal', 4],
        ['2026-10-13', 'high', 5],
      ]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.status).toBe('alert');
    expect(ev.coverageComplete).toBe(false);
  });
});

describe('confidence floor and reporting', () => {
  test('minConfidence=high counts only high detections', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([
        ['2026-10-09', 'low', 1],
        ['2026-10-10', 'nominal', 1],
        ['2026-10-11', 'high', 5],
      ]),
      minConfidence: 'high',
      detectionThreshold: 1,
    });
    expect(ev.detectionCount).toBe(1);
    expect(ev.status).toBe('alert');
    expect(ev.byConfidence).toEqual({ low: 1, nominal: 1, high: 1 });
  });

  test('archive-gap days are reported, never zero-filled', () => {
    const withGap = days(true).map((d) => ({ ...d, dataAvailable: d.date !== '2026-10-12' }));
    const ev = evaluateWatchlist({
      ...base,
      days: withGap,
      detections: [],
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    expect(ev.daysNoData).toEqual(['2026-10-12']);
    expect(ev.rationale).toContain('archive gaps');
    expect(ev.status).toBe('unverified'); // checked-but-missing is not evidence of no fires
    expect(ev.coverageComplete).toBe(false);
  });

  test('perDay counts total vs qualifying separately', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([
        ['2026-10-10', 'low', null],
        ['2026-10-10', 'nominal', 2],
        ['2026-10-10', 'high', 4],
      ]),
      minConfidence: 'nominal',
      detectionThreshold: 5,
    });
    const day = ev.perDay.find((d) => d.date === '2026-10-10');
    expect(day?.total).toBe(3);
    expect(day?.qualifying).toBe(2);
  });

  test('detections outside the window are not counted', () => {
    const ev = evaluateWatchlist({
      ...base,
      days: days(true),
      detections: detections([['2025-01-01', 'high', 9]]),
      minConfidence: 'low',
      detectionThreshold: 1,
    });
    expect(ev.detectionCount).toBe(0);
    expect(ev.daysWithDetections).toBe(0);
    expect(ev.status).toBe('clear');
  });
});

describe('backtest date validation', () => {
  const TODAY = '2026-11-14';

  test('addDaysIso crosses month and year boundaries on the UTC grid', () => {
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28'); // 2026 is not a leap year
    expect(addDaysIso('2024-03-01', -1)).toBe('2024-02-29'); // 2024 is a leap year
    expect(addDaysIso('2026-11-14', 0)).toBe('2026-11-14');
  });

  test('minBacktestEndIso keeps the whole lookback window inside the archive', () => {
    expect(minBacktestEndIso(1)).toBe(FIRE_ARCHIVE_START);
    expect(minBacktestEndIso(7)).toBe('2015-01-07');
    expect(minBacktestEndIso(30)).toBe('2015-01-30');
    // the window ending at the minimum is exactly the archive head
    expect(windowFor(minBacktestEndIso(7), 7).start).toBe(FIRE_ARCHIVE_START);
  });

  test('validateEvalEnd rejects future dates', () => {
    expect(validateEvalEnd('2026-11-15', 7, TODAY)).toContain('cannot be in the future');
    expect(validateEvalEnd(TODAY, 7, TODAY)).toBeNull(); // today itself is allowed (partial VIIRS day)
  });

  test('validateEvalEnd rejects dates before the archive start', () => {
    expect(validateEvalEnd('2014-12-31', 7, TODAY)).toBe(`VIIRS fire archive starts ${FIRE_ARCHIVE_START}`);
  });

  test('validateEvalEnd rejects end dates whose window would precede the archive', () => {
    const msg = validateEvalEnd('2015-01-05', 7, TODAY);
    expect(msg).toContain('would start before the VIIRS archive begins');
    expect(msg).toContain('2015-01-07'); // the minimum usable end
    expect(validateEvalEnd('2015-01-07', 7, TODAY)).toBeNull();
    expect(validateEvalEnd('2015-01-06', 30, TODAY)).toContain('30-day window');
  });

  test('yesterdayIso subtracts exactly one UTC day', () => {
    expect(yesterdayIso(new Date('2026-11-14T00:00:00Z'))).toBe('2026-11-13');
    expect(yesterdayIso(new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-31');
  });
});

describe('scheduling core', () => {
  const NOW = new Date('2026-11-14T08:00:00Z');

  const watch = (over: Partial<SchedulableWatch>): SchedulableWatch => ({
    id: over.id ?? 'w1',
    name: over.name ?? 'list',
    reevaluateIntervalMin: over.reevaluateIntervalMin ?? null,
    nextReevaluateAt: over.nextReevaluateAt ?? null,
  });

  test('cadence membership: only 360 | 720 | 1440 are valid', () => {
    expect([...REEVALUATE_INTERVALS]).toEqual([360, 720, 1440]);
    expect(isReevaluateInterval(360)).toBe(true);
    expect(isReevaluateInterval(60)).toBe(false);
    expect(isReevaluateInterval(null)).toBe(false);
    expect(isReevaluateInterval('720')).toBe(false);
  });

  test('nextRunAfter advances by exactly the interval, no drift', () => {
    expect(nextRunAfter(NOW.getTime(), 360).toISOString()).toBe('2026-11-14T14:00:00.000Z');
    expect(nextRunAfter(NOW.getTime(), 1440).toISOString()).toBe('2026-11-15T08:00:00.000Z');
  });

  test('isDue: needs a cadence and a reached claim time', () => {
    expect(isDue(watch({ reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T07:59:59Z' }), NOW)).toBe(true);
    expect(isDue(watch({ reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T08:00:00Z' }), NOW)).toBe(true);
    expect(isDue(watch({ reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T08:00:01Z' }), NOW)).toBe(false);
    expect(isDue(watch({ reevaluateIntervalMin: null, nextReevaluateAt: '2020-01-01T00:00:00Z' }), NOW)).toBe(false);
    // a cadence with no claim yet (legacy row) is due immediately
    expect(isDue(watch({ reevaluateIntervalMin: 1440, nextReevaluateAt: null }), NOW)).toBe(true);
  });

  test('selectDueWatchlists orders by oldest claim and caps at maxRuns', () => {
    const rows = [
      watch({ id: 'a', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T06:00:00Z' }),
      watch({ id: 'b', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T05:00:00Z' }), // oldest
      watch({ id: 'c', reevaluateIntervalMin: null, nextReevaluateAt: '2020-01-01T00:00:00Z' }), // not schedulable
      watch({ id: 'd', reevaluateIntervalMin: 1440, nextReevaluateAt: '2026-11-13T08:00:00Z' }), // even older claim
      watch({ id: 'e', reevaluateIntervalMin: 720, nextReevaluateAt: '2026-11-14T09:00:00Z' }), // not due
    ];
    const due = selectDueWatchlists(rows, NOW, 2);
    expect(due.map((w) => w.id)).toEqual(['d', 'b']);
  });

  test('runSchedulerTick claims before running and evaluates within budget', async () => {
    const rows = [
      watch({ id: 'aaaa1111', name: 'Kafue', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T06:00:00Z' }),
      watch({ id: 'bbbb2222', name: 'Zambia Central', reevaluateIntervalMin: 720, nextReevaluateAt: '2026-11-14T05:00:00Z' }),
      watch({ id: 'cccc3333', name: 'Not due', reevaluateIntervalMin: 720, nextReevaluateAt: '2026-11-14T20:00:00Z' }),
    ];
    const claims: { id: string; nextAt: string }[] = [];
    const evaluated: string[] = [];
    const outcomes: string[] = [];
    const deps: TickDeps = {
      now: NOW,
      maxRuns: 2,
      listCandidates: async () => rows,
      claim: async (w, nextAt) => {
        claims.push({ id: w.id, nextAt: nextAt.toISOString() });
        return true;
      },
      evaluate: async (w) => {
        evaluated.push(w.id);
        return { status: 'clear', detectionCount: 0 };
      },
      recordOutcome: async (w, o) => {
        outcomes.push(`${w.id}:${o.ok ? o.status : 'fail'}`);
      },
      isInFlight: () => false,
    };

    const res = await runSchedulerTick(deps);
    expect(res.dueCount).toBe(2); // 'cccc3333' not due
    expect(res.ran).toBe(2);
    // claim happens BEFORE evaluate for every run (crash-safe ordering)
    expect(claims.map((c) => c.id)).toEqual(['bbbb2222', 'aaaa1111']); // oldest claim first
    expect(claims[0].nextAt).toBe('2026-11-14T20:00:00.000Z'); // claimed from NOW: 08:00 + 720 min
    expect(claims[1].nextAt).toBe('2026-11-14T14:00:00.000Z'); // claimed from NOW: 08:00 + 360 min
    expect(evaluated).toEqual(['bbbb2222', 'aaaa1111']);
    expect(outcomes).toEqual(['bbbb2222:clear', 'aaaa1111:clear']);
    expect(res.runs.every((r) => r.ok && r.status === 'clear')).toBe(true);
    // correlation IDs are scheduler-scoped and fit the 4-64 char contract
    expect(res.runs[0].correlationId).toMatch(/^sched-[a-z0-9]+-[a-z0-9]{8}$/);
  });

  test('runSchedulerTick records failures, still claims ahead (no hot-loop)', async () => {
    const rows = [watch({ id: 'fail9999', name: 'Broken', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T06:00:00Z' })];
    let evaluations = 0;
    const deps: TickDeps = {
      now: NOW,
      maxRuns: 5,
      listCandidates: async () => rows,
      claim: async () => true,
      evaluate: async () => {
        evaluations += 1;
        throw new Error('GIBS unreachable');
      },
      recordOutcome: async (_w, o) => {
        expect(o.ok).toBe(false);
        if (!o.ok) expect(o.error).toBe('GIBS unreachable');
      },
      isInFlight: () => false,
    };
    const res = await runSchedulerTick(deps);
    expect(res.ran).toBe(1);
    expect(evaluations).toBe(1);
    expect(res.runs[0].ok).toBe(false);
    expect(res.runs[0].error).toBe('GIBS unreachable');
    expect(res.runs[0].claimedNextAt).toBe('2026-11-14T14:00:00.000Z'); // advanced from NOW despite failure
  });

  test('runSchedulerTick skips watchlists already in flight and honors maxRuns', async () => {
    const rows = [
      watch({ id: 'inflight1', name: 'Busy', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-13T00:00:00Z' }),
      watch({ id: 'queued0001', name: 'Queued A', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-13T01:00:00Z' }),
      watch({ id: 'queued0002', name: 'Queued B', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-13T02:00:00Z' }),
      watch({ id: 'queued0003', name: 'Queued C', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-13T03:00:00Z' }),
    ];
    const evaluated: string[] = [];
    const deps: TickDeps = {
      now: NOW,
      maxRuns: 2,
      listCandidates: async () => rows,
      claim: async () => true,
      evaluate: async (w) => {
        evaluated.push(w.id);
        return { status: 'watch', detectionCount: 2 };
      },
      recordOutcome: async () => {},
      isInFlight: (w) => w.id === 'inflight1',
    };
    const res = await runSchedulerTick(deps);
    expect(res.skippedRunning).toBe(true);
    expect(evaluated).toEqual(['queued0001', 'queued0002']); // budget of 2 respected
    expect(res.ran).toBe(2);
  });

  test('runSchedulerTick skips a lost claim race (atomic claim contract)', async () => {
    const rows = [watch({ id: 'racelose1', name: 'Contended', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T06:00:00Z' })];
    let evaluations = 0;
    const deps: TickDeps = {
      now: NOW,
      maxRuns: 5,
      listCandidates: async () => rows,
      // another claimant won the conditional update between select and claim
      claim: async () => false,
      evaluate: async () => {
        evaluations += 1;
        return { status: 'clear', detectionCount: 0 };
      },
      recordOutcome: async () => {
        throw new Error('a lost race must not record an outcome');
      },
      isInFlight: () => false,
    };
    const res = await runSchedulerTick(deps);
    expect(res.ran).toBe(1);
    expect(evaluations).toBe(0); // the winner runs it — this caller skipped
    expect(res.runs[0].lostRace).toBe(true);
    expect(res.runs[0].ok).toBe(true);
  });

  test('claim receives the tick now so the guard window matches due time', async () => {
    const rows = [watch({ id: 'nowcheck1', name: 'Timing', reevaluateIntervalMin: 360, nextReevaluateAt: '2026-11-14T06:00:00Z' })];
    const seen: string[] = [];
    const deps: TickDeps = {
      now: NOW,
      maxRuns: 1,
      listCandidates: async () => rows,
      claim: async (_w, _nextAt, now) => {
        seen.push(now.toISOString());
        return true;
      },
      evaluate: async () => ({ status: 'clear', detectionCount: 0 }),
      recordOutcome: async () => {},
      isInFlight: () => false,
    };
    await runSchedulerTick(deps);
    expect(seen).toEqual([NOW.toISOString()]);
  });
});
