import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { AccountAccessError } from '@/lib/access-error';
import type { TenantContext } from '@/lib/tenancy';

export const entitlementsSchema = z.object({
  limits: z.object({
    farms: z.number().int().nonnegative(),
    processing_jobs_per_month: z.number().int().nonnegative(),
    api_requests_per_day: z.number().int().nonnegative(),
    reports_per_month: z.number().int().nonnegative(),
    ai_runs_per_month: z.number().int().nonnegative(),
    storage_mb: z.number().int().nonnegative(),
  }),
  capabilities: z.object({
    organization: z.boolean(),
    api_access: z.boolean(),
    webhooks: z.boolean(),
    advanced_analytics: z.boolean(),
  }),
});

export type Entitlements = z.infer<typeof entitlementsSchema>;
export type UsageMetric = keyof Entitlements['limits'];

interface PlanDefinition {
  code: string;
  name: string;
  description: string;
  monthlyPriceMinor: number;
  sortOrder: number;
  entitlements: Entitlements;
}

/** Initial configuration only. Administrators can edit Plan rows later. */
export const DEFAULT_PLANS: readonly PlanDefinition[] = [
  {
    code: 'explorer', name: 'Explorer', description: 'Public exploration and limited personal workflows.', monthlyPriceMinor: 0, sortOrder: 10,
    entitlements: { limits: { farms: 25, processing_jobs_per_month: 50, api_requests_per_day: 0, reports_per_month: 20, ai_runs_per_month: 20, storage_mb: 1_000 }, capabilities: { organization: false, api_access: false, webhooks: false, advanced_analytics: false } },
  },
  {
    code: 'professional', name: 'Professional', description: 'Individual agricultural professionals and consultants.', monthlyPriceMinor: 2900, sortOrder: 20,
    entitlements: { limits: { farms: 25, processing_jobs_per_month: 50, api_requests_per_day: 1_000, reports_per_month: 20, ai_runs_per_month: 20, storage_mb: 2_000 }, capabilities: { organization: false, api_access: true, webhooks: false, advanced_analytics: true } },
  },
  {
    code: 'cooperative', name: 'Cooperative', description: 'Multi-farm monitoring and team workflows.', monthlyPriceMinor: 19900, sortOrder: 30,
    entitlements: { limits: { farms: 250, processing_jobs_per_month: 500, api_requests_per_day: 10_000, reports_per_month: 200, ai_runs_per_month: 100, storage_mb: 20_000 }, capabilities: { organization: true, api_access: true, webhooks: true, advanced_analytics: true } },
  },
  {
    code: 'enterprise', name: 'Enterprise', description: 'Organization controls, APIs, reporting, and higher limits.', monthlyPriceMinor: 99900, sortOrder: 40,
    entitlements: { limits: { farms: 2_000, processing_jobs_per_month: 5_000, api_requests_per_day: 100_000, reports_per_month: 2_000, ai_runs_per_month: 1_000, storage_mb: 200_000 }, capabilities: { organization: true, api_access: true, webhooks: true, advanced_analytics: true } },
  },
  {
    code: 'institutional', name: 'Institutional', description: 'Custom government, NGO, research, and programme deployments.', monthlyPriceMinor: 0, sortOrder: 50,
    entitlements: { limits: { farms: 100_000, processing_jobs_per_month: 1_000_000, api_requests_per_day: 10_000_000, reports_per_month: 100_000, ai_runs_per_month: 100_000, storage_mb: 10_000_000 }, capabilities: { organization: true, api_access: true, webhooks: true, advanced_analytics: true } },
  },
];

export async function ensurePlans(): Promise<void> {
  await db.plan.createMany({
    data: DEFAULT_PLANS.map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      monthlyPriceMinor: plan.monthlyPriceMinor,
      currency: 'USD',
      entitlementsJson: JSON.stringify(plan.entitlements),
      sortOrder: plan.sortOrder,
    })),
    skipDuplicates: true,
  });
}

export async function ensureOrganizationTrial(organizationId: string): Promise<void> {
  await ensurePlans();
  const existing = await db.subscription.findFirst({ where: { organizationId }, select: { id: true } });
  if (existing) return;
  const plan = await db.plan.findUniqueOrThrow({ where: { code: 'cooperative' } });
  const now = new Date();
  await db.subscription.create({
    data: {
      organizationId,
      planId: plan.id,
      status: 'trialing',
      trialEndsAt: new Date(now.getTime() + 14 * 86_400_000),
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 14 * 86_400_000),
    },
  });
}

