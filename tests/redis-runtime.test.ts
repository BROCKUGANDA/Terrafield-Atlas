import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import Redis from 'ioredis';
import { canonicalJson, createRedisRuntime, canonicalKey, RedisUnavailableError, type RedisRuntime } from '@/lib/redis';

const url = process.env.TEST_REDIS_URL;
if (!url) throw new Error('TEST_REDIS_URL must point to disposable Redis');

let runtime: RedisRuntime;
let otherReplica: RedisRuntime;
const prefix = `task4:${crypto.randomUUID()}:`;

beforeAll(async () => {
  runtime = createRedisRuntime({ url, keyPrefix: `${prefix}a:` });
  otherReplica = createRedisRuntime({ url, keyPrefix: `${prefix}a:` });
  await Promise.all([runtime.ping(), otherReplica.ping()]);
});

afterAll(async () => {
  await Promise.all([runtime.close(), otherReplica.close()]);
});

describe('canonical keys and bounded JSON', () => {
  test('canonical parameter order is stable and distinct complete inputs do not collide', () => {
    expect(canonicalJson({ a: 1, B: 2, ä: 3 })).toBe('{"B":2,"a":1,"ä":3}');
    const first = canonicalKey({ bbox: { west: 0.1, east: 0.3, south: -0.4, north: -0.1 }, date: '2024-07-25', tiles: [2, 1] });
    const reordered = canonicalKey({ tiles: [2, 1], date: '2024-07-25', bbox: { north: -0.1, south: -0.4, east: 0.3, west: 0.1 } });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    const keys = new Set(Array.from({ length: 2_000 }, (_, i) => canonicalKey({ date: '2024-07-25', bbox: [i / 10, -0.4, 0.3, -0.1] })));
    expect(keys.size).toBe(2_000);
    expect(canonicalKey('ab|c')).not.toBe(canonicalKey('a|bc'));
    expect(canonicalKey({ lat: 1, lon: 2 })).not.toBe(canonicalKey({ lat: 12, lon: 2 }));
  });

  test('JSON round-trips, namespaces replicas, bounds TTL/payload, and deletes only a prefix', async () => {
    await runtime.setJson('cache:one', { value: 1 }, { ttlMs: 5_000 });
    await runtime.setJson('cache:two', { value: 2 }, { ttlMs: 5_000 });
    await runtime.setJson('other:one', { value: 3 }, { ttlMs: 5_000 });
    expect(await runtime.getJson<{ value: number }>('cache:one')).toEqual({ value: 1 });
    const isolated = createRedisRuntime({ url, keyPrefix: `${prefix}isolated:` });
    try { expect(await isolated.getJson<{ value: number }>('cache:one')).toBeUndefined(); } finally { await isolated.close(); }
    await expect(runtime.setJson('cache:huge', 'x'.repeat(1_001), { ttlMs: 5_000 })).rejects.toThrow('payload');
    await expect(runtime.setJson('cache:forever', 1, { ttlMs: 10_000_000_000 })).rejects.toThrow('TTL');
    expect(await runtime.deletePrefix('cache:')).toBe(2);
    expect(await runtime.getJson<{ value: number }>('cache:one')).toBeUndefined();
    expect(await runtime.getJson<{ value: number }>('other:one')).toEqual({ value: 3 });
  });

  test('bounded JSON indexes evict the oldest entry', async () => {
    const bounded = createRedisRuntime({ url, keyPrefix: `${prefix}bounded:` });
    try {
      for (let i = 0; i < 4; i++) await bounded.setJson(`bounded:${i}`, i, { ttlMs: 5_000, maxEntries: 3 });
      expect(await bounded.getJson('bounded:0')).toBeUndefined();
      expect(await bounded.getJson<number>('bounded:3')).toBe(3);
    } finally { await bounded.close(); }
  });

  test('prefix invalidation cannot delete a refresh that follows its atomic snapshot', async () => {
    await runtime.setJson('race:refresh', 'old', { ttlMs: 5_000, maxEntries: 10 });
    const invalidation = runtime.deletePrefix('race:');
    const refresh = runtime.setJson('race:refresh', 'fresh', { ttlMs: 5_000, maxEntries: 10 });
    await Promise.all([invalidation, refresh]);
    expect(await runtime.getJson<string>('race:refresh')).toBe('fresh');
  });

  test('expired JSON is removed and unavailable Redis is explicit', async () => {
    await runtime.setJson('cache:expired', true, { ttlMs: 30 });
    await Bun.sleep(60);
    expect(await runtime.getJson('cache:expired')).toBeUndefined();
    const unavailable = createRedisRuntime({ url: 'redis://127.0.0.1:1', connectTimeout: 50, maxRetriesPerRequest: 1 });
    try {
      await expect(unavailable.getJson('cache:x')).rejects.toBeInstanceOf(RedisUnavailableError);
    } finally { await unavailable.close(); }
  });

  test('freshness, stale age, and index timestamps follow Redis time despite application clock skew', async () => {
    const bounded = createRedisRuntime({ url, keyPrefix: `${prefix}clock:` });
    const client = new Redis(url);
    const clock = spyOn(Date, 'now').mockReturnValue(0);
    try {
      await bounded.setJson('cache:clock', { value: 1 }, { ttlMs: 30, retentionMs: 5_000, maxEntries: 2 });
      const [seconds, microseconds] = await client.time();
      const redisTime = seconds * 1_000 + Math.floor(microseconds / 1_000);
      const score = await client.zscore(`${prefix}clock:json-index`, `${prefix}clock:json:${canonicalKey('cache:clock')}`);
      expect(Math.abs(Number(score) - redisTime)).toBeLessThan(5_000);
      await Bun.sleep(60);
      expect(await bounded.getJson('cache:clock')).toBeUndefined();
      expect((await bounded.getJsonStale<{ value: number }>('cache:clock'))?.staleMs).toBeGreaterThanOrEqual(1);
      expect((await bounded.cacheStats()).expiredEntries).toBe(1);
    } finally {
      clock.mockRestore();
      await Promise.all([bounded.close(), client.quit()]);
    }
  });
});

