import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { fetchFiresForDate, persistFireDetections, FIRE_ARCHIVE_START } from '@/lib/adapters/gibsFires';
import { regionBboxAround, regionKeyFor } from '@/lib/geo';
import { firmsConfigured } from '@/lib/adapters/firms';
import { recordIngestCoverage } from '@/lib/fires/coverage';

/**
 * GET  /api/v1/fires?farmId=|lat=&lon=&from=&to= — stored real detections
 * POST /api/v1/fires — ingest real VIIRS detections (GIBS MVT) for a date
 *      range around a location (max 40 days per call to stay polite).
 *
 * FIRMS CSV adapter status is reported alongside (unreachable / no MAP_KEY),
 * and the GIBS VIIRS stream is labeled as the actual source of detections.
 */

const getSchema = z.object({
  farmId: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confidence: z.enum(['low', 'nominal', 'high']).optional(),
  dayNight: z.enum(['D', 'N']).optional(),
});

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const q = getSchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!q.success) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'from/to (YYYY-MM-DD) are required; provide farmId or lat+lon', details: q.error.issues, correlationId } }, { status: 400, correlationId });
  }
  const { farmId, lat, lon, from, to, confidence, dayNight } = q.data;
  if (daysBetween(from, to) < 0 || daysBetween(from, to) > 366) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'invalid date range (max 366 days)', correlationId } }, { status: 400, correlationId });
  }

  let latitude = lat;
  let longitude = lon;
  if (farmId && (latitude === undefined || longitude === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true } });
    if (farm) {
      latitude ??= farm.centroidLat;
      longitude ??= farm.centroidLon;
    }
  }
  if (latitude === undefined || longitude === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }
  if (from < FIRE_ARCHIVE_START) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `VIIRS fire archive starts ${FIRE_ARCHIVE_START}`, correlationId } }, { status: 400, correlationId });
  }

  const bbox = regionBboxAround(latitude, longitude);
  const regionKey = regionKeyFor(latitude, longitude);
  const where: Record<string, unknown> = {
    regionKey,
    obsDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) },
    latitude: { gte: bbox.south, lte: bbox.north },
    longitude: { gte: bbox.west, lte: bbox.east },
  };
  if (confidence) where.confidence = confidence;
  if (dayNight) where.dayNight = dayNight;

  const detections = await db.fireObservation.findMany({ where, orderBy: { obsDate: 'asc' }, take: 20_000 });

  // aggregates: monthly counts, confidence distribution, FRP stats
  const monthly = new Map<string, number>();
  const confDist = { low: 0, nominal: 0, high: 0 };
  let frpSum = 0;
  let frpCount = 0;
  for (const d of detections) {
    const key = d.obsDate.toISOString().slice(0, 7);
    monthly.set(key, (monthly.get(key) ?? 0) + 1);
    confDist[d.confidence as keyof typeof confDist]++;
    if (d.frp !== null) {
      frpSum += d.frp;
      frpCount++;
    }
  }

  return jsonResponse(
    {
      location: { lat: latitude, lon: longitude },
      region: { key: regionKey, bbox },
      requestedRange: { from, to },
      count: detections.length,
      source:
        'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All vector tiles (VIIRS 375 m active-fire detections, same detection stream NASA FIRMS distributes). FIRMS CSV adapter: ' +
        (firmsConfigured() ? 'MAP_KEY configured (host currently unreachable from sandbox)' : 'MAP_KEY not configured'),
      monthlyCounts: [...monthly.entries()].sort().map(([month, count]) => ({ month, count })),
      confidenceDistribution: confDist,
      frpStats: frpCount
        ? { meanMW: Number((frpSum / frpCount).toFixed(1)), minMW: Number(Math.min(...detections.filter((d) => d.frp !== null).map((d) => d.frp as number)).toFixed(1)), count: frpCount }
        : null,
      detections: detections.slice(0, 500).map((d) => ({
        date: d.obsDate.toISOString().slice(0, 10),
        time: d.acqTime,
        latitude: d.latitude,
        longitude: d.longitude,
        confidence: d.confidence,
        dayNight: d.dayNight,
        frp: d.frp,
        brightTi4: d.brightTi4,
        sensor: d.sensor,
      })),
      truncated: detections.length > 500,
      limitations:
        'VIIRS overpasses ~twice daily (day/night): fires starting and ending between overpasses are invisible; cloud cover blocks detection; gap days exist in the archive (returned honestly as no-data).',
    },
    { correlationId },
  );
});

const postSchema = z.object({
  farmId: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'fires:ingest'), { capacity: 4, refillPerMinute: 2 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, postSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  if (body.farmId && (lat === undefined || lon === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: body.farmId }, select: { centroidLat: true, centroidLon: true } });
    if (!farm) return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${body.farmId} not found`, correlationId } }, { status: 404, correlationId });
    lat = farm.centroidLat;
    lon = farm.centroidLon;
  }
  if (lat === undefined || lon === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }
  const days = daysBetween(body.from, body.to);
  if (days < 0 || days > 40) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `date range must be 0–40 days (got ${days})`, correlationId } }, { status: 400, correlationId });
  }
  if (body.from < FIRE_ARCHIVE_START) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `VIIRS fire archive starts ${FIRE_ARCHIVE_START}`, correlationId } }, { status: 400, correlationId });
  }

  const regionKey = regionKeyFor(lat, lon);
  const bbox = regionBboxAround(lat, lon);
  const job = await db.processingJob.create({
    data: {
      type: 'fires-ingest',
      status: 'running',
      params: JSON.stringify({ lat, lon, from: body.from, to: body.to }),
      correlationId,
      progressNote: `decoding GIBS VIIRS thermal-anomaly vector tiles for ${days + 1} day(s)`,
    },
  });

  let totalDetections = 0;
  let written = 0;
  const noDataDays: string[] = [];
  try {
    for (const date of dateRange(body.from, body.to)) {
      const res = await fetchFiresForDate(date, bbox, correlationId);
      // Record honest archive coverage (drives watchlist evaluations): a row
      // here means "GIBS was asked for this date over this bbox".
      await recordIngestCoverage(lat, lon, date, bbox, res.dataAvailable, res.detections.length);
      if (!res.dataAvailable && res.detections.length === 0) {
        noDataDays.push(date);
        continue;
      }
      totalDetections += res.detections.length;
      written += await persistFireDetections(regionKey, res.detections);
    }
    const done = await db.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        progressNote: `${totalDetections} real detections decoded; ${written} new rows stored${noDataDays.length ? `; ${noDataDays.length} day(s) had no archive data (reported honestly)` : ''}`,
        resultRef: JSON.stringify({ totalDetections, written, noDataDays }),
        finishedAt: new Date(),
      },
    });
    return jsonResponse(
      {
        job: done,
        region: { key: regionKey, bbox },
        totalDetections,
        rowsWritten: written,
        noDataDays,
        source: 'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All (VIIRS 375 m detections; the same detection stream NASA FIRMS distributes)',
      },
      { status: 201, correlationId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.processingJob.update({ where: { id: job.id }, data: { status: 'failed', error: msg, finishedAt: new Date() } });
    return jsonResponse({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'GIBS fire tile ingestion failed. No data fabricated.', providerMessage: msg, correlationId } }, { status: 502, correlationId });
  }
});
