import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse } from '@/lib/api/helpers';
import { resolveTenantContext } from '@/lib/tenancy';

type RunCtx = { params: Promise<{ id: string }> };

export const GET = apiHandler<RunCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  const run = await db.agentRun.findUnique({ where: { id }, include: { toolExecutions: { orderBy: { startedAt: 'asc' } }, evidence: true } });
  if (!run || !context.userId || run.ownerId !== context.userId || run.organizationId !== context.organizationId) {
    return errorResponse(404, 'NOT_FOUND', 'agent run not found', correlationId);
  }
  return jsonResponse({ run, plan: JSON.parse(run.planJson), result: run.resultJson ? JSON.parse(run.resultJson) : null }, { correlationId });
});
