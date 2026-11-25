import { describe, expect, test } from 'bun:test';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import type { EngineEnvironment, Priorities, SoilInformation } from '@/lib/crops/rotation-engine';
import { aggregateMonthlyPrices } from '@/lib/markets';

/**
 * Behavioural guards that pin down decision boundaries the broader suites leave
 * to implication. These are deliberately narrow: each test kills one specific
 * mutant from `scripts/mutation-check.ts` by asserting observable behaviour
 * (a score, a flag or an explanation), never source text.
 */

const ENV: EngineEnvironment = {
  rainfall: {
    p25: [40, 40, 90, 150, 120, 60, 30, 30, 40, 70, 110, 60],
    p50: [60, 60, 120, 200, 170, 80, 40, 40, 55, 95, 150, 80],
    p75: [90, 90, 160, 260, 220, 110, 55, 55, 75, 130, 200, 110],
    years: 12,
  },
  thermal: {
    meanT: [17, 17.5, 18.5, 19, 18.5, 17.5, 16.5, 16.5, 17.5, 18, 17.5, 17],
    years: 12,
  },
};

const SOIL: SoilInformation = { ph: 6.2, texture: 'loam', source: 'farmer', organicCarbonPct: 1.8 };

const PRIORITIES: Priorities = {
  soilHealth: 0.25,
  waterEfficiency: 0.25,
  seasonalAdaptability: 0.15,
  nutrientManagement: 0.15,
  cropDiversity: 0.1,
  economics: 0,
  foodSecurity: 0.1,
};

describe('rotation-engine boundary guards', () => {
  test('a half-legume sequence earns the full legume-N credit', () => {
    const result = evaluateRotation(['cowpea', 'maize'], 'guard', ENV, SOIL, PRIORITIES);
    const legume = result.factors.find((f) => f.criterion.includes('Legume nitrogen'))!;
    // 1 legume in 2 positions = fraction 0.5, and 0.5 is the documented target.
    expect(legume.score).toBe(1);
  });

  test('eight crop positions are accepted and nine are rejected', () => {
    const eight = ['maize', 'sorghum', 'pearl_millet', 'wheat', 'barley', 'common_bean', 'cowpea', 'groundnut'];
    expect(() => evaluateRotation(eight, 'guard', ENV, SOIL, PRIORITIES)).not.toThrow();
    expect(() => evaluateRotation([...eight, 'maize'], 'guard', ENV, SOIL, PRIORITIES)).toThrow(/too long/);
  });

  test('a single-crop sequence scores zero diversity without poisoning the overall score', () => {
    const result = evaluateRotation(['maize'], 'guard', ENV, SOIL, PRIORITIES);
    const diversity = result.factors.find((f) => f.criterion.includes('Crop diversity'))!;
    expect(diversity.score).toBe(0);
    expect(Number.isFinite(result.overallScore)).toBe(true);
  });

  test('the documented pH range is inclusive at its lower endpoint', () => {
    const atLowerBound: SoilInformation = { ...SOIL, ph: 5.5 };
    const result = evaluateRotation(['maize'], 'guard', ENV, atLowerBound, PRIORITIES);
    const soil = result.factors.find((f) => f.criterion.includes('Soil pH'))!;
    expect(soil.score).toBe(1);
    expect(result.incompatible).toHaveLength(0);
  });

  test('the 0.5 pH tolerance extends below the documented lower bound', () => {
    const withinTolerance: SoilInformation = { ...SOIL, ph: 5.0 };
    const result = evaluateRotation(['maize'], 'guard', ENV, withinTolerance, PRIORITIES);
    const soil = result.factors.find((f) => f.criterion.includes('Soil pH'))!;
    // inside = false, near (±0.5) = true, best texture = 1 → 0.6*0.5 + 0.4*1.
    expect(soil.score).toBe(0.7);
    expect(result.incompatible).toHaveLength(0);
  });

  test('a calorie staple raises the food-security score', () => {
    const maize = evaluateRotation(['maize'], 'guard', ENV, SOIL, PRIORITIES);
    const cotton = evaluateRotation(['cotton'], 'guard', ENV, SOIL, PRIORITIES);
    const stapleScore = (key: string) => {
      const result = key === 'maize' ? maize : cotton;
      return result.factors.find((f) => f.criterion === 'Staple-calorie presence')!.score;
    };
    expect(stapleScore('maize')).toBe(1);
    expect(stapleScore('cotton')).toBe(0);
  });

  test('a month at exactly 12 °C mean counts as part of the warm season', () => {
    const boundary: EngineEnvironment = {
      rainfall: ENV.rainfall,
      thermal: {
        meanT: [12, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
        years: 12,
      },
    };
    const result = evaluateRotation(['maize'], 'guard', boundary, SOIL, PRIORITIES);
    const seasonal = result.factors.find((f) => f.criterion.includes('thermal'))!;
    expect(seasonal.score).toBe(1);
    expect(seasonal.explanation).toContain('spans ~24 consecutive month(s)');
  });

  test('a rainfall record shorter than ten years lowers confidence', () => {
    const nine: EngineEnvironment = {
      rainfall: { ...ENV.rainfall!, years: 9 },
      thermal: ENV.thermal,
    };
    const eleven: EngineEnvironment = {
      rainfall: { ...ENV.rainfall!, years: 11 },
      thermal: ENV.thermal,
    };
    const short = evaluateRotation(['maize'], 'guard', nine, SOIL, PRIORITIES);
    const long = evaluateRotation(['maize'], 'guard', eleven, SOIL, PRIORITIES);
    expect(short.confidence).toBeLessThan(long.confidence);
  });
});

describe('market aggregation guards', () => {
  test('a zero price is dropped before aggregation, like any non-positive price', () => {
    const series = aggregateMonthlyPrices([
      { priceDate: new Date('2026-01-05T00:00:00.000Z'), price: 0 },
      { priceDate: new Date('2026-01-06T00:00:00.000Z'), price: 10 },
      { priceDate: new Date('2026-01-07T00:00:00.000Z'), price: -5 },
    ]);
    expect(series).toEqual([
      { month: '2026-01', median: 10, min: 10, max: 10, sampleCount: 1 },
    ]);
  });
});
