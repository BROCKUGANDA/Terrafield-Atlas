import { watchThresholdFor, type WatchConfidence } from '@/lib/fires/watchlist-engine';

/**
 * Wire serializers for the fire-watchlist feature — shared by the watchlist
 * routes and the evaluation core (moved out of the route module so both the
 * HTTP layer and the scheduler serialize identically).
 */

export function serializeEvent(e: {
  id: string;
  evaluatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  status: string;
  detectionCount: number;
  highConfidenceCount: number;
  nominalCount: number;
  lowCount: number;
  maxFrpMW: number | null;
  daysWithDetections: number;
  daysChecked: number;
  daysNoData: number;
  triggeredAlert: boolean;
  detailJson: string;
}) {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(e.detailJson) as Record<string, unknown>;
  } catch {
    detail = {};
  }
  return {
    id: e.id,
    evaluatedAt: e.evaluatedAt.toISOString(),
    windowStart: e.windowStart.toISOString().slice(0, 10),
    windowEnd: e.windowEnd.toISOString().slice(0, 10),
    status: e.status,
    detectionCount: e.detectionCount,
    highConfidenceCount: e.highConfidenceCount,
    nominalCount: e.nominalCount,
    lowCount: e.lowCount,
    maxFrpMW: e.maxFrpMW,
    daysWithDetections: e.daysWithDetections,
    daysChecked: e.daysChecked,
    daysNoData: e.daysNoData,
    triggeredAlert: e.triggeredAlert,
    rationale: (detail.rationale as string) ?? '',
    daysNoDataList: (detail.daysNoData as string[]) ?? [],
    daysUnchecked: (detail.daysUnchecked as string[]) ?? [],
    perDay: (detail.perDay as { date: string; total: number; qualifying: number }[]) ?? [],
    trigger: ((detail.trigger as string) ?? 'manual') as 'manual' | 'backtest' | 'scheduled',
  };
}

export function serializeWatchlist(w: {
  id: string;
  name: string;
  label: string | null;
  lat: number;
  lon: number;
  radiusKm: number;
  minConfidence: string;
  lookbackDays: number;
  detectionThreshold: number;
  notes: string | null;
  lastStatus: string;
  lastDetectionCount: number | null;
  lastEvaluatedAt: Date | null;
  reevaluateIntervalMin?: number | null;
  nextReevaluateAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: w.id,
    name: w.name,
    label: w.label,
    lat: w.lat,
    lon: w.lon,
    radiusKm: w.radiusKm,
    minConfidence: w.minConfidence as WatchConfidence,
    lookbackDays: w.lookbackDays,
    detectionThreshold: w.detectionThreshold,
    watchThreshold: watchThresholdFor(w.detectionThreshold),
    notes: w.notes,
    lastStatus: w.lastStatus,
    lastDetectionCount: w.lastDetectionCount,
    lastEvaluatedAt: w.lastEvaluatedAt ? w.lastEvaluatedAt.toISOString() : null,
    reevaluateIntervalMin: w.reevaluateIntervalMin ?? null,
    nextReevaluateAt: w.nextReevaluateAt ? w.nextReevaluateAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
  };
}
