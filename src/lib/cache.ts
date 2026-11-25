import { isPrivateProvider } from '@/lib/ingest/provider-context';
import { canonicalKey, redisRuntime, stableHash } from '@/lib/redis';

export { canonicalKey, stableHash };

/**
 * Server-only Redis cache adapter. Public callers use async methods; there is
 * deliberately no process-local production fallback. Private-provider work is
 * bypassed before any shared cache operation so coordinates cannot leak.
 */
const MAX_CACHE_BYTES = 5 * 1024 * 1024;
const STALE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 500;

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (isPrivateProvider()) return undefined;
  return redisRuntime().getJson<T>(key);
}

export interface StaleResult<T> {
  value: T;
  staleMs: number;
}

export async function cacheGetStale<T>(key: string): Promise<StaleResult<T> | undefined> {
  if (isPrivateProvider()) return undefined;
  return redisRuntime().getJsonStale<T>(key);
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  if (isPrivateProvider()) return;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('Cache TTL must be positive');
  const freshTtl = Math.min(ttlMs, 7 * 24 * 60 * 60 * 1_000 - STALE_RETENTION_MS);
  await redisRuntime().setJson(key, value, {
    ttlMs: freshTtl,
    retentionMs: freshTtl + STALE_RETENTION_MS,
    maxBytes: MAX_CACHE_BYTES,
    maxEntries: MAX_ENTRIES,
  });
}

export async function cacheInvalidate(prefix: string): Promise<number> {
  if (isPrivateProvider()) return 0;
  return redisRuntime().deletePrefix(prefix);
}

export async function cacheStats() {
  return redisRuntime().cacheStats();
}
