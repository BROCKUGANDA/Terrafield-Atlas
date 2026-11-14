/**
 * Fire-watchlist evaluation engine — PURE, deterministic, testable.
 *
 * Given a lookback window, per-day archive coverage flags and the STORED real
 * detections for a region, this module computes the watchlist status and a
 * human-readable rationale. It performs no I/O and never fabricates data:
 *
 *  - "unchecked" day  = GIBS was never asked for that date → the window is
 *    incomplete; only "alert" (real detections seen) or "unverified"/"watch"
 *    can be honestly reported, never "clear".
 *  - "no-data" day    = GIBS archive gap for that date (provider-side);
 *    reported as-is, never zero-filled.
 *  - qualifying detection = confidence class >= minConfidence.
 *
 * Status semantics:
 *   alert       — qualifying detections >= detectionThreshold (real fires seen)
 *   watch       — qualifying detections >= ceil(threshold / 2), OR partial
 *                 coverage with at least one qualifying detection (cannot clear)
 *   clear       — complete coverage and every count below the watch threshold
 *   unverified  — nothing (or not enough) has actually been checked yet
 */

export type WatchConfidence = 'low' | 'nominal' | 'high';
export type WatchStatus = 'unverified' | 'clear' | 'watch' | 'alert';

/**
 * First day of the NASA GIBS VIIRS active-fire archive (canonical constant —
 * the gibsFires adapter re-exports this so every consumer sees one value).
 */
export const FIRE_ARCHIVE_START = '2015-01-01';

export const CONFIDENCE_RANK: Record<WatchConfidence, number> = { low: 0, nominal: 1, high: 2 };

export const MIN_CONFIDENCE_LABELS: Record<WatchConfidence, string> = {
  low: 'any confidence',
  nominal: 'nominal+ confidence',
  high: 'high-confidence only',
};

export function confidenceRank(c: string): number {
  return CONFIDENCE_RANK[c as WatchConfidence] ?? 1;
}

export function isQualifying(confidence: string, minConfidence: WatchConfidence): boolean {
  return confidenceRank(confidence) >= CONFIDENCE_RANK[minConfidence];
}

/** Half-threshold caution boundary: ceil(threshold/2) but at least 1. */
export function watchThresholdFor(detectionThreshold: number): number {
  return Math.max(1, Math.ceil(detectionThreshold / 2));
}

/** Inclusive [start, end] window (ISO dates) covering `lookbackDays` days ending at `end`. */
export function windowFor(endIso: string, lookbackDays: number): { start: string; end: string; days: string[] } {
  const n = Math.max(1, Math.floor(lookbackDays));
  const end = new Date(`${endIso}T00:00:00Z`);
  const start = new Date(end.getTime() - (n - 1) * 86_400_000);
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return { start: start.toISOString().slice(0, 10), end: endIso, days };
}

// --- calendar-day helpers for backtests and scheduling (pure; UTC day grid) ---

/** Shift an ISO date by whole calendar days (UTC). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The most recent fully-observed VIIRS day: the archive typically lags one day. */
export function yesterdayIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Earliest window END for which the full lookback window still lies inside the
 * VIIRS archive: FIRE_ARCHIVE_START + (lookbackDays - 1). A backtest ending
 * earlier could never reach complete coverage, so it is rejected instead of
 * reporting a guaranteed-unverified window.
 */
export function minBacktestEndIso(lookbackDays: number, archiveStart: string = FIRE_ARCHIVE_START): string {
  return addDaysIso(archiveStart, Math.max(1, Math.floor(lookbackDays)) - 1);
}

/**
 * Validate an evaluation end date. Returns an error message, or null when the
 * date is usable. `today` and `archiveStart` are injected so callers (and
 * tests) stay deterministic.
 */
export function validateEvalEnd(
  end: string,
  lookbackDays: number,
  today: string,
  archiveStart: string = FIRE_ARCHIVE_START,
): string | null {
  if (end > today) return `end date cannot be in the future (today is ${today})`;
  if (end < archiveStart) return `VIIRS fire archive starts ${archiveStart}`;
  const minEnd = minBacktestEndIso(lookbackDays, archiveStart);
  if (end < minEnd) {
    return `a ${Math.max(1, Math.floor(lookbackDays))}-day window ending ${end} would start before the VIIRS archive begins (${archiveStart}); use an end date of ${minEnd} or later`;
  }
  return null;
}

/** Bbox (degrees) that covers a circle of radiusKm around (lat, lon), capped at 0.3° padding. */
export function bboxForRadiusKm(lat: number, lon: number, radiusKm: number): { west: number; south: number; east: number; north: number } {
  const latPad = Math.min(0.3, radiusKm / 111.32);
  const cos = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const lonPad = Math.min(0.3, radiusKm / (111.32 * cos));
  const r = (v: number) => Number(v.toFixed(4));
  return { west: r(lon - lonPad), south: r(lat - latPad), east: r(lon + lonPad), north: r(lat + latPad) };
}

export interface WatchDay {
  date: string;
  /** false = GIBS was never queried for this date (window incomplete). */
  checked: boolean;
  /** checked && false = provider archive gap for this date. */
  dataAvailable: boolean;
}

export interface WatchDetection {
  date: string;
  confidence: string;
  frp: number | null;
}

