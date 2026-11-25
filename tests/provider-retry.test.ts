import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { db } from '@/lib/db';
import { parseRetryAfter, resilientFetch } from '@/lib/http';
import { redisRuntime, RedisUnavailableError } from '@/lib/redis';
import { createFetchMock } from './fetch-mock';

const originalFetch = globalThis.fetch;
const originalLog = db.apiRequestLog.create;

beforeEach(() => {
  db.apiRequestLog.create = mock(async () => ({} as never)) as unknown as typeof originalLog;
});

afterEach(async () => {
  globalThis.fetch = createFetchMock(async () => new Response(null));
  for (const provider of ['NASA_POWER', 'GIBS', 'SOILGRIDS', 'FIRMS', 'EONET'] as const) {
    await resilientFetch('https://example.test/reset', { provider, operation: 'test-reset', maxAttempts: 1 });
  }
  globalThis.fetch = originalFetch;
  db.apiRequestLog.create = originalLog;
});

test('Retry-After supports delay seconds and HTTP dates', () => {
  expect(parseRetryAfter('2')).toBe(2);
  expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThanOrEqual(4);
  expect(parseRetryAfter(null)).toBeUndefined();
  expect(parseRetryAfter('invalid')).toBeUndefined();
});

test('429 retries once and honors Retry-After elapsed time without duplicating retry ownership', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => ++calls === 1
    ? new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
    : new Response('ok'));
  const started = performance.now();
  const result = await resilientFetch('https://example.test/rate', { provider: 'EONET', operation: 'retry-after', maxAttempts: 2 });
  expect(result.ok).toBe(true);
  expect(calls).toBe(2);
  expect(performance.now() - started).toBeGreaterThanOrEqual(900);
});

test('500 retries and exhausts into ProviderUnavailableError', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(null, { status: 500 }); });
  await expect(resilientFetch('https://example.test/fail', { provider: 'EONET', operation: 'server-error', maxAttempts: 2 })).rejects.toThrow('after 2 attempts');
  expect(calls).toBe(2);
});

test('permanent 400 fails after one request', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(null, { status: 400 }); });
  const result = await resilientFetch('https://example.test/bad', { provider: 'EONET', operation: 'bad-request', maxAttempts: 3 });
  expect(result.status).toBe(400);
  expect(calls).toBe(1);
});

test('timeout retries only within the single transport retry loop', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => {
    calls++;
    throw new DOMException('request timed out', 'AbortError');
  });
  await expect(resilientFetch('https://example.test/slow', { provider: 'EONET', operation: 'timeout', maxAttempts: 2, timeoutMs: 5 })).rejects.toThrow('timeout');
  expect(calls).toBe(2);
});

test('caller abort is not retried or converted into provider failure', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response('ok'); });
  await expect(resilientFetch('https://example.test/abort', { provider: 'EONET', operation: 'abort', maxAttempts: 3, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(0);
});

test('caller abort mid-fetch stops the active request without retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  let announceFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { announceFetch = resolve; });
  globalThis.fetch = createFetchMock((_input, init) => {
    calls++;
    announceFetch();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const pending = resilientFetch('https://example.test/mid-fetch', { provider: 'EONET', operation: 'mid-fetch-abort', maxAttempts: 3, signal: controller.signal });
  await fetchStarted;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
});

test('caller abort during Retry-After backoff prevents the next attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  let announceFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { announceFetch = resolve; });
  globalThis.fetch = createFetchMock(async () => {
    calls++;
    announceFetch();
    return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
  });
  const started = performance.now();
  const pending = resilientFetch('https://example.test/backoff', { provider: 'EONET', operation: 'backoff-abort', maxAttempts: 3, signal: controller.signal });
  await fetchStarted;
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
  expect(performance.now() - started).toBeLessThan(1_000);
});

test('Redis failure after a successful provider response propagates without retrying transport', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response('ok'); });
  const reset = spyOn(redisRuntime(), 'resetCircuit').mockRejectedValue(new RedisUnavailableError('reset failed'));
  try {
    await expect(resilientFetch('https://example.test/success-redis', { provider: 'EONET', operation: 'redis-after-success', maxAttempts: 2 })).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(calls).toBe(1);
  } finally { reset.mockRestore(); }
});

test('Redis failure after a permanent provider response propagates without retrying transport', async () => {
  let calls = 0;
  globalThis.fetch = createFetchMock(async () => { calls++; return new Response(null, { status: 400 }); });
  const trip = spyOn(redisRuntime(), 'recordCircuitFailure').mockRejectedValue(new RedisUnavailableError('trip failed'));
  try {
    await expect(resilientFetch('https://example.test/permanent-redis', { provider: 'EONET', operation: 'redis-after-permanent', maxAttempts: 3 })).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(calls).toBe(1);
  } finally { trip.mockRestore(); }
});
