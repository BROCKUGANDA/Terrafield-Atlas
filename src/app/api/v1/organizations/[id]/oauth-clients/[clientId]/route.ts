import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { revokeOAuthClient } from '@/lib/oauth';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * DELETE /api/v1/organizations/{id}/oauth-clients/{clientId}
 *
 * Revokes the client and deletes every access token it issued. `{clientId}`
 * accepts the record id or the public `tf_oauth_...` client identifier.
 */

type ClientCtx = { params: Promise<{ id: string; clientId: string }> };

export const DELETE = apiHandler<ClientCtx>((req, { correlationId, params }) => withIdempotency(
  req,
  `/api/v1/organizations/${req.nextUrl.pathname.split('/')[4]}/oauth-clients/${req.nextUrl.pathname.split('/')[6]}`,
  async (req, { userId }) => {
    const { id, clientId } = await params;
    const context = await resolveTenantContext(req);
    requireOrganization(context, id);
    requirePermission(context, 'org.manage');
    const client = await db.oAuthClient.findFirst({
      where: { organizationId: id, OR: [{ id: clientId }, { clientId }] },
      select: { id: true, clientId: true, active: true },
    });
    if (!client) return errorResponse(404, 'NOT_FOUND', 'OAuth client not found', correlationId);
    return {
      commit: async (tx) => {
        await revokeOAuthClient(tx, client.id);
        await writeMutationEffects(tx, {
          actor: `account:${userId}`,
          action: 'oauth-client.revoke',
          targetId: client.id,
          organizationId: id,
          aggregateType: 'OAuthClient',
          aggregateId: client.id,
          eventType: 'oauth_client.revoked',
          payload: { oauthClientId: client.id, clientId: client.clientId },
        });
        return jsonResponse({ revoked: true, id: client.id, clientId: client.clientId }, { correlationId });
      },
    };
  },
  {
    authorize: async (req) => {
      const { id } = await params;
      const context = await resolveTenantContext(req);
      requireOrganization(context, id);
      requirePermission(context, 'org.manage');
    },
  },
));
