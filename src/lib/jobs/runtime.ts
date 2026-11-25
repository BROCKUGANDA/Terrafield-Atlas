import IORedis from 'ioredis';
import { db } from '@/lib/db';
import { dispatchJob, jobQueue, JOB_QUEUE_NAME } from '@/lib/queue';

/**
 * Durable job runtime: leases, heartbeats, deadlines, cooperative
 * cancellation, concurrency caps, stale-running recovery and queue metrics.
 *
 * LEASES are database-backed (`JobLease`): the holder and its expiry survive a
 * process crash, so a killed worker's job is recoverable by anyone.
 *
 * CONCURRENCY CAPS are Redis-backed semaphores: they must hold across web
 * replicas and worker replicas, which a per-process counter cannot do.
 */

export class JobCancelledError extends Error {
  constructor(message = 'job was cancelled cooperatively') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export class JobDeadlineExceededError extends Error {
  constructor(message = 'job exceeded its overall deadline') {
    super(message);
    this.name = 'JobDeadlineExceededError';
  }
}

export class JobConcurrencyError extends Error {
  constructor(message = 'concurrency cap reached') {
    super(message);
    this.name = 'JobConcurrencyError';
  }
}

export class JobLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobLeaseError';
  }
}

export interface JobLease {
  jobId: string;
  holder: string;
  expiresAt: Date;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_GLOBAL_CONCURRENCY = 4;
export const DEFAULT_TENANT_CONCURRENCY = 2;
export const WORKER_HEARTBEAT_TTL_MS = 90_000;

export function jobLeaseKey(jobId: string): string {
  return `job:${jobId}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function globalConcurrencyCap(): number {
  return positiveInt(process.env.JOB_GLOBAL_CONCURRENCY, DEFAULT_GLOBAL_CONCURRENCY);
}

export function tenantConcurrencyCap(): number {
  return positiveInt(process.env.JOB_TENANT_CONCURRENCY, DEFAULT_TENANT_CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

/**
 * Acquire the execution lease of one job. Returns null when another live
 * holder owns it.
 *
 * The claim is a single conditional UPDATE (plus an INSERT for a lease that
 * does not exist yet): it is atomic without SERIALIZABLE isolation, so two
 * workers racing for the same job can never both win.
 */
export async function acquireJobLease(
  jobId: string,
  holder: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<JobLease | null> {
  const key = jobLeaseKey(jobId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const claimed = await db.jobLease.updateMany({
    where: { key, OR: [{ expiresAt: { lte: now } }, { holder }] },
    data: { holder, expiresAt, heartbeatAt: now },
  });
  let acquired = claimed.count === 1;
  if (!acquired) {
    // No lease row yet: create it. skipDuplicates makes the concurrent
    // creation a no-op instead of an error, so the loser simply does not
    // own the lease.
    const inserted = await db.jobLease.createMany({
      data: [{ key, holder, expiresAt, heartbeatAt: now }],
      skipDuplicates: true,
    });
    acquired = inserted.count === 1;
  }
  if (!acquired) return null;

  await db.processingJob.updateMany({
    where: { id: jobId, status: { in: ['queued', 'running'] } },
    data: { status: 'running', leaseHolder: holder, leaseExpiresAt: expiresAt },
  });
  return { jobId, holder, expiresAt };
}

/** Renew the lease (heartbeat). Returns false when ownership was lost. */
export async function renewJobLease(
  jobId: string,
  holder: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const renewed = await db.jobLease.updateMany({
    where: { key: jobLeaseKey(jobId), holder },
    data: { expiresAt, heartbeatAt: now },
  });
  if (renewed.count !== 1) return false;
  await db.processingJob.updateMany({
    where: { id: jobId, leaseHolder: holder },
    data: { leaseExpiresAt: expiresAt },
  });
  return true;
}

/** Release the lease (only the holder may release it). */
export async function releaseJobLease(jobId: string, holder: string): Promise<void> {
  await db.jobLease.deleteMany({ where: { key: jobLeaseKey(jobId), holder } }).catch(() => undefined);
  await db.processingJob.updateMany({
    where: { id: jobId, leaseHolder: holder },
    data: { leaseExpiresAt: null, leaseHolder: null },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Cooperative cancellation and deadlines
// ---------------------------------------------------------------------------

/** Request cooperative cancellation. The running job stops at its next checkpoint. */
export async function requestJobCancellation(jobId: string): Promise<boolean> {
  const result = await db.processingJob.updateMany({
    where: { id: jobId, status: { in: ['queued', 'running'] } },
    data: { cancelRequested: true, progressNote: 'cancellation requested' },
  });
  return result.count === 1;
}

export async function isJobCancelled(jobId: string): Promise<boolean> {
  const row = await db.processingJob.findUnique({
    where: { id: jobId },
    select: { cancelRequested: true },
  });
  return row?.cancelRequested === true;
}

export function deadlineExceeded(deadlineAt: Date | null, now: Date = new Date()): boolean {
  return deadlineAt !== null && deadlineAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Stale-running recovery
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  recovered: string[];
  deadLettered: string[];
}

/**
 * Reclaim jobs whose worker died. A `running` row whose lease expired (or
 * that never had one) is returned to `queued` and re-enqueued; a row that
 * exhausted its attempt budget is dead-lettered instead.
 */
export async function recoverStaleJobs(options: { limit?: number; now?: Date } = {}): Promise<RecoveryResult> {
  const now = options.now ?? new Date();
  const stale = await db.processingJob.findMany({
    where: {
      status: 'running',
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    orderBy: { startedAt: 'asc' },
    take: options.limit ?? 50,
    select: { id: true, attempts: true, maxAttempts: true },
  });

  const recovered: string[] = [];
  const deadLettered: string[] = [];
  for (const job of stale) {
    await db.jobLease.deleteMany({ where: { key: jobLeaseKey(job.id) } }).catch(() => undefined);
    const exhausted = job.attempts + 1 >= job.maxAttempts;
    const updated = await db.processingJob.updateMany({
      where: {
        id: job.id,
        status: 'running',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: exhausted
        ? {
            status: 'dead-lettered',
            deadLettered: true,
            leaseExpiresAt: null,
            leaseHolder: null,
            error: 'worker lease expired and the attempt budget was exhausted',
            finishedAt: now,
          }
        : {
            status: 'queued',
            leaseExpiresAt: null,
            leaseHolder: null,
            attempts: { increment: 1 },
            progressNote: 'recovered after an expired worker lease',
          },
    });
    if (updated.count !== 1) continue;
    if (exhausted) {
      deadLettered.push(job.id);
      continue;
    }
    recovered.push(job.id);
    await dispatchJob(job.id);
  }
  return { recovered, deadLettered };
}

/**
 * Reconcile enqueue failures through the outbox. Every durable job has a
 * committed `job.enqueued` outbox event; a job that never reached Redis is
 * re-enqueued here.
 */
export async function reconcilePendingEnqueues(options: { limit?: number } = {}): Promise<string[]> {
  const pending = await db.outboxEvent.findMany({
    where: { eventType: 'job.enqueued', publishedAt: null },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 100,
    select: { id: true, aggregateId: true, payload: true },
  });
  const requeued: string[] = [];
  for (const event of pending) {
    const job = await db.processingJob.findUnique({ where: { id: event.aggregateId } });
    if (!job) {
      await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } }).catch(() => undefined);
      continue;
    }
    if (job.status !== 'queued') {
      await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } }).catch(() => undefined);
      continue;
    }
    const dispatch = await dispatchJob(job.id);
    if (dispatch.enqueued) {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date(), attempts: { increment: 1 } },
      }).catch(() => undefined);
      requeued.push(job.id);
    } else {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, lastError: dispatch.error ?? 'enqueue failed' },
      }).catch(() => undefined);
    }
  }
  return requeued;
}

// ---------------------------------------------------------------------------
// Concurrency semaphores (Redis)
// ---------------------------------------------------------------------------

const ACQUIRE_SLOT_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const RELEASE_SLOT_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

let runtimeRedis: IORedis | undefined;

export function runtimeRedisConnection(): IORedis {
  if (!runtimeRedis) {
    const url = process.env.REDIS_URL ?? process.env.TEST_REDIS_URL;
    if (!url) throw new Error('REDIS_URL is not configured');
    runtimeRedis = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 100, 1_000),
    });
    runtimeRedis.on('error', () => { /* surfaced per operation */ });
  }
  return runtimeRedis;
}

export async function closeRuntimeRedis(): Promise<void> {
  const connection = runtimeRedis;
  runtimeRedis = undefined;
  if (connection) await connection.quit().catch(() => connection.disconnect());
}

export function semaphoreKey(scope: string): string {
  return `${process.env.REDIS_KEY_PREFIX ?? 'terrafield:'}queue:semaphore:${scope}`;
}

export function globalScope(): string {
  return 'global';
}

export function tenantScope(ownerId: string | null, organizationId?: string | null): string {
  if (organizationId) return `organization:${organizationId}`;
  return ownerId ? `tenant:${ownerId}` : 'tenant:public';
}

/**
 * Try to take one slot of a bounded semaphore. Slots expire on their own, so a
 * crashed worker never leaks capacity.
 */
export async function acquireConcurrencySlot(
  scope: string,
  member: string,
  cap: number,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<boolean> {
  const connection = runtimeRedisConnection();
  const result = await connection.eval(
    ACQUIRE_SLOT_LUA,
    1,
    semaphoreKey(scope),
    String(cap),
    String(ttlMs),
    member,
    String(Math.max(ttlMs * 2, 60_000)),
  );
  return Number(result) === 1;
}

export async function releaseConcurrencySlot(scope: string, member: string): Promise<void> {
  const connection = runtimeRedisConnection();
  await connection.eval(RELEASE_SLOT_LUA, 1, semaphoreKey(scope), member);
}

/** Count of live slots in a semaphore (expired slots are not counted). */
export async function concurrencySlotsInUse(scope: string): Promise<number> {
  const connection = runtimeRedisConnection();
  const time = await connection.time();
  const now = time[0] * 1000 + Math.floor(time[1] / 1000);
  await connection.zremrangebyscore(semaphoreKey(scope), '-inf', now);
  return connection.zcard(semaphoreKey(scope));
}

// ---------------------------------------------------------------------------
// Worker heartbeats and queue metrics
// ---------------------------------------------------------------------------

export function workerHeartbeatKey(workerId: string): string {
  return `${process.env.REDIS_KEY_PREFIX ?? 'terrafield:'}queue:worker:${workerId}`;
}

export async function registerWorkerHeartbeat(workerId: string): Promise<void> {
  const connection = runtimeRedisConnection();
  await connection.set(workerHeartbeatKey(workerId), new Date().toISOString(), 'PX', WORKER_HEARTBEAT_TTL_MS);
}

export interface WorkerHeartbeat {
  id: string;
  lastSeenAt: string;
  ageSec: number;
}

export async function listWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
  const connection = runtimeRedisConnection();
  const pattern = `${process.env.REDIS_KEY_PREFIX ?? 'terrafield:'}queue:worker:*`;
  const found: WorkerHeartbeat[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const raw = await connection.get(key);
      if (!raw) continue;
      const lastSeen = Date.parse(raw);
      found.push({
        id: key.slice(key.lastIndexOf(':') + 1),
        lastSeenAt: raw,
        ageSec: Number.isFinite(lastSeen) ? Math.max(0, Math.round((Date.now() - lastSeen) / 1000)) : null as unknown as number,
      });
    }
  } while (cursor !== '0');
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export interface QueueMetrics {
  queue: string;
  depth: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused: number;
  };
  /** Age of the oldest durable job that is still waiting to run. */
  oldestJobAgeSec: number | null;
  /** Durable jobs that already consumed at least one attempt. */
  retries: number;
  /** Durable jobs that failed in the last 24 h. */
  failures: number;
  deadLettered: number;
  running: number;
  workers: WorkerHeartbeat[];
  generatedAt: string;
}

export async function queueMetrics(): Promise<QueueMetrics> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const queue = jobQueue();
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  const paused = await queue.isPaused();
  const oldest = await db.processingJob.findFirst({
    where: { status: 'queued' },
    orderBy: { startedAt: 'asc' },
    select: { startedAt: true },
  });
  const [retries, failures, deadLettered, running] = await Promise.all([
    db.processingJob.count({ where: { status: { in: ['queued', 'running'] }, attempts: { gt: 0 } } }),
    db.processingJob.count({ where: { status: 'failed', finishedAt: { gte: dayAgo } } }),
    db.processingJob.count({ where: { deadLettered: true } }),
    db.processingJob.count({ where: { status: 'running' } }),
  ]);
  return {
    queue: JOB_QUEUE_NAME,
    depth: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: paused ? 1 : 0,
    },
    oldestJobAgeSec: oldest ? Math.max(0, Math.round((now.getTime() - oldest.startedAt.getTime()) / 1000)) : null,
    retries,
    failures,
    deadLettered,
    running,
    workers: await listWorkerHeartbeats(),
    generatedAt: now.toISOString(),
  };
}
