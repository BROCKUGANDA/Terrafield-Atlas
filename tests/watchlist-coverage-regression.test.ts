import { expect, test } from 'bun:test';
import { evaluateWatchlist } from '@/lib/fires/watchlist-engine';

test('checked but missing archive coverage cannot establish a clear window', () => {
  const result = evaluateWatchlist({
    windowStart: '2026-01-01', windowEnd: '2026-01-03', lookbackDays: 3,
    detectionThreshold: 5, minConfidence: 'nominal', detections: [],
    days: ['2026-01-01', '2026-01-02', '2026-01-03'].map(date => ({ date, checked: true, dataAvailable: false })),
  });
  expect(result.status).toBe('unverified');
  expect(result.coverageComplete).toBe(false);
  expect(result.daysNoData).toHaveLength(3);
  expect(result.rationale).toContain('no usable archive coverage');
});