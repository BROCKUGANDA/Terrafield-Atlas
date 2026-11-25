import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.TERRAFIELD_REPLICA_WORKER !== '1') {
  test('replica-safe scheduling, evaluation and digest delivery (isolated PostgreSQL and Redis)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/replica-delivery.integration.ts'], {
      env: { ...process.env, TERRAFIELD_REPLICA_WORKER: '1' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('task7_replica');
  process.env.DATABASE_URL = database.url;
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.DIGEST_PUSH_OFF = '0';
  process.env.DIGEST_WEBHOOK_OFF = '1';
  process.env.DIGEST_EMAIL_OFF = '1';
  process.env.REDIS_KEY_PREFIX = `task7:${crypto.randomUUID()}:`;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { redisRuntime } = await import('@/lib/redis');
  const provider = await import('@/lib/adapters/gibsFires');
  const { runWatchlistEvaluation } = await import('@/lib/fires/watchlist-evaluate');
  const { computeWatchlistDigest } = await import('@/lib/fires/watchlist-digest-service');
  const { createRedisDigestHub } = await import('@/lib/fires/redis-digest-hub');
  const scheduler = await import('@/lib/scheduler');
  const { processPendingDigestOutbox } = await import('@/lib/digest-outbox-worker');

  let hubA: Awaited<ReturnType<typeof createRedisDigestHub>> | undefined;
  let hubB: Awaited<ReturnType<typeof createRedisDigestHub>> | undefined;

  beforeAll(async () => { await redisRuntime().ping(); });
  afterAll(async () => {
    await hubA?.close?.();
    await hubB?.close?.();
    await redisRuntime().close();
    await db.$disconnect();
    await database.drop();
  });

  test('only one database lease holder can lead the scheduler', async () => {
    expect(await scheduler.tryAcquireSchedulerLeadership('replica-a')).toBe(true);
    expect(await scheduler.tryAcquireSchedulerLeadership('replica-b')).toBe(false);
    expect((await scheduler.schedulerLeaseStatus()).leader).toBe(true);
    await scheduler.releaseSchedulerLeadership('replica-a');
    expect(await scheduler.tryAcquireSchedulerLeadership('replica-b')).toBe(true);
    await scheduler.releaseSchedulerLeadership('replica-b');
  });

  test('a stale evaluation cannot overwrite a newer committed version', async () => {
    const watch = await db.fireWatchlist.create({ data: { name: 'stale version', lat: 1, lon: 2, lookbackDays: 1 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = spyOn(provider, 'fetchFiresForDate').mockImplementation(async () => {
      await gate;
      return { date: '2026-11-23', detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false };
    });
    try {
      const pending = runWatchlistEvaluation({
        watchlistId: watch.id, trigger: 'manual', actor: 'test', correlationId: 'stale-version',
        now: new Date('2026-11-24T00:00:00Z'), ownerId: null, leaseHolder: 'stale-evaluator',
      });
      while (fetch.mock.calls.length === 0) await Bun.sleep(5);
      await db.fireWatchlist.update({ where: { id: watch.id }, data: { evaluationVersion: { increment: 1 }, lastStatus: 'alert' } });
      release();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure.code).toBe('STALE_EVALUATION');
      expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: watch.id } })).lastStatus).toBe('alert');
      expect(await db.fireWatchEvent.count({ where: { watchlistId: watch.id } })).toBe(0);
    } finally {
      fetch.mockRestore();
    }
  });

  test('backtests append history without changing current live status', async () => {
    const watch = await db.fireWatchlist.create({ data: { name: 'backtest status', lat: 1, lon: 2, lookbackDays: 1 } });
    const fetch = spyOn(provider, 'fetchFiresForDate').mockImplementation(async (date) => ({
      date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false,
    }));
    try {
      const live = await runWatchlistEvaluation({
        watchlistId: watch.id, trigger: 'manual', actor: 'test', correlationId: 'live',
        now: new Date('2026-11-24T00:00:00Z'), ownerId: null,
      });
      expect(live.ok).toBe(true);
      const before = await db.fireWatchlist.findUniqueOrThrow({ where: { id: watch.id } });
      const backtest = await runWatchlistEvaluation({
        watchlistId: watch.id, trigger: 'backtest', end: '2026-01-10', actor: 'test', correlationId: 'backtest',
        now: new Date('2026-11-24T00:00:00Z'), ownerId: null,
      });
      expect(backtest.ok).toBe(true);
      const after = await db.fireWatchlist.findUniqueOrThrow({ where: { id: watch.id } });
      expect(after.lastStatus).toBe(before.lastStatus);
      expect(after.lastEvaluatedAt).toEqual(before.lastEvaluatedAt);
      expect(after.evaluationVersion).toBe(before.evaluationVersion + 1);
      expect(await db.fireWatchEvent.count({ where: { watchlistId: watch.id } })).toBe(2);
      expect(await db.outboxEvent.count({ where: { aggregateId: watch.id, eventType: 'watchlist.digest' } })).toBe(2);
    } finally {
      fetch.mockRestore();
    }
  });

  test('two Redis-backed hub instances each receive one committed event', async () => {
    hubA = createRedisDigestHub();
    hubB = createRedisDigestHub();
    const framesA: string[] = [];
    const framesB: string[] = [];
    hubA.register({ clientId: 'a', send: (frame) => framesA.push(frame) });
    hubB.register({ clientId: 'b', send: (frame) => framesB.push(frame) });
    const payload = { eventId: 'cross-replica-event', type: 'digest', watchlistId: 'watch-1' };
    const result = hubA.publish('watchlist.digest', payload);
    expect(result.delivered).toBe(1);
    const deadline = Date.now() + 3_000;
    while (framesB.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(framesA).toHaveLength(1);
    expect(framesB).toHaveLength(1);
    expect(framesB[0]).toContain('cross-replica-event');
  });

  test('outbox delivery sends a stable idempotency key and records one receiver receipt', async () => {
    await db.outboxEvent.updateMany({ where: { eventType: 'watchlist.digest', publishedAt: null }, data: { publishedAt: new Date() } });
    const watch = await db.fireWatchlist.create({ data: { name: 'outbox delivery', lat: 1, lon: 2, lookbackDays: 1 } });
    const fetch = spyOn(provider, 'fetchFiresForDate').mockImplementation(async (date) => ({
      date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false,
    }));
    const originalFetch = globalThis.fetch;
    const requests: Array<{ headers: Headers; body: string }> = [];
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
      return Response.json({ ok: true });
    }, { preconnect: originalFetch.preconnect });
    const previous = {
      DIGEST_WEBHOOK_OFF: process.env.DIGEST_WEBHOOK_OFF,
      DIGEST_WEBHOOK_URL: process.env.DIGEST_WEBHOOK_URL,
      DIGEST_WEBHOOK_ALLOWLIST: process.env.DIGEST_WEBHOOK_ALLOWLIST,
      DIGEST_WEBHOOK_SECRET: process.env.DIGEST_WEBHOOK_SECRET,
    };
    process.env.DIGEST_WEBHOOK_OFF = '0';
    process.env.DIGEST_WEBHOOK_URL = 'http://127.0.0.1:4317/digest';
    process.env.DIGEST_WEBHOOK_ALLOWLIST = '127.0.0.1:4317';
    process.env.DIGEST_WEBHOOK_SECRET = 'task7-webhook-secret-not-production';
    try {
      const evaluation = await runWatchlistEvaluation({
        watchlistId: watch.id, trigger: 'manual', actor: 'test', correlationId: 'outbox-delivery',
        now: new Date('2026-11-24T00:00:00Z'), ownerId: null,
      });
      expect(evaluation.ok).toBe(true);
      const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: watch.id, eventType: 'watchlist.digest' } });
      const first = await processPendingDigestOutbox({ holder: 'outbox-test-a' });
      expect(first.published).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get('idempotency-key')).toBe(event.id);
      expect(JSON.parse(requests[0].body).eventId).toBe(event.id);
      expect(await db.deliveryReceipt.count({ where: { eventId: event.id, channel: 'webhook' } })).toBe(1);
      const second = await processPendingDigestOutbox({ holder: 'outbox-test-b' });
      expect(second.published).toBe(0);
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      fetch.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('digest reads fetch newest rows before limiting and honor explicit trigger identity', async () => {
    const watch = await db.fireWatchlist.create({ data: { name: 'busy digest', lat: 1, lon: 2, lookbackDays: 1 } });
    const now = new Date('2026-11-24T00:00:00Z');
    const rows = Array.from({ length: 205 }, (_, index) => ({
      watchlistId: watch.id,
      evaluatedAt: new Date(now.getTime() - (205 - index) * 60_000),
      windowStart: new Date('2026-11-22T00:00:00Z'),
      windowEnd: new Date('2026-11-23T00:00:00Z'),
      status: index % 2 ? 'clear' : 'watch',
      detectionCount: index,
      highConfidenceCount: 0,
      nominalCount: index,
      lowCount: 0,
      maxFrpMW: null,
      daysWithDetections: 0,
      daysChecked: 1,
      daysNoData: 0,
      triggeredAlert: false,
      detailJson: JSON.stringify({ trigger: index === 204 ? 'scheduled' : index === 100 ? 'backtest' : 'manual' }),
    }));
    await db.fireWatchEvent.createMany({ data: rows });
    const newest = await computeWatchlistDigest(watch.id, { now });
    expect(newest.ok).toBe(true);
    if (newest.ok) {
      expect(newest.result.eventRowsRead).toBe(200);
      expect(newest.result.newestEventTrigger).toBe('scheduled');
      expect(newest.result.digest.current.last?.detectionCount).toBe(204);
    }
    const events = await db.fireWatchEvent.findMany({ where: { watchlistId: watch.id }, orderBy: { evaluatedAt: 'asc' } });
    const explicit = await computeWatchlistDigest(watch.id, { now, triggeringEventId: events[100].id });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.result.newestEventTrigger).toBe('backtest');
  });
}
