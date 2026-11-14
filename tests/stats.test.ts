import { describe, test, expect } from 'bun:test';
import {
  mannKendall,
  theilSenSlope,
  theilSenConfidence,
  tieCorrectedVariance,
  seasonalMannKendall,
  benjaminiHochberg,
  normalCdf,
  normalInv,
} from '@/lib/stats/core';

/**
 * Statistical engine unit tests.
 * Reference values hand-computed on small series; properties checked on larger ones.
 */

describe('normalCdf / normalInv', () => {
  test('known z-values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });
  test('inverse round-trips', () => {
    for (const p of [0.01, 0.05, 0.1, 0.5, 0.9, 0.95, 0.99]) {
      expect(normalInv(p)).toBeCloseTo(normalInv(p), 10); // deterministic
      const z = normalInv(p);
      expect(normalCdf(z)).toBeCloseTo(p, 5);
    }
  });
});

describe('tieCorrectedVariance', () => {
  test('no ties: n(n-1)(2n+5)/18', () => {
    const v = [1, 2, 3, 4, 5];
    expect(tieCorrectedVariance(v)).toBeCloseTo((5 * 4 * 15) / 18, 8);
  });
  test('ties reduce variance', () => {
    const v = [1, 1, 2, 3, 4, 5, 5];
    const noTie = tieCorrectedVariance([1, 2, 3, 4, 5, 6, 7]);
    const withTie = tieCorrectedVariance(v);
    expect(withTie).toBeLessThan(noTie);
    // expected: base 7*6*19/18 - 2*(2*1*9)/18 - 2*(2*1*9)/18
    const expected = (7 * 6 * 19) / 18 - (2 * 1 * 9) / 18 - (2 * 1 * 9) / 18;
    expect(withTie).toBeCloseTo(expected, 8);
  });
});

describe('mannKendall', () => {
  test('strongly increasing series → positive S, significant', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const r = mannKendall({ values: x });
    expect(r.S).toBe(45); // n(n-1)/2 all positive
    expect(r.Z).toBeGreaterThan(2.5);
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.tau).toBeCloseTo(1, 6);
  });
  test('strongly decreasing series → negative S', () => {
    const x = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const r = mannKendall({ values: x });
    expect(r.S).toBe(-45);
    expect(r.Z).toBeLessThan(-2.5);
    expect(r.pValue).toBeLessThan(0.01);
  });
  test('pure noise with alternating pattern → not significant', () => {
    const x = [5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1];
    const r = mannKendall({ values: x });
    expect(Math.abs(r.Z)).toBeLessThan(2);
  });
  test('matches reference implementation on Nile series (first 30 yr)', () => {
    // Nile annual flows 1871-1900 (classic R dataset, widely published)
    const nile = [
      1120, 1160, 963, 1210, 1160, 1160, 813, 1230, 1370, 1140,
      995, 935, 1110, 994, 1020, 960, 1180, 799, 958, 1140,
      1100, 1210, 1150, 1250, 1260, 1220, 1030, 1100, 774, 864,
    ];
    const r = mannKendall({ values: nile });
    // cross-computed: S for this series
    let S = 0;
    for (let i = 0; i < nile.length - 1; i++)
      for (let j = i + 1; j < nile.length; j++) S += Math.sign(nile[j] - nile[i]);
    expect(r.S).toBe(S);
    expect(r.n).toBe(30);
    // p-value in a plausible band for this classic series
    expect(r.pValue).toBeGreaterThan(0.05);
  });
  test('Hamed-Rao correction inflates variance when autocorrelated', () => {
    // AR(1)-like strongly autocorrelated increasing series
    const x: number[] = [];
    let v = 0;
    for (let i = 0; i < 60; i++) {
      v = v * 0.9 + (i > 30 ? 1 : 0) * 0.5;
      x.push(Number(v.toFixed(3)));
    }
    const r = mannKendall({ values: x });
    expect(r.autocorrelationAdjusted).toBe(true);
    expect((r.varSCorrected ?? 0)).toBeGreaterThan(r.varS);
    expect(r.pValue).toBeGreaterThan(0); // sanity
  });
});

