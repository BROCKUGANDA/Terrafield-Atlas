import { afterAll, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.PRIVATE_FIRES_WORKER !== '1') {
  test('private fires HTTP integration (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', 'tests/private-fires.test.ts'], {
      env: { ...process.env, PRIVATE_FIRES_WORKER: '1' }, encoding: 'utf8', timeout: 120_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 125_000);
} else {
  const database = await createPostgresTestDatabase('private_fires');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'private-fires-test-only-secret';
  process.env.NEXTAUTH_URL = 'https://fires.example.test';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  const { db } = await import('@/lib/db');
  const { NextRequest } = await import('next/server');
  const { encode } = await import('next-auth/jwt');
  const { cacheSet, cacheGet, cacheStats } = await import('@/lib/cache');
  const { resilientFetch } = await import('@/lib/http');
  const { isPrivateProvider } = await import('@/lib/ingest/provider-context');
  const adapter = await import('@/lib/adapters/gibsFires');
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => new Response('provider fixture', { status: 200 })) as unknown as typeof fetch;
  let marker = 10;
  let failure = false;
  let bulk = false;
  let stale = false;
  let expectPrivate = true;
  let providerCalls = 0;
  const detection = (date: string, frp = marker) => ({
    obsDate: date, acqTime: '12:00', latitude: 1, longitude: 2, confidence: 'high' as const,
    satellite: 'N', dayNight: 'D' as const, brightTi4: 310, brightTi5: 290, frp, uid: `uid-${frp}`,
  });
  mock.module('@/lib/adapters/gibsFires', () => ({ ...adapter, fetchFiresForDate: async (date: string) => {
    providerCalls++;
    expect(isPrivateProvider()).toBe(expectPrivate);
    cacheSet('private-fire-leak', 'secret location', 60_000);
    await resilientFetch('https://provider.example.test/?lat=1&lon=2', { provider: 'GIBS', operation: 'private-test', maxAttempts: 1 });
    if (failure) throw new Error('SECRET provider URL lat=1 lon=2 credentials=never-expose');
    const detections = !expectPrivate ? [detection(date)] : date === '2024-01-02' ? [] : bulk
      ? Array.from({ length: 5_001 }, (_, i) => detection(date, i))
      : [detection(date), detection(date), { ...detection('2023-12-01'), uid: 'wrong-date' }, { ...detection(date), latitude: 50, uid: 'outside' }];
    return { date, detections, dataAvailable: date !== '2024-01-02', stale, tiles: 1, tilesWithData: 1 };
  } }));
  const { GET, POST } = await import('@/app/api/v1/fires/route');
  const { executeJob } = await import('@/lib/jobs/handlers');
  const runAccepted = async (response: Response) => {
    expect(response.status).toBe(202);
    const accepted = await response.clone().json();
    const executed = await executeJob(accepted.jobId, { skipConcurrency: true });
    expect(executed.status).toBe('succeeded');
    return executed.result as Record<string, unknown>;
  };
  const users = await Promise.all(['a', 'b'].map((name) => db.accountUser.create({ data: { email: `${name}@private-fires.test`, emailVerified: new Date() } })));
  const farms = await Promise.all(users.map((user) => db.farm.create({ data: { ownerId: user.id, name: 'same coordinates', centroidLat: 1, centroidLon: 2 } })));
  const sibling = await db.farm.create({ data: { ownerId: users[0].id, name: 'same owner other farm', centroidLat: 1, centroidLon: 2 } });
  const cookies = await Promise.all(users.map(async (user) => `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: user.id }, maxAge: 3600 })}`));
  let requestId = 0;
  const ctx = { params: Promise.resolve({}) };
  const request = (method: string, farmId?: string, cookie?: string, extra: Record<string, unknown> = {}) => {
    const data = { ...(farmId ? { farmId } : {}), from: '2024-01-01', to: '2024-01-03', ...extra };
    const query = method === 'GET' ? `?${new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]))}` : '';
    return new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/fires${query}`, {
      method, headers: { origin: process.env.NEXTAUTH_URL!, cookie: cookie ?? '', 'content-type': 'application/json', 'x-forwarded-for': `test-${requestId++}` },
      ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
    });
  };
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await database.drop();
  });

  test('signed owners ingest isolated snapshots with no shared rows, cache or provenance', async () => {
    const beforeCache = await cacheStats();
    for (let i = 0; i < 2; i++) {
      marker = 10 + i;
      const response = await POST(request('POST', farms[i].id, cookies[i]), ctx);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const body = await runAccepted(response);
      const job = await db.processingJob.findFirstOrThrow({ where: { type: 'private-fires-snapshot-v1', ownerId: users[i].id }, orderBy: { startedAt: 'desc' } });
      expect(job.ownerId).toBe(users[i].id);
      expect(JSON.parse(job.params).farmId).toBe(farms[i].id);
      expect(body.rowsWritten).toBe(0);
      expect(body.noDataDays).toEqual(['2024-01-02']);
    }
    expect(await cacheGet('private-fire-leak')).toBeUndefined();
    expect(await cacheStats()).toEqual(beforeCache);
    expect(await db.fireObservation.count()).toBe(0);
    expect(await db.fireCoverageDay.count()).toBe(0);
    expect(await db.apiRequestLog.count()).toBe(0);
    for (let i = 0; i < 2; i++) {
      const response = await GET(request('GET', farms[i].id, cookies[i], { to: '2024-01-04' }), ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.count).toBe(2);
      expect(body.detections.map((d: { frp: number }) => d.frp)).toEqual([10 + i, 10 + i]);
      expect(body.noDataDays).toEqual(['2024-01-02']);
      expect(body.uncheckedDays).toEqual(['2024-01-04']);
      expect(body.countsPartial).toBe(true);
      expect(body.confidenceDistribution.high).toBe(2);
    }
    const ownOther = await (await GET(request('GET', sibling.id, cookies[0]), ctx)).json();
    expect(ownOther.count).toBe(0);
    expect(ownOther.uncheckedDays).toHaveLength(3);
    const publicResponse = await GET(request('GET', undefined, undefined, { lat: 1, lon: 2 }), ctx);
    expect((await publicResponse.json()).count).toBe(0);
  });

  test('all supplied farm references enforce ownership even with explicit coordinates', async () => {
    const before = providerCalls;
    const expired = `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: users[0].id }, maxAge: -60 })}`;
    for (const method of ['GET', 'POST']) {
      const handler = method === 'GET' ? GET : POST;
      const unauthenticatedStatus = method === 'GET' ? 404 : 401;
      for (const cookie of [undefined, cookies[0] + 'tampered', expired]) {
        expect((await handler(request(method, farms[0].id, cookie, { lat: 1, lon: 2 }), ctx)).status).toBe(unauthenticatedStatus);
      }
      expect((await handler(request(method, farms[0].id, cookies[1], { lat: 1, lon: 2 }), ctx)).status).toBe(404);
    }
    expect((await GET(request('GET', 'missing', cookies[0], { lat: 1, lon: 2 }), ctx)).status).toBe(404);
    expect(providerCalls).toBe(before);
    const crossOrigin = request('POST', farms[0].id, cookies[0]);
    crossOrigin.headers.set('origin', 'https://attacker.example');
    expect((await POST(crossOrigin, ctx)).status).toBe(403);
  });

  test('repeated ingests use newest day, range and filters clip correctly; location mismatch stays unchecked', async () => {
    marker = 20;
    stale = true;
    const accepted = await POST(request('POST', farms[0].id, cookies[0], { to: '2024-01-01' }), ctx);
    expect(accepted.status).toBe(202);
    await runAccepted(accepted);
    stale = false;
    const body = await (await GET(request('GET', farms[0].id, cookies[0], { to: '2024-01-01' }), ctx)).json();
    expect(body.count).toBe(1);
    expect(body.detections[0].frp).toBe(20);
    expect(body.coverage[0].stale).toBe(true);
    expect(body.countsPartial).toBe(true);
    const filtered = await (await GET(request('GET', farms[0].id, cookies[0], { confidence: 'low' }), ctx)).json();
    expect(filtered.count).toBe(0);
    const moved = await (await GET(request('GET', farms[0].id, cookies[0], { lat: 3, lon: 4 }), ctx)).json();
    expect(moved.count).toBe(0);
    expect(moved.uncheckedDays).toHaveLength(3);
    expect((await POST(request('POST', farms[0].id, cookies[0], { from: '2024-02-31' }), ctx)).status).toBe(400);
  });

  test('provider failure persists a sanitized durable owner and never exposes false coverage', async () => {
    failure = true;
    const response = await POST(request('POST', farms[0].id, cookies[0], { from: '2024-02-01', to: '2024-02-01' }), ctx);
    expect(response.status).toBe(202);
    const accepted = await response.clone().json();
    let executed = await executeJob(accepted.jobId, { skipConcurrency: true });
    failure = false;
    for (let attempt = 1; executed.retryable && attempt < 5; attempt++) {
      failure = true;
      executed = await executeJob(accepted.jobId, { skipConcurrency: true });
      failure = false;
    }
    expect(executed.status).toBe('dead-lettered');
    expect(await response.text()).not.toContain('SECRET');
    const job = await db.processingJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
    expect(job.status).toBe('dead-lettered');
    expect(job.error).not.toContain('SECRET');
    expect(job.resultRef).toBeNull();
    const body = await (await GET(request('GET', farms[0].id, cookies[0], { from: '2024-02-01', to: '2024-02-01' }), ctx)).json();
    expect(body.coverage[0]).toMatchObject({ checked: false, dataAvailable: false });
    expect(await db.apiRequestLog.count()).toBe(0);
  }, 30_000);

  test('storage and response caps explicitly report partial detection counts', async () => {
    bulk = true;
    const response = await POST(request('POST', farms[0].id, cookies[0], { from: '2024-03-01', to: '2024-03-01' }), ctx);
    const ingested = await runAccepted(response);
    bulk = false;
    expect(ingested.totalDetections).toBe(5_001);
    expect(ingested.privateDetectionsStored).toBe(5_000);
    expect(ingested.truncated).toBe(true);
    const body = await (await GET(request('GET', farms[0].id, cookies[0], { from: '2024-03-01', to: '2024-03-01' }), ctx)).json();
    expect(body.count).toBe(5_000);
    expect(body.detections).toHaveLength(500);
    expect(body.truncated).toBe(true);
    expect(body.countsPartial).toBe(true);
    expect(body.coverage[0].detectionsTruncated).toBe(true);
    expect(await db.fireObservation.count()).toBe(0);
    expect(await db.fireCoverageDay.count()).toBe(0);
    expect(await db.apiRequestLog.count()).toBe(0);
  });

  test('aggregate cap reports partial counts even when every archive day was available', async () => {
    const farm = await db.farm.create({ data: { ownerId: users[0].id, name: 'aggregate limit', centroidLat: 1, centroidLon: 2 } });
    for (let i = 1; i <= 5; i++) {
      const date = `2024-06-0${i}`;
      await db.processingJob.create({ data: {
        ownerId: users[0].id, type: 'private-fires-snapshot-v1', status: 'succeeded',
        params: JSON.stringify({ farmId: farm.id, lat: 1, lon: 2 }),
        resultRef: JSON.stringify({ days: [{ date, dataAvailable: true, stale: false, truncated: false, detections: Array.from({ length: 5_000 }, (_, j) => detection(date, j)) }] }),
      } });
    }
    const body = await (await GET(request('GET', farm.id, cookies[0], { from: '2024-06-01', to: '2024-06-05' }), ctx)).json();
    expect(body.count).toBe(20_000);
    expect(body.detections).toHaveLength(500);
    expect(body.countsPartial).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.uncheckedDays).toEqual([]);
    expect(body.coverage.every((day: { dataAvailable: boolean }) => day.dataAvailable)).toBe(true);
  });

  test('unowned, failed and malformed snapshots never establish coverage; bounded lookups disclose omissions', async () => {
    const params = JSON.stringify({ farmId: sibling.id, lat: 1, lon: 2, from: '2024-04-01', to: '2024-04-01' });
    const resultRef = JSON.stringify({ days: [{ date: '2024-04-01', dataAvailable: true, stale: false, truncated: false, detections: [detection('2024-04-01', 999)] }] });
    for (const data of [
      { ownerId: null, status: 'succeeded', resultRef },
      { ownerId: users[1].id, status: 'succeeded', resultRef },
      { ownerId: users[0].id, status: 'failed', resultRef },
      { ownerId: users[0].id, status: 'succeeded', resultRef: '{broken' },
    ]) await db.processingJob.create({ data: { type: 'private-fires-snapshot-v1', params, ...data } });
    const read = async () => (await GET(request('GET', sibling.id, cookies[0], { from: '2024-04-01', to: '2024-04-01' }), ctx)).json();
    const before = await read();
    expect(before.count).toBe(0);
    expect(before.uncheckedDays).toEqual(['2024-04-01']);
    await db.processingJob.create({ data: { ownerId: users[0].id, type: 'private-fires-snapshot-v1', status: 'succeeded', params, resultRef, startedAt: new Date('2020-01-01') } });
    expect((await read()).count).toBe(1);
    await db.processingJob.createMany({ data: Array.from({ length: 51 }, () => ({
      ownerId: users[0].id, type: 'private-fires-snapshot-v1', status: 'succeeded',
      params: JSON.stringify({ farmId: farms[0].id, lat: 1, lon: 2 }), resultRef: JSON.stringify({ days: [] }),
    })) });
    const after = await read();
    expect(after.count).toBe(0);
    expect(after.snapshotLookupTruncated).toBe(true);
    expect(after.truncated).toBe(true);
    expect(after.countsPartial).toBe(true);
    expect(after.uncheckedDays).toEqual(['2024-04-01']);
  });

  test('verified shared ingest retains observation, coverage, cache and provenance behavior', async () => {
    expectPrivate = false;
    marker = 777;
    try {
      const response = await POST(request('POST', undefined, cookies[0], { lat: 1, lon: 2, from: '2024-05-01', to: '2024-05-01' }), ctx);
      const body = await runAccepted(response);
      const job = await db.processingJob.findFirstOrThrow({ where: { type: 'fires-ingest', ownerId: users[0].id }, orderBy: { startedAt: 'desc' } });
      expect(job.ownerId).toBe(users[0].id);
      expect(JSON.parse(job.params).ownerId).toBeUndefined();
      expect(body.rowsWritten).toBe(1);
      expect(await db.fireObservation.count()).toBe(1);
      expect(await db.fireCoverageDay.count()).toBe(1);
      expect(await db.apiRequestLog.count()).toBe(1);
      expect(await cacheGet<string>('private-fire-leak')).toBe('secret location');
      const publicBody = await (await GET(request('GET', undefined, undefined, { lat: 1, lon: 2, from: '2024-05-01', to: '2024-05-01' }), ctx)).json();
      expect(publicBody.count).toBe(1);
      const privateBody = await (await GET(request('GET', farms[1].id, cookies[1], { from: '2024-05-01', to: '2024-05-01' }), ctx)).json();
      expect(privateBody.count).toBe(0);
      expect(privateBody.uncheckedDays).toEqual(['2024-05-01']);
    } finally { expectPrivate = true; }
  });
}