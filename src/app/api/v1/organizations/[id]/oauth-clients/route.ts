import { z } from 'zod';
import { db } from '@/lib/db';
import { API_SCOPES } from '@/lib/api-auth';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { createOAuthClient } from '@/lib/oauth';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * GET  /api/v1/organizations/{id}/oauth-clients — list clients (never secrets)
 * POST /api/v1/organizations/{id}/oauth-clients — create a client; secret shown once
 */

type ClientCtx = { params: Promise<{ id: string }> };

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});

function redactClientSecret(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('client_secret' in body)) return body;
  const { client_secret: _secret, ...safe } = body as Record<string, unknown>;
  return { ...safe, note: 'Client secret was shown only on the initial creation response.' };
}

export const GET = apiHandler<ClientCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.manage');
  const clients = await db.oAuthClient.findMany({
    where: { organizationId: id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, clientId: true, scopesJson: true, active: true, createdAt: true, lastUsedAt: true },
  });
  return jsonResponse({
    clients: clients.map(({ scopesJson, ...client }) => ({ ...client, scopes: JSON.parse(scopesJson) })),
  }, { correlationId });
});

export const POST = apiHandler<ClientCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/organizations/${req.nextUrl.pathname.split('/')[4]}/oauth-clients`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'org.manage');
  const rl = await rateLimit(clientKey(req, 'oauth-client:create'), { capacity: 10, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  return {
    commit: async (tx) => {
      const { client, clientSecret } = await createOAuthClient(tx, {
        organizationId: id,
        ownerId: userId,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'oauth-client.create',
        targetId: client.id,
        organizationId: id,
        aggregateType: 'OAuthClient',
        aggregateId: client.id,
        eventType: 'oauth_client.created',
        payload: { oauthClientId: client.id, clientId: client.clientId, scopes: client.scopes },
      });
      return jsonResponse({
        client,
        client_secret: clientSecret,
        note: 'Shown once. Store it securely; only its SHA-256 hash is retained.',
      }, { status: 201, correlationId });
    },
  };
}, {
  authorize: async (req) => {
    const { id } = await params;
    const context = await resolveTenantContext(req);
    requireOrganization(context, id);
    requirePermission(context, 'org.manage');
    },
  redactReplay: redactClientSecret,
}));
