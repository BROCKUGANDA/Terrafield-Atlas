import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { FIRE_ARCHIVE_START } from '@/lib/adapters/gibsFires';
import { regionBboxAround, regionKeyFor } from '@/lib/geo';
import { firmsConfigured } from '@/lib/adapters/firms';
import { AccountAccessError } from '@/lib/account-access';
import { canReadResource, requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement } from '@/lib/commercial';
import { enqueueJob, jobUrl } from '@/lib/queue';
import type { FireDetection } from '@/lib/adapters/gibsFires';

const snapshotLimit = 5_000;
const snapshotType = 'private-fires-snapshot-v1';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

async function resolveFarm(req: Request, farmId?: string) {
  if (!farmId) return null;
  const farm = await db.farm.findUnique({ where: { id: farmId }, select: { ownerId: true, organizationId: true, centroidLat: true, centroidLon: true } });
  const context = await resolveTenantContext(req);
  if (!farm || !canReadResource(context, farm)) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
  if (req.method === 'POST' && context.userId && farm.ownerId !== context.userId && farm.organizationId !== context.organizationId) throw new AccountAccessError(403, 'READ_ONLY_DEMO', 'demo farms are read-only while signed in');
  return farm;
}

const privateDetection = z.object({
  obsDate: isoDate, acqTime: z.string(), latitude: z.number().finite(), longitude: z.number().finite(),
  confidence: z.enum(['low', 'nominal', 'high']), satellite: z.string(), dayNight: z.enum(['D', 'N']),
  brightTi4: z.number().nullable(), brightTi5: z.number().nullable(), frp: z.number().nullable(), uid: z.string().nullable(),
});
const snapshotSchema = z.object({
  days: z.array(z.object({ date: isoDate, dataAvailable: z.boolean(), stale: z.boolean(), truncated: z.boolean(), detections: z.array(privateDetection).max(snapshotLimit) })).max(41),
});

