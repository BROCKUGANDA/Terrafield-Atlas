import { db } from '@/lib/db';
import { processPendingDigestOutbox } from '@/lib/digest-outbox-worker';
import { dispatchPendingWebhooks, enqueueWebhookDeliveries } from '@/lib/outbox-worker';

async function main(): Promise<void> {
  console.log('[outbox-worker] durable digest delivery service started');
  const timer = setInterval(() => {
    void (async () => {
      await processPendingDigestOutbox();
      await enqueueWebhookDeliveries();
      await dispatchPendingWebhooks();
    })().catch((error) => {
      console.error('[outbox-worker] processing failed:', error instanceof Error ? error.message : error);
    });
  }, 5_000);
  timer.unref?.();
  const shutdown = async () => {
    clearInterval(timer);
    await db.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  setInterval(() => undefined, 60_000);
}

void main();
