import { z } from 'zod';
import { db } from '@/lib/db';
import { API_SCOPES, generateApiKey } from '@/lib/api-auth';
import { apiHandler, clientKey, errorResponse, jsonResponse, parseBody, rateLimit, rateLimitResponse, redactOneTimeSecret, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertCapability } from '@/lib/commercial';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.userId) return errorResponse(401, 'AUTH_REQUIRED', 'sign in to manage API keys', correlationId);
  requirePermission(context, 'api_key.manage');
  const keys = await db.apiKey.findMany({
    where: context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId, organizationId: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, scopesJson: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true },
  });
  return jsonResponse({ keys: keys.map((key) => ({ ...key, scopes: JSON.parse(key.scopesJson) })) }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/api-keys', async (req, { userId }) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'api_key.manage');
  await assertCapability(context, 'api_access');
  const rl = await rateLimit(clientKey(req, 'api-key:create'), { capacity: 10, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const generated = generateApiKey();
  return {
    commit: async (tx) => {
      const key = await tx.apiKey.create({
        data: {
          organizationId: context.organizationId,
          ownerId: userId,
          createdById: userId,
          name: parsed.data.name,
          prefix: generated.prefix,
          keyHash: generated.hash,
          scopesJson: JSON.stringify(parsed.data.scopes),
          expiresAt: parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000) : null,
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'api-key.create',
        targetId: key.id,
        organizationId: context.organizationId,
        aggregateType: 'ApiKey',
        aggregateId: key.id,
        eventType: 'api_key.created',
        payload: { keyId: key.id, prefix: key.prefix, scopes: parsed.data.scopes },
      });
      return jsonResponse({ key: { id: key.id, name: key.name, prefix: key.prefix, scopes: parsed.data.scopes, expiresAt: key.expiresAt }, secret: generated.secret, note: 'Shown once. Store it securely; only its SHA-256 hash is retained.' }, { status: 201, correlationId });
    },
  };
}, {
  authorize: async () => {
    const context = await resolveTenantContext(req);
    requirePermission(context, 'api_key.manage');
    await assertCapability(context, 'api_access');
  },
  redactReplay: redactOneTimeSecret,
}));
