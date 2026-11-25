import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export class RedisUnavailableError extends Error {
  constructor(detail: string) {
    super(`Redis runtime unavailable: ${detail}`);
    this.name = 'RedisUnavailableError';
  }
}

export interface RedisRuntimeOptions {
  url?: string;
  keyPrefix?: string;
  connectTimeout?: number;
  maxRetriesPerRequest?: number;
}

export interface TokenBucketLimit {
  capacity: number;
  refillPerMinute: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
  open: boolean;
  cooldownRemainingMs: number;
}

export interface RedisRuntime {
  getJson<T>(key: string): Promise<T | undefined>;
  getJsonStale<T>(key: string): Promise<{ value: T; staleMs: number } | undefined>;
  setJson<T>(key: string, value: T, options: { ttlMs: number; retentionMs?: number; maxBytes?: number; maxEntries?: number }): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  tokenBucket(key: string, limit: TokenBucketLimit): Promise<TokenBucketResult>;
  singleFlight<T>(key: string, loader: () => Promise<T>, options?: { ttlMs?: number; lockMs?: number }): Promise<T>;
  getCircuit(key: string): Promise<CircuitState>;
  recordCircuitFailure(key: string, options: { threshold: number; cooldownMs: number }): Promise<CircuitState>;
  resetCircuit(key: string): Promise<void>;
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, listener: (message: unknown) => void): Promise<() => Promise<void>>;
  cacheStats(): Promise<{ liveEntries: number; expiredEntries: number; maxEntries: number }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = 'terrafield:runtime:';
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 1_024;
const CIRCUIT_TTL_MS = 24 * 60 * 60 * 1_000;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable JSON encoding with recursively sorted object keys and no delimiter ambiguity. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical keys require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical key value: ${typeof value}`);
}

export function canonicalKey(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function stableHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function unavailable(error: unknown): RedisUnavailableError {
  return new RedisUnavailableError(error instanceof Error ? error.message : String(error));
}

interface StoredJson<T> {
  key: string;
  value: T;
  expiresAt: number;
  createdAt?: number;
}

interface FlightResult<T> extends StoredJson<T> {
  owner: string;
}

const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local tokens = tonumber(state[1])
local lastRefill = tonumber(state[2])
if not tokens then
  tokens = capacity
  lastRefill = now
else
  tokens = math.min(capacity, tokens + (math.max(0, now - lastRefill) / 60000) * refill)
  lastRefill = now
end
local allowed = 0
local retryAfter = 0
if tokens >= 1 then
  tokens = math.max(0, tokens - 1)
  allowed = 1
else
  tokens = math.max(0, tokens)
  retryAfter = math.ceil(((1 - tokens) / refill) * 60)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('EXPIRE', KEYS[1], 3600)
return {allowed, math.floor(tokens), retryAfter}
`;

const CIRCUIT_FAILURE_LUA = `
local raw = redis.call('GET', KEYS[1])
local state = {consecutiveFailures=0, openUntil=0}
if raw then
  local decoded = cjson.decode(raw)
  state.consecutiveFailures = tonumber(decoded.value.consecutiveFailures) or 0
  state.openUntil = tonumber(decoded.value.openUntil) or 0
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
state.consecutiveFailures = state.consecutiveFailures + 1
if state.consecutiveFailures >= tonumber(ARGV[1]) then state.openUntil = now + tonumber(ARGV[2]) end
redis.call('SET', KEYS[1], cjson.encode({key=ARGV[3], value=state, expiresAt=now + tonumber(ARGV[4])}), 'PX', ARGV[4])
return {state.consecutiveFailures, state.openUntil}
`;

