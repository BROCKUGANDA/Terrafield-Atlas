import { db } from '@/lib/db';
import { regionKeyFor } from '@/lib/geo';
import {
  bboxForRadiusKm,
  evaluateWatchlist,
  validateEvalEnd,
  windowFor,
  yesterdayIso,
  type WatchConfidence,
} from '@/lib/fires/watchlist-engine';
import { ensureCoverageForDate, storedDetections, type EnsuredDay } from '@/lib/fires/coverage';
import { serializeEvent, serializeWatchlist } from '@/lib/fires/watchlist-serialize';

/**
 * Shared LIVE watchlist evaluation — ONE code path for every trigger:
 *
 *  - 'manual'    → POST /evaluate with no body (operator: Evaluate now)
 *  - 'backtest'  → POST /evaluate with an explicit end date (the date picker)
 *  - 'scheduled' → in-process background scheduler (lib/scheduler.ts)
 *
 * 1. Window = [end - lookbackDays + 1, end] (end defaults to yesterday: the
 *    VIIRS archive typically lags one day).
 * 2. For every day in the window we ENSURE archive coverage: days never asked
 *    (or asked with a narrower bbox) are fetched from the real GIBS VIIRS
 *    375 m vector tiles and persisted idempotently; provider archive gaps are
 *    recorded as no-data days — never zero-filled.
 * 3. Status is computed from the STORED real detections only, via the pure
 *    watchlist engine, and one FireWatchEvent row is written per evaluation.
 *
 * No detection is ever synthesized; a provider error marks the job failed and
 * writes nothing. HTTP mapping lives in the route module; the scheduler maps
 * failures onto its audit ledger.
 */

export type WatchEvalTrigger = 'manual' | 'backtest' | 'scheduled';

export interface RunWatchlistEvalArgs {
  watchlistId: string;
  trigger: WatchEvalTrigger;
  /** Explicit window end (ISO date). Absent → yesterday (live semantics). */
  end?: string;
  correlationId: string;
  /** Audit actor: 'demo-user' for the console, 'system:scheduler' for ticks. */
  actor: string;
  /** Injected clock (defaults to now) so callers stay deterministic. */
  now?: Date;
}

export interface WatchEvalResult {
  watchlist: ReturnType<typeof serializeWatchlist>;
  evaluation: ReturnType<typeof evaluateWatchlist> & { daysFetchedFromGibs: number; rowsWritten: number };
  event: ReturnType<typeof serializeEvent>;
  recentEvents: ReturnType<typeof serializeEvent>[];
  mode: 'live' | 'backtest';
  requestedEnd: string;
  trigger: WatchEvalTrigger;
  source: string;
}

export type WatchEvalFailure = {
  code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PROVIDER_UNAVAILABLE';
  message: string;
  details?: unknown;
};

const SOURCE_NOTE =
  'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All vector tiles (VIIRS 375 m active-fire detections — the same detection stream NASA FIRMS distributes). Evaluation reads stored real detections only; archive-gap days are reported as no-data, never zero-filled.';

