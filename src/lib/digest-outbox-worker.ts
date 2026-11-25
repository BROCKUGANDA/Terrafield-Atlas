import { db } from '@/lib/db';
import { stableHash } from '@/lib/redis';
import { computeWatchlistDigest } from '@/lib/fires/watchlist-digest-service';
import { buildDigestPushPayload, type DigestPushPayload } from '@/lib/fires/digest-push';
import { publishDigestToSse } from '@/lib/fires/digest-channel';
import { deliverDigestWebhook, parseWebhookConfig } from '@/lib/fires/digest-exit-webhook';
import { deliverDigestEmail, parseEmailConfig, shouldEmailDigest } from '@/lib/fires/digest-exit-email';

interface DigestOutboxPayload {
  watchlistId: string;
  ownerId: string | null;
  reason: 'evaluation' | 'scheduled-failure';
  trigger: 'manual' | 'backtest' | 'scheduled' | null;
  correlationId: string | null;
  triggeredAt: string;
  triggeringEventId: string;
}

export interface DigestOutboxRunResult { processed: number; published: number; retried: number; failed: number }

const leaseKey = (eventId: string) => `digest-outbox:${eventId}`;

async function acquireLease(eventId: string, holder: string): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  const key = leaseKey(eventId);
  const claimed = await db.jobLease.updateMany({
    where: { key, OR: [{ expiresAt: { lte: now } }, { holder }] },
    data: { holder, expiresAt, heartbeatAt: now },
  });
  if (claimed.count === 1) return true;
  const inserted = await db.jobLease.createMany({ data: [{ key, holder, expiresAt, heartbeatAt: now }], skipDuplicates: true });
  return inserted.count === 1;
}

async function releaseLease(eventId: string, holder: string): Promise<void> {
  await db.jobLease.deleteMany({ where: { key: leaseKey(eventId), holder } }).catch(() => undefined);
}

async function claimReceipt(channel: string, destinationKey: string, eventId: string): Promise<boolean> {
  return (await db.deliveryReceipt.createMany({ data: [{ channel, destinationKey, eventId }], skipDuplicates: true })).count === 1;
}

async function releaseReceipt(channel: string, destinationKey: string, eventId: string): Promise<void> {
  await db.deliveryReceipt.deleteMany({ where: { channel, destinationKey, eventId } }).catch(() => undefined);
}

async function buildPayload(input: DigestOutboxPayload, eventId: string): Promise<DigestPushPayload | null> {
  const computed = await computeWatchlistDigest(input.watchlistId, { ownerId: input.ownerId, triggeringEventId: input.triggeringEventId });
  if (!computed.ok) return null;
  return buildDigestPushPayload({
    eventId,
    reason: input.reason,
    trigger: input.trigger,
    correlationId: input.correlationId,
    triggeredAt: new Date(input.triggeredAt),
    now: new Date(),
    watchlistId: computed.result.watchlist.id,
    watchlistName: computed.result.watchlist.name,
    watchlist: computed.result.watchlist,
    digest: computed.result.digest,
  });
}

/** Process committed digest notifications with durable receiver deduplication. */
export async function processPendingDigestOutbox(options: { limit?: number; holder?: string } = {}): Promise<DigestOutboxRunResult> {
  const now = new Date();
  const events = await db.outboxEvent.findMany({
    where: { eventType: 'watchlist.digest', publishedAt: null, availableAt: { lte: now } },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
  });
  const result: DigestOutboxRunResult = { processed: 0, published: 0, retried: 0, failed: 0 };
  const holder = options.holder ?? `digest-outbox:${process.pid}:${crypto.randomUUID()}`;

  for (const event of events) {
    if (!await acquireLease(event.id, holder)) continue;
    result.processed += 1;
    try {
      const input = JSON.parse(event.payload) as DigestOutboxPayload;
      if (!input.watchlistId || !input.triggeringEventId) throw new Error('invalid digest outbox payload');
      const payload = await buildPayload(input, event.id);
      if (!payload) {
        await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: now, attempts: { increment: 1 } } });
        result.published += 1;
        continue;
      }

      await publishDigestToSse(payload, input.ownerId);
      let retry = false;
      let lastError: string | null = null;
      if (input.ownerId === null) {
        const webhookCfg = parseWebhookConfig(process.env as Record<string, string | undefined>);
        if (webhookCfg.enabled && webhookCfg.url) {
          const destinationKey = stableHash(webhookCfg.url);
          if (await claimReceipt('webhook', destinationKey, event.id)) {
            const outcome = await deliverDigestWebhook(payload, { correlationId: input.correlationId, now });
            if (!outcome.delivered) {
              await releaseReceipt('webhook', destinationKey, event.id);
              retry = true;
              lastError = outcome.error ?? 'webhook delivery failed';
            }
          }
        }
        const emailCfg = parseEmailConfig(process.env as Record<string, string | undefined>);
        if (emailCfg.enabled && shouldEmailDigest(payload)) {
          const destinationKey = stableHash([...emailCfg.recipients].sort().join(','));
          if (await claimReceipt('email', destinationKey, event.id)) {
            const outcome = await deliverDigestEmail(payload, { correlationId: input.correlationId, now });
            if (!outcome.sent) {
              await releaseReceipt('email', destinationKey, event.id);
              retry = true;
              lastError = outcome.error ?? 'email delivery failed';
            }
          }
        }
      }

      if (retry) {
        const attempts = event.attempts + 1;
        await db.outboxEvent.update({
          where: { id: event.id },
          data: { attempts: { increment: 1 }, lastError, availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))) },
        });
        result.retried += 1;
      } else {
        await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
        result.published += 1;
      }
    } catch (error) {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500), availableAt: new Date(Date.now() + 5_000) },
      }).catch(() => undefined);
      result.failed += 1;
    } finally {
      await releaseLease(event.id, holder);
    }
  }
  return result;
}
