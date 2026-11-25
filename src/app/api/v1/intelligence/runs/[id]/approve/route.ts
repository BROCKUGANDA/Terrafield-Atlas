import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, withIdempotency } from '@/lib/api/helpers';
import { executeAgentRun } from '@/lib/intelligence';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement } from '@/lib/commercial';

type RunCtx = { params: Promise<{ id: string }> };

export const POST = apiHandler<RunCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/intelligence/runs/${req.nextUrl.pathname.split('/')[5]}/approve`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  const run = await db.agentRun.findUnique({ where: { id } });
  if (!run || run.ownerId !== userId || run.organizationId !== context.organizationId) return errorResponse(404, 'NOT_FOUND', 'agent run not found', correlationId);
  if (run.status !== 'awaiting_approval') return errorResponse(409, 'INVALID_RUN_STATE', `run is ${run.status}`, correlationId);
  await assertEntitlement(context, 'ai_runs_per_month');
  const claimed = await db.agentRun.updateMany({ where: { id, status: 'awaiting_approval' }, data: { status: 'running', approvedAt: new Date() } });
  if (claimed.count !== 1) return errorResponse(409, 'INVALID_RUN_STATE', 'run was already claimed', correlationId);
  try {
    const result = await executeAgentRun(id, context);
    const updated = await db.agentRun.findUniqueOrThrow({ where: { id } });
    return jsonResponse({ run: updated, result }, { correlationId });
  } catch (error) {
    await db.agentRun.update({ where: { id }, data: { status: 'failed', finishedAt: new Date(), limitationsJson: JSON.stringify([error instanceof Error ? error.message : 'agent execution failed']) } });
    return errorResponse(502, 'AGENT_EXECUTION_FAILED', error instanceof Error ? error.message : 'agent execution failed', correlationId);
  }
}));