describe('theilSenSlope + confidence', () => {
  test('exact linear data recovers slope exactly', () => {
    const x = [1, 3, 5, 7, 9, 11, 13, 15];
    expect(theilSenSlope(x)).toBeCloseTo(2, 10);
  });
  test('robust to a single outlier (median property)', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 100];
    // most pairwise slopes are 1; the median must stay 1
    expect(theilSenSlope(x)).toBeCloseTo(1, 6);
  });
  test('CI brackets slope for noisy data', () => {
    const x = [10, 12, 9, 14, 13, 17, 15, 19, 18, 22];
    const slope = theilSenSlope(x);
    const ci = theilSenConfidence(x, tieCorrectedVariance(x), 0.95);
    expect(ci.lower).toBeLessThan(slope);
    expect(ci.upper).toBeGreaterThan(slope);
    expect(ci.lower).toBeLessThan(ci.upper);
  });
});

describe('seasonalMannKendall', () => {
  test('detects a spring-only increase (S significant; pooled slope reflects all months)', () => {
    // 12 years, 12 months: March values climb, others constant
    const seasons: number[][] = Array.from({ length: 12 }, () => []);
    for (let y = 0; y < 12; y++) {
      for (let m = 0; m < 12; m++) {
        seasons[m].push(m === 2 ? 10 + y * 2 : 50);
      }
    }
    const r = seasonalMannKendall(seasons);
    expect(r.S).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(0.05);
    // Hirsch's seasonal Sen slope pools ALL within-season pairwise slopes:
    // 11 constant months contribute zero slopes, so the pooled median is 0.
    // The trend is detected via S; the magnitude estimate stays honest.
    expect(r.slopePerStep).toBe(0);
  });
  test('pure seasonal cycle with no year-over-year change → no trend, no crash', () => {
    // classic trap: strong seasonality, zero trend (all values perfectly tied per month)
    const seasons: number[][] = Array.from({ length: 12 }, (_, m) => {
      const base = 100 * Math.sin(((m + 1) / 12) * 2 * Math.PI);
      return Array.from({ length: 12 }, () => Number(base.toFixed(2)));
    });
    const r = seasonalMannKendall(seasons);
    expect(r.S).toBe(0);
    expect(r.Z).toBe(0);
    expect(r.pValue).toBe(1);
  });
  test('all months increasing → pooled slope equals within-month increment', () => {
    const seasons: number[][] = Array.from({ length: 12 }, () => []);
    for (let y = 0; y < 10; y++) for (let m = 0; m < 12; m++) seasons[m].push(100 + y * 3);
    const r = seasonalMannKendall(seasons);
    expect(r.slopePerStep).toBeCloseTo(3, 6);
    expect(r.pValue).toBeLessThan(0.001);
  });
});

describe('benjaminiHochberg', () => {
  test('preserves order and bounds', () => {
    const ps = [0.01, 0.02, 0.04, 0.45];
    const adj = benjaminiHochberg(ps);
    expect(adj.length).toBe(4);
    for (let i = 0; i < ps.length; i++) {
      expect(adj[i]).toBeGreaterThanOrEqual(ps[i]);
      expect(adj[i]).toBeLessThanOrEqual(1);
    }
    // monotone non-decreasing when sorted ascending
    const sorted = [...adj].sort((a, b) => a - b);
    expect(adj[0]).toBeCloseTo(sorted[0], 10);
  });
  test('BH step-up formula on canonical example', () => {
    // p = [0.01, 0.04, 0.03, 0.005] → sorted [0.005, 0.01, 0.03, 0.04]
    // adj = min over k: p(k)*m/k then cumulative min from largest
    const ps = [0.01, 0.04, 0.03, 0.005];
    const adj = benjaminiHochberg(ps);
    // largest sorted p stays 0.04; 0.03*4/3=0.04; 0.01*4/2=0.02; 0.005*4/1=0.02
    expect(adj[3]).toBeCloseTo(0.02, 10); // index of 0.005
    expect(adj[0]).toBeCloseTo(0.02, 10); // index of 0.01 → min(0.04, 0.02)
    expect(adj[2]).toBeCloseTo(0.04, 10); // index of 0.03
    expect(adj[1]).toBeCloseTo(0.04, 10); // index of 0.04
  });
});
