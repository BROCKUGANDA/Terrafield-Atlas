import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { buildAnalysisPlan, intelligenceQuerySchema, type AnalysisPlan } from '@/lib/intelligence';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { requireFeature } from '@/lib/feature-flags';

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/intelligence/plans', async (req, { userId }) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'farm.read');
  await requireFeature('intelligence.enabled');
  const rl = await rateLimit(clientKey(req, 'intelligence:plan'), { capacity: 20, refillPerMinute: 6 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, intelligenceQuerySchema);
  if (!parsed.ok) return parsed.res;
  const plan = buildAnalysisPlan(parsed.data);
  return {
    commit: async (tx) => {
      const run = await tx.agentRun.create({
        data: {
          ownerId: userId,
          organizationId: context.organizationId,
          query: parsed.data.query,
          planJson: JSON.stringify(plan),
          status: plan.intent === 'unsupported' ? 'failed' : 'awaiting_approval',
          limitationsJson: JSON.stringify(plan.limitations),
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'intelligence.plan.create',
        targetId: run.id,
        organizationId: context.organizationId,
        aggregateType: 'AgentRun',
        aggregateId: run.id,
        eventType: 'intelligence.plan.created',
        payload: { runId: run.id, intent: plan.intent, agent: plan.agent },
      });
      return jsonResponse({ run, plan, canExecute: plan.intent !== 'unsupported' }, { status: 201, correlationId });
    },
  };
}));

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.userId) return jsonResponse({ runs: [] }, { correlationId });
  requirePermission(context, 'analysis.run');
  const runs = await db.agentRun.findMany({
    where: context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, status: true, planJson: true, createdAt: true, finishedAt: true },
  });
  const summaries = runs.map((run) => {
    let plan: AnalysisPlan | null = null;
    try { plan = JSON.parse(run.planJson) as AnalysisPlan; } catch { /* expose only safe status fields */ }
    return { id: run.id, status: run.status, intent: plan?.intent ?? 'unknown', agent: plan?.agent ?? null, dateRange: plan?.dateRange ?? null, createdAt: run.createdAt, finishedAt: run.finishedAt };
  });
  return jsonResponse({ runs: summaries }, { correlationId });
});
