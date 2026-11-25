import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/helpers';
import { GET as digestStream } from '@/app/api/v1/fires/watchlists/digest-stream/route';
import { GET as health } from '@/app/api/v1/health/route';
import { GET as systemStatus, POST as systemStatusAction } from '@/app/api/v1/system/status/route';
import { redisRuntime, RedisUnavailableError } from '@/lib/redis';

const correlationId = 'runtime-route-test';
const request = (path: string, method = 'GET') => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { 'x-correlation-id': correlationId },
});

beforeAll(async () => {
  process.env.WATCH_SCHEDULER_OFF = '1';
  await redisRuntime().setJson('source-signs:report', {
    checkedAt: new Date().toISOString(),
    probeMs: 0,
    signs: [],
    summary: { live: 0, degraded: 0, unreachable: 0 },
    note: 'runtime route test fixture',
  }, { ttlMs: 60_000 });
});

afterAll(async () => {
  await redisRuntime().deletePrefix('source-signs:report');
});

test('apiHandler preserves route cache directives while enforcing no-store', async () => {
  const custom = apiHandler(async () => new NextResponse('ok', {
    headers: { 'Cache-Control': 'private, no-store, no-transform' },
  }));
  const customResponse = await custom(request('/api/v1/custom'));
  expect(customResponse.headers.get('Cache-Control')).toBe('private, no-store, no-transform');

  const cacheable = apiHandler(async () => new NextResponse('ok', {
    headers: { 'Cache-Control': 'public, max-age=60, no-transform' },
  }));
  const cacheableResponse = await cacheable(request('/api/v1/cacheable'));
  expect(cacheableResponse.headers.get('Cache-Control')).toBe('public, max-age=60, no-transform, no-store');

  const ordinary = apiHandler(async () => new NextResponse('ok'));
  const ordinaryResponse = await ordinary(request('/api/v1/ordinary'));
  expect(ordinaryResponse.headers.get('Cache-Control')).toBe('private, no-store');
});

test('digest SSE retains both no-store and no-transform through apiHandler', async () => {
  const response = await digestStream(request('/api/v1/fires/watchlists/digest-stream'));
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('text/event-stream');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Cache-Control')).toContain('no-transform');
  await response.body?.cancel();
});

test('digest stream maps Redis rate-limit outages to structured 503', async () => {
  const bucket = spyOn(redisRuntime(), 'tokenBucket').mockRejectedValue(new RedisUnavailableError('rate limiter unavailable'));
  try {
    const response = await digestStream(request('/api/v1/fires/watchlists/digest-stream'));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await response.json()).toMatchObject({ error: { code: 'RUNTIME_UNAVAILABLE', correlationId } });
  } finally { bucket.mockRestore(); }
});

test('health maps Redis cache-stat outages to structured 503', async () => {
  const stats = spyOn(redisRuntime(), 'cacheStats').mockRejectedValue(new RedisUnavailableError('cache stats unavailable'));
  try {
    const response = await health(request('/api/v1/health'));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await response.json()).toMatchObject({ error: { code: 'RUNTIME_UNAVAILABLE', correlationId } });
  } finally { stats.mockRestore(); }
});

test('system status maps Redis diagnostics outages to structured 503', async () => {
  const stats = spyOn(redisRuntime(), 'cacheStats').mockRejectedValue(new RedisUnavailableError('diagnostics unavailable'));
  try {
    const response = await systemStatus(request('/api/v1/system/status'));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await response.json()).toMatchObject({ error: { code: 'RUNTIME_UNAVAILABLE', correlationId } });
  } finally { stats.mockRestore(); }
});

test('system status cache action requires a verified administrator before Redis work', async () => {
  const invalidate = spyOn(redisRuntime(), 'deletePrefix').mockRejectedValue(new RedisUnavailableError('invalidation unavailable'));
  try {
    const response = await systemStatusAction(request('/api/v1/system/status?action=invalidate-cache', 'POST'));
    expect(response.status).toBe(401);
    expect(response.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED', correlationId } });
    expect(invalidate).not.toHaveBeenCalled();
  } finally { invalidate.mockRestore(); }
});
