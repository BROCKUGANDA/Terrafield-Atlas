/**
 * TerraField Atlas — shared domain types.
 * Every observation carries provenance; every score carries an explanation.
 */

export type VariableKey =
  | 'PRECTOTCORR'
  | 'T2M'
  | 'T2M_MAX'
  | 'T2M_MIN'
  | 'ALLSKY_SFC_SW_DWN'
  | 'RH2M'
  | 'WS2M'
  | 'GWETROOT'
  | 'GWETTOP';

export interface VariableMeta {
  key: VariableKey;
  label: string;
  unit: string;
  community: 'AG' | 'RE';
  description: string;
  /** Lower bound for plausible physical values (sanity guard, not clamping). */
  plausibleMin?: number;
  plausibleMax?: number;
}

export const POWER_VARIABLES: VariableMeta[] = [
  {
    key: 'PRECTOTCORR', label: 'Precipitation', unit: 'mm/day', community: 'AG',
    description: 'Daily total corrected precipitation (MERRA-2 assimilated).',
    plausibleMin: 0, plausibleMax: 400,
  },
  {
    key: 'T2M', label: 'Mean temperature', unit: '°C', community: 'AG',
    description: 'Temperature at 2 meters above ground, daily mean.',
    plausibleMin: -70, plausibleMax: 60,
  },
  {
    key: 'T2M_MAX', label: 'Maximum temperature', unit: '°C', community: 'AG',
    description: 'Daily maximum temperature at 2 meters.',
    plausibleMin: -70, plausibleMax: 65,
  },
  {
    key: 'T2M_MIN', label: 'Minimum temperature', unit: '°C', community: 'AG',
    description: 'Daily minimum temperature at 2 meters.',
    plausibleMin: -80, plausibleMax: 50,
  },
  {
    key: 'ALLSKY_SFC_SW_DWN', label: 'Solar radiation', unit: 'MJ/m²/day', community: 'AG',
    description: 'All-sky insolation incident on a horizontal surface (POWER v2.10 returns MJ/m²/day).',
    plausibleMin: 0, plausibleMax: 40,
  },
  {
    key: 'RH2M', label: 'Relative humidity', unit: '%', community: 'AG',
    description: 'Relative humidity at 2 meters.',
    plausibleMin: 0, plausibleMax: 100,
  },
  {
    key: 'WS2M', label: 'Wind speed', unit: 'm/s', community: 'AG',
    description: 'Wind speed at 2 meters.',
    plausibleMin: 0, plausibleMax: 60,
  },
  {
    key: 'GWETROOT', label: 'Root-zone wetness', unit: 'fraction 0–1', community: 'RE',
    description: 'MERRA-2 root-zone soil wetness (model-assimilated, NOT a substitute for measured soil properties).',
    plausibleMin: 0, plausibleMax: 1,
  },
  {
    key: 'GWETTOP', label: 'Surface wetness', unit: 'fraction 0–1', community: 'RE',
    description: 'MERRA-2 surface (topsoil) wetness fraction.',
    plausibleMin: 0, plausibleMax: 1,
  },
];

export interface ObservationPoint {
  date: string; // YYYY-MM-DD
  value: number | null; // null = missing/fill value, never fabricated
}

export interface PowerSeries {
  variable: VariableKey;
  unit: string;
  points: ObservationPoint[];
}

export interface PowerFetchMeta {
  apiVersion: string;
  timeStandard: string;
  sources: string;
  fillValue: number;
  requestedPoints: number;
  validPoints: number;
  missingPoints: number;
  retrievedAt: string;
  url: string;
}

export interface PowerFetchResult {
  lat: number;
  lon: number;
  start: string;
  end: string;
  series: PowerSeries[];
  meta: PowerFetchMeta;
}

export interface TrendFactor {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface TrendExplanation {
  headline: string;
  interpretation: string;
  caveats: string[];
}

export interface TrendResult {
  variable: VariableKey;
  label: string;
  unit: string;
  periodStart: string;
  periodEnd: string;
  observationPeriodYears: number;
  sampleCount: number;
  missingCount: number;
  method: string;
  seasonalMethod: string;
  direction: 'increasing' | 'decreasing' | 'no trend';
  slopePerYear: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  zValue: number | null;
  pValue: number | null;
  significant: boolean;
  autocorrelationAdjusted: boolean;
  minSampleSatisfied: boolean;
  multipleTestingAdjustedP: number | null;
  anomalies: { date: string; value: number; zScore: number }[];
  monthlyClimatology: { month: number; mean: number; std: number; n: number }[];
  explanation: TrendExplanation;
  warnings: string[];
}

export interface RotationFactorScore {
  criterion: string;
  weight: number;
  score: number | null; // null = not assessed due to missing data
  missingDataReason?: string;
  explanation: string;
}

export interface RotationScenarioResult {
  scenarioName: string;
  cropKeys: string[];
  cropNames: string[];
  factors: RotationFactorScore[];
  overallScore: number;
  confidence: number;
  incompatible: { rule: string; detail: string }[];
  missingInformation: string[];
  narrative: string[];
  ruleVersion: string;
  weightsUsed: Record<string, number>;
}
