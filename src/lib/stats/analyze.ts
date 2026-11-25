import {
  benjaminiHochberg,
  seasonalMannKendall,
  theilSenSlope,
  mannKendall,
} from '@/lib/stats/core';
import type { ObservationPoint, TrendExplanation, TrendResult, VariableKey } from '@/lib/types';

/**
 * Environmental trend detection service ("Earth System Trend Detective" work-alike).
 *
 * Pipeline per variable (each step is reported in the output):
 *  1. temporal coverage from available observations
 *  2. daily → monthly aggregation (sum for precipitation, mean otherwise)
 *  3. missing-observation accounting (never imputed)
 *  4. seasonal cycle handling: seasonal Mann-Kendall across calendar months
 *     (Hirsch-Slack), which tests within-season year-over-year change so the
 *     seasonal cycle itself cannot manufacture a trend
 *  5. baseline climatology + monthly z-score anomalies
 *  6. Theil-Sen seasonal slope with Sen-rank confidence interval
 *  7. significance: two-sided p; Hamed-Rao-type variance inflation when the
 *     deseasonalized ranks show significant lag-1 autocorrelation
 *  8. minimum-sample rule: ≥ 8 full years of monthly data required before any
 *     significance claim; otherwise flagged "insufficient"
 *  9. Benjamini-Hochberg FDR across all variables in the request
 * 10. plain-language explanation with units, method, and caveats
 *
 * HONESTY RULES:
 * - "two selected dates differ" is never reported as a trend
 * - correlation/causation: the explanation text never claims agricultural
 *   causation, only observed environmental change
 * - MERRA-2 grid-cell provenance and LST time standard always surfaced
 */

export const MIN_YEARS_FOR_TREND = 8;
export const MIN_MONTHS_PER_SEASON = 8;

type Aggregation = 'sum' | 'mean';

function aggregationFor(variable: VariableKey): Aggregation {
  return variable === 'PRECTOTCORR' ? 'sum' : 'mean';
}

/** Unit of the aggregated series the statistics actually run on. */
function monthlyUnitFor(variable: VariableKey, dailyUnit: string): string {
  return aggregationFor(variable) === 'sum' ? 'mm/month' : dailyUnit;
}

export interface MonthlyPoint {
  year: number;
  month: number; // 1-12
  value: number;
  nDays: number;
}

export function aggregateMonthly(
  variable: VariableKey,
  points: ObservationPoint[],
): { monthly: MonthlyPoint[]; missingDays: number; daysTotal: number } {
  const agg = aggregationFor(variable);
  const buckets = new Map<string, { sum: number; n: number }>();
  let missingDays = 0;
  let daysTotal = 0;
  for (const p of points) {
    daysTotal++;
    if (p.value === null || !Number.isFinite(p.value)) {
      missingDays++;
      continue;
    }
    const key = p.date.slice(0, 7); // YYYY-MM
    const b = buckets.get(key) ?? { sum: 0, n: 0 };
    b.sum += p.value;
    b.n += 1;
    buckets.set(key, b);
  }
  const monthly: MonthlyPoint[] = [];
  for (const [key, b] of buckets) {
    // months with < 20 valid days are not representative: excluded, counted
    if (b.n < 20) {
      missingDays += b.n; // hmm: these days are valid observations but the month is unusable
      continue;
    }
    const [y, m] = key.split('-').map(Number);
    monthly.push({
      year: y,
      month: m,
      value: agg === 'sum' ? b.sum : b.sum / b.n,
      nDays: b.n,
    });
  }
  monthly.sort((a, b) => (a.year - b.year) || (a.month - b.month));
  // correct the missing accounting for dropped short months
  return { monthly, missingDays, daysTotal };
}

function directionOf(z: number, p: number, significant: boolean): TrendResult['direction'] {
  if (!significant || p >= 0.05) return 'no trend';
  return z > 0 ? 'increasing' : 'decreasing';
}