const READ_STORED_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, '', -2, 0} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
return {1, raw, redis.call('PTTL', KEYS[1]), now}
`;

const SET_BOUNDED_JSON_LUA = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[3], 'LIMIT', 0, 100)
for _, key in ipairs(expired) do redis.call('DEL', key) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[3])
local size = redis.call('ZCARD', KEYS[2])
local evicted = {}
-- Millisecond scores can tie. Never evict the entry just written; choose from
-- the oldest candidates until the configured bound is satisfied.
for _, key in ipairs(redis.call('ZRANGE', KEYS[2], 0, size - 1)) do
  if #evicted >= size - tonumber(ARGV[5]) then break end
  if key ~= KEYS[1] then
    redis.call('DEL', key)
    evicted[#evicted + 1] = key
  end
end
if #evicted > 0 then redis.call('ZREM', KEYS[2], unpack(evicted)) end
return 1
`;

const ACQUIRE_LOCK_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local prior = redis.call('GET', KEYS[2])
if prior then
  local ok, decoded = pcall(cjson.decode, prior)
  if ok and type(decoded) == 'table' and decoded.key == ARGV[3] and
      tonumber(decoded.createdAt or 0) >= tonumber(ARGV[4]) and tonumber(decoded.expiresAt or 0) > now then
    return {2, prior}
  end
end
local owner = redis.call('GET', KEYS[1])
if owner then return {0, owner} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[3], cjson.encode({key=ARGV[3], owner=ARGV[1]}), 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
return {1, ''}
`;

const RENEW_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
return 0
`;

const PUBLISH_FLIGHT_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('DEL', KEYS[1], KEYS[3])
return 1
`;

const DELETE_PREFIX_LUA = `
local removed = 0
local function matches(raw, refreshFlight)
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' or type(decoded.key) ~= 'string' then return false end
  if string.sub(decoded.key, 1, string.len(ARGV[1])) == ARGV[1] then return true end
  if not refreshFlight or string.sub(decoded.key, 1, 8) ~= 'refresh:' then return false end
  local cacheKey = string.sub(decoded.key, 9)
  return string.sub(cacheKey, 1, string.len(ARGV[1])) == ARGV[1]
end
local function deleteFlight(key, raw)
  if not matches(raw, true) then return end
  local base = key
  if string.sub(key, -5) == ':meta' then base = string.sub(key, 1, -6) end
  if redis.call('EXISTS', base) == 1 then removed = removed + 1 end
  redis.call('DEL', base, base .. ':lock', base .. ':meta')
end
local cursor = '0'
repeat
  local scanned = redis.call('SCAN', cursor, 'MATCH', ARGV[2], 'COUNT', 200)
  cursor = scanned[1]
  for _, key in ipairs(scanned[2]) do
    local raw = redis.call('GET', key)
    if raw and matches(raw) then
      redis.call('DEL', key)
      redis.call('ZREM', KEYS[1], key)
      removed = removed + 1
    end
  end
until cursor == '0'
cursor = '0'
repeat
  local scanned = redis.call('SCAN', cursor, 'MATCH', ARGV[3], 'COUNT', 200)
  cursor = scanned[1]
  for _, key in ipairs(scanned[2]) do
    local raw = redis.call('GET', key)
    if raw then deleteFlight(key, raw) end
  end
