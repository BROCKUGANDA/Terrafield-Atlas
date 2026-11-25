import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, paginationSchema, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';

type OrgCtx = { params: Promise<{ id: string }> };
const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  country: z.string().trim().max(80).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});

export const GET = apiHandler<OrgCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.read');
  const organization = await db.organization.findUnique({
    where: { id },
    include: {
      workspaces: { orderBy: { createdAt: 'asc' } },
      subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      _count: { select: { farms: true, memberships: true, reports: true, agentRuns: true } },
    },
  });
  if (!organization) return errorResponse(404, 'NOT_FOUND', 'organization not found', correlationId);
  return jsonResponse({ organization }, { correlationId });
});

export const PATCH = apiHandler<OrgCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/organizations/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.manage');
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  return {
    commit: async (tx) => {
      const organization = await tx.organization.update({ where: { id }, data: parsed.data });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'organization.update',
        targetId: id,
        detail: `fields: ${Object.keys(parsed.data).join(',')}`,
        organizationId: id,
        aggregateType: 'Organization',
        aggregateId: id,
        eventType: 'organization.updated',
        payload: { organizationId: id, fields: Object.keys(parsed.data) },
      });
      return jsonResponse({ organization }, { correlationId });
    },
  };
}));
