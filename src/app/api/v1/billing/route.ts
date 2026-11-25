import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { currentSubscription, ensurePlans, entitlementsFor, usageFor, type UsageMetric } from '@/lib/commercial';

const metrics: UsageMetric[] = ['farms', 'processing_jobs_per_month', 'api_requests_per_day', 'reports_per_month', 'ai_runs_per_month', 'storage_mb'];
const patchSchema = z.object({
  planCode: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/).optional(),
  action: z.enum(['cancel', 'resume']).optional(),
}).refine((value) => Boolean(value.planCode) || Boolean(value.action));

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  await ensurePlans();
  const [plans, subscription, entitlements] = await Promise.all([
    db.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
    currentSubscription(context),
    entitlementsFor(context),
  ]);
  const usage = Object.fromEntries(await Promise.all(metrics.map(async (metric) => [metric, await usageFor(context, metric)])));
  const events = context.userId ? await db.usageEvent.findMany({
    where: context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId },
    orderBy: { occurredAt: 'desc' },
    take: 100,
    select: { id: true, metric: true, quantity: true, operationId: true, jobId: true, billed: true, occurredAt: true },
  }) : [];
  return jsonResponse({
    plans: plans.map((plan) => ({ ...plan, entitlements: JSON.parse(plan.entitlementsJson) })),
    subscription,
    entitlements,
    usage,
    events,
    paymentNote: 'No payment provider is connected. Plan changes are administrative state changes; settlement requires a reviewed provider integration.',
  }, { correlationId });
});

export const PATCH = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/billing', async (req, { userId }) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'billing.manage');
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  await ensurePlans();
  const plan = parsed.data.planCode ? await db.plan.findUnique({ where: { code: parsed.data.planCode } }) : null;
  if (parsed.data.planCode && (!plan || !plan.active)) return errorResponse(404, 'PLAN_NOT_FOUND', 'plan not found', correlationId);

  return {
    commit: async (tx) => {
      const scope: { organizationId?: string; ownerId?: string } = context.organizationId ? { organizationId: context.organizationId } : { ownerId: userId };
      const existing = await tx.subscription.findFirst({ where: scope, orderBy: { createdAt: 'desc' } });
      const now = new Date();
      let subscription;
      if (!existing && parsed.data.action === 'cancel') return errorResponse(409, 'NO_SUBSCRIPTION', 'there is no subscription to cancel', correlationId);
      if (!existing) {
        subscription = await tx.subscription.create({ data: { ...scope, planId: plan!.id, status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) } });
      } else if (parsed.data.action === 'cancel') {
        subscription = await tx.subscription.update({ where: { id: existing.id }, data: { status: 'canceled', cancelAt: now } });
      } else if (parsed.data.action === 'resume') {
        subscription = await tx.subscription.update({ where: { id: existing.id }, data: { status: 'active', cancelAt: null } });
      } else {
        subscription = await tx.subscription.update({ where: { id: existing.id }, data: { planId: plan!.id, status: 'active', cancelAt: null, currentPeriodStart: now, currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) } });
      }
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'billing.subscription.update',
        targetId: subscription.id,
        organizationId: context.organizationId,
        aggregateType: 'Subscription',
        aggregateId: subscription.id,
        eventType: 'subscription.updated',
        payload: { planId: subscription.planId, status: subscription.status },
      });
      return jsonResponse({ subscription }, { correlationId });
    },
  };
}));
