import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, jsonResponse, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';

type WorkspaceCtx = { params: Promise<{ id: string }> };
const schema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional() });

export const GET = apiHandler<WorkspaceCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.read');
  const workspaces = await db.workspace.findMany({
    where: { organizationId: id },
    include: { _count: { select: { farms: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return jsonResponse({ workspaces }, { correlationId });
});

export const POST = apiHandler<WorkspaceCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/organizations/${req.nextUrl.pathname.split('/')[4]}/workspaces`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.manage');
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  return {
    commit: async (tx) => {
      const workspace = await tx.workspace.create({ data: { organizationId: id, name: parsed.data.name, description: parsed.data.description ?? null } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'workspace.create',
        targetId: workspace.id,
        organizationId: id,
        aggregateType: 'Workspace',
        aggregateId: workspace.id,
        eventType: 'workspace.created',
        payload: { workspaceId: workspace.id, name: workspace.name },
      });
      return jsonResponse({ workspace }, { status: 201, correlationId });
    },
  };
}));
