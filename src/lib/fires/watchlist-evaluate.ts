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
import { fetchFiresForDate } from '@/lib/adapters/gibsFires';
import { withPrivateProvider } from '@/lib/ingest/provider-context';
import {
  acquireWatchlistEvaluationLease,
  releaseWatchlistEvaluationLease,
  WATCHLIST_EVALUATION_LEASE_MS,
} from '@/lib/fires/evaluation-lease';

/**
 * Shared watchlist evaluation for manual, backtest, scheduled, and durable-job
 * triggers. Provider work happens before the commit transaction. The commit
 * atomically creates the event, audit row, digest outbox event, and—only for
 * live evaluations—the current status after a compare-and-swap on the
 * watchlist's monotonic evaluation version.
 */

export type WatchEvalTrigger = 'manual' | 'backtest' | 'scheduled';

export interface RunWatchlistEvalArgs {
  watchlistId: string;
  trigger: WatchEvalTrigger;
  end?: string;
  correlationId: string;
  actor: string;
  ownerId?: string | null;
  jobId?: string;
  now?: Date;
  /** Test/operator override; production uses a TTL longer than the job deadline. */
  leaseTtlMs?: number;
  leaseHolder?: string;
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
  code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PROVIDER_UNAVAILABLE' | 'EVALUATION_IN_PROGRESS' | 'STALE_EVALUATION';
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
  const holder = args.leaseHolder ?? `evaluation:${args.jobId ?? crypto.randomUUID()}`;

  const w = await db.fireWatchlist.findUnique({ where: { id: args.watchlistId } });
  if (!w || (w.ownerId !== null && w.ownerId !== args.ownerId)) {
    return { ok: false, failure: { code: 'NOT_FOUND', message: `watchlist ${args.watchlistId} not found`, details: { correlationId } } };
  }

  const today = now.toISOString().slice(0, 10);
  const requestedEnd = args.end ?? yesterdayIso(now);
  const endError = validateEvalEnd(requestedEnd, w.lookbackDays, today);
  if (endError) {
    return { ok: false, failure: { code: 'VALIDATION_ERROR', message: endError, details: { correlationId } } };
  }

