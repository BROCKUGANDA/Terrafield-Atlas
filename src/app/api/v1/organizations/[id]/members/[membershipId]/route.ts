import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';

type MemberCtx = { params: Promise<{ id: string; membershipId: string }> };
const patchSchema = z.object({
  role: z.enum(['owner', 'admin', 'analyst', 'agronomist', 'researcher', 'field_officer', 'viewer', 'api_service']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined);

export const GET = apiHandler<MemberCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.read');
  const members = await db.membership.findMany({
    where: { organizationId: id },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return jsonResponse({ members }, { correlationId });
});

export const PATCH = apiHandler<MemberCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/organizations/${req.nextUrl.pathname.split('/')[4]}/members/${req.nextUrl.pathname.split('/')[6]}`, async (req, { userId }) => {
  const { id, membershipId } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'member.manage');
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const existing = await db.membership.findUnique({ where: { id: membershipId }, select: { organizationId: true, role: true, status: true } });
  if (!existing || existing.organizationId !== id) return errorResponse(404, 'NOT_FOUND', 'membership not found', correlationId);
  const touchesOwnerRole = existing.role === 'owner' || parsed.data.role === 'owner';
  if (touchesOwnerRole && context.role !== 'owner' && !context.isPlatformAdmin) {
    return errorResponse(403, 'OWNER_ROLE_REQUIRED', 'only an owner can grant, change, or suspend the owner role', correlationId);
  }
  if (existing.role === 'owner' && (parsed.data.role !== 'owner' || parsed.data.status === 'suspended')) {
    const owners = await db.membership.count({ where: { organizationId: id, role: 'owner', status: 'active' } });
    if (owners <= 1) return errorResponse(409, 'LAST_OWNER', 'an organization must retain at least one active owner', correlationId);
  }
  return {
    commit: async (tx) => {
      // Serialize membership changes for this organization so concurrent owner
      // demotions cannot both observe the same pre-update owner count.
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${id} FOR UPDATE`;
      if (existing.role === 'owner' && (parsed.data.role !== 'owner' || parsed.data.status === 'suspended')) {
        const owners = await tx.membership.count({ where: { organizationId: id, role: 'owner', status: 'active' } });
        if (owners <= 1) return errorResponse(409, 'LAST_OWNER', 'an organization must retain at least one active owner', correlationId);
      }
      const member = await tx.membership.update({ where: { id: membershipId }, data: parsed.data });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'organization.member.update',
        targetId: membershipId,
        organizationId: id,
        aggregateType: 'Membership',
        aggregateId: membershipId,
        eventType: 'organization.member.updated',
        payload: { role: member.role, status: member.status },
      });
      return jsonResponse({ member }, { correlationId });
    },
  };
}));
