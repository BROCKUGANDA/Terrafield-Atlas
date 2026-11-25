import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { withPrivateProvider } from '@/lib/ingest/provider-context';
import { cacheGet, cacheGetStale, cacheInvalidate, cacheSet } from '@/lib/cache';
import { db } from '@/lib/db';
import { resilientFetch } from '@/lib/http';
import { fetchSoilGridsPoint } from '@/lib/adapters/soilgrids';
import * as auth from '@/lib/auth';
import { NextRequest } from 'next/server';
import { POST as trends } from '@/app/api/v1/analysis/trends/route';
import { ingestPowerForLocation, rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import { createFetchMock } from './fetch-mock';

const originalFetch = globalThis.fetch;
afterEach(async () => { globalThis.fetch = originalFetch; await cacheInvalidate('private-provider-test:'); });

test('coordinate-only trend jobs cannot read signed-in users private observations into public analyses', async () => {
  const previousUrl = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = 'https://example.test';
  const user = spyOn(auth, 'accountUserId').mockResolvedValue('private-user');
  const originalRows = db.environmentalObservation.findMany;
  const rows = mock(async (_args: unknown) => []);
  db.environmentalObservation.findMany = rows as typeof originalRows;
  try {
    const response = await trends(new NextRequest('https://example.test/api/v1/analysis/trends', {
      method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 1, lon: 2 }),
    }), { params: Promise.resolve({}) });
    expect(response.status).toBe(409);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows.mock.calls[0])).not.toContain('private-user');
    expect(rows.mock.calls[0][0]).toMatchObject({ where: { ownerId: null } });
  } finally {
    user.mockRestore(); db.environmentalObservation.findMany = originalRows;
    if (previousUrl === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previousUrl;
  }
});

test('private cache access is bypassed across await without affecting concurrent public requests', async () => {
  const key = 'private-provider-test:shared';
  await cacheSet(key, 'public', 60_000);
  await Promise.all([
    withPrivateProvider(async () => {
      await Promise.resolve();
      expect(await cacheGet(key)).toBeUndefined();
      expect(await cacheGetStale(key)).toBeUndefined();
      await cacheSet(key, 'private coordinates', 60_000);
    }),
    Promise.resolve().then(async () => expect(await cacheGet<string>(key)).toBe('public')),
  ]);
  expect(await cacheGet<string>(key)).toBe('public');
  await expect(withPrivateProvider(async () => { throw new Error('test'); })).rejects.toThrow('test');
  expect(await cacheGet<string>(key)).toBe('public');
});

test('private SoilGrids requests neither populate public cache nor persist provider logs', async () => {
  const originalLog = db.apiRequestLog.create;
  const log = mock(async () => ({} as never));
  db.apiRequestLog.create = log as unknown as typeof originalLog;
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => {
    calls++;
    return Response.json({ properties: { layers: [{ name: 'sand', unit_measure: { d_factor: 10 }, depths: [{ values: { mean: 250 } }] }] } });
  });
  try {
    await withPrivateProvider(() => fetchSoilGridsPoint(12.34567, 45.67891));
    expect(log).not.toHaveBeenCalled();
    await fetchSoilGridsPoint(12.34567, 45.67891);
    expect(calls).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { db.apiRequestLog.create = originalLog; await cacheInvalidate('SOILGRIDS:point:'); }
});

test('private failed provider attempts do not persist URLs or raw network errors', async () => {
  const originalLog = db.apiRequestLog.create;
  const log = mock(async () => ({} as never));
  db.apiRequestLog.create = log as unknown as typeof originalLog;
  globalThis.fetch = createFetchMock(async () => { throw new Error('secret coordinates in URL'); });
  try {
    await expect(withPrivateProvider(() => resilientFetch('https://example.test/?lat=12.34567', { provider: 'EONET', operation: 'private-test', maxAttempts: 1 }))).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  } finally { db.apiRequestLog.create = originalLog; }
});

test('organization-attributed private provider calls log provenance metadata without coordinates', async () => {
  const originalLog = db.apiRequestLog.create;
  const rows: unknown[] = [];
  const log = mock(async (args: { data: Record<string, unknown> }) => { rows.push(args.data); return {} as never; });
  db.apiRequestLog.create = log as unknown as typeof originalLog;
  globalThis.fetch = createFetchMock(async () => Response.json({ ok: true }));
  try {
    await withPrivateProvider(async () => {
      await resilientFetch('https://example.test/point?lat=12.34567&lon=45.67891', { provider: 'NASA_POWER', operation: 'private-org-test', maxAttempts: 1 });
    }, 'org-private-test');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: 'org-private-test',
      provider: 'NASA_POWER',
      requestUrl: '[private]',
      paramsHash: null,
      ok: true,
    });
    expect(JSON.stringify(rows[0])).not.toContain('12.34567');
    expect(JSON.stringify(rows[0])).not.toContain('45.67891');
  } finally { db.apiRequestLog.create = originalLog; }
});

test('POWER ingestion rejects a missing farm before any provider or storage access', async () => {
  const originalFarm = db.farm.findUnique;
  db.farm.findUnique = mock(async () => null) as unknown as typeof originalFarm;
  const originalCreate = db.environmentalObservation.createMany;
  const writes = mock(async () => ({ count: 0 }));
  db.environmentalObservation.createMany = writes as typeof originalCreate;
  const network = mock(async () => new Response(null));
  globalThis.fetch = createFetchMock(network);
  try {
    await expect(ingestPowerForLocation(1, 2, 2, ['T2M'], 'private-farm')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(network).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  } finally { db.farm.findUnique = originalFarm; db.environmentalObservation.createMany = originalCreate; }
});

test('shared rotation climatology queries exclude private observations', async () => {
  const originalRows = db.environmentalObservation.findMany;
  const rows = mock(async (_args: unknown) => []);
  db.environmentalObservation.findMany = rows as typeof originalRows;
  try {
    expect(await rainfallMonthlyStats(1, 2)).toBeNull();
    expect(await thermalMonthlyStats(1, 2)).toBeNull();
    expect(rows).toHaveBeenCalledTimes(2);
    for (const [args] of rows.mock.calls) expect(args).toMatchObject({ where: { ownerId: null } });
    await rainfallMonthlyStats(1, 2, 'private-farm');
    await thermalMonthlyStats(1, 2, 'private-farm');
    for (const [args] of rows.mock.calls.slice(2)) expect(args).toMatchObject({ where: { farmId: 'private-farm' } });
  } finally { db.environmentalObservation.findMany = originalRows; }
});