describe('shared token buckets', () => {
  test('capacity is shared across replicas and throttled keys return retryAfterSec', async () => {
    const key = 'bucket:shared';
    const limit = { capacity: 2, refillPerMinute: 2 };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? runtime : otherReplica).tokenBucket(key, limit)));
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    const throttled = results.find((r) => !r.allowed)!;
    expect(throttled.remaining).toBe(0);
    expect(throttled.retryAfterSec).toBeGreaterThan(0);
    expect(throttled.retryAfterSec).toBeLessThanOrEqual(30);
  });

  test('clock rollback cannot create negative tokens or retry budgets', async () => {
    const key = 'bucket:clock-rollback';
    const client = new Redis(url);
    try {
      await client.hset(`${prefix}a:bucket:${canonicalKey(key)}`, 'tokens', 0, 'lastRefill', Date.now() + 60_000);
      const result = await runtime.tokenBucket(key, { capacity: 2, refillPerMinute: 2 });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSec).toBeGreaterThan(0);
    } finally { await client.quit(); }
  });

  test('idle bucket state is evicted by Redis TTL', async () => {
    const key = 'bucket:expired';
    await runtime.tokenBucket(key, { capacity: 1, refillPerMinute: 1 });
    const client = new Redis(url);
    try {
      const ttl = await client.ttl(`${prefix}a:bucket:${canonicalKey(key)}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3_600);
    } finally { await client.quit(); }
  });
});

describe('distributed single-flight', () => {
  test('20 calls across two replicas execute one loader', async () => {
    let loads = 0;
    const calls = Array.from({ length: 20 }, (_, i) => (i % 2 ? runtime : otherReplica).singleFlight('flight:source-refresh', async () => {
      loads++;
      await Bun.sleep(80);
      return { checkedAt: 'now', signs: ['live'] };
    }, { ttlMs: 5_000, lockMs: 2_000 }));
    const results = await Promise.all(calls);
    expect(loads).toBe(1);
    expect(results.every((r) => r?.checkedAt === 'now')).toBe(true);
  });

  test('a loader that outlives its initial lease keeps exclusive ownership', async () => {
    let loads = 0;
    const calls = [runtime, otherReplica].map((replica) => replica.singleFlight('flight:long-loader', async () => {
      loads++;
      await Bun.sleep(2_200);
      return 'long-result';
    }, { ttlMs: 5_000, lockMs: 1_000 }));
    expect(await Promise.all(calls)).toEqual(['long-result', 'long-result']);
    expect(loads).toBe(1);
  });

  test('sequential flights refresh instead of replaying an earlier result', async () => {
    let loads = 0;
    const first = await runtime.singleFlight('flight:sequential', async () => ++loads, { ttlMs: 5_000 });
    await Bun.sleep(10);
    const second = await otherReplica.singleFlight('flight:sequential', async () => ++loads, { ttlMs: 5_000 });
    expect([first, second]).toEqual([1, 2]);
  });

  test('a crashed lock owner expires and a waiter can take over', async () => {
    let loads = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = runtime.singleFlight('flight:takeover', async () => { loads++; await blocked; throw new Error('owner failed'); }, { lockMs: 100, ttlMs: 1_000 });
    await Bun.sleep(20);
    const second = otherReplica.singleFlight('flight:takeover', async () => { loads++; return 'recovered'; }, { lockMs: 100, ttlMs: 1_000 });
    release();
    await expect(first).rejects.toThrow('owner failed');
    expect(await second).toBe('recovered');
    expect(loads).toBe(2);
  });

  test('a paused old owner cannot publish after takeover and resume', async () => {
    const client = new Redis(url);
    let loads = 0;
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let announceNew!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newBlocked = new Promise<void>((resolve) => { releaseNew = resolve; });
    const newStarted = new Promise<void>((resolve) => { announceNew = resolve; });
    const key = 'flight:paused-owner';
    const lockKey = `${prefix}a:flight:${canonicalKey(key)}:lock`;
    const resultKey = `${prefix}a:flight:${canonicalKey(key)}`;
    try {
      const oldOutcome = runtime.singleFlight(key, async () => { loads++; await oldBlocked; return 'stale'; }, { lockMs: 1_000, ttlMs: 5_000 }).catch((error) => error);
      for (let attempt = 0; attempt < 100 && !await client.get(lockKey); attempt++) await Bun.sleep(5);
      expect(await client.get(lockKey)).not.toBeNull();
      const second = otherReplica.singleFlight(key, async () => {
        loads++;
        announceNew();
        await newBlocked;
        return 'recovered';
      }, { lockMs: 1_000, ttlMs: 5_000 });
      await client.set(lockKey, 'takeover-owner', 'PX', 100);
      releaseOld();
      expect(await oldOutcome).toBeInstanceOf(RedisUnavailableError);
      await newStarted;
      expect(await client.get(resultKey)).toBeNull();
      releaseNew();
      expect(await second).toBe('recovered');
      expect(loads).toBe(2);
    } finally {
      releaseOld();
      releaseNew();
      await client.quit();
    }
  });

  test('cache-prefix invalidation removes adapter-style completed and active refresh flights', async () => {
    const cachePrefix = 'GIBS:fires:';
    const cacheKey = `${cachePrefix}v3:adapter-style`;
    const refreshKey = `refresh:${cacheKey}`;
    let loads = 0;
    await runtime.setJson(cacheKey, { cached: true }, { ttlMs: 5_000, maxEntries: 10 });
    expect(await runtime.singleFlight(refreshKey, async () => ++loads, { ttlMs: 5_000 })).toBe(1);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = runtime.singleFlight(`refresh:${cachePrefix}v3:active`, async () => {
      loads++;
      await blocked;
      return 'stale';
    }, { lockMs: 1_000, ttlMs: 5_000 }).catch((error) => error);
    const client = new Redis(url);
    const lockKey = `${prefix}a:flight:${canonicalKey(`refresh:${cachePrefix}v3:active`)}:lock`;
    try {
      for (let attempt = 0; attempt < 100 && !await client.get(lockKey); attempt++) await Bun.sleep(5);
      expect(await client.get(lockKey)).not.toBeNull();
      expect(await runtime.deletePrefix(cachePrefix)).toBe(2);
    } finally {
      release();
      await client.quit();
    }

    expect(await runtime.getJson(cacheKey)).toBeUndefined();
    expect(await otherReplica.singleFlight(refreshKey, async () => ++loads, { ttlMs: 5_000 })).toBe(3);
    expect(await active).toBeInstanceOf(RedisUnavailableError);
    expect(await otherReplica.singleFlight(`refresh:${cachePrefix}v3:active`, async () => ++loads, { ttlMs: 5_000 })).toBe(4);
  });

  test('prefix invalidation removes completed and active single-flight results', async () => {
    let loads = 0;
    expect(await runtime.singleFlight('flight:invalidate-complete', async () => ++loads, { ttlMs: 5_000 })).toBe(1);
    expect(await runtime.deletePrefix('flight:invalidate-complete')).toBe(1);
    expect(await otherReplica.singleFlight('flight:invalidate-complete', async () => ++loads, { ttlMs: 5_000 })).toBe(2);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = runtime.singleFlight('flight:invalidate-active', async () => { loads++; await blocked; return 'stale'; }, { lockMs: 1_000, ttlMs: 5_000 }).catch((error) => error);
    const client = new Redis(url);
    try {
      const lockKey = `${prefix}a:flight:${canonicalKey('flight:invalidate-active')}:lock`;
      for (let attempt = 0; attempt < 100 && !await client.get(lockKey); attempt++) await Bun.sleep(5);
      expect(await client.get(lockKey)).not.toBeNull();
      await runtime.deletePrefix('flight:invalidate-active');
    } finally {
      release();
      await client.quit();
    }
    expect(await active).toBeInstanceOf(RedisUnavailableError);
    expect(await otherReplica.singleFlight('flight:invalidate-active', async () => ++loads, { ttlMs: 5_000 })).toBe(4);
  });
});

describe('shared circuits and pub/sub', () => {
  test('circuit failures and cooldown are shared by replicas', async () => {
    const key = 'circuit:provider';
    for (let i = 0; i < 4; i++) await (i % 2 ? runtime : otherReplica).recordCircuitFailure(key, { threshold: 4, cooldownMs: 60_000 });
    expect((await runtime.getCircuit(key)).open).toBe(true);
    expect((await otherReplica.getCircuit(key)).consecutiveFailures).toBe(4);
    await runtime.resetCircuit(key);
    expect((await otherReplica.getCircuit(key)).open).toBe(false);
  });

  test('published messages cross runtime namespaces and unsubscribe works', async () => {
    const messages: unknown[] = [];
    const unsubscribe = await otherReplica.subscribe('events', (message) => messages.push(message));
    await Bun.sleep(30);
    await runtime.publish('events', { type: 'refresh' });
    await Bun.sleep(80);
    unsubscribe();
    await runtime.publish('events', { type: 'ignored' });
    await Bun.sleep(50);
    expect(messages).toEqual([{ type: 'refresh' }]);
  });
});
