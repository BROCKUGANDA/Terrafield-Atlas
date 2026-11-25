import { afterEach, expect, spyOn, test } from 'bun:test';
import { db } from '@/lib/db';
import { sourceSigns } from '@/lib/source-health';
import { createFetchMock } from './fetch-mock';

const originalFetch = globalThis.fetch;
const host = globalThis as typeof globalThis & { __terraSourceProbeMem?: Map<string, unknown> };
afterEach(() => { globalThis.fetch = originalFetch; host.__terraSourceProbeMem?.clear(); });

test('only a sparse FIRMS 404 proves host reachability; other HTTP errors stay degraded', async () => {
  const write = spyOn(db.dataSource, 'updateMany').mockResolvedValue({ count: 0 });
  try {
    for (const status of [404, 429, 500]) {
      globalThis.fetch = createFetchMock(async () => new Response(null, { status }));
      const report = await sourceSigns(true);
      const fireStream = report.signs.find((sign) => sign.key === 'FIRMS_STREAM');
      if (status === 404) {
        expect(report.summary.live).toBe(1);
        expect(fireStream?.state).toBe('live');
        expect(fireStream?.detail).toContain('no data established for this sampled tile/date');
        expect(report.signs.filter((sign) => sign.key !== 'FIRMS_STREAM').every((sign) => sign.state !== 'live')).toBe(true);
      } else {
        expect(report.summary.live).toBe(0);
        expect(report.signs.every((sign) => sign.state !== 'live')).toBe(true);
      }
    }
  } finally { write.mockRestore(); }
});

test('20 concurrent source refreshes across calls execute only six probes', async () => {
  const write = spyOn(db.dataSource, 'updateMany').mockResolvedValue({ count: 0 });
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; await Bun.sleep(30); return new Response('{}', { status: 200 }); });
  try {
    const reports = await Promise.all(Array.from({ length: 20 }, () => sourceSigns(true)));
    expect(calls).toBe(6);
    expect(reports.every((report) => report.summary.live === 6)).toBe(true);
  } finally { write.mockRestore(); }
});

test('successful endpoint responses report live and POWER uses a real daily query', async () => {
  const urls: string[] = [];
  const write = spyOn(db.dataSource, 'updateMany').mockResolvedValue({ count: 0 });
  globalThis.fetch = createFetchMock(async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response('{}', { status: 200 });
  });
  try {
    expect((await sourceSigns(true)).summary.live).toBe(6);
    expect(urls.some((url) => url.includes('/api/temporal/daily/point?'))).toBe(true);
    expect(urls.some((url) => url.includes('/stop'))).toBe(false);
  } finally { write.mockRestore(); }
});