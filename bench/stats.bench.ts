import { describe, test } from 'vitest';
import { aggregateAnnual, aggregateMonthly, analyzeTrend } from '@/lib/stats/analyze';
import {
  benjaminiHochberg,
  mannKendall,
  seasonalMannKendall,
  theilSenConfidence,
  theilSenSlope,
  tieCorrectedVariance,
} from '@/lib/stats/core';
import { PRECIP_12Y, T2M_12Y, T2M_30Y, monthlySeries, seasonalSeries } from './fixtures';

const SEASONAL_12Y = seasonalSeries(12, 10);
const SEASONAL_40Y = seasonalSeries(40, 11);
const MONTHLY_144 = monthlySeries(144, 12);
const MONTHLY_240 = monthlySeries(240, 13);
const MONTHLY_240_VAR = tieCorrectedVariance(MONTHLY_240);
const P_VALUES = monthlySeries(200, 14).map((v) => (v % 1 + 1) % 1);

describe('stats', () => {
  // Full trend pipeline run by the Environmental Analysis view, per variable.
  test('analyzeTrend', async ({ bench }) => {
    await bench.compare(
      bench('precipitation, 12 years daily', () => {
        analyzeTrend({
          variable: 'PRECTOTCORR', label: 'Precipitation', unit: 'mm/day', points: PRECIP_12Y,
          periodStart: '2013-01-01', periodEnd: '2024-12-31', allPValues: [0.01, 0.2, 0.04], pIndex: 0,
        });
      }),
      bench('mean temperature, 12 years daily', () => {
        analyzeTrend({
          variable: 'T2M', label: 'Mean temperature', unit: '°C', points: T2M_12Y,
          periodStart: '2013-01-01', periodEnd: '2024-12-31',
        });
      }),
      bench('mean temperature, 30 years daily', () => {
        analyzeTrend({
          variable: 'T2M', label: 'Mean temperature', unit: '°C', points: T2M_30Y,
          periodStart: '1995-01-01', periodEnd: '2024-12-31',
        });
      }),
    );
  });

  test('aggregation', async ({ bench }) => {
    await bench.compare(
      bench('aggregateMonthly, 12 years daily', () => {
        aggregateMonthly('PRECTOTCORR', PRECIP_12Y);
      }),
      bench('aggregateAnnual, 30 years daily', () => {
        aggregateAnnual('T2M', T2M_30Y);
      }),
    );
  });

  test('seasonalMannKendall', async ({ bench }) => {
    await bench.compare(
      bench('seasonalMannKendall, 12 seasons x 12 years', () => {
        seasonalMannKendall(SEASONAL_12Y);
      }),
      bench('seasonalMannKendall, 12 seasons x 40 years', () => {
        seasonalMannKendall(SEASONAL_40Y);
      }),
    );
  });

  test('mannKendall with Hamed-Rao correction', async ({ bench }) => {
    await bench.compare(
      bench('mannKendall, 144 values', () => {
        mannKendall({ values: MONTHLY_144 });
      }),
      bench('mannKendall, 240 values', () => {
        mannKendall({ values: MONTHLY_240 });
      }),
    );
  });

  test('Theil-Sen and FDR', async ({ bench }) => {
    await bench.compare(
      bench('theilSenSlope, 240 values', () => {
        theilSenSlope(MONTHLY_240);
      }),
      bench('theilSenConfidence, 240 values', () => {
        theilSenConfidence(MONTHLY_240, MONTHLY_240_VAR);
      }),
      bench('benjaminiHochberg, 200 p-values', () => {
        benjaminiHochberg(P_VALUES);
      }),
    );
  });
});