function parseEntitlements(raw: string): Entitlements {
  return entitlementsSchema.parse(JSON.parse(raw));
}

export async function currentSubscription(context: TenantContext) {
  await ensurePlans();
  const scope = context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId };
  const subscription = await db.subscription.findFirst({
    where: { ...scope, status: { in: ['trialing', 'active', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });
  if (subscription) return subscription;
  const plan = await db.plan.findUniqueOrThrow({ where: { code: 'explorer' } });
  return { plan, status: 'active' as const, id: null, organizationId: context.organizationId, ownerId: context.userId };
}

export async function entitlementsFor(context: TenantContext): Promise<Entitlements> {
  if (context.isPlatformAdmin) {
    return { limits: { farms: Number.MAX_SAFE_INTEGER, processing_jobs_per_month: Number.MAX_SAFE_INTEGER, api_requests_per_day: Number.MAX_SAFE_INTEGER, reports_per_month: Number.MAX_SAFE_INTEGER, ai_runs_per_month: Number.MAX_SAFE_INTEGER, storage_mb: Number.MAX_SAFE_INTEGER }, capabilities: { organization: true, api_access: true, webhooks: true, advanced_analytics: true } };
  }
  return parseEntitlements((await currentSubscription(context)).plan.entitlementsJson);
}

function usageStart(metric: UsageMetric): Date {
  const now = new Date();
  if (metric === 'api_requests_per_day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usageFor(context: TenantContext, metric: UsageMetric): Promise<number> {
  if (metric === 'farms') {
    if (context.organizationId) return db.farm.count({ where: { organizationId: context.organizationId } });
    return db.farm.count({ where: { ownerId: context.userId } });
  }
  if (metric === 'storage_mb') return 0; // object-storage metering is not configured yet
  const scope = context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId };
  const result = await db.usageEvent.aggregate({
    where: { ...scope, metric, occurredAt: { gte: usageStart(metric) } },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

export async function assertEntitlement(context: TenantContext, metric: UsageMetric, amount = 1): Promise<void> {
  const entitlements = await entitlementsFor(context);
  const limit = entitlements.limits[metric];
  const used = await usageFor(context, metric);
  if (used + amount > limit) {
    throw new AccountAccessError(402, 'PLAN_LIMIT_REACHED', `${metric} limit reached (${used}/${limit})`);
  }
}

export async function assertCapability(context: TenantContext, capability: keyof Entitlements['capabilities']): Promise<void> {
  const entitlements = await entitlementsFor(context);
  if (!entitlements.capabilities[capability]) {
    throw new AccountAccessError(402, 'PLAN_UPGRADE_REQUIRED', `capability ${capability} is not included in the current plan`);
  }
}

/** Atomically meter one successfully fulfilled durable job. */
export async function recordJobUsage(
  tx: Prisma.TransactionClient,
  job: { id: string; ownerId: string | null; organizationId: string | null; type: string },
): Promise<void> {
  await tx.usageEvent.create({
    data: {
      ownerId: job.ownerId,
      organizationId: job.organizationId,
      metric: 'processing_jobs_per_month',
      quantity: 1,
      operationId: `job:${job.id}`,
      jobId: job.id,
      billed: false,
    },
  }).catch((error: unknown) => {
    if ((error as { code?: string })?.code === 'P2002') return;
    throw error;
  });
}

/** Record one successfully fulfilled operation. The unique operation ID deduplicates retries. */
export async function recordUsage(input: {
  context: TenantContext;
  metric: UsageMetric;
  quantity?: number;
  operationId: string;
  jobId?: string;
  billed?: boolean;
}): Promise<void> {
  await db.usageEvent.create({
    data: {
      organizationId: input.context.organizationId,
      ownerId: input.context.userId,
      metric: input.metric,
      quantity: input.quantity ?? 1,
      operationId: input.operationId,
      jobId: input.jobId,
      billed: input.billed ?? false,
    },
  }).catch((error: unknown) => {
    if ((error as { code?: string })?.code === 'P2002') return;
    throw error;
  });
}
