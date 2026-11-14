import { describe, test, expect } from 'bun:test';
import {
  evaluateWatchlist,
  watchThresholdFor,
  windowFor,
  bboxForRadiusKm,
  isQualifying,
  confidenceRank,
  type WatchDay,
  type WatchDetection,
} from '@/lib/fires/watchlist-engine';

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
    expect(ev.status).toBe('clear'); // gap day is checked-but-no-archive, not unchecked
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
