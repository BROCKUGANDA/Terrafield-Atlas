import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, jsonResponse, parseBody } from '@/lib/api/helpers';
import { aggregateAnnual, analyzeTrend } from '@/lib/stats/analyze';
import { rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import { POWER_VARIABLES } from '@/lib/types';
import type { ObservationPoint, VariableKey } from '@/lib/types';

/**
 * POST /api/v1/reports
 * Compiles the full farm assessment report from REAL stored data only:
 * environmental history + trend results + soil + rotation comparison +
 * provenance references + methodology + honest limitation list.
 * The frontend renders it printable (browser print → PDF).
 */

const bodySchema = z.object({ farmId: z.string() });

export const POST = apiHandler(async (req, { correlationId }) => {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const { farmId } = parsed.data;

  const farm = await db.farm.findUnique({
    where: { id: farmId },
    include: { soilTests: { orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }] } },
  });
  if (!farm) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
  }

  const { centroidLat: lat, centroidLon: lon } = farm;

  const rows = await db.environmentalObservation.findMany({
    where: { lat, lon },
    orderBy: { obsDate: 'asc' },
  });
  const scenarios = await db.rotationScenario.findMany({
    where: { farmId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  // trends on stored data
  const byVar = new Map<string, ObservationPoint[]>();
  for (const r of rows) {
    const arr = byVar.get(r.variable) ?? [];
    arr.push({ date: r.obsDate.toISOString().slice(0, 10), value: r.value });
    byVar.set(r.variable, arr);
  }
  const periodStart = rows.length ? rows[0].obsDate.toISOString().slice(0, 10) : null;
  const periodEnd = rows.length ? rows[rows.length - 1].obsDate.toISOString().slice(0, 10) : null;
  const prelim = [...byVar.keys()].map((v) => {
    const meta = POWER_VARIABLES.find((m) => m.key === v)!;
    return analyzeTrend({
      variable: v as VariableKey, label: meta.label, unit: meta.unit,
      points: byVar.get(v)!, periodStart: periodStart ?? '', periodEnd: periodEnd ?? '',
    });
  });
  const pValues = prelim.map((r) => (r.pValue === null ? 1 : r.pValue));
  const trendResults = prelim.map((r, i) =>
    r.pValue === null ? r : analyzeTrend({
      variable: r.variable, label: r.label, unit: r.unit,
      points: byVar.get(r.variable)!, periodStart: periodStart ?? '', periodEnd: periodEnd ?? '',
      allPValues: pValues, pIndex: i,
    }),
  );
  const annual = Object.fromEntries(trendResults.map((r) => [r.variable, aggregateAnnual(r.variable, byVar.get(r.variable) ?? [])]));

  const [rainfall, thermal] = await Promise.all([rainfallMonthlyStats(lat, lon), thermalMonthlyStats(lat, lon)]);

  const soil = farm.soilTests;
  const measured = soil.find((t) => t.source === 'laboratory') ?? soil.find((t) => t.source === 'farmer') ?? null;
  const soilgrids = soil.find((t) => t.source === 'soilgrids') ?? null;

  const requestLogs = await db.apiRequestLog.findMany({
    where: { OR: [{ provider: 'NASA_POWER' }, { provider: 'GIBS' }, { provider: 'SOILGRIDS' }] },
    orderBy: { retrievedAt: 'desc' },
    take: 12,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    farm: {
      id: farm.id,
      name: farm.name,
      location: { lat, lon },
      country: farm.country,
      region: farm.region,
      areaHa: farm.areaHa,
      cropHistory: farm.cropHistory ? JSON.parse(farm.cropHistory) : [],
      notes: farm.notes,
    },
    environmentalRecord: {
      available: rows.length > 0,
      observationCount: rows.length,
      period: { start: periodStart, end: periodEnd },
      datasetVersions: [...new Set(rows.map((r) => r.datasetVersion))],
      sources: 'NASA POWER Daily API (MERRA-2), 0.5°×0.625° grid cell, LST time standard',
      climatology: rainfall ? { rainfallMonthlyMedianMm: rainfall.p50, years: rainfall.years } : null,
      thermal: thermal ? { meanMonthlyTemperatureC: thermal.meanT, years: thermal.years } : null,
    },
    trendAnalyses: trendResults.map((r) => ({
      variable: r.variable,
      label: r.label,
      unit: r.unit,
      direction: r.direction,
      significant: r.significant,
      slopePerYear: r.slopePerYear,
      ci: [r.ciLower, r.ciUpper],
      pValue: r.pValue,
      fdrAdjustedP: r.multipleTestingAdjustedP,
      sampleCount: r.sampleCount,
      method: r.method,
      minSampleSatisfied: r.minSampleSatisfied,
      interpretation: r.explanation.interpretation,
    })),
    annualSeries: annual,
    soilInformation: {
      measured: measured
        ? {
            source: measured.source,
            measuredAt: measured.measuredAt,
            ph: measured.ph, texture: measured.texture,
            organicCarbonPct: measured.organicCarbonPct,
            nitrogenMgKg: measured.nitrogenMgKg,
            phosphorusMgKg: measured.phosphorusMgKg,
            potassiumCmolKg: measured.potassiumCmolKg,
            notes: measured.notes,
          }
        : null,
      supplementaryModeled: soilgrids
        ? { source: 'SoilGrids v2.0 (modeled, 250 m grid — not an in-field measurement)', ph: soilgrids.ph, texture: soilgrids.texture, detail: soilgrids.sourceDetail }
        : null,
      note: 'Satellite soil-moisture estimates are never substituted for measured soil characteristics; they are reported separately in the environmental record.',
    },
    rotationScenarios: scenarios.map((s) => ({
      name: s.name,
      cropKeys: JSON.parse(s.cropKeys),
      ruleVersion: s.ruleVersion,
      overallScore: s.overallScore,
      confidence: s.confidence,
      incompatible: JSON.parse(s.incompatibleJson ?? '[]'),
      fullResult: JSON.parse(s.scoresJson),
      createdAt: s.createdAt,
    })),
    provenance: requestLogs.map((l) => ({
      provider: l.provider,
      datasetId: l.datasetId,
      operation: l.operation,
      status: l.status,
      ok: l.ok,
      latencyMs: l.latencyMs,
      retrievedAt: l.retrievedAt,
      requestUrl: l.requestUrl,
    })),
    methodology: {
      trendEngine:
        'Daily observations aggregated to complete months (≥ 20 valid days; precipitation summed, others averaged). Seasonal Mann-Kendall (Hirsch & Slack 1984) across 12 calendar months with tie-corrected variance; Theil-Sen seasonal slope (median of pooled within-month pairwise slopes) with Sen-rank 95% CI; Hamed-Rao (1998) lag-1 variance inflation applied when deseasonalized lag-1 autocorrelation exceeds the ±2/√n white-noise bound; Benjamini-Hochberg FDR across the variables analysed together; minimum 8 full years required before any significance claim; anomalies = monthly z-scores ≥ 2σ against the hold-out climatology.',
      rotationEngine:
        'Deterministic multi-criteria scoring over: family-sequence compatibility, legume N contribution, water-demand compatibility (FAO I&D Paper 33 ranges vs POWER rainfall climatology), seasonal thermal feasibility, nutrient-balance sequence rules, crop diversity, soil pH/texture suitability, staple presence, economics (honest not-assessed). Missing inputs remove criteria from scoring and reduce confidence instead of counting as zero. Rule citations: FAO 1979; FAO 2016; Karlen et al. 1994; FAO EcoCrop ranges.',
      honestyRules: [
        'No environmental correlation is ever presented as proof of agricultural causation.',
        'Missing data is never imputed; it is counted and surfaced.',
        'No yield or profit prediction is made anywhere in the product.',
        'Modeled SoilGrids values never silently substitute measured soil tests.',
        'Every observation traces to a provider request with a retrieval timestamp.',
      ],
    },
    limitations: [
      'NASA POWER values are reanalysis grid-cell estimates (0.5°×0.625°, LST day boundaries), not farm microclimate.',
      'MOD13Q1 NDVI and SMAP L4 soil moisture are served as GIBS colormap visualizations; quantitative per-pixel series with QA flags require Earthdata credentials not configured in this deployment.',
      'VIIRS fire detections miss fires that start and end between the ~twice-daily overpasses, and clouds block detection.',
      'FIRMS CSV API is reachable from this deployment (host probed live); fire data is served from the live GIBS VIIRS stream (same detections).',
      'SoilGrids is a 250 m modeled surface; treat as indicative until a laboratory test confirms.',
      'The rotation engine compares documented requirements against evidence; it does not model local pest pressure, markets, labor, or varieties.',
    ],
  };

  return jsonResponse(report, { correlationId });
});