  const leased = await acquireWatchlistEvaluationLease(
    w.id,
    holder,
    args.leaseTtlMs ?? WATCHLIST_EVALUATION_LEASE_MS,
  );
  if (!leased) {
    return {
      ok: false,
      failure: { code: 'EVALUATION_IN_PROGRESS', message: 'another evaluation holds this watchlist lease', details: { correlationId } },
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

  let jobId = args.jobId;
  try {
    if (jobId) {
      await db.processingJob.update({
        where: { id: jobId },
        data: {
          type: 'fires-watch-eval',
          ownerId: w.ownerId,
          status: 'running',
          params: JSON.stringify({ watchlistId: w.id, trigger, requestedEnd, window: { start, end }, bbox }),
          correlationId,
          progressNote: `${actionNote}: ensuring ${days.length} day(s) of real VIIRS archive coverage`,
        },
      });
    } else {
      const created = await db.processingJob.create({
        data: {
          type: 'fires-watch-eval',
          ownerId: w.ownerId,
          status: 'running',
          params: JSON.stringify({ watchlistId: w.id, trigger, requestedEnd, window: { start, end }, bbox }),
          correlationId,
          progressNote: `${actionNote}: ensuring ${days.length} day(s) of real VIIRS archive coverage`,
        },
      });
      jobId = created.id;
    }

    let daysFetched = 0;
    let rowsWritten = 0;
    const ensured: EnsuredDay[] = [];
    const privateDetections: { date: string; confidence: string; frp: number | null }[] = [];
    for (const date of days) {
      const live = w.ownerId ? await withPrivateProvider(() => fetchFiresForDate(date, bbox, correlationId), w.organizationId) : null;
      if (live) {
        privateDetections.push(...live.detections.map((d) => ({ date, confidence: d.confidence, frp: d.frp ?? null })));
      }
      const day: EnsuredDay = live
        ? { date, checked: true, dataAvailable: live.dataAvailable, fetched: true, rowsWritten: 0 }
        : await ensureCoverageForDate(regionKey, date, bbox, correlationId);
      if (day.fetched) daysFetched += 1;
      rowsWritten += day.rowsWritten;
      ensured.push(day);
    }

    const detections = w.ownerId ? privateDetections : await storedDetections(regionKey, bbox, start, end);
    const evaluation = evaluateWatchlist({
      windowStart: start,
      windowEnd: end,
      days: ensured.map((d) => ({ date: d.date, checked: d.checked, dataAvailable: d.dataAvailable })),
      detections,
      minConfidence: w.minConfidence as WatchConfidence,
      lookbackDays: w.lookbackDays,
      detectionThreshold: w.detectionThreshold,
    });

    const committed = await db.$transaction(async (tx) => {
      const changed = await tx.fireWatchlist.updateMany({
        where: { id: w.id, evaluationVersion: w.evaluationVersion },
        data: {
          evaluationVersion: { increment: 1 },
          ...(trigger === 'backtest' ? {} : {
            lastStatus: evaluation.status,
            lastDetectionCount: evaluation.detectionCount,
            lastEvaluatedAt: now,
          }),
        },
      });
      if (changed.count !== 1) return null;

      const event = await tx.fireWatchEvent.create({
        data: {
          watchlistId: w.id,
          evaluatedAt: now,
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
            evaluationVersion: w.evaluationVersion + 1,
          }),
          correlationId,
        },
      });
      await tx.auditEvent.create({
        data: {
          actor: args.actor,
          action: 'watchlist.evaluate',
          targetId: w.id,
          detail: JSON.stringify({
            eventId: event.id,
            evaluationVersion: w.evaluationVersion + 1,
            status: evaluation.status,
            detectionCount: evaluation.detectionCount,
            window: { start, end },
            trigger,
          }),
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'FireWatchlist',
          aggregateId: w.id,
          eventType: 'watchlist.digest',
          payload: JSON.stringify({
            watchlistId: w.id,
            ownerId: w.ownerId,
            organizationId: w.organizationId,
            reason: 'evaluation',
            trigger,
            correlationId,
            triggeredAt: now.toISOString(),
            triggeringEventId: event.id,
          }),
        },
      });
      await tx.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'succeeded',
          progressNote: `${evaluation.status.toUpperCase()} — ${evaluation.detectionCount} qualifying detection(s) in ${start} → ${end}${trigger === 'backtest' ? ' (backtest)' : ''}`,
          resultRef: JSON.stringify({ eventId: event.id, status: evaluation.status, detectionCount: evaluation.detectionCount, daysFetched, trigger }),
          finishedAt: now,
          leaseExpiresAt: null,
          leaseHolder: null,
          error: null,
        },
      });
      return event;
    }, { isolationLevel: 'Serializable' });

    if (!committed) {
      await db.processingJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: 'stale evaluation completion rejected', finishedAt: now },
      });
      return {
        ok: false,
        failure: { code: 'STALE_EVALUATION', message: 'a newer evaluation committed first; stale completion rejected', details: { correlationId } },
      };
    }

    const updated = await db.fireWatchlist.findUniqueOrThrow({ where: { id: w.id } });
    const recentEvents = await db.fireWatchEvent.findMany({
      where: { watchlistId: w.id },
      orderBy: { evaluatedAt: 'desc' },
      take: 10,
    });
    return {
      ok: true,
      result: {
        watchlist: serializeWatchlist(updated),
        evaluation: { ...evaluation, daysFetchedFromGibs: daysFetched, rowsWritten },
        event: serializeEvent(committed),
        recentEvents: recentEvents.map(serializeEvent),
        mode: trigger === 'backtest' ? 'backtest' : 'live',
        requestedEnd,
        trigger,
        source: SOURCE_NOTE,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jobId) {
      await db.processingJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: msg, finishedAt: new Date() },
      }).catch(() => undefined);
    }
    return {
      ok: false,
      failure: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'watchlist evaluation failed — no status was fabricated',
        details: { providerMessage: msg, correlationId },
      },
    };
  } finally {
    await releaseWatchlistEvaluationLease(w.id, holder);
  }
}
