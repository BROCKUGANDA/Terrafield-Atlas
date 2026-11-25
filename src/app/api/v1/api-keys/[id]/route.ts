import { rawDb } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type KeyCtx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/api-keys/{id}
 *
 * Owners may revoke their keys without first selecting the key's organization.
 * The lookup and write therefore run on the owner connection after an explicit
 * authorization check: caller owns the key, or the key belongs to the caller's
 * active organization and the caller has `api_key.manage`.
 */
export const DELETE = apiHandler<KeyCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/api-keys/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'api_key.manage');
  const key = await rawDb.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, organizationId: true } });
  if (!key) return errorResponse(404, 'NOT_FOUND', 'API key not found', correlationId);
  const ownedByCaller = key.ownerId === userId;
  let ownedByOrganization = context.organizationId !== null && key.organizationId === context.organizationId;
  if (ownedByCaller && key.organizationId) {
    const membership = await rawDb.membership.findUnique({
      where: { organizationId_userId: { organizationId: key.organizationId, userId } },
      select: { status: true },
    });
    ownedByOrganization ||= membership?.status === 'active';
  }
  if (!ownedByCaller && !ownedByOrganization) return errorResponse(404, 'NOT_FOUND', 'API key not found', correlationId);
  return {
    commit: async () => rawDb.$transaction(async (tx) => {
      await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'api-key.revoke',
        targetId: id,
        organizationId: key.organizationId,
        aggregateType: 'ApiKey',
        aggregateId: id,
        eventType: 'api_key.revoked',
        payload: { keyId: id },
      });
      return jsonResponse({ revoked: true, id }, { correlationId });
    }),
  };
}));
