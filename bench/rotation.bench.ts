import { describe, test } from 'vitest';
import {
  evaluateRotation,
  type EngineEnvironment,
  type Priorities,
  type SoilInformation,
} from '@/lib/crops/rotation-engine';

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

describe('rotation', () => {
  // The Rotation Planner scores every scenario a user compares.
  test('evaluateRotation', async ({ bench }) => {
    await bench.compare(
      bench('4-crop maize-legume rotation', () => {
        evaluateRotation(['maize', 'cowpea', 'maize', 'common_bean'], 'B', ENV, SOIL, PRIORITIES);
      }),
      bench('8-crop rotation (maximum length)', () => {
        evaluateRotation(
          ['maize', 'cowpea', 'sorghum', 'common_bean', 'maize', 'cowpea', 'sorghum', 'common_bean'],
          'long', ENV, SOIL, PRIORITIES,
        );
      }),
      bench('4-crop rotation, no soil or climate record', () => {
        evaluateRotation(['maize', 'cowpea', 'maize', 'common_bean'], 'B', { rainfall: null, thermal: null }, null, PRIORITIES);
      }),
    );
  });
});
