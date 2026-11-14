/**
 * TTL memory cache with size bound and explicit invalidation.
 * Rationale (documented deviation): the deployment sandbox runs a single
 * Node/Bun process with SQLite; a Redis instance would add infrastructure
 * that solves no actual requirement at this scale. The cache interface
 * mirrors what a Redis-backed store would expose so the storage backend can
 * be swapped without touching call sites.
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

const MAX_ENTRIES = 500;
const store = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  // refresh LRU position
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

export interface StaleResult<T> {
  value: T;
  /** How far past the TTL the entry is (0 when still fresh). */
  staleMs: number;
}

/**
 * Stale-while-revalidate read: returns the cached value EVEN IF EXPIRED so a
 * provider outage can degrade to "serving the last good snapshot, labeled
 * stale" instead of a hard failure. Fresh entries report staleMs=0.
 */
export function cacheGetStale<T>(key: string): StaleResult<T> | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  const now = Date.now();
  // keep expired entries addressable: refresh LRU but do NOT delete
  store.delete(key);
  store.set(key, entry);
  return { value: entry.value, staleMs: Math.max(0, now - entry.expiresAt) };
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheInvalidate(prefix: string): number {
  let removed = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

export function cacheStats() {
  let expired = 0;
  const now = Date.now();
  for (const entry of store.values()) {
    if (entry.expiresAt < now) expired++;
  }
  return { liveEntries: store.size - expired, expiredEntries: expired, maxEntries: MAX_ENTRIES };
}

export function stableHash(input: string): string {
  // FNV-1a 32-bit — deterministic, no dependency
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