export async function runWatchlistEvaluation(
  args: RunWatchlistEvalArgs,
): Promise<{ ok: true; result: WatchEvalResult } | { ok: false; failure: WatchEvalFailure }> {
  const now = args.now ?? new Date();
  const correlationId = args.correlationId;
  const trigger = args.trigger;

  const w = await db.fireWatchlist.findUnique({ where: { id: args.watchlistId } });
  if (!w) {
    return {
      ok: false,
      failure: { code: 'NOT_FOUND', message: `watchlist ${args.watchlistId} not found`, details: { correlationId } },
    };
  }

  const today = now.toISOString().slice(0, 10);
  const requestedEnd = args.end ?? yesterdayIso(now);
  const endError = validateEvalEnd(requestedEnd, w.lookbackDays, today);
  if (endError) {
    return {
      ok: false,
      failure: { code: 'VALIDATION_ERROR', message: endError, details: { correlationId } },
    };
  }

  const { start, end, days } = windowFor(requestedEnd, w.lookbackDays);
  const regionKey = regionKeyFor(w.lat, w.lon);
  const bbox = bboxForRadiusKm(w.lat, w.lon, w.radiusKm);

  const actionNote =
    trigger === 'scheduled'
      ? `scheduled re-evaluation of “${w.name}”`
      : trigger === 'backtest'
        ? `backtesting “${w.name}” against ${start} → ${end}`
        : `evaluating “${w.name}”`;

  const job = await db.processingJob.create({
    data: {
      type: 'fires-watch-eval',
      status: 'running',
      params: JSON.stringify({ watchlistId: w.id, trigger, requestedEnd, window: { start, end }, bbox }),
      correlationId,
      progressNote: `${actionNote}: ensuring ${days.length} day(s) of real VIIRS archive coverage`,
    },
  });

  let daysFetched = 0;
  let rowsWritten = 0;
  try {
    const ensured: EnsuredDay[] = [];
    for (const date of days) {
      const day = await ensureCoverageForDate(regionKey, date, bbox, correlationId);
      if (day.fetched) daysFetched += 1;
      rowsWritten += day.rowsWritten;
      ensured.push(day);
    }

    const detections = await storedDetections(regionKey, bbox, start, end);
    const evaluation = evaluateWatchlist({
      windowStart: start,
      windowEnd: end,
      days: ensured.map((d) => ({ date: d.date, checked: d.checked, dataAvailable: d.dataAvailable })),
      detections,
      minConfidence: w.minConfidence as WatchConfidence,
      lookbackDays: w.lookbackDays,
      detectionThreshold: w.detectionThreshold,
    });

    const event = await db.fireWatchEvent.create({
      data: {
        watchlistId: w.id,
        windowStart: new Date(`${start}T00:00:00Z`),
        windowEnd: new Date(`${end}T00:00:00Z`),
        status: evaluation.status,
        detectionCount: evaluation.detectionCount,
        highConfidenceCount: evaluation.byConfidence.high,
        nominalCount: evaluation.byConfidence.nominal,
        lowCount: evaluation.byConfidence.low,
        maxFrpMW: evaluation.maxFrpMW,
        daysWithDetections: evaluation.daysWithDetections,
        daysChecked: evaluation.daysChecked,
        daysNoData: evaluation.daysNoData.length,
        triggeredAlert: evaluation.status === 'alert',
        detailJson: JSON.stringify({
          perDay: evaluation.perDay,
          rationale: evaluation.rationale,
          daysNoData: evaluation.daysNoData,
          daysUnchecked: evaluation.daysUnchecked,
          daysFetched,
          rowsWritten,
          trigger,
          actor: args.actor,
        }),
        correlationId,
      },
    });
    const updated = await db.fireWatchlist.update({
      where: { id: w.id },
      data: {
        lastStatus: evaluation.status,
        lastDetectionCount: evaluation.detectionCount,
        lastEvaluatedAt: new Date(),
      },
    });
    await db.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        progressNote: `${evaluation.status.toUpperCase()} — ${evaluation.detectionCount} qualifying detection(s) in ${start} → ${end}${trigger === 'backtest' ? ' (backtest)' : ''}`,
        resultRef: JSON.stringify({ status: evaluation.status, detectionCount: evaluation.detectionCount, daysFetched, trigger }),
        finishedAt: new Date(),
      },
    });
    await db.auditEvent.create({
      data: {
        actor: args.actor,
        action: 'watchlist.evaluate',
        targetId: w.id,
        detail: JSON.stringify({ status: evaluation.status, detectionCount: evaluation.detectionCount, window: { start, end }, trigger }),
      },
    });
    const recentEvents = await db.fireWatchEvent.findMany({
      where: { watchlistId: w.id },
      orderBy: { evaluatedAt: 'desc' },
      take: 10,
    });

    return {
      ok: true,
      result: {
        watchlist: serializeWatchlist(updated),
        evaluation: {
          ...evaluation,
          daysFetchedFromGibs: daysFetched,
          rowsWritten,
        },
        event: serializeEvent(event),
        recentEvents: recentEvents.map(serializeEvent),
        mode: trigger === 'backtest' ? 'backtest' : 'live',
        requestedEnd,
        trigger,
        source: SOURCE_NOTE,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.processingJob.update({ where: { id: job.id }, data: { status: 'failed', error: msg, finishedAt: new Date() } });
    return {
      ok: false,
      failure: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'watchlist evaluation failed — no status was fabricated',
        details: { providerMessage: msg, correlationId },
      },
    };
  }
}