export interface WatchEvaluation {
  status: WatchStatus;
  windowStart: string;
  windowEnd: string;
  daysChecked: number;
  daysNoData: string[];
  daysUnchecked: string[];
  coverageComplete: boolean;
  detectionCount: number;
  byConfidence: { low: number; nominal: number; high: number };
  watchThreshold: number;
  daysWithDetections: number;
  maxFrpMW: number | null;
  perDay: { date: string; total: number; qualifying: number }[];
  rationale: string;
}

export function evaluateWatchlist(args: {
  windowStart: string;
  windowEnd: string;
  days: WatchDay[];
  detections: WatchDetection[];
  minConfidence: WatchConfidence;
  lookbackDays: number;
  detectionThreshold: number;
}): WatchEvaluation {
  const { windowStart, windowEnd, days, detections } = args;
  const minConfidence: WatchConfidence = args.minConfidence;
  const threshold = Math.max(1, Math.floor(args.detectionThreshold));
  const watchThreshold = watchThresholdFor(threshold);

  const byConfidence = { low: 0, nominal: 0, high: 0 };
  let detectionCount = 0;
  let maxFrpMW: number | null = null;
  const perDayMap = new Map<string, { total: number; qualifying: number }>();
  for (const day of days) perDayMap.set(day.date, { total: 0, qualifying: 0 });

  for (const d of detections) {
    const bucket = perDayMap.get(d.date);
    if (!bucket) continue; // outside the evaluation window — not counted
    bucket.total += 1;
    const conf: WatchConfidence = d.confidence in CONFIDENCE_RANK ? (d.confidence as WatchConfidence) : 'nominal';
    byConfidence[conf] += 1;
    if (isQualifying(d.confidence, minConfidence)) {
      detectionCount += 1;
      bucket.qualifying += 1;
    }
    if (d.frp !== null && d.frp !== undefined && Number.isFinite(d.frp)) {
      maxFrpMW = maxFrpMW === null ? d.frp : Math.max(maxFrpMW, d.frp);
    }
  }

  const daysChecked = days.filter((d) => d.checked).length;
  const daysNoData = days.filter((d) => d.checked && !d.dataAvailable).map((d) => d.date);
  const daysUnchecked = days.filter((d) => !d.checked).map((d) => d.date);
  const coverageComplete = daysUnchecked.length === 0;
  const daysWithDetections = [...perDayMap.entries()].filter(([, c]) => c.total > 0).length;
  const perDay = days.map((d) => ({ date: d.date, ...(perDayMap.get(d.date) ?? { total: 0, qualifying: 0 }) }));

  let status: WatchStatus;
  if (daysChecked === 0) {
    status = 'unverified';
  } else if (detectionCount >= threshold) {
    status = 'alert';
  } else if (!coverageComplete && detectionCount > 0) {
    // partial coverage with real detections — cannot honestly clear
    status = 'watch';
  } else if (detectionCount >= watchThreshold) {
    status = 'watch';
  } else if (!coverageComplete) {
    status = 'unverified';
  } else {
    status = 'clear';
  }

  const confNote = MIN_CONFIDENCE_LABELS[minConfidence];
  const rationaleParts: string[] = [];
  if (status === 'alert') {
    rationaleParts.push(
      `ALERT: ${detectionCount} qualifying detections (${confNote}) in the last ${days.length} day(s) — at or above the threshold of ${threshold}.`,
    );
  } else if (status === 'watch') {
    rationaleParts.push(
      `WATCH: ${detectionCount} qualifying detection(s) (${confNote}) in the last ${days.length} day(s) — below the alert threshold of ${threshold} but at/above the watch level of ${watchThreshold}${!coverageComplete ? ', with archive coverage still incomplete' : ''}.`,
    );
  } else if (status === 'clear') {
    rationaleParts.push(
      `CLEAR: all ${days.length} day(s) checked; ${detectionCount} qualifying detection(s) (${confNote}) — below the watch level of ${watchThreshold}.`,
    );
  } else {
    rationaleParts.push(
      daysChecked === 0
        ? 'UNVERIFIED: no archive coverage has been checked for this window yet — evaluate the watchlist to query the real GIBS VIIRS record.'
        : `UNVERIFIED: ${daysUnchecked.length} of ${days.length} day(s) have never been checked against the archive; a clear status requires complete coverage.`,
    );
  }
  if (daysNoData.length > 0) {
    rationaleParts.push(
      `${daysNoData.length} day(s) are GIBS archive gaps (${daysNoData.slice(0, 4).join(', ')}${daysNoData.length > 4 ? ', …' : ''}) — reported as no-data, never zero-filled.`,
    );
  }
  if (daysWithDetections > 0) rationaleParts.push(`Fire activity occurred on ${daysWithDetections} of ${days.length} day(s).`);
  if (maxFrpMW !== null) rationaleParts.push(`Max stored FRP ${maxFrpMW.toFixed(1)} MW.`);

  return {
    status,
    windowStart,
    windowEnd,
    daysChecked,
    daysNoData,
    daysUnchecked,
    coverageComplete,
    detectionCount,
    byConfidence,
    watchThreshold,
    daysWithDetections,
    maxFrpMW: maxFrpMW === null ? null : Number(maxFrpMW.toFixed(1)),
    perDay,
    rationale: rationaleParts.join(' '),
  };
}
