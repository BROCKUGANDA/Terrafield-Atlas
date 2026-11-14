import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { analyzeTrend, aggregateAnnual } from '@/lib/stats/analyze';
import { POWER_VARIABLES } from '@/lib/types';
import type { ObservationPoint, VariableKey } from '@/lib/types';

/**
 * POST /api/v1/analysis/trends
 * Runs the trend-detection pipeline (Seasonal Mann-Kendall + Theil-Sen +
 * anomalies + FDR) over stored POWER observations for a location.
 * Data must already be ingested; if not, a 409 with instructions is returned
 * (never an analysis of nothing, never synthetic data).
 */

const bodySchema = z.object({
  farmId: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  variables: z
    .array(z.enum(POWER_VARIABLES.map((v) => v.key) as [VariableKey, ...VariableKey[]]))
    .min(1)
    .default(['PRECTOTCORR', 'T2M', 'T2M_MAX', 'T2M_MIN', 'ALLSKY_SFC_SW_DWN', 'RH2M', 'GWETROOT']),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'analysis:trends'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  let farmId: string | null = body.farmId ?? null;
  if (farmId && (lat === undefined || lon === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true } });
    if (!farm) return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
    lat = farm.centroidLat;
    lon = farm.centroidLon;
  }
  if (lat === undefined || lon === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }

  const rows = await db.environmentalObservation.findMany({
    where: { lat, lon, variable: { in: body.variables } },
    orderBy: { obsDate: 'asc' },
  });

  if (rows.length === 0) {
    return jsonResponse(
      {
        error: {
          code: 'NO_DATA_INGESTED',
          message: `No POWER observations are stored for ${lat.toFixed(3)},${lon.toFixed(3)}. Call POST /api/v1/observations/ingest first — trends are computed on real observations only, never on synthetic data.`,
          correlationId,
        },
      },
      { status: 409, correlationId },
    );
  }

  // Build per-variable daily series
  const byVar = new Map<string, ObservationPoint[]>();
  for (const r of rows) {
    const arr = byVar.get(r.variable) ?? [];
    arr.push({ date: r.obsDate.toISOString().slice(0, 10), value: r.value });
    byVar.set(r.variable, arr);
  }

  const periodStart = rows[0].obsDate.toISOString().slice(0, 10);
  const periodEnd = rows[rows.length - 1].obsDate.toISOString().slice(0, 10);

  // First pass to collect p-values for FDR
  const prelim = body.variables
    .filter((v) => byVar.has(v))
    .map((v) => {
      const meta = POWER_VARIABLES.find((m) => m.key === v)!;
      return analyzeTrend({
        variable: v,
        label: meta.label,
        unit: meta.unit,
        points: byVar.get(v)!,
        periodStart,
        periodEnd,
      });
    });
  const pValues = prelim.map((r) => (r.pValue === null ? 1 : Math.min(1, Math.max(0, r.pValue))));
  const results = prelim.map((r, i) =>
    r.pValue === null
      ? r
      : analyzeTrend({
          variable: r.variable,
          label: r.label,
          unit: r.unit,
          points: byVar.get(r.variable)!,
          periodStart,
          periodEnd,
          allPValues: pValues,
          pIndex: i,
        }),
  );

  // Persist analyses (traceable, reproducible)
  for (const r of results) {
    await db.trendAnalysis.create({
      data: {
        farmId,
        lat,
        lon,
        variable: r.variable,
        periodStart: new Date(`${periodStart}T00:00:00Z`),
        periodEnd: new Date(`${periodEnd}T00:00:00Z`),
        sampleCount: r.sampleCount,
        method: r.method,
        slopePerYear: r.slopePerYear,
        pValue: r.pValue,
        zValue: r.zValue,
        direction: r.direction,
        significant: r.significant,
        ciLower: r.ciLower,
        ciUpper: r.ciUpper,
        resultJson: JSON.stringify(r),
        ruleVersion: 'trend-engine/2026.11-r1',
      },
    });
  }

  const job = await db.processingJob.create({
    data: {
      type: 'trends',
      status: 'succeeded',
      params: JSON.stringify({ lat, lon, variables: body.variables, farmId }),
      progressNote: `${results.length} variables analysed from ${rows.length} stored observations (${periodStart} → ${periodEnd})`,
      resultRef: JSON.stringify(results.map((r) => ({ variable: r.variable, direction: r.direction, significant: r.significant }))),
      correlationId,
      finishedAt: new Date(),
    },
  });

  // annual series for chart overlays
  const annual = Object.fromEntries(
    results.map((r) => [r.variable, aggregateAnnual(r.variable, byVar.get(r.variable) ?? [])]),
  );

  return jsonResponse(
    {
      jobId: job.id,
      location: { lat, lon },
      farmId,
      period: { start: periodStart, end: periodEnd },
      observationCount: rows.length,
      datasetVersions: [...new Set(rows.map((r) => r.datasetVersion))],
      multipleTesting: {
        method: 'Benjamini-Hochberg FDR across requested variables',
        testedHypotheses: pValues.length,
      },
      results,
      annualSeries: annual,
    },
    { correlationId },
  );
});
