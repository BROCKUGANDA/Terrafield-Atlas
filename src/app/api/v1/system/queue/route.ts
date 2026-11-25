import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { requireAdministrator } from '@/lib/account-access';
import { queueMetrics } from '@/lib/jobs/runtime';

/**
 * GET /api/v1/system/queue — protected operational diagnostics for the durable
 * job queue: depth, oldest-job age, retries, failures, dead-lettered jobs and
 * worker heartbeats.
 *
 * Administrator only: queue metrics reveal tenant workload volume.
 */
export const GET = apiHandler(async (req, { correlationId }) => {
  await requireAdministrator(req);
  const metrics = await queueMetrics();
  return jsonResponse({ queue: metrics, correlationId }, { correlationId });
});
