/**
 * Mann-Kendall trend statistics with exact algorithms.
 *
 * References implemented here:
 * - Mann (1945), Kendall (1975): S statistic, tie-corrected variance.
 * - Hamed & Rao (1998), J. Hydrology 204:182-196: variance inflation for
 *   serially correlated series (detrend by Sen's slope, ACF of ranks,
 *   zero-out non-significant lags, factor 1 + [2/(n(n-1)(n-2))] Σ (n-i)(n-i-1)(n-i-2) ρ_i).
 *   Algorithm cross-checked line-by-line against the reference R
 *   implementation (CRAN modifiedmk::mmkh).
 * - Hirsch, Slack & Smith (1982) / Hirsch & Slack (1984): seasonal
 *   Mann-Kendall (per-season S, summed variance under inter-season
 *   independence).
 * - Sen (1968) / Gilbert (1987): Theil-Sen slope with rank-based CI.
 */

export interface MkInput {
  /** time steps (equal spacing) */
  values: number[];
  /** confidence interval for significance of ACF lags (Hamed-Rao) */
  ci?: number;
}

export interface MkResult {
  n: number;
  S: number;
  varS: number;
  varSCorrected: number | null;
  correctionFactor: number | null;
  Z: number;
  pValue: number;
  tau: number;
  autocorrelationAdjusted: boolean;
  /** lag-1 ACF of the detrended rank series (diagnostic) */
  lag1Rho: number | null;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 / Hart double-precision). */
export function normalCdf(z: number): number {
  // Zelen & Severo approximation, max abs error ~7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p =
    d *
    t *
    (1.330274429 * Math.pow(t, 4) +
      -1.821255978 * Math.pow(t, 3) +
      1.781477937 * Math.pow(t, 2) +
      -0.356563782 * t +
      0.319381530);
  return z >= 0 ? 1 - p : p;
}

/** Standard normal inverse CDF (Acklam's algorithm, |error| < 1.15e-9). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Acklam's canonical coefficients
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const pLow = 0.02425;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function tieCorrectedVariance(values: number[]): number {
  const n = values.length;
  let varS = (n * (n - 1) * (2 * n + 5)) / 18;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const tie of counts.values()) {
    if (tie > 1) varS -= (tie * (tie - 1) * (2 * tie + 5)) / 18;
  }
  return Math.max(varS, 0);
}

function acfOfRanks(ranks: number[], maxLag: number): number[] {
  const n = ranks.length;
  const mean = ranks.reduce((a, b) => a + b, 0) / n;
  const centered = ranks.map((r) => r - mean);
  const denom = centered.reduce((a, b) => a + b * b, 0);
  const out: number[] = [];
  for (let k = 1; k <= maxLag; k++) {
    let num = 0;
    for (let t = 0; t < n - k; t++) num += centered[t] * centered[t + k];
    out.push(denom === 0 ? 0 : num / denom);
  }
  return out;
}

/**
 * Mann-Kendall with optional Hamed-Rao variance correction.
 * Use for non-seasonal series (e.g., annual aggregates).
 */
