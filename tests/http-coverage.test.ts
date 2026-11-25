import { expect, test } from 'bun:test';
import { redactProviderUrl, resilientFetch } from '@/lib/http';
import { createFetchMock } from './fetch-mock';

test('provenance redacts path and query credentials before persistence', () => {
  const raw = 'https://user:password@firms.modaps.eosdis.nasa.gov/api/area/csv/private-key/VIIRS_SNPP_NRT/0,0,1,1/1?api_key=another-secret&date=2026-11-19';
  const logged = redactProviderUrl(raw);
  for (const secret of ['user', 'password', 'private-key', 'another-secret']) expect(logged).not.toContain(secret);
  expect(logged).toContain('/api/area/csv/REDACTED/');
  expect(logged).toContain('date=2026-11-19');
});

test('archive gaps cannot open the provider-wide circuit and hide available tiles', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = createFetchMock(async () => {
    requests++;
    return new Response(null, { status: requests <= 10 ? 404 : 200 });
  });
  try {
    for (let index = 0; index < 10; index++) {
      const gap = await resilientFetch(`https://example.test/gap/${index}`, { provider: 'GIBS', operation: 'coverage-test', maxAttempts: 1 });
      expect(gap.status).toBe(404);
      expect(gap.ok).toBe(false);
    }
    const available = await resilientFetch('https://example.test/available', { provider: 'GIBS', operation: 'coverage-test', maxAttempts: 1 });
    expect(available.ok).toBe(true);
    expect(requests).toBe(11);
  } finally { globalThis.fetch = original; }
});