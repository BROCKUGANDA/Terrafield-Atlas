import { Worker, UnrecoverableError, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '@/lib/db';
import { JOB_QUEUE_NAME, bullPrefix, closeJobQueue } from '@/lib/queue';
import { executeJob } from '@/lib/jobs/handlers';
import { dispatchPendingWebhooks, enqueueWebhookDeliveries } from '@/lib/outbox-worker';
import {
  closeRuntimeRedis,
  recoverStaleJobs,
  reconcilePendingEnqueues,
  registerWorkerHeartbeat,
} from '@/lib/jobs/runtime';

/**
 * Worker entry point.
 *
 * Run standalone:  bun src/lib/jobs/worker.ts
 * (the deployment stack starts one worker container per replica.)
 *
 * The worker is a thin, replaceable executor: all durable state lives in
 * PostgreSQL, so killing a worker loses nothing that cannot be recovered.
 */

export interface WorkerHandle {
  worker: Worker;
  workerId: string;
  close(force?: boolean): Promise<void>;
}

export interface StartWorkerOptions {
  workerId?: string;
  concurrency?: number;
  queueName?: string;
  /** Run the stale-job recovery and outbox reconciliation timers. */
  maintenance?: boolean;
}

function workerRedis(): IORedis {
  const url = process.env.REDIS_URL ?? process.env.TEST_REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null, // required for blocking commands
    enableReadyCheck: false,
  });
  connection.on('error', () => { /* surfaced through worker events */ });
  return connection;
}

export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const workerId = options.workerId ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const queueName = options.queueName ?? JOB_QUEUE_NAME;
  const concurrency = options.concurrency ?? Number(process.env.JOB_WORKER_CONCURRENCY ?? 4);
  const connection = workerRedis();

  const worker = new Worker(
    queueName,
    async (bullJob: Job) => {
      const jobId = bullJob.id ?? '';
      const result = await executeJob(jobId, { holder: workerId });
      if (result.status === 'failed' || result.status === 'dead-lettered') {
        // BullMQ owns the retry schedule (exponential backoff); the durable
        // row is finalised by the 'failed' handler below.
        const message = result.error ?? `job ${jobId} failed`;
        if (!result.retryable) throw new UnrecoverableError(message);
        throw new Error(message);
      }
      return result;
    },
    {
      connection,
      prefix: bullPrefix(),
      concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 4,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job?.id) return;
    void (async () => {
      const attempts = job.opts.attempts ?? 1;
      const exhausted = job.attemptsMade >= attempts;
      // A terminal state written by the handler (cancelled, dead-lettered) is
      // never overwritten by the queue bookkeeping.
      await db.processingJob.updateMany({
        where: { id: job.id, status: { in: ['failed', 'running', 'queued'] } },
        data: exhausted
          ? {
              status: 'dead-lettered',
              deadLettered: true,
              error: error?.message ?? 'job failed',
              progressNote: 'dead-lettered after exhausting the attempt budget',
              finishedAt: new Date(),
              leaseExpiresAt: null,
              leaseHolder: null,
            }
          : {
              status: 'queued',
              error: error?.message ?? 'job failed',
              progressNote: 'failed — scheduled for retry',
              leaseExpiresAt: null,
              leaseHolder: null,
            },
      });
    })().catch(() => undefined);
  });

  worker.on('error', (error) => {
    console.error(`[queue-worker:${workerId}] worker error:`, error instanceof Error ? error.message : error);
  });

  await registerWorkerHeartbeat(workerId);

  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  if (options.maintenance !== false) {
    maintenanceTimer = setInterval(() => {
      void registerWorkerHeartbeat(workerId).catch(() => undefined);
      void recoverStaleJobs().catch(() => undefined);
      void reconcilePendingEnqueues().catch(() => undefined);
      void enqueueWebhookDeliveries().catch(() => undefined);
      void dispatchPendingWebhooks().catch(() => undefined);
    }, 30_000);
    maintenanceTimer.unref?.();
  }

  return {
    worker,
    workerId,
    async close(force = false) {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      await worker.close(force);
      await connection.quit().catch(() => connection.disconnect());
      await closeRuntimeRedis().catch(() => undefined);
      await closeJobQueue().catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const handle = await startWorker();
  console.log(`[queue-worker] ${handle.workerId} listening on "${JOB_QUEUE_NAME}"`);
  await recoverStaleJobs().catch(() => undefined);
  await reconcilePendingEnqueues().catch(() => undefined);
  const shutdown = async () => {
    console.log('[queue-worker] shutting down');
    await handle.close();
    await db.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

const invokedPath = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invokedPath.endsWith('/jobs/worker.ts') || invokedPath.endsWith('/jobs/worker.js')) {
  void main();
}
