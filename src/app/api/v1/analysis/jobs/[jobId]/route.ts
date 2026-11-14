import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';

/**
 * GET /api/v1/analysis/jobs/{jobId}
 * Job status retrieval (power-ingest, trends, rotation, fires).
 */

type JobCtx = { params: Promise<{ jobId: string }> };

export const GET = apiHandler<JobCtx>(async (req, { correlationId, params }) => {
  const { jobId } = await params;
  const job = await db.processingJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `job ${jobId} not found`, correlationId } }, { status: 404, correlationId });
  }
  return jsonResponse({ job }, { correlationId });
});
