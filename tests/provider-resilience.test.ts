import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { db } from '@/lib/db';
import { cacheGet, cacheGetStale, cacheInvalidate, cacheSet, canonicalKey } from '@/lib/cache';
import { resilientFetch } from '@/lib/http';
import { fetchFiresForDate, type FireTileResult } from '@/lib/adapters/gibsFires';
import { fetchSoilGridsPoint } from '@/lib/adapters/soilgrids';
import { sourceSigns } from '@/lib/source-health';
import { createFetchMock } from './fetch-mock';

const originalFetch = globalThis.fetch;
const bbox = { west: 0.1, south: -0.4, east: 0.3, north: -0.1 };
const date = '2024-07-25';
const key = `GIBS:fires:v3:${canonicalKey({ date, bbox })}`;
const originalCreate = db.apiRequestLog.create;

beforeEach(async () => {
  await cacheInvalidate('GIBS:fires:');
  await cacheInvalidate('SOILGRIDS:point:');
  db.apiRequestLog.create = mock(async () => ({} as never)) as unknown as typeof originalCreate;
});

afterEach(async () => {
  // Successful requests reset the real HTTP client's provider circuit state.
  globalThis.fetch = createFetchMock(async () => new Response(null));
  for (const provider of ['GIBS', 'SOILGRIDS'] as const) {
    await resilientFetch('https://example.test/reset', { provider, operation: 'test-reset', maxAttempts: 1 });
  }
  globalThis.fetch = originalFetch;
  db.apiRequestLog.create = originalCreate;
  await cacheInvalidate('GIBS:fires:');
  await cacheInvalidate('SOILGRIDS:point:');
});

test('cache-prefix invalidation refreshes a real adapter flight instead of replaying it', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(new Uint8Array()); });
  expect((await fetchFiresForDate(date, bbox)).dataAvailable).toBe(true);
  expect((await fetchFiresForDate(date, bbox)).dataAvailable).toBe(true);
  expect(calls).toBe(1);

  expect(await cacheInvalidate('GIBS:fires:')).toBe(2);
  expect((await fetchFiresForDate(date, bbox)).dataAvailable).toBe(true);
  expect(calls).toBe(2);
});

test('a 404 is missing fire data, is not retried, and is not zero-fire evidence', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(null, { status: 404 }); });
  const result = await fetchFiresForDate(date, bbox);
  expect(calls).toBe(1);
  expect(result.dataAvailable).toBe(false);
  expect(result.detections).toEqual([]);
});

test('an exhausted fire request rejects after two attempts instead of becoming an archive gap', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; throw new TypeError('network down'); });
  await expect(fetchFiresForDate(date, bbox)).rejects.toThrow();
  expect(calls).toBe(2);
  expect(await cacheGet(key)).toBeUndefined();
});

test('a forbidden fire request is not an archive gap and is not retried', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(null, { status: 403 }); });
  await expect(fetchFiresForDate(date, bbox)).rejects.toThrow();
  expect(calls).toBe(1);
});

test('an undecodable fire tile is not cached as available zero detections', async () => {
  globalThis.fetch = createFetchMock(async () => new Response(new Uint8Array([0xff])));
  const quiet = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(fetchFiresForDate(date, bbox)).rejects.toThrow();
    expect(await cacheGet(key)).toBeUndefined();
  } finally { quiet.mockRestore(); }
});

test('a valid empty MVT is available data with zero detections', async () => {
  globalThis.fetch = createFetchMock(async () => new Response(new Uint8Array()));
  const result = await fetchFiresForDate(date, bbox);
  expect(result.dataAvailable).toBe(true);
  expect(result.detections).toEqual([]);
});

test('one missing tile does not establish complete zero-fire coverage', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => ++calls === 1
    ? new Response(new Uint8Array()) : new Response(null, { status: 404 }));
  const result = await fetchFiresForDate(date, { ...bbox, west: -0.2 });
  expect(result.tiles).toBe(2);
  expect(result.dataAvailable).toBe(false);
});

test('a partial tile outage cannot be cached as complete coverage', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => {
    if (++calls === 1) return new Response(new Uint8Array());
    throw new TypeError('network down');
  });
  await expect(fetchFiresForDate(date, { ...bbox, west: -0.2 })).rejects.toThrow();
  expect(calls).toBe(3);
});