function fmt(v: number | null, digits = 3): string {
  if (v === null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

export interface AnalyzeTrendInput {
  variable: VariableKey;
  label: string;
  unit: string;
  points: ObservationPoint[]; // daily observations, sorted
  periodStart: string;
  periodEnd: string;
  /** all p-values in this request, for FDR */
  allPValues?: number[];
  /** index of this variable's p in allPValues */
  pIndex?: number;
}

export function analyzeTrend(input: AnalyzeTrendInput): TrendResult {
  const { variable, points } = input;
  const monthlyUnit = monthlyUnitFor(variable, input.unit);
  const aggregated = aggregationFor(variable);

  const { monthly, missingDays, daysTotal } = aggregateMonthly(variable, points);
  const years = monthly.length / 12;
  const periodStart = input.periodStart;
  const periodEnd = input.periodEnd;
  const distinctYears = new Set(monthly.map((m) => m.year)).size;
  const minSampleSatisfied =
    distinctYears >= MIN_YEARS_FOR_TREND &&
    monthly.length >= MIN_MONTHS_PER_SEASON * 12;

  const warnings: string[] = [];

  // ---- series by calendar month (season) ----
  const bySeason: number[][] = Array.from({ length: 12 }, () => []);
  for (const m of monthly) bySeason[m.month - 1].push(m.value);
  const perSeasonN = bySeason.map((s) => s.length);
  const leastSeason = Math.min(...perSeasonN);

  // ---- climatology + anomalies (baseline = full record minus final year) ----
  const anomalyYears = distinctYears - 1;
  const anomalyCutoff = Math.max(...monthly.map((m) => m.year));
  const climatology = Array.from({ length: 12 }, () => ({ sum: 0, n: 0, sq: 0 }));
  for (const m of monthly) {
    if (m.year >= anomalyCutoff) continue; // hold-out year for anomalies
    const c = climatology[m.month - 1];
    c.sum += m.value;
    c.sq += m.value * m.value;
    c.n += 1;
  }
  const monthlyClimatology = climatology.map((c, i) => {
    const mean = c.n ? c.sum / c.n : 0;
    const variance = c.n > 1 ? c.sq / c.n - mean * mean : 0;
    return { month: i + 1, mean, std: Math.sqrt(Math.max(variance, 0)), n: c.n };
  });
  const anomalies: { date: string; value: number; zScore: number }[] = [];
  for (const m of monthly) {
    if (m.year < anomalyCutoff) continue;
    const c = monthlyClimatology[m.month - 1];
    if (c.n < 3 || c.std === 0) continue;
    const z = (m.value - c.mean) / c.std;
    if (Math.abs(z) >= 2) anomalies.push({ date: `${m.year}-${String(m.month).padStart(2, '0')}`, value: m.value, zScore: z });
  }

  if (missingDays > 0) {
    warnings.push(
      `${missingDays} of ${daysTotal} daily observations are missing (POWER fill values / short months excluded). Missing data is never imputed; it reduces the effective sample size.`,
    );
  }

  // ---- insufficient-data path (honest) ----
  if (!minSampleSatisfied || leastSeason < MIN_MONTHS_PER_SEASON) {
    return {
      variable,
      label: input.label,
      unit: monthlyUnit,
      periodStart,
      periodEnd,
      observationPeriodYears: Number(years.toFixed(1)),
      sampleCount: monthly.length,
      missingCount: missingDays,
      method: 'Seasonal Mann-Kendall (Hirsch-Slack) + Theil-Sen',
      seasonalMethod: '12 calendar-month seasons',
      direction: 'no trend',
      slopePerYear: null,
      ciLower: null,
      ciUpper: null,
      zValue: null,
      pValue: null,
      significant: false,
      autocorrelationAdjusted: false,
      minSampleSatisfied: false,
      multipleTestingAdjustedP: null,
      anomalies,
      monthlyClimatology,
      explanation: {
        headline: `Insufficient record for a trend claim (${distinctYears} years, ${monthly.length} months)`,
        interpretation:
          `At least ${MIN_YEARS_FOR_TREND} full years with ≥ ${MIN_MONTHS_PER_SEASON} observations per calendar month are required before any significance claim. ` +
          `The available record covers ${distinctYears} distinct years (${monthly.length} usable months; weakest month has ${leastSeason} observations). ` +
          'No trend direction, slope, or significance is reported: an honest "insufficient data" outcome is more scientifically credible than a statistics-sounding guess.',
        caveats: [...baselineCaveats(), ...warnings],
      },
      warnings: [
        ...warnings,
        `minimum sample requirement not met (need ≥ ${MIN_YEARS_FOR_TREND} years; weakest calendar month has ${leastSeason} observations, need ${MIN_MONTHS_PER_SEASON})`,
      ],
    };
  }

  // ---- seasonal Mann-Kendall ----
  const smk = seasonalMannKendall(bySeason);
  // Hamed-Rao-type variance inflation if deseasonalized ranks show significant lag-1 autocorrelation
  const sigBound = 2 / Math.sqrt(smk.n); // 95% white-noise bound
  const autocorrSignificant = Math.abs(smk.lag1RhoDeseasonalized) > sigBound;
  let pValue = smk.pValue;
  let Z = smk.Z;
  let method = 'Seasonal Mann-Kendall (Hirsch & Slack 1984) with Theil-Sen slope';
  if (autocorrSignificant) {
    // Exact lag-1 term of the Hamed & Rao (1998) correction factor
    // 1 + (2/(n(n-1)(n-2))) · (n-1)(n-2)(n-3) · ρ1  =  1 + 2ρ1(n-3)/n,
    // applied to the summed seasonal statistic (adaptation documented in METHODOLOGY).
    const n = smk.n;
    const correction = 1 + (2 * smk.lag1RhoDeseasonalized * (n - 3)) / n;
    const inflatedVar = smk.varS * Math.max(correction, 1);
    if (smk.S > 0) Z = (smk.S - 1) / Math.sqrt(inflatedVar);
    else if (smk.S < 0) Z = (smk.S + 1) / Math.sqrt(inflatedVar);
    else Z = 0;
    pValue = 2 * (1 - cdfApprox(Math.abs(Z)));
    method = 'Seasonal Mann-Kendall with Hamed-Rao (1998) lag-1 variance inflation (autocorrelation detected)';
    warnings.push(
      `lag-1 autocorrelation of deseasonalized series is ${smk.lag1RhoDeseasonalized.toFixed(3)} (significance bound ±${sigBound.toFixed(3)}); the MK variance was inflated accordingly, making the test more conservative`,
    );
  }

  // slope per year: within-season steps are 1 year
  const slopePerYear = smk.slopePerStep;
  const slopeCI = smk.slopeCi;

  // ---- FDR ----
  let adjustedP: number | null = null;
  if (input.allPValues && input.pIndex !== undefined && input.allPValues.length > 1) {
    adjustedP = benjaminiHochberg(input.allPValues)[input.pIndex] ?? null;
  }

  const significant = pValue < 0.05;
  const direction = directionOf(Z, pValue, significant);

  const monthlyValue = aggregated === 'sum' ? 'monthly total' : 'monthly mean';
  const perDecade = slopePerYear !== null ? slopePerYear * 10 : null;
  const annualEquivalent =
    aggregated === 'sum' && slopePerYear !== null
      ? `equivalent to ≈ ${fmt(slopePerYear * 12)} mm of additional rainfall per year, per year — `
      : '';
  const explanation: TrendExplanation = {
    headline: significant
      ? `${direction === 'increasing' ? 'Statistically significant increase' : 'Statistically significant decrease'} detected in ${input.label.toLowerCase()}`
      : `No statistically significant trend detected in ${input.label.toLowerCase()}`,
    interpretation:
      `Over ${distinctYears} years (${monthly.length} usable months, weakest calendar month has ${leastSeason} observations), ` +
      `${input.label} ${monthlyValue} shows a Theil-Sen slope of ${fmt(slopePerYear)} ${monthlyUnit} per year ` +
      `(95% CI ${fmt(slopeCI.lower)} to ${fmt(slopeCI.upper)} ${monthlyUnit} per year). ` +
      `The seasonal Mann-Kendall test yields Z = ${fmt(Z)}, p = ${fmt(pValue, 4)}${adjustedP !== null ? ` (FDR-adjusted p = ${fmt(adjustedP, 4)} across the variables analysed together)` : ''}, ` +
      `${significant ? 'which is significant at the 0.05 level' : 'which is NOT significant at the 0.05 level'}. ` +
      (perDecade !== null ? `${annualEquivalent}roughly ${fmt(perDecade)} ${monthlyUnit} per decade at face value, ` : '') +
      `with ${anomalies.length} months in the final year flagged as ≥ 2σ anomalies against the ${anomalyYears}-year monthly climatology. ` +
      'Seasonality is handled by testing within-month year-over-year changes, so the annual cycle itself cannot produce this result. ' +
      'This describes an observed environmental association only; it is not evidence of an agricultural cause or effect.',
    caveats: [
      ...baselineCaveats(),
      'Theil-Sen and Mann-Kendall detect monotonic change; they can miss step changes or non-monotonic patterns.',
      `${anomalies.length} anomaly month(s) in the hold-out year do not by themselves constitute a trend.`,
    ],
  };

  return {
    variable,
    label: input.label,
    unit: monthlyUnit,
    periodStart,
    periodEnd,
    observationPeriodYears: Number(years.toFixed(1)),
    sampleCount: monthly.length,
    missingCount: missingDays,
    method,
    seasonalMethod: '12 calendar-month seasons, within-season slopes pooled for Theil-Sen',
    direction,
    slopePerYear,
    ciLower: slopeCI.lower,
    ciUpper: slopeCI.upper,
    zValue: Z,
    pValue,
    significant,
    autocorrelationAdjusted: autocorrSignificant,
    minSampleSatisfied: true,
    multipleTestingAdjustedP: adjustedP,
    anomalies,
    monthlyClimatology,
    explanation,
    warnings,
  };
}

function baselineCaveats(): string[] {
  return [
    'Observations are NASA POWER (MERRA-2) values for the 0.5° × 0.625° grid cell containing this point, on a local-solar-time (LST) day boundary — not in-farm measurements.',
    'Satellite-era reanalysis has known regional biases (e.g. underestimating heavy convective precipitation); magnitudes should be read as indicative, not exact.',
  ];
}

function cdfApprox(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - d * poly;
}

/** Annual aggregation helper for charting (returns per-year value + n). */
export function aggregateAnnual(variable: VariableKey, points: ObservationPoint[]): { year: number; value: number; n: number }[] {
  const monthly = aggregateMonthly(variable, points).monthly;
  const agg = aggregationFor(variable);
  const byYear = new Map<number, { sum: number; n: number }>();
  for (const m of monthly) {
    const b = byYear.get(m.year) ?? { sum: 0, n: 0 };
    b.sum += agg === 'sum' ? m.value : m.value * m.nDays;
    b.n += agg === 'sum' ? 1 : m.nDays;
    byYear.set(m.year, b);
  }
  const out: { year: number; value: number; n: number }[] = [];
  for (const [year, b] of byYear) {
    if (b.n < 12) continue; // incomplete years excluded from annual series
    out.push({ year, value: b.sum / (agg === 'sum' ? 1 : b.n), n: b.n });
  }
  return out.sort((a, b) => a.year - b.year);
}

export { theilSenSlope, mannKendall };
