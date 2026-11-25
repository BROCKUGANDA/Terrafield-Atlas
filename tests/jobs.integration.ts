import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';
import { createFetchMock } from './fetch-mock';

/**
 * Task 6 — durable BullMQ jobs.
 *
 * RED cases covered here:
 *  - a repeated enqueue with the same idempotency key creates ONE logical job
 *  - a killed worker's expired lease is recovered and can be re-leased
 *  - tenant and global concurrency caps are enforced
 *  - long work answers 202 with a durable job id and the worker persists the
 *    result with PostgreSQL natural-key upserts (no duplicates on re-run)
 */

if (process.env.TERRAFIELD_JOBS_WORKER !== '1') {
  test('durable job integration (isolated PostgreSQL and Redis)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/jobs.integration.ts'], {
      env: { ...process.env, TERRAFIELD_JOBS_WORKER: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 245_000);
} else {
  const database = await createPostgresTestDatabase('task6_jobs');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'task6-jobs-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://task6-jobs.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.DIGEST_PUSH_OFF = '1';
  process.env.REDIS_KEY_PREFIX = `task6:${crypto.randomUUID()}:`;
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { enqueueJob, createDurableJob, jobDedupeKey } = await import('@/lib/queue');
  const runtime = await import('@/lib/jobs/runtime');
  const { executeJob } = await import('@/lib/jobs/handlers');
  const { startWorker } = await import('@/lib/jobs/worker');
  const ingest = await import('@/app/api/v1/observations/ingest/route');
  const trends = await import('@/app/api/v1/analysis/trends/route');
  const queueRoute = await import('@/app/api/v1/system/queue/route');

  const origin = process.env.NEXTAUTH_URL!;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  let requestSequence = 0;
  const request = (
    path: string,
    method = 'GET',
    cookie?: string,
    body?: unknown,
    options: { key?: string } = {},
  ) => new NextRequest(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      'x-forwarded-for': `task6-${requestSequence++}`,
      ...(cookie ? { cookie } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const originalFetch = globalThis.fetch;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let ownerId = '';
  let adminId = '';
  let cookieOwner = '';
  let cookieAdmin = '';
  let farmId = '';

  async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value as T;
      await Bun.sleep(50);
    }
    const diagnostic = await probe().catch(() => null);
    throw new Error(`timed out waiting for the expected job state (last value: ${JSON.stringify(diagnostic)})`);
  }

  beforeAll(async () => {
    await runtime.runtimeRedisConnection().ping();
    const owner = await db.accountUser.create({ data: { email: 'owner@task6-jobs.test', emailVerified: new Date() } });
    const admin = await db.accountUser.create({ data: { email: 'admin@task6-jobs.test', emailVerified: new Date(), isAdmin: true } });
    ownerId = owner.id;
    adminId = admin.id;
    const token = async (id: string) => `__Secure-next-auth.session-token=${await encode({ token: { sub: id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    cookieOwner = await token(owner.id);
    cookieAdmin = await token(admin.id);
    farmId = (await db.farm.create({
      data: { ownerId: owner.id, name: 'Task 6 farm', centroidLat: 11.23456, centroidLon: 22.34567 },
    })).id;

    let value = 10;
    globalThis.fetch = createFetchMock(async () => {
      value += 1;
      return Response.json({
        properties: { parameter: { T2M: { '20240101': value, '20240102': value + 1 } } },
        header: { api: { name: 'POWER Daily API', version: 'test' }, sources: ['test-provider'] },
      });
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (worker) await worker.close(true);
    await runtime.closeRuntimeRedis();
    const { closeJobQueue } = await import('@/lib/queue');
    await closeJobQueue();
    await db.$disconnect();
    await database.drop();
  }, 30_000);

  test('a repeated enqueue with the same idempotency key creates one logical job', async () => {
    const input = {
      type: 'trends' as const,
      ownerId,
      params: { lat: 1, lon: 2, variables: ['T2M'], farmId: null },
      correlationId: 'task6-idempotent-enqueue',
      idempotencyKey: 'task6-idempotent-key-0001',
      route: '/api/v1/analysis/trends',
    };
    const first = await enqueueJob(input);
    const second = await enqueueJob(input);
    const third = await enqueueJob(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.jobId).toBe(first.jobId);
    expect(second.jobId).toBe(first.jobId);
    expect(await db.processingJob.count({ where: { dedupeKey: jobDedupeKey(input) } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: first.jobId, eventType: 'job.enqueued' } })).toBe(1);

    // A different tenant using the same key is a different logical job.
    const otherTenant = await enqueueJob({ ...input, ownerId: adminId, params: { ...input.params, lat: 3 } });
    expect(otherTenant.jobId).not.toBe(first.jobId);
    expect(otherTenant.created).toBe(true);

    // The durable row and the outbox event commit together, before the queue.
    const row = await db.processingJob.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(row.status).toBe('queued');
    expect(row.ownerId).toBe(ownerId);
    expect(row.dedupeKey).toBe(jobDedupeKey(input));
    expect(row.deadlineAt).toBeInstanceOf(Date);
  }, 30_000);

  test('terminal job failures emit a durable job.failed outbox event', async () => {
    const job = await db.processingJob.create({
      data: {
        ownerId,
        type: 'unsupported-job-type',
        status: 'queued',
        params: JSON.stringify({}),
        correlationId: 'task6-terminal-failure-event',
        attempts: 0,
        maxAttempts: 1,
      },
    });
    const result = await executeJob(job.id, { holder: 'failure-event-worker' });
    expect(result.status).toBe('failed');
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: job.id, eventType: 'job.failed' } });
    expect(JSON.parse(event.payload)).toMatchObject({ jobId: job.id, type: 'unsupported-job-type', ownerId, organizationId: null });
  });

  test('trend jobs honor an approved observation date range', async () => {
    const lat = 91.125;
    const lon = 92.25;
    await db.environmentalObservation.createMany({ data: [
      { ownerId, lat, lon, variable: 'T2M', value: 10, unit: '°C', sourceProvider: 'test', datasetVersion: 'test', obsDate: new Date('2023-01-01T00:00:00Z') },
      { ownerId, lat, lon, variable: 'T2M', value: 20, unit: '°C', sourceProvider: 'test', datasetVersion: 'test', obsDate: new Date('2024-06-01T00:00:00Z') },
      { ownerId, lat, lon, variable: 'T2M', value: 30, unit: '°C', sourceProvider: 'test', datasetVersion: 'test', obsDate: new Date('2024-07-01T00:00:00Z') },
      { ownerId, lat, lon, variable: 'T2M', value: 40, unit: '°C', sourceProvider: 'test', datasetVersion: 'test', obsDate: new Date('2025-01-01T00:00:00Z') },
    ] });
    const job = await db.processingJob.create({ data: {
      ownerId,
      type: 'trends',
      status: 'queued',
      params: JSON.stringify({ lat, lon, farmId: null, ownerId, organizationId: null, variables: ['T2M'], from: '2024-01-01', to: '2024-12-31' }),
      correlationId: 'task6-approved-range',
      attempts: 0,
      maxAttempts: 1,
    } });
    const result = await executeJob(job.id, { holder: 'approved-range-worker' });
    expect(result.status).toBe('succeeded');
    const analyses = await db.trendAnalysis.findMany({ where: { lat, lon, ownerId } });
    expect(analyses).toHaveLength(1);
    expect(analyses[0].periodStart.toISOString().slice(0, 10)).toBe('2024-06-01');
    expect(analyses[0].periodEnd.toISOString().slice(0, 10)).toBe('2024-07-01');
    await db.trendAnalysis.deleteMany({ where: { lat, lon, ownerId } });
    await db.environmentalObservation.deleteMany({ where: { lat, lon, ownerId } });
    await db.usageEvent.deleteMany({ where: { jobId: job.id } });
    await db.outboxEvent.deleteMany({ where: { aggregateId: job.id } });
    await db.jobLease.deleteMany({ where: { key: runtime.jobLeaseKey(job.id) } });
    await db.processingJob.delete({ where: { id: job.id } });
  }, 30_000);

  test("a killed worker's expired lease is recovered and can be re-leased", async () => {
    const job = await db.processingJob.create({
      data: {
        ownerId,
        type: 'trends',
        status: 'running',
        params: JSON.stringify({ lat: 1, lon: 2, variables: ['T2M'], farmId: null }),
        correlationId: 'task6-stale-lease',
        attempts: 1,
        maxAttempts: 5,
        leaseHolder: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await db.jobLease.create({
      data: {
        key: runtime.jobLeaseKey(job.id),
        holder: 'dead-worker',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const recovery = await runtime.recoverStaleJobs();
    expect(recovery.recovered).toContain(job.id);

    const recovered = await db.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(recovered.status).toBe('queued');
    expect(recovered.leaseHolder).toBeNull();
    expect(recovered.leaseExpiresAt).toBeNull();
    expect(recovered.attempts).toBe(2);
    expect(await db.jobLease.count({ where: { key: runtime.jobLeaseKey(job.id) } })).toBe(0);

    // A live worker can now take the lease over.
    const lease = await runtime.acquireJobLease(job.id, 'live-worker', 60_000);
    expect(lease).not.toBeNull();
    expect(lease?.holder).toBe('live-worker');
    const contended = await runtime.acquireJobLease(job.id, 'other-worker', 60_000);
    expect(contended).toBeNull();
    await runtime.releaseJobLease(job.id, 'live-worker');
  }, 30_000);

  test('tenant and global concurrency caps are enforced', async () => {
    const globalCap = runtime.globalConcurrencyCap();
    const tenantCap = runtime.tenantConcurrencyCap();

    for (let index = 0; index < globalCap; index++) {
      expect(await runtime.acquireConcurrencySlot(runtime.globalScope(), `global-${index}`, globalCap, 60_000)).toBe(true);
    }
    expect(await runtime.acquireConcurrencySlot(runtime.globalScope(), 'global-overflow', globalCap, 60_000)).toBe(false);
    expect(await runtime.concurrencySlotsInUse(runtime.globalScope())).toBe(globalCap);

    // Releasing a slot admits the next waiter.
    await runtime.releaseConcurrencySlot(runtime.globalScope(), 'global-0');
    expect(await runtime.acquireConcurrencySlot(runtime.globalScope(), 'global-overflow', globalCap, 60_000)).toBe(true);

    // The tenant scope is independent from the global scope and from other tenants.
    for (let index = 0; index < tenantCap; index++) {
      expect(await runtime.acquireConcurrencySlot(runtime.tenantScope('tenant-a'), `tenant-a-${index}`, tenantCap, 60_000)).toBe(true);
    }
    expect(await runtime.acquireConcurrencySlot(runtime.tenantScope('tenant-a'), 'tenant-a-overflow', tenantCap, 60_000)).toBe(false);
    expect(await runtime.acquireConcurrencySlot(runtime.tenantScope('tenant-b'), 'tenant-b-1', tenantCap, 60_000)).toBe(true);

    // A job that cannot take a slot never runs its handler.
    for (const member of Array.from({ length: globalCap }, (_, index) => `blocked-${index}`)) {
      await runtime.acquireConcurrencySlot(runtime.globalScope(), member, globalCap, 60_000);
    }
    const blocked = await createDurableJob({
      type: 'trends',
      ownerId,
      params: { lat: 1, lon: 2, variables: ['T2M'], farmId: null },
      correlationId: 'task6-concurrency-cap',
    });
    const blockedResult = await executeJob(blocked.jobId, { holder: 'capped-worker' });
    expect(blockedResult.status).toBe('failed');
    expect(blockedResult.retryable).toBe(true);
    const blockedRow = await db.processingJob.findUniqueOrThrow({ where: { id: blocked.jobId } });
    expect(blockedRow.status).toBe('queued');
    expect(await db.trendAnalysis.count()).toBe(0);

    for (const member of Array.from({ length: globalCap }, (_, index) => `blocked-${index}`)) {
      await runtime.releaseConcurrencySlot(runtime.globalScope(), member);
    }
    await runtime.releaseConcurrencySlot(runtime.globalScope(), 'global-overflow');
    for (let index = 1; index < globalCap; index++) {
      await runtime.releaseConcurrencySlot(runtime.globalScope(), `global-${index}`);
    }
    for (let index = 0; index < tenantCap; index++) {
      await runtime.releaseConcurrencySlot(runtime.tenantScope('tenant-a'), `tenant-a-${index}`);
    }
    await runtime.releaseConcurrencySlot(runtime.tenantScope('tenant-b'), 'tenant-b-1');
  }, 30_000);

  test('long work answers 202 with a durable job id and the worker persists real observations', async () => {
    worker = await startWorker({ workerId: 'task6-test-worker', concurrency: 2 });
    const body = { farmId, years: 2, variables: ['T2M'] };
    const response = await ingest.POST(request('observations/ingest', 'POST', cookieOwner, body, { key: 'task6-ingest-key-0001' }), ctx());
    expect(response.status).toBe(202);
    expect(response.headers.get('Location')).toEqual(expect.any(String));
    const payload = await response.json();
    expect(payload.jobId).toEqual(expect.any(String));
    expect(payload.jobUrl).toBe(`/api/v1/analysis/jobs/${payload.jobId}`);
    expect(payload.status).toBe('queued');

    // The provider was NOT called inline: the work is queued, not executed.
    const queued = await db.processingJob.findUniqueOrThrow({ where: { id: payload.jobId } });
    expect(queued.type).toBe('power-ingest');
    expect(queued.ownerId).toBe(ownerId);
    expect(queued.status).toBe('queued');
    expect(await db.environmentalObservation.count()).toBe(0);

    const finished = await waitFor(async () => {
      const row = await db.processingJob.findUniqueOrThrow({ where: { id: payload.jobId } });
      return row.status === 'succeeded' ? row : null;
    });
    expect(finished.status).toBe('succeeded');
    expect(finished.finishedAt).toBeInstanceOf(Date);
    const stored = await db.environmentalObservation.findMany({ where: { farmId } });
    expect(stored.length).toBe(2);
    expect(stored.every((row) => row.ownerId === ownerId)).toBe(true);
    // Re-running the same ingestion must not duplicate an observation: the
    // natural key (namespace, lat, lon, variable, date) is a database upsert.
    const repeat = await ingest.POST(request('observations/ingest', 'POST', cookieOwner, body, { key: 'task6-ingest-key-0002' }), ctx());
    expect(repeat.status).toBe(202);
    const repeatBody = await repeat.json();
    expect(repeatBody.jobId).not.toBe(payload.jobId);
    await waitFor(async () => {
      const row = await db.processingJob.findUniqueOrThrow({ where: { id: repeatBody.jobId } });
      return row.status === 'succeeded' ? row : null;
    });
    expect(await db.environmentalObservation.count({ where: { farmId } })).toBe(2);
  }, 60_000);

  test('the same idempotency key on the route replays one durable job', async () => {
    const body = { farmId, years: 2, variables: ['T2M'] };
    const first = await ingest.POST(request('observations/ingest', 'POST', cookieOwner, body, { key: 'task6-route-idem-key' }), ctx());
    const second = await ingest.POST(request('observations/ingest', 'POST', cookieOwner, body, { key: 'task6-route-idem-key' }), ctx());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.duplicate).toBe(true);
    expect(await db.processingJob.count({ where: { dedupeKey: jobDedupeKey({
      type: 'power-ingest',
      ownerId,
      params: { lat: 11.23456, lon: 22.34567, years: 2, variables: ['T2M'], farmId, ownerId },
      correlationId: '',
      idempotencyKey: 'task6-route-idem-key',
      route: '/api/v1/observations/ingest',
    }) } })).toBe(1);
  }, 30_000);

  test('trends run as a durable job and are refused when nothing was ingested', async () => {
    const noData = await trends.POST(request('analysis/trends', 'POST', cookieOwner, { farmId: 'missing-farm' }), ctx());
    expect(noData.status).toBe(404);

    const accepted = await trends.POST(request('analysis/trends', 'POST', cookieOwner, { farmId, variables: ['T2M'] }), ctx());
    expect(accepted.status).toBe(202);
    const body = await accepted.json();
    expect(body.jobId).toEqual(expect.any(String));

    const finished = await waitFor(async () => {
      const row = await db.processingJob.findUniqueOrThrow({ where: { id: body.jobId } });
      return row.status === 'succeeded' ? row : null;
    });
    expect(finished.status).toBe('succeeded');
    expect(await db.trendAnalysis.count({ where: { farmId } })).toBeGreaterThan(0);
  }, 60_000);

  test('queue metrics are protected and report depth, retries and worker heartbeats', async () => {
    const anonymous = await queueRoute.GET(request('system/queue'), ctx());
    expect(anonymous.status).toBe(401);
    const denied = await queueRoute.GET(request('system/queue', 'GET', cookieOwner), ctx());
    expect(denied.status).toBe(403);
    const allowed = await queueRoute.GET(request('system/queue', 'GET', cookieAdmin), ctx());
    expect(allowed.status).toBe(200);
    const metrics = await allowed.json();
    expect(metrics.queue.queue).toEqual(expect.any(String));
    expect(metrics.queue.depth.waiting).toEqual(expect.any(Number));
    expect(metrics.queue.oldestJobAgeSec).toEqual(expect.any(Number));
    expect(metrics.queue.workers.some((worker: { id: string }) => worker.id === 'task6-test-worker')).toBe(true);
  }, 30_000);
}
