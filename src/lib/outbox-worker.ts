import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/webhook-crypto';
import { fetchPinnedPublicUrl } from '@/lib/network-safety';
import { signWebhookV1, webhookTimestamp } from '@/lib/fires/digest-exit-webhook';

const MAX_ATTEMPTS = 5;

function organizationFromPayload(raw: string): string | null {
  try {
    const payload = JSON.parse(raw) as { organizationId?: unknown };
    return typeof payload.organizationId === 'string' ? payload.organizationId : null;
  } catch { return null; }
}

/** Fan committed outbox events out to matching tenant webhook endpoints. */
export async function enqueueWebhookDeliveries(limit = 100): Promise<number> {
  const events = await db.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let enqueued = 0;
  for (const event of events) {
    const organizationId = organizationFromPayload(event.payload);
    if (!organizationId) {
      await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } }).catch(() => undefined);
      continue;
    }
    const endpoints = await db.webhookEndpoint.findMany({ where: { organizationId, status: 'active' } });
    const matching = endpoints.filter((endpoint) => {
      try { return (JSON.parse(endpoint.eventsJson) as string[]).includes(event.eventType); } catch { return false; }
    });
    if (matching.length === 0) {
      await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } }).catch(() => undefined);
      continue;
    }
    const body = JSON.stringify({ id: event.id, type: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, createdAt: event.createdAt, data: JSON.parse(event.payload) });
    await db.webhookDelivery.createMany({
      data: matching.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId: `${event.id}:${endpoint.id}`,
        eventType: event.eventType,
        payloadJson: body,
        status: 'pending',
        nextAttemptAt: new Date(),
      })),
      skipDuplicates: true,
    });
    await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
    enqueued += matching.length;
  }
  return enqueued;
}

/** Deliver due webhook records with bounded timeouts and durable retry state. */
export async function dispatchPendingWebhooks(limit = 20, fetcher: typeof fetchPinnedPublicUrl = fetchPinnedPublicUrl): Promise<{ delivered: number; failed: number; retried: number }> {
  const due = await db.webhookDelivery.findMany({
    where: {
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        { status: 'failed', nextAttemptAt: { not: null, lte: new Date() } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { endpoint: true },
  });
  let delivered = 0;
  let failed = 0;
  let retried = 0;
  for (const delivery of due) {
    if (delivery.endpoint.status !== 'active') {
      await db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'failed', lastError: 'endpoint disabled' } });
      failed += 1;
      continue;
    }
    try {
      const secret = decryptSecret(delivery.endpoint);
      const timestamp = webhookTimestamp();
      const signature = signWebhookV1(secret, delivery.payloadJson, timestamp);
      const response = await fetcher(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-terrafield-event-id': delivery.eventId,
          'x-terrafield-topic': delivery.eventType,
          'x-terrafield-signature': `t=${timestamp},v1=${signature}`,
          'user-agent': 'terrafield-atlas/webhook-worker',
        },
        body: delivery.payloadJson,
        timeoutMs: 8_000,
        maxResponseBytes: 64 * 1024,
      });
      const attempts = delivery.attempts + 1;
      if (response.status >= 200 && response.status < 300) {
        await db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'delivered', attempts, deliveredAt: new Date(), lastError: null, nextAttemptAt: null } });
        delivered += 1;
      } else if ((response.status === 429 || response.status >= 500) && attempts < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : Math.min(2 ** attempts * 1_000, 60_000);
        await db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'failed', attempts, lastError: `HTTP ${response.status}`, nextAttemptAt: new Date(Date.now() + delay) } });
        retried += 1;
      } else {
        await db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'failed', attempts, lastError: `HTTP ${response.status}`, nextAttemptAt: null } });
        failed += 1;
      }
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const message = error instanceof Error ? error.message : 'webhook delivery failed';
      const retry = attempts < MAX_ATTEMPTS;
      await db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'failed', attempts, lastError: message.slice(0, 500), nextAttemptAt: retry ? new Date(Date.now() + Math.min(2 ** attempts * 1_000, 60_000)) : null } });
      if (retry) retried += 1; else failed += 1;
    }
  }
  return { delivered, failed, retried };
}