async function privateFires(ownerId: string, farmId: string, lat: number, lon: number, from: string, to: string, confidence?: string, dayNight?: string) {
  const bbox = regionBboxAround(lat, lon);
  const jobs = await db.processingJob.findMany({
    where: { ownerId, type: snapshotType, status: 'succeeded' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 51, select: { params: true, resultRef: true },
  });
  const days = new Map<string, z.infer<typeof snapshotSchema>['days'][number]>();
  for (const job of jobs.slice(0, 50)) {
    try {
      const params = JSON.parse(job.params);
      if (params.farmId !== farmId || params.lat !== lat || params.lon !== lon) continue;
      const snapshot = snapshotSchema.safeParse(JSON.parse(job.resultRef ?? 'null'));
      if (!snapshot.success) continue;
      for (const day of snapshot.data.days) {
        if (day.date >= from && day.date <= to && !days.has(day.date)) days.set(day.date, day);
      }
    } catch { /* Invalid snapshots never establish coverage. */ }
  }
  const unique = new Map<string, FireDetection>();
  let readTruncated = false;
  for (const day of days.values()) for (const d of day.detections) {
    if (d.obsDate !== day.date || d.latitude < bbox.south || d.latitude > bbox.north || d.longitude < bbox.west || d.longitude > bbox.east) continue;
    if ((confidence && d.confidence !== confidence) || (dayNight && d.dayNight !== dayNight)) continue;
    const key = JSON.stringify([d.obsDate, d.acqTime, d.latitude, d.longitude, d.uid, d.satellite]);
    if (unique.size >= 20_000 && !unique.has(key)) {
      readTruncated = true;
      continue;
    }
    unique.set(key, d);
  }
  const detections = [...unique.values()].sort((a, b) => a.obsDate.localeCompare(b.obsDate) || a.acqTime.localeCompare(b.acqTime));
  const monthly = new Map<string, number>();
  const confidenceDistribution = { low: 0, nominal: 0, high: 0 };
  const frps: number[] = [];
  for (const detection of detections) {
    const month = detection.obsDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 0) + 1);
    confidenceDistribution[detection.confidence]++;
    if (detection.frp !== null) frps.push(detection.frp);
  }
  const coverage = dateRange(from, to).map((date) => {
    const day = days.get(date);
    return { date, checked: !!day, dataAvailable: day?.dataAvailable ?? false, stale: day?.stale ?? false, detectionsTruncated: day?.truncated ?? false };
  });
  return {
    location: { lat, lon }, region: { key: regionKeyFor(lat, lon), bbox }, requestedRange: { from, to },
    count: detections.length, detections: detections.slice(0, 500).map((d) => ({
      date: d.obsDate, time: d.acqTime, latitude: d.latitude, longitude: d.longitude,
      confidence: d.confidence, dayNight: d.dayNight, frp: d.frp, brightTi4: d.brightTi4, sensor: 'VIIRS_SNPP',
    })),
    coverage, noDataDays: coverage.filter((d) => d.checked && !d.dataAvailable).map((d) => d.date),
    uncheckedDays: coverage.filter((d) => !d.checked).map((d) => d.date),
    truncated: readTruncated || detections.length > 500 || coverage.some((d) => d.detectionsTruncated) || jobs.length > 50,
    snapshotLookupTruncated: jobs.length > 50,
    countsPartial: readTruncated || jobs.length > 50 || coverage.some((d) => !d.checked || !d.dataAvailable || d.stale || d.detectionsTruncated),
    monthlyCounts: [...monthly.entries()].map(([month, count]) => ({ month, count })), confidenceDistribution,
    frpStats: frps.length ? { meanMW: Number((frps.reduce((a, b) => a + b, 0) / frps.length).toFixed(1)), minMW: Number(frps.reduce((a, b) => Math.min(a, b), Infinity).toFixed(1)), count: frps.length } : null,
    source: 'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All; private farm snapshots only',
    limitations: 'Only the latest matching snapshot per date is used (up to 50 recent owner jobs). Unchecked, incomplete or stale coverage never proves zero fires; stored detections are capped at 5000 per ingest, aggregates at 20000 and responses at 500.',
  };
}

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
  from: isoDate,
  to: isoDate,
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
  const farm = await resolveFarm(req, farmId);
  latitude ??= farm?.centroidLat;
  longitude ??= farm?.centroidLon;
  if (latitude === undefined || longitude === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }
  if (from < FIRE_ARCHIVE_START) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `VIIRS fire archive starts ${FIRE_ARCHIVE_START}`, correlationId } }, { status: 400, correlationId });
  }

  if (farm?.ownerId && farmId) {
    try {
      return jsonResponse(await privateFires(farm.ownerId, farmId, latitude, longitude, from, to, confidence, dayNight), { correlationId });
    } catch {
      return jsonResponse({ error: { code: 'PRIVATE_STORAGE_UNAVAILABLE', message: 'Private fire snapshots are temporarily unavailable.', correlationId } }, { status: 503, correlationId });
    }
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
  from: isoDate,
  to: isoDate,
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = await rateLimit(clientKey(req, 'fires:ingest'), { capacity: 4, refillPerMinute: 2 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, postSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  const farm = await resolveFarm(req, body.farmId);
  lat ??= farm?.centroidLat;
  lon ??= farm?.centroidLon;
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
  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  await assertEntitlement(context, 'processing_jobs_per_month');
  const tenantId = context.userId;
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() || null;

  if (farm?.ownerId && body.farmId) {
    // Private per-farm snapshot: executed as a durable job so the provider
    // traffic never blocks the request and a crash is recoverable.
    const job = await enqueueJob({
      type: snapshotType,
      ownerId: tenantId ?? farm.ownerId,
      organizationId: context.organizationId ?? farm.organizationId,
      params: { farmId: body.farmId, lat, lon, from: body.from, to: body.to, ownerId: farm.ownerId, organizationId: farm.organizationId },
      correlationId,
      idempotencyKey,
      route: '/api/v1/fires',
    });
    const url = jobUrl(job.jobId);
    return jsonResponse(
      {
        jobId: job.jobId,
        jobUrl: url,
        type: job.type,
        status: job.status,
        duplicate: !job.created,
        enqueued: job.enqueued,
        deadlineAt: job.deadlineAt,
        region: { key: regionKey, bbox },
        correlationId,
        message: job.enqueued
          ? 'Private fire ingestion is queued as a durable job. Poll the job URL for the snapshot.'
          : 'Private fire ingestion is queued as a durable job; the queue pointer is pending outbox reconciliation.',
      },
      { status: 202, correlationId, headers: { Location: url } },
    );
  }

  const job = await enqueueJob({
    type: 'fires-ingest',
    ownerId: tenantId,
    organizationId: context.organizationId,
    params: { lat, lon, from: body.from, to: body.to },
    correlationId,
    idempotencyKey,
    route: '/api/v1/fires',
  });
  const url = jobUrl(job.jobId);
  return jsonResponse(
    {
      jobId: job.jobId,
      jobUrl: url,
      type: job.type,
      status: job.status,
      duplicate: !job.created,
      enqueued: job.enqueued,
      deadlineAt: job.deadlineAt,
      region: { key: regionKey, bbox },
      correlationId,
      message: job.enqueued
        ? 'Fire ingestion is queued as a durable job. Poll the job URL for the result.'
        : 'Fire ingestion is queued as a durable job; the queue pointer is pending outbox reconciliation.',
    },
    { status: 202, correlationId, headers: { Location: url } },
  );
});
