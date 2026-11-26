import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { POWER_VARIABLES } from '@/lib/types';
import type { VariableKey } from '@/lib/types';
import { enqueueJob, jobUrl } from '@/lib/queue';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { withQuotaGuard } from '@/lib/commercial';

/**
 * POST /api/v1/analysis/trends
 *
 * Runs the trend-detection pipeline (Seasonal Mann-Kendall + Theil-Sen +
 * anomalies + FDR) over stored POWER observations for a location.
 *
 * The analysis is CPU-bound work over years of stored observations, so it runs
 * as a durable job: the route commits the job row and its outbox event,
 * pushes the queue pointer and answers 202 with the durable job id.
 *
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
  const rl = await rateLimit(clientKey(req, 'analysis:trends'), { capacity: 10, refillPerMinute: 5 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  let lat = body.lat;
  let lon = body.lon;
  const farmId: string | null = body.farmId ?? null;
  let dataOwnerId: string | null = null;
  let dataOrganizationId: string | null = null;
  if (farmId) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true, ownerId: true, organizationId: true } });
    if (!farm) return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
    lat ??= farm.centroidLat;
    lon ??= farm.centroidLon;
    dataOwnerId = farm.ownerId;
    dataOrganizationId = farm.organizationId;
  }
  if (lat === undefined || lon === undefined) {
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'provide farmId or lat+lon', correlationId } }, { status: 400, correlationId });
  }

  // Honest pre-flight: trends are computed on real stored observations only.
  // The scope never widens to another tenant's observations.
  const existing = await db.environmentalObservation.findMany({
    where: { lat, lon, ownerId: dataOwnerId, organizationId: dataOrganizationId, variable: { in: body.variables }, ...(farmId ? { farmId } : {}) },
    orderBy: { obsDate: 'asc' },
    take: 1,
    select: { id: true },
  });
  if (existing.length === 0) {
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

  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  const tenantId = context.userId ?? dataOwnerId;
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() || null;

  const job = await withQuotaGuard(context, 'processing_jobs_per_month', () => enqueueJob({
    type: 'trends',
    ownerId: tenantId,
    organizationId: context.organizationId ?? dataOrganizationId,
    params: { lat, lon, variables: body.variables, farmId, ownerId: dataOwnerId, organizationId: dataOrganizationId },
    correlationId,
    idempotencyKey,
    route: '/api/v1/analysis/trends',
  }));

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
        ? 'Trend analysis is queued as a durable job. Poll the job URL for the result.'
        : 'Trend analysis is queued as a durable job; the queue pointer is pending outbox reconciliation.',
    },
    { status: 202, correlationId, headers: { Location: url } },
  );
});