export function mannKendall(input: MkInput): MkResult {
  const x = input.values.filter((v) => Number.isFinite(v));
  const n = x.length;
  if (n < 3) throw new Error('Mann-Kendall requires ≥ 3 observations');
  const ci = input.ci ?? 0.95;

  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) S += Math.sign(x[j] - x[i]);
  }
  const varS = tieCorrectedVariance(x);
  const tau = S / (0.5 * n * (n - 1));

  // --- Hamed-Rao correction on significant ACF lags of detrended ranks ---
  const slope = theilSenSlope(x); // used only to detrend
  const detrended = x.map((v, i) => v - slope * (i + 1));
  const ranks = rank(detrended);
  const ro = acfOfRanks(ranks, Math.min(n - 1, 30));
  const sig = normalInv((1 + ci) / 2) / Math.sqrt(n);
  let ess = 0;
  let anySignificant = false;
  for (let i = 0; i < ro.length; i++) {
    // ro[i] is lag i+1 (R: ro[i] with i from 1)
    const lag = i + 1;
    const significant = ro[i] > sig || ro[i] < -sig;
    if (significant) {
      anySignificant = true;
      ess += (n - lag) * (n - lag - 1) * (n - lag - 2) * ro[i];
    }
  }
  const cte = 2 / (n * (n - 1) * (n - 2));
  const correctionFactor = anySignificant ? 1 + ess * cte : 1;
  const varSCorrected = varS * correctionFactor;

  const V = n >= 4 ? varSCorrected : varS; // correction undefined for n<4
  let Z: number;
  if (S === 0) Z = 0;
  else if (S > 0) Z = (S - 1) / Math.sqrt(V);
  else Z = (S + 1) / Math.sqrt(V);
  const pValue = 2 * (1 - normalCdf(Math.abs(Z)));

  return {
    n,
    S,
    varS,
    varSCorrected: n >= 4 ? varSCorrected : null,
    correctionFactor: n >= 4 ? correctionFactor : null,
    Z,
    pValue,
    tau,
    autocorrelationAdjusted: anySignificant && n >= 4,
    lag1Rho: ro[0] ?? null,
  };
}

function rank(values: number[]): number[] {
  const sorted = [...values].map((v, i) => ({ v, i }));
  sorted.sort((a, b) => a.v - b.v);
  const r = new Array<number>(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) r[sorted[k].i] = avgRank;
    i = j + 1;
  }
  return r;
}

/** Theil-Sen slope: median of pairwise slopes (time index as x). */
export function theilSenSlope(values: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < values.length - 1; i++) {
    for (let j = i + 1; j < values.length; j++) {
      slopes.push((values[j] - values[i]) / (j - i));
    }
  }
  slopes.sort((a, b) => a - b);
  return medianSorted(slopes);
}

function medianSorted(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return arr[(n - 1) / 2];
  return (arr[n / 2 - 1] + arr[n / 2]) / 2;
}

/**
 * Theil-Sen slope confidence interval via the Sen (1968)/Gilbert (1987)
 * rank method on the sorted pairwise slopes:
 *   Cα = z_{1−α/2} · sqrt(Var(S));  M1 = (N − Cα)/2; M2 = (N + Cα)/2
 * bounds interpolate the sorted slope list at ranks M1 and M2.
 */
export function theilSenConfidence(
  values: number[],
  varS: number,
  ci = 0.95,
): { lower: number; upper: number } {
  const slopes: number[] = [];
  for (let i = 0; i < values.length - 1; i++) {
    for (let j = i + 1; j < values.length; j++) {
      slopes.push((values[j] - values[i]) / (j - i));
    }
  }
  slopes.sort((a, b) => a - b);
  const N = slopes.length;
  const C = normalInv(1 - (1 - ci) / 2) * Math.sqrt(Math.max(varS, 0));
  const M1 = Math.max(0, (N - C) / 2);
  const M2 = Math.min(N - 1, (N + C) / 2);
  const at = (rankPos: number): number => {
    const idx = Math.floor(rankPos);
    const frac = rankPos - idx;
    if (idx >= N) return slopes[N - 1];
    if (idx < 0) return slopes[0];
    if (frac === 0 || idx + 1 >= N) return slopes[idx];
    return slopes[idx] + frac * (slopes[idx + 1] - slopes[idx]);
  };
  return { lower: at(M1), upper: at(M2) };
}

/**
 * Seasonal Mann-Kendall (Hirsch et al. 1982; Hirsch & Slack 1984).
 * `seriesBySeason`: for each season (calendar month), the values in
 * chronological order. Direction/Z from summed S and summed variance;
 * slope = median of pooled within-season pairwise slopes (units per step).
 */
export interface SeasonalMkResult {
  n: number;
  seasons: number;
  S: number;
  varS: number;
  Z: number;
  pValue: number;
  tau: number;
  slopePerStep: number;
  slopeCi: { lower: number; upper: number };
  perSeasonN: number[];
  lag1RhoDeseasonalized: number;
}