until cursor == '0'
return removed
`;

export function createRedisRuntime(options: RedisRuntimeOptions = {}): RedisRuntime {
  const url = options.url ?? process.env.REDIS_URL ?? process.env.TEST_REDIS_URL;
  if (!url) throw new RedisUnavailableError('REDIS_URL is not configured');
  const prefix = options.keyPrefix ?? process.env.REDIS_KEY_PREFIX ?? DEFAULT_PREFIX;
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: options.connectTimeout ?? 2_000,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 1,
    retryStrategy: (times) => Math.min(times * 100, 1_000),
  });
  client.on('error', () => { /* Errors are returned explicitly by each operation. */ });

  const subscribers = new Set<Redis>();
  let connection: Promise<void> | undefined;
  const ensureConnected = () => {
    connection ??= client.connect().then(() => undefined).catch((error) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      if (client.status === 'wait' || client.status === 'connecting') await ensureConnected();
      if (client.status !== 'ready') throw new Error(`connection is ${client.status}`);
      return await operation();
    } catch (error) {
      if (error instanceof RedisUnavailableError) throw error;
      throw unavailable(error);
    }
  };
  const jsonKey = (key: string) => `${prefix}json:${canonicalKey(key)}`;
  const bucketKey = (key: string) => `${prefix}bucket:${canonicalKey(key)}`;
  const circuitKey = (key: string) => `${prefix}circuit:${canonicalKey(key)}`;
  const flightKey = (key: string) => `${prefix}flight:${canonicalKey(key)}`;
  const channelKey = (channel: string) => `${prefix}channel:${canonicalKey(channel)}`;

  const parseStored = <T>(raw: string | null): StoredJson<T> | undefined => {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredJson<T>;
      if (typeof parsed.key !== 'string' || typeof parsed.expiresAt !== 'number') return undefined;
      return parsed;
    } catch { return undefined; }
  };
  const readStored = async <T>(key: string): Promise<{ entry: StoredJson<T>; ttlMs: number; now: number } | undefined> => {
    const [exists, raw, ttlMs, now] = await run(() => client.eval(READ_STORED_LUA, 1, jsonKey(key))) as [number, string, number, number];
    if (exists !== 1) return undefined;
    const parsed = parseStored<T>(raw);
    return parsed?.key === key ? { entry: parsed, ttlMs, now } : undefined;
  };

  const parseFlight = <T>(key: string, raw: string): FlightResult<T> | undefined => {
    try {
      const parsed = JSON.parse(raw) as FlightResult<T>;
      return parsed.key === key && typeof parsed.owner === 'string' &&
        typeof parsed.expiresAt === 'number' && 'value' in parsed ? parsed : undefined;
    } catch { return undefined; }
  };

  const readFlight = async <T>(key: string): Promise<{ entry: FlightResult<T>; ttlMs: number; now: number } | undefined> => {
    const [exists, raw, ttlMs, now] = await run(() => client.eval(READ_STORED_LUA, 1, flightKey(key))) as [number, string, number, number];
    if (exists !== 1) return undefined;
    const parsed = parseFlight<T>(key, raw);
    return parsed ? { entry: parsed, ttlMs, now } : undefined;
  };

  const redisNow = async (): Promise<number> => {
    const [seconds, microseconds] = await run(() => client.time());
    return seconds * 1_000 + Math.floor(microseconds / 1_000);
  };

  const runtime: RedisRuntime = {
    async getJson<T>(key: string) {
      const stored = await readStored<T>(key);
      return stored && stored.entry.expiresAt > stored.now ? stored.entry.value : undefined;
    },

    async getJsonStale<T>(key: string) {
      const stored = await readStored<T>(key);
      if (!stored) return undefined;
      return { value: stored.entry.value, staleMs: Math.max(0, stored.now - stored.entry.expiresAt) };
    },

    async setJson<T>(key: string, value: T, { ttlMs, retentionMs = ttlMs, maxBytes = DEFAULT_MAX_BYTES, maxEntries }: { ttlMs: number; retentionMs?: number; maxBytes?: number; maxEntries?: number }) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS ||
          !Number.isFinite(retentionMs) || retentionMs < ttlMs || retentionMs > MAX_TTL_MS) {
        throw new RangeError(`Redis JSON TTL and retention must be bounded between 1 and ${MAX_TTL_MS} ms`);
      }
      const now = await redisNow();
      const entry: StoredJson<T> = { key, value, expiresAt: now + ttlMs, createdAt: now };
      const serialized = JSON.stringify(entry);
      if (jsonBytes(serialized) > maxBytes) throw new RangeError(`Redis JSON payload exceeds ${maxBytes} bytes`);
      if (maxEntries !== undefined) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
        await run(() => client.eval(SET_BOUNDED_JSON_LUA, 2, jsonKey(key), `${prefix}json-index`,
          serialized, String(Math.ceil(retentionMs)), String(now), String(now + retentionMs), String(maxEntries)));
      } else {
        await run(() => client.set(jsonKey(key), serialized, 'PX', Math.ceil(retentionMs)));
      }
    },

    async deletePrefix(prefixToDelete: string) {
      const escapeGlob = (value: string) => value.replace(/[\\*?\[\]]/g, '\\$&');
      const namespace = escapeGlob(prefix);
      return Number(await run(() => client.eval(
        DELETE_PREFIX_LUA, 1, `${prefix}json-index`, prefixToDelete,
        `${namespace}json:*`, `${namespace}flight:*`,
      )));
    },

    async tokenBucket(key: string, limit) {
      if (!Number.isInteger(limit.capacity) || limit.capacity < 1 || limit.capacity > 10_000 ||
          !Number.isInteger(limit.refillPerMinute) || limit.refillPerMinute < 1 || limit.refillPerMinute > 10_000) {
        throw new RangeError('Token bucket capacity and refill must be integers between 1 and 10000');
      }
      const [allowed, remaining, retryAfterSec] = await run(() => client.eval(
        TOKEN_BUCKET_LUA, 1, bucketKey(key), String(limit.capacity), String(limit.refillPerMinute),
      )) as [number, number, number];
      return { allowed: allowed === 1, remaining, retryAfterSec };
    },

    async singleFlight<T>(key: string, loader: () => Promise<T>, options: { ttlMs?: number; lockMs?: number } = {}) {
      const ttlMs = Math.min(Math.max(options.ttlMs ?? 60_000, 1_000), MAX_TTL_MS);
      const lockMs = Math.min(Math.max(options.lockMs ?? 30_000, 1_000), ttlMs);
      const lockKey = `${flightKey(key)}:lock`;
      const resultKey = flightKey(key);
      const metaKey = `${resultKey}:meta`;
      const owner = `${process.pid}:${crypto.randomUUID()}`;
      const startedAt = await redisNow();
      const deadline = startedAt + lockMs + ttlMs;
      let ownsLock = false;
      try {
        while (await redisNow() < deadline) {
          const prior = await readFlight<T>(key);
          if (prior && prior.entry.expiresAt > prior.now && (prior.entry.createdAt ?? 0) >= startedAt) return prior.entry.value;
          // Returning the observed lock owner from the same atomic script that
          // attempts acquisition ties results to a generation, not wall clocks.
          const [acquired, observed] = await run(() => client.eval(
            ACQUIRE_LOCK_LUA, 3, lockKey, resultKey, metaKey, owner, String(lockMs), key, String(startedAt),
          )) as [number, string];
          if (acquired === 2) {
            const completed = parseFlight<T>(key, observed);
            if (completed) return completed.value;
          }
          if (acquired === 1) {
            ownsLock = true;
            let renewalError: unknown;
            const renewal = setInterval(() => {
              void run(() => client.eval(RENEW_LOCK_LUA, 2, lockKey, metaKey, owner, String(lockMs)))
                .then((renewed) => {
                  if (renewed !== 1) renewalError = new RedisUnavailableError('single-flight lock ownership was lost');
                })
                .catch((error) => { renewalError = error; });
            }, Math.max(50, Math.floor(lockMs / 5)));
            renewal.unref();
            try {
              const value = await loader();
              if (renewalError) throw renewalError;
              const now = await redisNow();
              const result: FlightResult<T> = { key, value, owner, createdAt: now, expiresAt: now + ttlMs };
              const serialized = JSON.stringify(result);
              if (jsonBytes(serialized) > 5 * 1024 * 1024) throw new RangeError('Redis single-flight payload exceeds 5242880 bytes');
              const published = await run(() => client.eval(
                PUBLISH_FLIGHT_LUA, 3, lockKey, resultKey, metaKey, owner, serialized, String(ttlMs),
              ));
              if (published !== 1) throw new RedisUnavailableError('single-flight lock ownership was lost before publication');
              return value;
            } finally {
              clearInterval(renewal);
              if (ownsLock) await run(() => client.eval(RELEASE_LOCK_LUA, 2, lockKey, metaKey, owner));
            }
          }
          const completed = await readFlight<T>(key);
          if (completed && completed.entry.expiresAt > completed.now &&
              ((completed.entry.createdAt ?? 0) >= startedAt || completed.entry.owner === observed)) return completed.entry.value;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new RedisUnavailableError(`single-flight wait timed out for ${key}`);
      } finally {
        if (ownsLock) await run(() => client.eval(RELEASE_LOCK_LUA, 2, lockKey, metaKey, owner)).catch(() => undefined);
      }
    },

    async getCircuit(key: string) {
      const state = parseStored<Omit<CircuitState, 'open' | 'cooldownRemainingMs'>>(await run(() => client.get(circuitKey(key))))?.value;
      const current = state ?? { consecutiveFailures: 0, openUntil: 0 };
      const now = await redisNow();
      return {
        ...current,
        open: current.openUntil > now,
        cooldownRemainingMs: Math.max(0, current.openUntil - now),
      };
    },

    async recordCircuitFailure(key: string, options) {
      if (!Number.isInteger(options.threshold) || options.threshold < 1 ||
          !Number.isFinite(options.cooldownMs) || options.cooldownMs <= 0) {
        throw new RangeError('Circuit threshold and cooldown must be positive');
      }
      const now = await redisNow();
      const [consecutiveFailures, openUntil] = await run(() => client.eval(
        CIRCUIT_FAILURE_LUA, 1, circuitKey(key), String(options.threshold), String(options.cooldownMs),
        key, String(CIRCUIT_TTL_MS),
      )) as [number, number];
      return {
        consecutiveFailures,
        openUntil,
        open: openUntil > now,
        cooldownRemainingMs: Math.max(0, openUntil - now),
      };
    },

    async resetCircuit(key: string) {
      await run(() => client.del(circuitKey(key)));
    },

    async publish(channel: string, message: unknown) {
      const serialized = JSON.stringify(message);
      if (jsonBytes(serialized) > 64 * 1024) throw new RangeError('Redis pub/sub payload exceeds 65536 bytes');
      await run(() => client.publish(channelKey(channel), serialized));
    },

    async subscribe(channel: string, listener: messageListener) {
      const subscriber = client.duplicate();
      subscribers.add(subscriber);
      const subscribedChannel = channelKey(channel);
      subscriber.on('error', () => {});
      try {
        if (subscriber.status === 'wait') await subscriber.connect();
        await run(() => subscriber.subscribe(subscribedChannel));
      } catch (error) {
        subscribers.delete(subscriber);
        await subscriber.quit().catch(() => undefined);
        throw unavailable(error);
      }
      const handler = (receivedChannel: string, raw: string) => {
        if (receivedChannel !== subscribedChannel) return;
        try { listener(JSON.parse(raw)); } catch { listener(raw); }
      };
      subscriber.on('message', handler);
      let active = true;
      return async () => {
        if (!active) return;
        active = false;
        subscriber.off('message', handler);
        await subscriber.unsubscribe(subscribedChannel).catch(() => undefined);
        subscribers.delete(subscriber);
        await subscriber.quit().catch(() => undefined);
      };
    },

    async cacheStats() {
      const keys = await run(() => client.zrange(`${prefix}json-index`, 0, -1));
      const now = await redisNow();
      let liveEntries = 0;
      let expiredEntries = 0;
      for (const key of keys) {
        const entry = parseStored<unknown>(await run(() => client.get(key)));
        const ttlMs = await run(() => client.pttl(key));
        if (!entry || ttlMs <= 0 || entry.expiresAt <= now) expiredEntries++; else liveEntries++;
      }
      return { liveEntries, expiredEntries, maxEntries: 500 };
    },

    async ping() { await run(() => client.ping()); },
    async close() {
      await Promise.allSettled([...subscribers].map((subscriber) => subscriber.quit()));
      subscribers.clear();
      await client.quit().catch(() => client.disconnect());
    },
  };

  return runtime;
}

type messageListener = (message: unknown) => void;

let sharedRuntime: RedisRuntime | undefined;
export function redisRuntime(): RedisRuntime {
  sharedRuntime ??= createRedisRuntime();
  return sharedRuntime;
}
