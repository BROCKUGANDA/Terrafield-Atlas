import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import type { Prisma } from '@prisma/client';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';
import { createFetchMock } from './fetch-mock';

if (process.env.PRIVATE_PROVIDER_WORKER !== '1') {
  test('private POWER and trends HTTP workflows (isolated database)', () => {
    const result = spawnSync(process.execPath, ['test', 'tests/private-provider-workflows.test.ts'], {
      env: { ...process.env, PRIVATE_PROVIDER_WORKER: '1' }, encoding: 'utf8', timeout: 60_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 65_000);
} else {
  const database = await createPostgresTestDatabase('private_provider');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'private-provider-test-secret';
  process.env.NEXTAUTH_URL = 'https://private-provider.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  const { db } = await import('@/lib/db');
  const ingest = await import('@/app/api/v1/observations/ingest/route');
  const trends = await import('@/app/api/v1/analysis/trends/route');
  const observations = await import('@/app/api/v1/observations/route');
  const jobs = await import('@/app/api/v1/analysis/jobs/[jobId]/route');
  const { executeJob } = await import('@/lib/jobs/handlers');
  const origin = process.env.NEXTAUTH_URL;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  const request = (path: string, method: string, cookie?: string, body?: unknown) => new NextRequest(`${origin}/api/v1/${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const originalFetch = globalThis.fetch;
  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await db.$disconnect();
    await database.drop();
  });

  test('two owners and public coordinates coexist; ownership survives farm deletion', async () => {
    const a = await db.accountUser.create({ data: { email: 'power-a@example.test', emailVerified: new Date() } });
    const b = await db.accountUser.create({ data: { email: 'power-b@example.test', emailVerified: new Date() } });
    const cookie = async (id: string) => `__Secure-next-auth.session-token=${await encode({ token: { sub: id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const cookieA = await cookie(a.id);
    const cookieB = await cookie(b.id);
    const farm = { name: 'private farm', centroidLat: 11.23456, centroidLon: 22.34567 };
    const farmA = await db.farm.create({ data: { ...farm, ownerId: a.id } });
    const farmB = await db.farm.create({ data: { ...farm, ownerId: b.id } });
    let value = 10;
    let calls = 0;
    globalThis.fetch = createFetchMock(async () => {
      calls++;
      return Response.json({ properties: { parameter: { T2M: { '20240101': value, '20240102': value + 1 } } }, header: { api: { name: 'POWER Daily API', version: 'test' }, sources: ['test-provider'] } });
    });
    const body = (farmId?: string) => ({ lat: farm.centroidLat, lon: farm.centroidLon, years: 2, variables: ['T2M'], ...(farmId ? { farmId } : {}) });
    // Both unauthorized references must be rejected before the provider runs.
    expect((await ingest.POST(request('observations/ingest', 'POST', cookieB, body(farmA.id)), ctx())).status).toBe(404);
    expect((await ingest.POST(request('observations/ingest', 'POST', undefined, body(farmA.id)), ctx())).status).toBe(401);
    expect(calls).toBe(0);
    // Long work is queued, never executed inline: the provider must not run
    // before the worker picks the durable job up.
    const publicResponse = await ingest.POST(request('observations/ingest', 'POST', cookieA, body()), ctx());
    expect(publicResponse.status).toBe(202);
    const publicBody = await publicResponse.json();
    expect(calls).toBe(0);
    expect(await executeJob(publicBody.jobId, { skipConcurrency: true })).toMatchObject({ status: 'succeeded' });
    value = 20;
    const responseA = await ingest.POST(request('observations/ingest', 'POST', cookieA, body(farmA.id)), ctx());
    expect(responseA.status).toBe(202);
    const dataA = await responseA.json();
    expect((await db.processingJob.findUniqueOrThrow({ where: { id: dataA.jobId } })).ownerId).toBe(a.id);
    expect(await executeJob(dataA.jobId, { skipConcurrency: true })).toMatchObject({ status: 'succeeded' });
    value = 30;
    const responseB = await ingest.POST(request('observations/ingest', 'POST', cookieB, body(farmB.id)), ctx());
    expect(responseB.status).toBe(202);
    expect(await executeJob((await responseB.json()).jobId, { skipConcurrency: true })).toMatchObject({ status: 'succeeded' });
    expect(calls).toBe(3);
    expect(await db.apiRequestLog.count()).toBe(1);
    const stored = await db.environmentalObservation.findMany({ orderBy: { value: 'asc' } });
    expect(stored.map(r => r.value)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(new Set(stored.map(r => r.namespace)).size).toBe(3);
    const repeatResponse = await ingest.POST(request('observations/ingest', 'POST', cookieA, body(farmA.id)), ctx());
    expect(repeatResponse.status).toBe(202);
    expect(await executeJob((await repeatResponse.json()).jobId, { skipConcurrency: true })).toMatchObject({ status: 'succeeded' });
    expect(await db.environmentalObservation.count()).toBe(6);
    const trendA = await trends.POST(request('analysis/trends', 'POST', cookieA, body(farmA.id)), ctx());
    expect(trendA.status).toBe(202);
    const trendResult = await trendA.json();
    expect(await executeJob(trendResult.jobId, { skipConcurrency: true })).toMatchObject({ status: 'succeeded' });
    const analysis = await db.trendAnalysis.findFirstOrThrow({ where: { farmId: farmA.id } });
    expect(analysis.ownerId).toBe(a.id);
    const trendPublic = await trends.POST(request('analysis/trends', 'POST', cookieA, body()), ctx());
    expect(trendPublic.status).toBe(202);
    const trendPublicBody = await trendPublic.json();
    const trendPublicOutcome = await executeJob(trendPublicBody.jobId, { skipConcurrency: true });
    expect(trendPublicOutcome.status).toBe('succeeded');
    expect((trendPublicOutcome.result as { observationCount: number }).observationCount).toBe(2);
    expect((await db.trendAnalysis.findFirstOrThrow({ where: { farmId: null } })).ownerId).toBeNull();
    expect((await trends.POST(request('analysis/trends', 'POST', cookieB, body(farmA.id)), ctx())).status).toBe(404);
    // Structural provider errors can contain private coordinates. Neither the
    // shared ledger nor the durable job/HTTP error may retain that raw detail.
    globalThis.fetch = createFetchMock(async () => Response.json({ messages: [{ text: 'secret-private-location' }] }));
    const failed = await ingest.POST(request('observations/ingest', 'POST', cookieA, body(farmA.id)), ctx());
    expect(failed.status).toBe(202);
    const failedBody = await failed.json();
    const failedOutcome = await executeJob(failedBody.jobId, { skipConcurrency: true });
    expect(failedOutcome.status).toBe('failed');
    expect(JSON.stringify(failedOutcome)).not.toContain('secret-private-location');
    const failedJob = await db.processingJob.findUniqueOrThrow({ where: { id: failedBody.jobId } });
    expect(failedJob.ownerId).toBe(a.id);
    expect(failedJob.error).toBe('Private provider request failed. No data was fabricated.');
    expect(await db.apiRequestLog.count()).toBe(1);
    expect((await jobs.GET(request(`analysis/jobs/${trendResult.jobId}`, 'GET', cookieB), ctx({ jobId: trendResult.jobId }))).status).toBe(404);
    await db.farm.delete({ where: { id: farmA.id } });
    expect((await db.trendAnalysis.findUniqueOrThrow({ where: { id: analysis.id } })).ownerId).toBe(a.id);
    expect(await db.environmentalObservation.count({ where: { ownerId: a.id, farmId: null } })).toBe(2);
    const publicRows = await observations.GET(request('observations?lat=11.23456&lon=22.34567', 'GET'), ctx());
    expect((await publicRows.json()).series.T2M.points.map((p: { value: number }) => p.value)).toEqual([10, 11]);
    for (const token of [undefined, cookieB]) {
      expect((await jobs.GET(request(`analysis/jobs/${dataA.jobId}`, 'GET', token), ctx({ jobId: dataA.jobId }))).status).toBe(404);
    }
    expect((await jobs.GET(request(`analysis/jobs/${dataA.jobId}`, 'GET', cookieA), ctx({ jobId: dataA.jobId }))).status).toBe(200);
    const { rainfallMonthlyStats, thermalMonthlyStats } = await import('@/lib/ingest/power');
    const climate: Prisma.EnvironmentalObservationCreateManyInput[] = [];
    for (let month = 0; month < 12; month++) {
      for (let day = 1; day <= 20; day++) {
        for (const [ownerId, namespace, farmId, value] of [[null, 'public', null, 2], [b.id, `farm:${farmB.id}`, farmB.id, 4]] as const) {
          for (const variable of ['T2M', 'PRECTOTCORR']) {
            climate.push({ ownerId, namespace, farmId, lat: 40, lon: 50, variable, value, obsDate: new Date(Date.UTC(2023, month, day, 12)), unit: 'test', sourceProvider: 'test', datasetVersion: 'test' });
          }
        }
      }
    }
    await db.environmentalObservation.createMany({ data: climate });
    expect((await rainfallMonthlyStats(40, 50))?.p50).toEqual(Array(12).fill(40));
    expect((await rainfallMonthlyStats(40, 50, farmB.id))?.p50).toEqual(Array(12).fill(80));
    expect((await thermalMonthlyStats(40, 50))?.meanT).toEqual(Array(12).fill(2));
    expect((await thermalMonthlyStats(40, 50, farmB.id))?.meanT).toEqual(Array(12).fill(4));
  }, 30_000);
}