import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, paginationSchema, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';
import { assertResolvedWebhookTargetSafe } from '@/lib/fires/digest-exit-webhook';

type WebhookCtx = { params: Promise<{ id: string }> };
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().url().max(2000).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).refine((value) => Object.keys(value).length > 0);

async function ownedWebhook(id: string, organizationId: string) {
  const webhook = await db.webhookEndpoint.findUnique({ where: { id } });
  if (!webhook || webhook.organizationId !== organizationId) return null;
  return webhook;
}

export const GET = apiHandler<WebhookCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  if (!context.organizationId) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  requirePermission(context, 'webhook.manage');
  const webhook = await ownedWebhook(id, context.organizationId);
  if (!webhook) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const deliveries = await db.webhookDelivery.findMany({ where: { endpointId: id }, orderBy: { createdAt: 'desc' }, take: query.limit });
  return jsonResponse({ deliveries }, { correlationId });
});

export const PATCH = apiHandler<WebhookCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/webhooks/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  if (!context.organizationId) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  requirePermission(context, 'webhook.manage');
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const existing = await ownedWebhook(id, context.organizationId);
  if (!existing) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  if (parsed.data.url) {
    if (process.env.NODE_ENV === 'production' && new URL(parsed.data.url).protocol !== 'https:') return errorResponse(400, 'HTTPS_REQUIRED', 'production webhook endpoints must use HTTPS', correlationId);
    const safe = await assertResolvedWebhookTargetSafe(parsed.data.url);
    if (!safe.ok) return errorResponse(400, 'UNSAFE_WEBHOOK_TARGET', safe.reason ?? 'webhook target is not allowed', correlationId);
  }
  return {
    commit: async (tx) => {
      const { events, ...rest } = parsed.data;
      const webhook = await tx.webhookEndpoint.update({ where: { id }, data: { ...rest, ...(events ? { eventsJson: JSON.stringify(events) } : {}) } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'webhook.update',
        targetId: id,
        organizationId: context.organizationId,
        aggregateType: 'WebhookEndpoint',
        aggregateId: id,
        eventType: 'webhook.updated',
        payload: { webhookId: id, fields: Object.keys(parsed.data) },
      });
      return jsonResponse({ webhook: { id: webhook.id, name: webhook.name, url: webhook.url, events: JSON.parse(webhook.eventsJson), status: webhook.status } }, { correlationId });
    },
  };
}));

export const DELETE = apiHandler<WebhookCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/webhooks/${req.nextUrl.pathname.split('/').at(-1)}`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  if (!context.organizationId) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  requirePermission(context, 'webhook.manage');
  const existing = await ownedWebhook(id, context.organizationId);
  if (!existing) return errorResponse(404, 'NOT_FOUND', 'webhook not found', correlationId);
  return {
    commit: async (tx) => {
      await tx.webhookEndpoint.update({ where: { id }, data: { status: 'disabled' } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'webhook.disable',
        targetId: id,
        organizationId: context.organizationId,
        aggregateType: 'WebhookEndpoint',
        aggregateId: id,
        eventType: 'webhook.disabled',
        payload: { webhookId: id },
      });
      return jsonResponse({ disabled: true, id }, { correlationId });
    },
  };
}));
