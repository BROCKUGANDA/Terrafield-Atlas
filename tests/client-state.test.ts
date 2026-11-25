import { afterEach, describe, expect, test } from 'bun:test';
import { api, ApiRequestError, request } from '@/lib/api-client';
import { isRequestContextCurrent, requestContextKey, type RequestContext } from '@/lib/request-context';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function rejectingFetch(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('expected request to fail');
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error;
    return error.code;
  }
}

describe('client transport', () => {
  test('caller cancellation wins over timeout and is not retried', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return rejectingFetch(init!.signal!);
    }, { preconnect: originalFetch.preconnect });
    const pending = request('/api/v1/health', { signal: controller.signal }, { timeoutMs: 1_000 });
    controller.abort();
    expect(await errorCode(pending)).toBe('ABORTED');
    expect(calls).toBe(1);
  });

  test('timeout aborts a hung request with a typed error', async () => {
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) =>
      rejectingFetch(init!.signal!), { preconnect: originalFetch.preconnect });
    expect(await errorCode(request('/api/v1/health', {}, { timeoutMs: 10 }))).toBe('TIMEOUT');
  });

  test('malformed 200 JSON rejects instead of becoming null data', async () => {
    globalThis.fetch = Object.assign(async () => new Response('{not-json', { status: 200 }), { preconnect: originalFetch.preconnect });
    expect(await errorCode(request('/api/v1/health'))).toBe('BAD_PAYLOAD');
  });

  test('GET retry is bounded and honors Retry-After', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      if (calls == 1) return new Response(JSON.stringify({ error: { code: 'RATE_LIMIT', message: 'slow down' } }), {
        status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' },
      });
      return Response.json({ status: 'ok' });
    }, { preconnect: originalFetch.preconnect });
    expect(await request<{ status: string }>('/api/v1/health')).toEqual({ status: 'ok' });
    expect(calls).toBe(2);

    calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      return new Response('upstream down', { status: 503 });
    }, { preconnect: originalFetch.preconnect });
    expect(await errorCode(request('/api/v1/health'))).toBe('HTTP_503');
    expect(calls).toBe(2);
  });

  test('mutations never auto-retry and always carry an idempotency key', async () => {
    let calls = 0;
    let key: string | null = null;
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      key = new Headers(init?.headers).get('idempotency-key');
      return new Response('server error', { status: 500 });
    }, { preconnect: originalFetch.preconnect });
    expect(await errorCode(api.createFarm({ name: 'test', centroidLat: 1, centroidLon: 2 }))).toBe('HTTP_500');
    expect(calls).toBe(1);
    expect(key).toEqual(expect.any(String));
  });

  test('free-location observation queries always include coordinates', async () => {
    let url = '';
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      url = String(input);
      return Response.json({ count: 0, variables: [], datasetVersions: [], firstRetrievedAt: null, provenanceNote: '', series: {} });
    }, { preconnect: originalFetch.preconnect });
    await api.observations({ lat: -1.25, lon: 36.5 });
    const parsed = new URL(url, 'https://example.test');
    expect(parsed.searchParams.get('lat')).toBe('-1.25');
    expect(parsed.searchParams.get('lon')).toBe('36.5');
  });
});

describe('request context guards', () => {
  test('a farm A result cannot populate farm B or a changed input set', () => {
    const farmA: RequestContext = { farmId: 'farm-a', inputHash: 'inputs-a' };
    const farmB: RequestContext = { farmId: 'farm-b', inputHash: 'inputs-a' };
    const changedInputs: RequestContext = { farmId: 'farm-a', inputHash: 'inputs-b' };
    expect(requestContextKey(farmA)).not.toBe(requestContextKey(farmB));
    expect(isRequestContextCurrent(farmA, farmB)).toBe(false);
    expect(isRequestContextCurrent(farmA, changedInputs)).toBe(false);
    expect(isRequestContextCurrent(farmA, { ...farmA })).toBe(true);
  });

  test('coordinate context distinguishes two free-location selections', () => {
    const a: RequestContext = { farmId: null, lat: 1, lon: 2 };
    const b: RequestContext = { farmId: null, lat: 1, lon: 3 };
    expect(isRequestContextCurrent(a, b)).toBe(false);
  });
});
