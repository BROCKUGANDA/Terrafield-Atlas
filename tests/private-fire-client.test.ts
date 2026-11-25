import { expect, spyOn, test } from 'bun:test';
import { api } from '@/lib/api-client';
import { createFetchMock } from './fetch-mock';

test('fire API client scopes selected farms without stale coordinates and preserves public queries', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(createFetchMock(async () => Response.json({})));
  try {
    await api.fires({ farmId: 'owned-farm', from: '2024-01-01', to: '2024-01-02', confidence: 'high' });
    const privateQuery = new URL(String(fetch.mock.calls[0]?.[0]), 'https://console.example.test').searchParams;
    expect(privateQuery.get('farmId')).toBe('owned-farm');
    expect(privateQuery.has('lat')).toBe(false);
    expect(privateQuery.has('lon')).toBe(false);
    expect(privateQuery.get('confidence')).toBe('high');

    fetch.mockClear();
    await api.ingestFires({ farmId: 'owned-farm', from: '2024-01-01', to: '2024-01-02' });
    const privateBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(privateBody).toEqual({ farmId: 'owned-farm', from: '2024-01-01', to: '2024-01-02' });

    fetch.mockClear();
    await api.fires({ lat: 1, lon: 2, from: '2024-01-01', to: '2024-01-02' });
    const publicQuery = new URL(String(fetch.mock.calls[0]?.[0]), 'https://console.example.test').searchParams;
    expect(publicQuery.get('lat')).toBe('1');
    expect(publicQuery.get('lon')).toBe('2');
    expect(publicQuery.has('farmId')).toBe(false);
  } finally {
    fetch.mockRestore();
  }
});