test('a real expired snapshot survives the cache miss and is labeled stale on outage', async () => {
  const snapshot: FireTileResult = { date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: true };
  await cacheSet(key, snapshot, 1);
  await Bun.sleep(10);
  globalThis.fetch = createFetchMock(async () => { throw new TypeError('network down'); });
  const result = await fetchFiresForDate(date, bbox);
  expect(result.stale).toBe(true);
  expect(result.staleMs).toBeGreaterThanOrEqual(1);
  expect(result.dataAvailable).toBe(true);
  expect((await cacheGetStale<FireTileResult>(key))?.staleMs).toBeGreaterThanOrEqual(1);
  expect((await fetchFiresForDate(date, bbox)).stale).toBe(true);
});

test('a 404 stays missing data rather than silently substituting an expired snapshot', async () => {
  await cacheSet<FireTileResult>(key, { date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: true }, 1);
  await Bun.sleep(10);
  globalThis.fetch = createFetchMock(async () => new Response(null, { status: 404 }));
  const result = await fetchFiresForDate(date, bbox);
  expect(result.dataAvailable).toBe(false);
  expect(result.stale).toBeUndefined();
});

test('SoilGrids does not parse a failed HTTP response as a successful profile', async () => {
  globalThis.fetch = createFetchMock(async () => Response.json({ properties: { layers: [{
    name: 'sand', unit_measure: { d_factor: 10 }, depths: [{ label: '0-5cm', values: { mean: 0 } }],
  }] } }, { status: 403 }));
  await expect(fetchSoilGridsPoint(-2.123, 34.123)).rejects.toThrow();
});

test('SoilGrids rejects provider coordinates that do not match the requested point', async () => {
  globalThis.fetch = createFetchMock(async () => Response.json({ coordinates: { lat: 10, lon: 20 }, properties: { layers: [{
    name: 'sand', unit_measure: { d_factor: 10 }, depths: [{ label: '0-5cm', values: { mean: 250 } }],
  }] } }));
  await expect(fetchSoilGridsPoint(-2.123, 34.123)).rejects.toThrow('coordinates do not match');
});

test('SoilGrids retries a transient HTTP failure once and preserves real zero', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => ++calls === 1 ? new Response(null, { status: 503 }) : Response.json({ properties: { layers: [
    { name: 'sand', unit_measure: { d_factor: 10 }, depths: [{ label: '0-5cm', values: { mean: 0 } }] },
    { name: 'clay', unit_measure: { d_factor: 10 }, depths: [{ label: '0-5cm', values: { mean: null } }] },
  ] } }));
  const result = await fetchSoilGridsPoint(-2.123, 34.123);
  expect(calls).toBe(2);
  expect(result.properties.map((p) => [p.property, p.value])).toEqual([['sand', 0]]);
});

test('SoilGrids exhausted timeouts stop after two attempts without a fabricated profile', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async (_input, init) => {
    calls++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    throw new DOMException('request timed out', 'AbortError');
  });
  await expect(fetchSoilGridsPoint(-2.123, 34.123)).rejects.toThrow('after 2 attempts');
  expect(calls).toBe(2);
});

test('health probes treat a sparse fire tile as reachable without claiming detections', async () => {
  const host = globalThis as typeof globalThis & { __terraSourceProbeMem?: Map<string, unknown> };
  host.__terraSourceProbeMem?.clear();
  const { redisRuntime } = await import('@/lib/redis');
  await redisRuntime().setJson('source-probe:SOILGRIDS', { lastLiveAt: 0, lastDetail: 'test reset' }, { ttlMs: 1_000 });
  const originalUpdate = db.dataSource.updateMany;
  db.dataSource.updateMany = mock(async () => ({ count: 0 })) as typeof originalUpdate;
  const urls: string[] = [];
  globalThis.fetch = createFetchMock(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('rest.isric.org')) throw new DOMException('request timed out', 'AbortError');
    return new Response(null, { status: url.endsWith('.mvt') ? 404 : 200 });
  });
  try {
    const report = await sourceSigns(true);
    expect(urls.length).toBe(6);
    const fireStream = report.signs.find((s) => s.key === 'FIRMS_STREAM');
    expect(fireStream?.state).toBe('live');
    expect(fireStream?.detail).toContain('no data established for this sampled tile');
    const soil = report.signs.find((s) => s.key === 'SOILGRIDS');
    expect(soil?.state).toBe('unreachable');
    expect(soil?.detail).toContain('timeout');
  } finally {
    db.dataSource.updateMany = originalUpdate;
    host.__terraSourceProbeMem?.clear();
  }
});