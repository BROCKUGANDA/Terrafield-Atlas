import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, jsonResponse, parseBody,
  rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { resolveTenantContext } from '@/lib/tenancy';
import { ensurePlans } from '@/lib/commercial';

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.string().trim().max(80).optional(),
  timezone: z.string().trim().min(1).max(80).default('Africa/Kampala'),
});

function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'organization';
}

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.userId) return jsonResponse({ organizations: [] }, { correlationId });
  const memberships = await db.membership.findMany({
    where: { userId: context.userId, status: 'active' },
    include: { organization: { include: { _count: { select: { farms: true, memberships: true, workspaces: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  return jsonResponse({
    organizations: memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      country: membership.organization.country,
      timezone: membership.organization.timezone,
      role: membership.role,
      farms: membership.organization._count.farms,
      members: membership.organization._count.memberships,
      workspaces: membership.organization._count.workspaces,
    })),
  }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/organizations', async (req, { userId }) => {
  const rl = await rateLimit(clientKey(req, 'organizations:create'), { capacity: 5, refillPerMinute: 2 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  await ensurePlans();
  const plan = await db.plan.findUniqueOrThrow({ where: { code: 'cooperative' } });
  const slug = `${slugify(parsed.data.name)}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();

  return {
    commit: async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: parsed.data.name,
          slug,
          country: parsed.data.country ?? null,
          timezone: parsed.data.timezone,
        },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId, role: 'owner' } });
      const workspace = await tx.workspace.create({ data: { organizationId: organization.id, name: 'Primary portfolio' } });
      await tx.subscription.create({
        data: {
          organizationId: organization.id,
          planId: plan.id,
          status: 'trialing',
          trialEndsAt: new Date(now.getTime() + 14 * 86_400_000),
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 14 * 86_400_000),
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'organization.create',
        targetId: organization.id,
        detail: organization.name,
        organizationId: organization.id,
        aggregateType: 'Organization',
        aggregateId: organization.id,
        eventType: 'organization.created',
        payload: { organizationId: organization.id, ownerId: userId, workspaceId: workspace.id },
      });
      return jsonResponse({ organization, workspace, trialEndsAt: new Date(now.getTime() + 14 * 86_400_000) }, { status: 201, correlationId });
    },
  };
}));
