import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type KeyCtx = { params: Promise<{ id: string }> };

export const DELETE = apiHandler<KeyCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/api-keys/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'api_key.manage');
  const key = await db.apiKey.findUnique({ where: { id } });
  const organizationKey = context.organizationId !== null && key?.organizationId === context.organizationId;
  if (!key || (!organizationKey && (key.ownerId !== userId || key.organizationId !== null))) return errorResponse(404, 'NOT_FOUND', 'API key not found', correlationId);
  return {
    commit: async (tx) => {
      await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'api-key.revoke',
        targetId: id,
        organizationId: context.organizationId,
        aggregateType: 'ApiKey',
        aggregateId: id,
        eventType: 'api_key.revoked',
        payload: { keyId: id },
      });
      return jsonResponse({ revoked: true, id }, { correlationId });
    },
  };
}));
