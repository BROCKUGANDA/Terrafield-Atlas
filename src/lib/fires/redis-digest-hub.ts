import { createDigestHub, type DigestHub } from '@/lib/fires/digest-push';
import { redisRuntime, stableHash } from '@/lib/redis';

const DIGEST_CHANNEL = 'digest-stream';
const EVENT_TTL_MS = 5 * 60_000;
const MAX_EVENT_BYTES = 5 * 1024 * 1024;

interface RemoteEnvelope {
  origin: string;
  event: string;
  ownerId: string | null;
  eventId: string;
  payloadKey: string;
}

/**
 * Redis fan-out wrapper around the process-local sink registry. Each web
 * replica keeps its own authenticated SSE connections; committed events are
 * published once and delivered to every other replica through Redis pub/sub.
 * Large digest bodies live in a short-lived Redis JSON entry, so the pub/sub
 * message itself stays bounded.
 */
export function createRedisDigestHub(maxClients?: number): DigestHub {
  const local = createDigestHub(maxClients);
  const origin = crypto.randomUUID();
  let subscription: Promise<() => Promise<void>> | undefined;

  const ensureSubscriber = (): Promise<() => Promise<void>> => {
    if (!subscription) subscription = redisRuntime().subscribe(DIGEST_CHANNEL, (message) => {
      const envelope = message as RemoteEnvelope;
      if (!envelope || envelope.origin === origin || typeof envelope.payloadKey !== 'string') return;
      void (async () => {
        const data = await redisRuntime().getJson(envelope.payloadKey);
        if (data === undefined) return;
        if (envelope.ownerId) await local.publishPrivate(envelope.event, data, envelope.ownerId);
        else local.publish(envelope.event, data);
      })().catch(() => undefined);
    });
    return subscription;
  };

  const publishRemote = async (event: string, data: unknown, ownerId: string | null) => {
    await ensureSubscriber();
    const candidate = data && typeof data === 'object' && 'eventId' in data
      ? (data as { eventId?: unknown }).eventId
      : null;
    const eventId = typeof candidate === 'string' && candidate ? candidate : crypto.randomUUID();
    const payloadKey = `digest-event:${stableHash(eventId)}`;
    await redisRuntime().setJson(payloadKey, data, { ttlMs: EVENT_TTL_MS, maxBytes: MAX_EVENT_BYTES });
    await redisRuntime().publish(DIGEST_CHANNEL, { origin, event, ownerId, eventId, payloadKey } satisfies RemoteEnvelope);
  };

  return {
    register(sink) {
      void ensureSubscriber().catch(() => undefined);
      return local.register(sink);
    },
    unregister(clientId) { local.unregister(clientId); },
    publish(event, data) {
      const result = local.publish(event, data);
      void publishRemote(event, data, null).catch(() => undefined);
      return result;
    },
    async publishPrivate(event, data, ownerId) {
      const result = await local.publishPrivate(event, data, ownerId);
      await publishRemote(event, data, ownerId);
      return result;
    },
    subscriberCount() { return local.subscriberCount(); },
    status() { return local.status(); },
    async close() {
      const unsubscribe = await subscription?.catch(() => undefined);
      await unsubscribe?.();
      subscription = undefined;
    },
  };
}
