import { describe, test, expect } from 'bun:test';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import type { EngineEnvironment, Priorities, SoilInformation } from '@/lib/crops/rotation-engine';
import { CROP_CATALOGUE, cropByKey } from '@/lib/crops/catalogue';

/**
 * Rotation-engine unit tests: determinism, missing-data handling,
 * incompatibility flags, explainability contract.
 */

const RAIN: EngineEnvironment = {
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

const PRIORITIES: Priorities = {
  soilHealth: 0.25,
  waterEfficiency: 0.25,
  seasonalAdaptability: 0.15,
  nutrientManagement: 0.15,
  cropDiversity: 0.1,
  economics: 0,
  foodSecurity: 0.1,
};

const SOIL: SoilInformation = { ph: 6.2, texture: 'loam', source: 'farmer', organicCarbonPct: 1.8 };

describe('evaluateRotation — core contracts', () => {
  test('deterministic: identical inputs produce byte-identical outputs', () => {
    const a = evaluateRotation(['maize', 'cowpea', 'maize', 'common_bean'], 'B', RAIN, SOIL, PRIORITIES);
    const b = evaluateRotation(['maize', 'cowpea', 'maize', 'common_bean'], 'B', RAIN, SOIL, PRIORITIES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('rule version is exposed and stable', () => {
    const r = evaluateRotation(['maize'], 'x', RAIN, SOIL, PRIORITIES);
    expect(r.ruleVersion).toMatch(/^rot-engine\//);
    expect(r.ruleVersion).toBe(evaluateRotation(['maize'], 'x', RAIN, SOIL, PRIORITIES).ruleVersion);
  });

  test('continuous maize scores lower than maize-legume rotation', () => {
    const mono = evaluateRotation(['maize', 'maize', 'maize', 'maize'], 'A', RAIN, SOIL, PRIORITIES);
    const alt = evaluateRotation(['maize', 'cowpea', 'maize', 'common_bean'], 'B', RAIN, SOIL, PRIORITIES);
    expect(mono.overallScore).toBeLessThan(alt.overallScore);
    // and the family-repetition flag fires for the monoculture
    expect(mono.factors.find((f) => f.criterion.includes('Family-sequence'))!.score!).toBeLessThan(1);
  });

  test('missing soil data removes the soil criterion instead of zeroing it', () => {
    const r = evaluateRotation(['maize', 'cowpea'], 'B', RAIN, null, PRIORITIES);
    const soilFactor = r.factors.find((f) => f.criterion.includes('Soil pH'));
    expect(soilFactor?.score).toBeNull();
    expect(soilFactor?.missingDataReason).toBeTruthy();
    expect(r.missingInformation.length).toBeGreaterThan(0);
  });

  test('missing environmental record removes water + seasonal criteria', () => {
    const r = evaluateRotation(['maize'], 'x', { rainfall: null, thermal: null }, SOIL, PRIORITIES);
    expect(r.factors.find((f) => f.criterion.includes('Water-demand'))?.score).toBeNull();
    expect(r.factors.find((f) => f.criterion.includes('thermal'))?.score).toBeNull();
    // confidence strictly lower than with full environment
    const full = evaluateRotation(['maize'], 'x', RAIN, SOIL, PRIORITIES);
    expect(r.confidence).toBeLessThan(full.confidence);
  });

  test('economics criterion is honestly not-assessed', () => {
    const r = evaluateRotation(['maize'], 'x', RAIN, SOIL, { ...PRIORITIES, economics: 0.5 });
    const eco = r.factors.find((f) => f.criterion === 'Economic viability');
    expect(eco?.score).toBeNull();
    expect(eco?.missingDataReason).toContain('configured');
  });

  test('water-demand compatibility reflects FAO ranges vs rainfall', () => {
    // wet environment: maize (500-800mm) fits, so score high
    const wet: EngineEnvironment = {
      rainfall: { p25: RAIN.rainfall!.p25.map((v) => v * 2), p50: RAIN.rainfall!.p50.map((v) => v * 2), p75: RAIN.rainfall!.p75.map((v) => v * 2), years: 12 },
      thermal: RAIN.thermal,
    };
    const wetResult = evaluateRotation(['maize'], 'wet', wet, SOIL, PRIORITIES);
    const dryResult = evaluateRotation(['cotton'], 'dry', { ...RAIN, rainfall: { p25: RAIN.rainfall!.p25.map((v) => v / 4), p50: RAIN.rainfall!.p50.map((v) => v / 4), p75: RAIN.rainfall!.p75.map((v) => v / 4), years: 12 } }, SOIL, PRIORITIES);
    const wetWater = wetResult.factors.find((f) => f.criterion.includes('Water-demand'))!.score!;
    const dryWater = dryResult.factors.find((f) => f.criterion.includes('Water-demand'))!.score!;
    expect(wetWater).toBeGreaterThan(dryWater);
  });

  test('pH incompatibility is flagged, not buried', () => {
    const acidSoil: SoilInformation = { ph: 4.2, texture: 'sand', source: 'farmer', organicCarbonPct: null };
    const r = evaluateRotation(['common_bean', 'soybean'], 'x', RAIN, acidSoil, PRIORITIES);
    expect(r.incompatible.length).toBeGreaterThan(0);
    expect(r.incompatible[0].detail).toContain('pH');
  });

  test('narrative exists and mentions confidence for incomplete data', () => {
    const r = evaluateRotation(['maize', 'cowpea'], 'x', { rainfall: null, thermal: null }, null, PRIORITIES);
    expect(r.narrative.length).toBeGreaterThan(0);
    expect(r.narrative.some((n) => n.includes('confidence'))).toBe(true);
  });

  test('legume N contribution scores only with actual legumes', () => {
    const withLegume = evaluateRotation(['cowpea', 'maize'], 'l', RAIN, SOIL, PRIORITIES);
    const noLegume = evaluateRotation(['sorghum', 'maize'], 'n', RAIN, SOIL, PRIORITIES);
    const l = withLegume.factors.find((f) => f.criterion.includes('Legume nitrogen'))!.score!;
    const n = noLegume.factors.find((f) => f.criterion.includes('Legume nitrogen'))!.score!;
    expect(l).toBeGreaterThan(n);
  });

  test('unknown crop key rejected', () => {
    expect(() => evaluateRotation(['durian'], 'x', RAIN, SOIL, PRIORITIES)).toThrow();
  });

  test('SoilGrids-sourced soil lowers confidence vs farmer soil', () => {
    const modeled: SoilInformation = { ph: 6.2, texture: 'loam', source: 'soilgrids', organicCarbonPct: 1.8 };
    const a = evaluateRotation(['maize'], 'x', RAIN, SOIL, PRIORITIES);
    const b = evaluateRotation(['maize'], 'x', RAIN, modeled, PRIORITIES);
    expect(b.confidence).toBeLessThan(a.confidence);
  });
});

describe('crop catalogue integrity', () => {
  test('every crop carries ≥ 1 citation and FAO water ranges', () => {
    for (const c of CROP_CATALOGUE) {
      expect(c.sources.length).toBeGreaterThanOrEqual(1);
      expect(c.waterReqMm[0]).toBeLessThan(c.waterReqMm[1]);
      expect(c.waterReqMm[0]).toBeGreaterThan(0);
      expect(c.soilPh[0]).toBeLessThan(c.soilPh[1]);
      expect(c.family).toBeTruthy();
    }
  });
  test('water ranges match FAO I&D Paper 33 published values for key crops', () => {
    expect(cropByKey('maize')!.waterReqMm).toEqual([500, 800]);
    expect(cropByKey('wheat')!.waterReqMm).toEqual([450, 650]);
    expect(cropByKey('cotton')!.waterReqMm).toEqual([700, 1300]);
    expect(cropByKey('sorghum')!.waterReqMm).toEqual([450, 650]);
  });
});
