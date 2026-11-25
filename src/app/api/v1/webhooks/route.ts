import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, errorResponse, jsonResponse, parseBody, rateLimit, rateLimitResponse, redactOneTimeSecret, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertCapability } from '@/lib/commercial';
import { encryptSecret } from '@/lib/webhook-crypto';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';
import { assertResolvedWebhookTargetSafe } from '@/lib/fires/digest-exit-webhook';

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.organizationId) return jsonResponse({ webhooks: [] }, { correlationId });
  requirePermission(context, 'webhook.manage');
  const webhooks = await db.webhookEndpoint.findMany({
    where: { organizationId: context.organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, url: true, eventsJson: true, status: true, createdAt: true, updatedAt: true,
      _count: { select: { deliveries: true } },
    },
  });
  return jsonResponse({ webhooks: webhooks.map((webhook) => ({ id: webhook.id, name: webhook.name, url: webhook.url, events: JSON.parse(webhook.eventsJson), status: webhook.status, createdAt: webhook.createdAt, deliveryCount: webhook._count.deliveries })) }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/webhooks', async (req, { userId }) => {
  const context = await resolveTenantContext(req);
  if (!context.organizationId) return errorResponse(400, 'ORGANIZATION_REQUIRED', 'webhooks require an organization workspace', correlationId);
  requirePermission(context, 'webhook.manage');
  await assertCapability(context, 'webhooks');
  const rl = await rateLimit(clientKey(req, 'webhooks:create'), { capacity: 10, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  if (process.env.NODE_ENV === 'production' && new URL(parsed.data.url).protocol !== 'https:') return errorResponse(400, 'HTTPS_REQUIRED', 'production webhook endpoints must use HTTPS', correlationId);
  const safe = await assertResolvedWebhookTargetSafe(parsed.data.url);
  if (!safe.ok) return errorResponse(400, 'UNSAFE_WEBHOOK_TARGET', safe.reason ?? 'webhook target is not allowed', correlationId);
  const secret = randomBytes(32).toString('base64url');
  const encrypted = encryptSecret(secret);
  return {
    commit: async (tx) => {
      const webhook = await tx.webhookEndpoint.create({
        data: {
          organizationId: context.organizationId!,
          name: parsed.data.name,
          url: parsed.data.url,
          eventsJson: JSON.stringify(parsed.data.events),
          ...encrypted,
        },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'webhook.create',
        targetId: webhook.id,
        organizationId: context.organizationId,
        aggregateType: 'WebhookEndpoint',
        aggregateId: webhook.id,
        eventType: 'webhook.created',
        payload: { webhookId: webhook.id, events: parsed.data.events },
      });
      return jsonResponse({ webhook: { id: webhook.id, name: webhook.name, url: webhook.url, events: parsed.data.events, status: webhook.status }, secret, note: 'Signing secret shown once. Verify x-terrafield-signature over the exact body and timestamp.' }, { status: 201, correlationId });
    },
  };
}, {
  authorize: async () => {
    const context = await resolveTenantContext(req);
    if (!context.organizationId) return errorResponse(400, 'ORGANIZATION_REQUIRED', 'webhooks require an organization workspace', correlationId);
    requirePermission(context, 'webhook.manage');
    await assertCapability(context, 'webhooks');
  },
  redactReplay: redactOneTimeSecret,
}));