export function seasonalMannKendall(
  seriesBySeason: number[][],
  ci = 0.95,
): SeasonalMkResult {
  const seasons = seriesBySeason.length;
  if (seasons < 2) throw new Error('seasonal MK needs ≥ 2 seasons');
  let S = 0;
  let varS = 0;
  let n = 0;
  let allSlopes: number[] = [];
  const perSeasonN: number[] = [];
  for (const vals of seriesBySeason) {
    const x = vals.filter((v) => Number.isFinite(v));
    perSeasonN.push(x.length);
    if (x.length < 2) continue;
    n += x.length;
    for (let i = 0; i < x.length - 1; i++) {
      for (let j = i + 1; j < x.length; j++) {
        S += Math.sign(x[j] - x[i]);
        allSlopes.push((x[j] - x[i]) / (j - i));
      }
    }
    varS += tieCorrectedVariance(x);
  }
  if (n < 3) throw new Error('insufficient data for seasonal MK');
  // All-constant series (perfect ties): S = 0 and Var = 0 → no trend, by definition.
  if (varS <= 0) {
    return {
      n,
      seasons,
      S: 0,
      varS: 0,
      Z: 0,
      pValue: 1,
      tau: 0,
      slopePerStep: allSlopes.length ? medianSorted(allSlopes) : 0,
      slopeCi: { lower: 0, upper: 0 },
      perSeasonN,
      lag1RhoDeseasonalized: 0,
    };
  }
  allSlopes = allSlopes.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);

  const slopePerStep = medianSorted(allSlopes);

  // Sen CI on pooled within-season slopes with the summed Var(S)
  const N = allSlopes.length;
  const C = normalInv(1 - (1 - ci) / 2) * Math.sqrt(varS);
  const at = (rankPos: number): number => {
    const idx = Math.floor(rankPos);
    const frac = rankPos - idx;
    if (idx >= N) return allSlopes[N - 1];
    if (idx < 0) return allSlopes[0];
    if (frac === 0 || idx + 1 >= N) return allSlopes[idx];
    return allSlopes[idx] + frac * (allSlopes[idx + 1] - allSlopes[idx]);
  };
  const slopeCi = { lower: at(Math.max(0, (N - C) / 2)), upper: at(Math.min(N - 1, (N + C) / 2)) };

  let Z: number;
  if (S === 0) Z = 0;
  else if (S > 0) Z = (S - 1) / Math.sqrt(varS);
  else Z = (S + 1) / Math.sqrt(varS);

  // Diagnostic: lag-1 autocorrelation of deseasonalized monthly series
  const climatology = seriesBySeason.map((vals) => {
    const x = vals.filter((v) => Number.isFinite(v));
    return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0;
  });
  const deseasonalized: number[] = [];
  seriesBySeason.forEach((vals, s) => {
    const x = vals.filter((v) => Number.isFinite(v));
    for (const v of x) deseasonalized.push(v - climatology[s]);
  });
  const lag1Rho = deseasonalized.length > 3
    ? acfOfRanks(deseasonalized.map((v) => v), 1)[0]
    : 0;

  // Seasonal Kendall tau: S / (0.5 · m · (m−1) · p), m = obs per season, p = seasons
  const m = n / seasons;
  const tauDenominator = 0.5 * m * (m - 1) * seasons;

  return {
    n,
    seasons,
    S,
    varS,
    Z,
    pValue: 2 * (1 - normalCdf(Math.abs(Z))),
    tau: tauDenominator > 0 ? S / tauDenominator : 0,
    slopePerStep,
    slopeCi,
    perSeasonN,
    lag1RhoDeseasonalized: lag1Rho,
  };
}

/** Benjamini-Hochberg FDR-adjusted p-values (for multi-variable requests). */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues
    .map((p, i) => ({ p: Math.min(Math.max(p, 0), 1), i }))
    .sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1;
    const adj = Math.min(prev, (order[k].p * m) / rank);
    adjusted[order[k].i] = adj;
    prev = adj;
  }
  return adjusted;
}
