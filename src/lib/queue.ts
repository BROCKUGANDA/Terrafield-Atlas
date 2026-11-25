import { Prisma } from '@prisma/client';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '@/lib/db';
import { canonicalJson, stableHash } from '@/lib/redis';

/**
 * Durable job queue.
 *
 * CONTRACT
 *  - PostgreSQL owns the durable job state (`ProcessingJob`); Redis/BullMQ only
 *    carries the pointer. A job that survives a Redis restart is still
 *    visible to the client through GET /api/v1/analysis/jobs/{id}.
 *  - The job row AND its outbox event are committed in ONE transaction BEFORE
 *    anything is pushed to Redis. If the enqueue then fails, the unpublished
 *    outbox event is the reconciliation record (see jobs/runtime.ts).
 *  - No provider call ever happens inside a transaction: enqueue only writes
 *    rows.
 *  - `dedupeKey` is the tenant-scoped natural key of a logical job. A repeated
 *    enqueue with the same idempotency key resolves to the SAME row.
 */

export const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME ?? 'terrafield-jobs';

export const JOB_TYPES = [
  'power-ingest',
  'trends',
  'fires-ingest',
  'private-fires-snapshot-v1',
  'fires-watch-eval',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

/** The payload carried by the queue pointer. The durable row stays authoritative. */
export interface JobPayload {
  jobId: string;
  type: JobType;
  ownerId: string | null;
  organizationId?: string | null;
  params: Record<string, unknown>;
  correlationId: string;
  deadlineAt: string | null;
  maxAttempts: number;
  attempt: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_DELAY_MS = 2_000;
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

/** Overall deadline per job type — provider work is bounded, never unbounded. */
const DEFAULT_DEADLINE_MS: Record<JobType, number> = {
  'power-ingest': 15 * 60_000,
  trends: 10 * 60_000,
  'fires-ingest': 15 * 60_000,
  'private-fires-snapshot-v1': 15 * 60_000,
  'fires-watch-eval': 15 * 60_000,
};

export function jobDeadlineMs(type: JobType): number {
  const override = Number(process.env.JOB_DEADLINE_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_DEADLINE_MS[type];
}

export function jobMaxAttempts(type: JobType): number {
  const scoped = Number(process.env[`JOB_MAX_ATTEMPTS_${type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]);
  if (Number.isInteger(scoped) && scoped >= 1 && scoped <= 20) return scoped;
  const override = Number(process.env.JOB_MAX_ATTEMPTS);
  if (Number.isInteger(override) && override >= 1 && override <= 20) return override;
  return DEFAULT_MAX_ATTEMPTS;
}

function backoffDelayMs(): number {
  const override = Number(process.env.JOB_BACKOFF_DELAY_MS);
  if (Number.isFinite(override) && override >= 100) return override;
  return DEFAULT_BACKOFF_DELAY_MS;
}

function enqueueTimeoutMs(): number {
  const override = Number(process.env.JOB_ENQUEUE_TIMEOUT_MS);
  if (Number.isFinite(override) && override >= 250) return override;
  return DEFAULT_ENQUEUE_TIMEOUT_MS;
}

/** Namespaced so parallel test runs and deployments never share queue state. */
export function bullPrefix(): string {
  if (process.env.BULLMQ_PREFIX) return process.env.BULLMQ_PREFIX;
  return `${process.env.REDIS_KEY_PREFIX ?? 'terrafield:'}bull`;
}

function redisUrl(): string {
  const url = process.env.REDIS_URL ?? process.env.TEST_REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');
  return url;
}

let producerConnection: IORedis | undefined;

/**
 * Producer connection. Deliberately NOT `enableOfflineQueue: false` (that
 * rejects even the first command of a lazily connected client) — instead the
 * enqueue is bounded by an explicit timeout so a request can never hang on an
 * unreachable broker.
 */
export function producerRedis(): IORedis {
  if (!producerConnection) {
    producerConnection = new IORedis(redisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 100, 1_000),
    });
    producerConnection.on('error', () => { /* surfaced per operation */ });
  }
  return producerConnection;
}

let queueInstance: Queue | undefined;

export function jobQueue(): Queue {
  queueInstance ??= new Queue(JOB_QUEUE_NAME, {
    connection: producerRedis(),
    prefix: bullPrefix(),
  });
  return queueInstance;
}

export async function closeJobQueue(): Promise<void> {
  const queue = queueInstance;
  queueInstance = undefined;
  if (queue) await queue.close().catch(() => undefined);
  const connection = producerConnection;
  producerConnection = undefined;
  if (connection) await connection.quit().catch(() => connection.disconnect());
}

// ---------------------------------------------------------------------------
// Durable job creation
// ---------------------------------------------------------------------------

export interface EnqueueJobInput {
  type: JobType;
  ownerId: string | null;
  organizationId?: string | null;
  params: Record<string, unknown>;
  correlationId: string;
  /** Tenant-scoped idempotency key. Absent → a new logical job every time. */
  idempotencyKey?: string | null;
  /** Route scope of the idempotency key (defaults to the job type). */
  route?: string;
  deadlineMs?: number;
  maxAttempts?: number;
  actor?: string;
}

export interface DurableJob {
  jobId: string;
  type: JobType;
  status: string;
  /** false → an existing job was reused (idempotent replay). */
  created: boolean;
  correlationId: string;
  deadlineAt: string | null;
  maxAttempts: number;
}

export interface EnqueuedJob extends DurableJob {
  /** true → the queue accepted the pointer; false → pending outbox reconciliation. */
  enqueued: boolean;
  enqueueError?: string;
}

/**
 * Tenant-scoped natural key of a logical job. The same key for a different
 * tenant, type or route is a DIFFERENT job.
 */
export function jobDedupeKey(input: EnqueueJobInput): string | null {
  const key = input.idempotencyKey?.trim();
  if (!key) return null;
  return stableHash(canonicalJson({
    scope: input.organizationId ?? input.ownerId ?? 'public',
    type: input.type,
    route: input.route ?? input.type,
    key,
  }));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function describeJob(job: {
  id: string;
  type: string;
  status: string;
  correlationId: string | null;
  deadlineAt: Date | null;
  maxAttempts: number;
}, created: boolean): DurableJob {
  return {
    jobId: job.id,
    type: job.type as JobType,
    status: job.status,
    created,
    correlationId: job.correlationId ?? '',
    deadlineAt: job.deadlineAt ? job.deadlineAt.toISOString() : null,
    maxAttempts: job.maxAttempts,
  };
}

/**
 * Create (or resolve) the durable job row and its outbox event.
 *
 * When `tx` is supplied the caller owns the transaction, so the job row, the
 * outbox event and any surrounding mutation commit together. Without `tx` the
 * two rows are committed in their own transaction.
 */
export async function createDurableJob(
  input: EnqueueJobInput,
  tx?: Prisma.TransactionClient,
): Promise<DurableJob> {
  const client = tx ?? db;
  const dedupeKey = jobDedupeKey(input);
  const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? jobDeadlineMs(input.type)));
  const maxAttempts = input.maxAttempts ?? jobMaxAttempts(input.type);

  if (dedupeKey) {
    const existing = await client.processingJob.findUnique({ where: { dedupeKey } });
    if (existing) return describeJob(existing, false);
  }

  try {
    const job = await client.processingJob.create({
      data: {
        ownerId: input.ownerId,
        organizationId: input.organizationId ?? null,
        type: input.type,
        status: 'queued',
        params: JSON.stringify(input.params),
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey ?? null,
        dedupeKey,
        attempts: 0,
        maxAttempts,
        deadlineAt,
        progressNote: 'queued for durable execution',
      },
    });
    await client.outboxEvent.create({
      data: {
        aggregateType: 'ProcessingJob',
        aggregateId: job.id,
        eventType: 'job.enqueued',
        payload: JSON.stringify({
          jobId: job.id,
          type: input.type,
          ownerId: input.ownerId,
          organizationId: input.organizationId ?? null,
          correlationId: input.correlationId,
          deadlineAt: deadlineAt.toISOString(),
        }),
      },
    });
    return describeJob(job, true);
  } catch (error) {
    // A concurrent enqueue with the same idempotency key wins; the loser
    // resolves to the SAME logical job instead of creating a second one.
    if (dedupeKey && isUniqueViolation(error)) {
      if (tx) throw error; // the caller's transaction is already aborted
      const raced = await db.processingJob.findUnique({ where: { dedupeKey } });
      if (raced) return describeJob(raced, false);
    }
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Push the durable job onto the queue. Safe to call repeatedly: BullMQ
 * de-duplicates by job id and the durable row is the source of truth.
 */
export async function dispatchJob(jobId: string): Promise<{ enqueued: boolean; error?: string }> {
  const job = await db.processingJob.findUnique({ where: { id: jobId } });
  if (!job) return { enqueued: false, error: 'job not found' };
  if (job.status !== 'queued') return { enqueued: false, error: `job is ${job.status}` };
  if (!isJobType(job.type)) return { enqueued: false, error: `unknown job type ${job.type}` };

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(job.params) as Record<string, unknown>;
  } catch {
    return { enqueued: false, error: 'job params are not valid JSON' };
  }

  const payload: JobPayload = {
    jobId: job.id,
    type: job.type,
    ownerId: job.ownerId,
    organizationId: job.organizationId,
    params,
    correlationId: job.correlationId ?? '',
    deadlineAt: job.deadlineAt ? job.deadlineAt.toISOString() : null,
    maxAttempts: job.maxAttempts,
    attempt: job.attempts + 1,
  };

  const options: JobsOptions = {
    jobId: job.id,
    attempts: Math.max(1, job.maxAttempts),
    backoff: { type: 'exponential', delay: backoffDelayMs() },
    removeOnComplete: { age: 3_600, count: 5_000 },
    removeOnFail: { age: 86_400, count: 5_000 },
  };

  try {
    const queue = jobQueue();
    const pending = queue.add(job.type, payload, options);
    pending.catch(() => { /* the timeout below owns the failure */ });
    await withTimeout(pending, enqueueTimeoutMs(), 'queue enqueue timed out');
    await db.processingJob.update({ where: { id: jobId }, data: { enqueuedAt: new Date() } });
    return { enqueued: true };
  } catch (error) {
    // The durable row and the outbox event stay committed: the unpublished
    // outbox event is the reconciliation record for this failure.
    const message = error instanceof Error ? error.message : String(error);
    await db.processingJob.update({
      where: { id: jobId },
      data: { progressNote: 'enqueue failed — pending outbox reconciliation' },
    }).catch(() => undefined);
    return { enqueued: false, error: message };
  }
}

/**
 * Full enqueue: durable rows first (atomic), queue pointer second.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueuedJob> {
  const durable = await createDurableJob(input);
  const dispatch = await dispatchJob(durable.jobId);
  return {
    ...durable,
    enqueued: dispatch.enqueued,
    ...(dispatch.error ? { enqueueError: dispatch.error } : {}),
  };
}

/** Public URL of the durable job status resource. */
export function jobUrl(jobId: string): string {
  return `/api/v1/analysis/jobs/${jobId}`;
}
