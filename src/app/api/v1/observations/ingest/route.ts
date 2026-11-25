import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';
import { enqueueJob, jobUrl } from '@/lib/queue';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement } from '@/lib/commercial';

/**
 * POST /api/v1/observations/ingest
 *
 * Ingests (idempotently) the real NASA POWER daily record for a farm or
 * coordinate. Ingestion of a 12-year x 7-variable record takes tens of
 * seconds of provider traffic, so the route does NOT run it inline:
 *
 *  - the durable job row and its outbox event are committed atomically,
 *  - the queue pointer is pushed afterwards,
 *  - the client receives 202 with the durable job id and the job URL.
 *
 * The worker (src/lib/jobs/worker.ts) executes the job with a heartbeat
 * lease, an overall deadline, cooperative cancellation and PostgreSQL
 * natural-key upserts, so a retry never duplicates an observation.
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
  const rl = await rateLimit(clientKey(req, 'observations:ingest'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  const farmId = body.farmId ?? null;
  let dataOwnerId: string | null = null;
  let dataOrganizationId: string | null = null;
  if (farmId) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true, ownerId: true, organizationId: true } });
    if (!farm) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
    }
    lat ??= farm.centroidLat;
    lon ??= farm.centroidLon;
    dataOwnerId = farm.ownerId;
    dataOrganizationId = farm.organizationId;
  }
  if (lat === undefined || lon === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }

  // The tenant is the authenticated account; the data owner is the farm owner
  // (null for the shared public namespace).
  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  await assertEntitlement(context, 'processing_jobs_per_month');
  const tenantId = context.userId ?? dataOwnerId;
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() || null;

  const job = await enqueueJob({
    type: 'power-ingest',
    ownerId: tenantId,
    organizationId: context.organizationId ?? dataOrganizationId,
    params: { lat, lon, years: body.years, variables: body.variables, farmId, ownerId: dataOwnerId, organizationId: dataOrganizationId },
    correlationId,
    idempotencyKey,
    route: '/api/v1/observations/ingest',
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
      correlationId,
      message: job.enqueued
        ? 'Ingestion is queued as a durable job. Poll the job URL for the result.'
        : 'Ingestion is queued as a durable job; the queue pointer is pending outbox reconciliation.',
    },
    { status: 202, correlationId, headers: { Location: url } },
  );
});
