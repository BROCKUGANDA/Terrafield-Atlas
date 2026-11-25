import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse } from '@/lib/api/helpers';
import { canReadResource, canWriteResource, resolveTenantContext } from '@/lib/tenancy';
import { requestJobCancellation } from '@/lib/jobs/runtime';

/**
 * GET    /api/v1/analysis/jobs/{jobId} — durable job status and result
 * DELETE /api/v1/analysis/jobs/{jobId} — request cooperative cancellation
 */

type JobCtx = { params: Promise<{ jobId: string }> };

function parseResult(resultRef: string | null): unknown {
  if (!resultRef) return null;
  try {
    return JSON.parse(resultRef) as unknown;
  } catch {
    return null;
  }
}

export const GET = apiHandler<JobCtx>(async (req, { correlationId, params }) => {
  const { jobId } = await params;
  const job = await db.processingJob.findUnique({ where: { id: jobId } });
  const context = await resolveTenantContext(req);
  if (!job || !canReadResource(context, job)) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `job ${jobId} not found`, correlationId } }, { status: 404, correlationId });
  }
  const { resultRef, ...rest } = job;
  return jsonResponse(
    {
      job: rest,
      result: parseResult(resultRef),
      jobUrl: `/api/v1/analysis/jobs/${job.id}`,
    },
    { correlationId },
  );
});

export const DELETE = apiHandler<JobCtx>(async (req, { correlationId, params }) => {
  const { jobId } = await params;
  const context = await resolveTenantContext(req);
  const job = await db.processingJob.findUnique({ where: { id: jobId } });
  if (!job || !canReadResource(context, job)) {
    return errorResponse(404, 'NOT_FOUND', `job ${jobId} not found`, correlationId);
  }
  if (!canWriteResource(context, job)) {
    return errorResponse(403, 'READ_ONLY_DEMO', 'only the owning account can cancel this job', correlationId);
  }
  const requested = await requestJobCancellation(jobId);
  if (!requested) {
    return errorResponse(409, 'JOB_NOT_CANCELLABLE', `job ${jobId} is already ${job.status}`, correlationId);
  }
  return jsonResponse(
    {
      jobId,
      status: 'cancelling',
      message: 'Cancellation requested; the job stops at its next cooperative checkpoint.',
      correlationId,
    },
    { status: 202, correlationId },
  );
});
