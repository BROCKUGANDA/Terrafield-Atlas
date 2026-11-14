import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { FIRE_ARCHIVE_START } from '@/lib/adapters/gibsFires';
import { regionKeyFor } from '@/lib/geo';
import { bboxForRadiusKm, evaluateWatchlist, windowFor, type WatchConfidence } from '@/lib/fires/watchlist-engine';
import { ensureCoverageForDate, storedDetections, type EnsuredDay } from '@/lib/fires/coverage';
import { serializeEvent, serializeWatchlist } from '@/app/api/v1/fires/watchlists/route';

/**
 * POST /api/v1/fires/watchlists/[id]/evaluate — LIVE evaluation.
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
 * No detection is ever synthesized; an error returns 502 and writes nothing.
 */

type WatchCtx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const todayIso = () => new Date().toISOString().slice(0, 10);

export const POST = apiHandler<WatchCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const rl = rateLimit(clientKey(req, 'watchlists:evaluate'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;

  const w = await db.fireWatchlist.findUnique({ where: { id } });
  if (!w) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `watchlist ${id} not found`, correlationId } }, { status: 404, correlationId });
  }

  const today = todayIso();
  const requestedEnd = parsed.data.end ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (requestedEnd > today) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `end date cannot be in the future (today is ${today})`, correlationId } }, { status: 400, correlationId });
  }
  if (requestedEnd < FIRE_ARCHIVE_START) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `VIIRS fire archive starts ${FIRE_ARCHIVE_START}`, correlationId } }, { status: 400, correlationId });
  }

  const { start, end, days } = windowFor(requestedEnd, w.lookbackDays);
  const regionKey = regionKeyFor(w.lat, w.lon);
  const bbox = bboxForRadiusKm(w.lat, w.lon, w.radiusKm);

  const job = await db.processingJob.create({
    data: {
      type: 'fires-watch-eval',
      status: 'running',
      params: JSON.stringify({ watchlistId: w.id, window: { start, end }, bbox }),
      correlationId,
      progressNote: `evaluating “${w.name}”: ensuring ${days.length} day(s) of real VIIRS archive coverage`,
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
        progressNote: `${evaluation.status.toUpperCase()} — ${evaluation.detectionCount} qualifying detection(s) in ${start} → ${end}`,
        resultRef: JSON.stringify({ status: evaluation.status, detectionCount: evaluation.detectionCount, daysFetched }),
        finishedAt: new Date(),
      },
    });
    await db.auditEvent.create({
      data: {
        actor: 'demo-user',
        action: 'watchlist.evaluate',
        targetId: w.id,
        detail: JSON.stringify({ status: evaluation.status, detectionCount: evaluation.detectionCount, window: { start, end } }),
      },
    });
    const recentEvents = await db.fireWatchEvent.findMany({
      where: { watchlistId: w.id },
      orderBy: { evaluatedAt: 'desc' },
      take: 10,
    });

    return jsonResponse(
      {
        watchlist: serializeWatchlist(updated),
        evaluation: {
          ...evaluation,
          daysFetchedFromGibs: daysFetched,
          rowsWritten,
        },
        event: serializeEvent(event),
        recentEvents: recentEvents.map(serializeEvent),
        source:
          'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All vector tiles (VIIRS 375 m active-fire detections — the same detection stream NASA FIRMS distributes). Evaluation reads stored real detections only; archive-gap days are reported as no-data, never zero-filled.',
        correlationId,
      },
      { status: 201, correlationId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.processingJob.update({ where: { id: job.id }, data: { status: 'failed', error: msg, finishedAt: new Date() } });
    return jsonResponse(
      { error: { code: 'PROVIDER_UNAVAILABLE', message: 'watchlist evaluation failed — no status was fabricated', providerMessage: msg, correlationId } },
      { status: 502, correlationId },
    );
  }
});
