import { describe, test, expect } from 'bun:test';
import { validatePowerRequest, PowerValidationError } from '@/lib/adapters/power';
import { parseBoundaryGeoJson } from '@/lib/geo';
import { aggregateMonthly, analyzeTrend, MIN_YEARS_FOR_TREND } from '@/lib/stats/analyze';
import type { ObservationPoint } from '@/lib/types';
import { tilesForBbox, fetchFiresForDate } from '@/lib/adapters/gibsFires';

/**
 * Adapter validation + geometry + aggregation tests (no network: pure logic).
 */

describe('POWER request validation', () => {
  const base = { lat: -0.28, lon: 36.07, start: '2015-01-01', end: '2015-12-31', variables: ['T2M' as const] };

  test('valid request passes', () => {
    expect(() => validatePowerRequest(base)).not.toThrow();
  });
  test('latitude out of range rejected', () => {
    expect(() => validatePowerRequest({ ...base, lat: 95 })).toThrow(PowerValidationError);
    expect(() => validatePowerRequest({ ...base, lat: -91 })).toThrow();
  });
  test('longitude out of range rejected', () => {
    expect(() => validatePowerRequest({ ...base, lon: 181 })).toThrow();
  });
  test('end before start rejected', () => {
    expect(() => validatePowerRequest({ ...base, start: '2016-01-01', end: '2015-01-01' })).toThrow();
  });
  test('range beyond 15 years rejected (chunking contract)', () => {
    expect(() => validatePowerRequest({ ...base, start: '2000-01-01', end: '2020-01-01' })).toThrow();
  });
  test('future end date rejected (availability lag)', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    expect(() => validatePowerRequest({ ...base, end: future.toISOString().slice(0, 10) })).toThrow();
  });
  test('unsupported variable rejected', () => {
    expect(() => validatePowerRequest({ ...base, variables: ['NOT_A_VAR' as never] })).toThrow();
  });
});

describe('GeoJSON boundary validation (safe parsing)', () => {
  const ring = (pts: number[][]) => JSON.stringify({ type: 'Polygon', coordinates: [pts] });
  const square = (west: number, south: number, size = 0.01): number[][] => [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];

  test('valid square parses with computed area and centroid', () => {
    const g = parseBoundaryGeoJson(ring(square(36.0, -0.3)));
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.areaHa).toBeGreaterThan(0);
      expect(g.vertices).toBe(4);
      expect(g.centroid.lat).toBeGreaterThan(-0.31);
      expect(g.centroid.lat).toBeLessThan(-0.29);
    }
  });
  test('unclosed ring rejected', () => {
    const open = [[36, -0.3], [36.01, -0.3], [36.01, -0.29], [36, -0.29]];
    const g = parseBoundaryGeoJson(ring(open));
    expect(g.ok).toBe(false);
  });
  test('self-intersecting bowtie rejected', () => {
    const bowtie = [[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]];
    const g = parseBoundaryGeoJson(ring(bowtie));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('self-intersect');
  });
  test('out-of-range coordinates rejected', () => {
    const g = parseBoundaryGeoJson(ring([[0, 0], [200, 0], [200, 1], [0, 1], [0, 0]]));
    expect(g.ok).toBe(false);
  });
  test('too many vertices rejected', () => {
    const pts: number[][] = [];
    for (let i = 0; i < 70; i++) pts.push([i * 0.0001, 0]);
    pts.push([0, 0.01], [0, 0]);
    const g = parseBoundaryGeoJson(ring(pts));
    expect(g.ok).toBe(false);
  });
  test('non-JSON rejected without throwing', () => {
    const g = parseBoundaryGeoJson('not json at all');
    expect(g.ok).toBe(false);
  });
  test('holes rejected', () => {
    const geojson = JSON.stringify({
      type: 'Polygon',
      coordinates: [square(0, 0), [[0.002, 0.002], [0.003, 0.002], [0.003, 0.003], [0.002, 0.002]]],
    });
    const g = parseBoundaryGeoJson(geojson);
    expect(g.ok).toBe(false);
  });
});

