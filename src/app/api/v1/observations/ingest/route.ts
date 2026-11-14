import { z } from 'zod';
import { db } from '@/lib/db';
import { ingestPowerForLocation } from '@/lib/ingest/power';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';

/**
 * POST /api/v1/observations/ingest
 * Ingests (idempotently) the real NASA POWER daily record for a farm or
 * coordinate. Creates a ProcessingJob record and runs the ingestion inline
 * with status tracking (the sandbox runs a single process; the job ledger
 * provides the same observability a queue would).
 *
 * Because ingestion of a 12-year × 7-variable record takes ~10-20 s (three
 * 5-year POWER requests), the route accepts a `years` parameter (min 2) and
 * returns a full result; the frontend drives it with a loading state and the
 * job is recorded either way.
 */

const bodySchema = z.object({
  farmId: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  years: z.number().int().min(2).max(25).default(12),
  variables: z
    .array(z.enum(POWER_VARIABLES.map((v) => v.key) as [VariableKey, ...VariableKey[]]))
    .default(['PRECTOTCORR', 'T2M', 'T2M_MAX', 'T2M_MIN', 'ALLSKY_SFC_SW_DWN', 'RH2M', 'GWETROOT']),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'observations:ingest'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  let farmId = body.farmId ?? null;
  if (farmId && (lat === undefined || lon === undefined)) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true } });
    if (!farm) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
    }
    lat = farm.centroidLat;
    lon = farm.centroidLon;
  }
  if (lat === undefined || lon === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }

  const job = await db.processingJob.create({
    data: {
      type: 'power-ingest',
      status: 'running',
      params: JSON.stringify({ lat, lon, years: body.years, variables: body.variables, farmId }),
      correlationId,
      progressNote: 'requesting NASA POWER daily API (MERRA-2) in 5-year chunks',
    },
  });

  try {
    const outcome = await ingestPowerForLocation(lat, lon, body.years, body.variables, farmId ?? undefined, correlationId);
    const done = await db.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        progressNote: `wrote ${outcome.rowsWritten} observations (${outcome.chunks} POWER requests)`,
        resultRef: JSON.stringify(outcome),
        finishedAt: new Date(),
      },
    });
    return jsonResponse({ job: done, outcome }, { status: 201, correlationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.processingJob.update({
      where: { id: job.id },
      data: { status: 'failed', error: msg, finishedAt: new Date(), progressNote: 'provider request failed after retries with backoff' },
    });
    return jsonResponse(
      { error: { code: 'PROVIDER_UNAVAILABLE', message: 'NASA POWER ingestion failed after retries with exponential backoff. No data was fabricated.', providerMessage: msg, jobId: job.id, correlationId } },
      { status: 502, correlationId },
    );
  }
});