describe('monthly aggregation rules', () => {
  const mk = (year: number, month: number, day: number, value: number | null): ObservationPoint => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    value,
  });

  test('precipitation sums; missing days counted, never imputed', () => {
    const points: ObservationPoint[] = [];
    for (let d = 1; d <= 30; d++) points.push(mk(2020, 6, d, d === 15 ? null : 1));
    const { monthly, missingDays, daysTotal } = aggregateMonthly('PRECTOTCORR', points);
    expect(monthly.length).toBe(1);
    expect(monthly[0].value).toBe(29); // 29 valid days × 1mm
    expect(missingDays).toBe(1);
    expect(daysTotal).toBe(30);
  });
  test('temperature averages', () => {
    const points: ObservationPoint[] = [];
    for (let d = 1; d <= 28; d++) points.push(mk(2021, 2, d, 10));
    const { monthly } = aggregateMonthly('T2M', points);
    expect(monthly[0].value).toBe(10);
  });
  test('months with < 20 valid days are excluded from the series', () => {
    const points: ObservationPoint[] = [];
    for (let d = 1; d <= 10; d++) points.push(mk(2021, 3, d, 5));
    const { monthly } = aggregateMonthly('T2M', points);
    expect(monthly.length).toBe(0);
  });
});

describe('trend engine — honest insufficient-data path', () => {
  const series = (years: number): ObservationPoint[] => {
    const pts: ObservationPoint[] = [];
    for (let y = 0; y < years; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 25; d++) {
          pts.push({ date: `${2015 + y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, value: 100 + y });
        }
      }
    }
    return pts;
  };

  test(`fewer than ${MIN_YEARS_FOR_TREND} years → no significance claimed`, () => {
    const r = analyzeTrend({ variable: 'T2M', label: 'T', unit: '°C', points: series(5), periodStart: '2015-01-01', periodEnd: '2019-12-31' });
    expect(r.minSampleSatisfied).toBe(false);
    expect(r.significant).toBe(false);
    expect(r.direction).toBe('no trend');
    expect(r.explanation.headline).toContain('Insufficient');
  });

  test('long artificial monotonic increase is detected as significant', () => {
    const pts: ObservationPoint[] = [];
    for (let y = 0; y < 12; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 25; d++) {
          pts.push({ date: `${2010 + y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, value: 100 + y * 2 });
        }
      }
    }
    const r = analyzeTrend({ variable: 'T2M', label: 'T', unit: '°C', points: pts, periodStart: '2010-01-01', periodEnd: '2021-12-31' });
    expect(r.minSampleSatisfied).toBe(true);
    expect(r.significant).toBe(true);
    expect(r.direction).toBe('increasing');
    expect(r.slopePerYear).toBeGreaterThan(1.9);
    // units for a mean-aggregated variable stay the daily unit family
    expect(r.unit).toBe('°C');
  });

  test('rainfall slope is expressed in mm/month (monthly total series)', () => {
    const pts: ObservationPoint[] = [];
    for (let y = 0; y < 12; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 25; d++) {
          pts.push({ date: `${2010 + y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, value: 2 });
        }
      }
    }
    const r = analyzeTrend({ variable: 'PRECTOTCORR', label: 'Rain', unit: 'mm/day', points: pts, periodStart: '2010-01-01', periodEnd: '2021-12-31' });
    expect(r.unit).toBe('mm/month');
  });
});

describe('GIBS fire tile math (EPSG:4326 500m level 7 grid)', () => {
  test('single small bbox → one tile with correct row/col', () => {
    // lon 0.1–0.3 → col 80 (both sides inside one 2.25° tile);
    // lat -0.4–-0.1 → row 40
    const tiles = tilesForBbox({ west: 0.1, south: -0.4, east: 0.3, north: -0.1 });
    expect(tiles.length).toBe(1);
    expect(tiles[0].row).toBe(40);
    expect(tiles[0].col).toBe(80);
  });
  test('bbox crossing a tile boundary yields multiple tiles', () => {
    const tiles = tilesForBbox({ west: -0.2, south: -0.4, east: 0.2, north: -0.1 });
    expect(tiles.length).toBe(2); // cols 79 and 80
  });
  test('oversized bbox is rejected by the fetch guard', async () => {
    // 10°×10° → 25 tiles > 12-tile cap; fetchFiresForDate must throw before any network call
    const big = { west: 20, south: -20, east: 30, north: -10 };
    await expect(fetchFiresForDate('2024-08-15', big)).rejects.toThrow('too large');
  });
});
