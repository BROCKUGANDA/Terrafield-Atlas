import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';
import { createFetchMock } from './fetch-mock';

// Keep Prisma singletons, credentials and mail transport spies out of other suites.
if (process.env.TERRAFIELD_ACCOUNT_TEST_WORKER !== '1') {
  test('account security integration tests (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/account-isolation.test.ts'], {
      env: { ...process.env, TERRAFIELD_ACCOUNT_TEST_WORKER: '1' }, encoding: 'utf8', timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
const database = await createPostgresTestDatabase('account_isolation');
process.env.DATABASE_URL = database.url;
process.env.NEXTAUTH_SECRET = 'account-test-secret-not-a-production-credential';
process.env.NEXTAUTH_URL = 'https://accounts.example.test';
process.env.WATCH_SCHEDULER_OFF = '1';
const setup = deployMigrations(database.url);
if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

const { db } = await import('@/lib/db');
const { hashPassword, verifyPassword, accountRateLimit, tokenHash, verificationToken } = await import('@/lib/account-security');
const { authenticatePassword, accountUserId } = await import('@/lib/auth');
const { accountApiGuard } = await import('@/lib/account-access');
const farmRoutes = await import('@/app/api/v1/farms/route');
const farmDetail = await import('@/app/api/v1/farms/[farmId]/route');
const soilRoutes = await import('@/app/api/v1/farms/[farmId]/soil-tests/route');
const soilGridsRoutes = await import('@/app/api/v1/farms/[farmId]/soil-tests/soilgrids/route');
const watchRoutes = await import('@/app/api/v1/fires/watchlists/route');
const watchDetail = await import('@/app/api/v1/fires/watchlists/[id]/route');
const watchDigest = await import('@/app/api/v1/fires/watchlists/[id]/digest/route');
const watchRuns = await import('@/app/api/v1/fires/watchlists/[id]/runs/route');
const watchEvaluate = await import('@/app/api/v1/fires/watchlists/[id]/evaluate/route');
const scenarioRoutes = await import('@/app/api/v1/rotation/scenarios/route');
const compareRoutes = await import('@/app/api/v1/rotation/compare/route');
const reportRoutes = await import('@/app/api/v1/reports/route');
const observationRoutes = await import('@/app/api/v1/observations/route');
const fireRoutes = await import('@/app/api/v1/fires/route');
const provenanceRoutes = await import('@/app/api/v1/provenance/route');
const jobRoutes = await import('@/app/api/v1/analysis/jobs/[jobId]/route');
const { computeWatchlistDigest } = await import('@/lib/fires/watchlist-digest-service');
const { executeJob } = await import('@/lib/jobs/handlers');
const { publishDigestForWatchlist, digestChannel } = await import('@/lib/fires/digest-channel');
const registerRoutes = await import('@/app/api/v1/account/register/route');
const verifyRoutes = await import('@/app/api/v1/account/verify/route');

const origin = process.env.NEXTAUTH_URL!;
let cookieA: string;
let cookieB: string;
let userA: string;
let farmA: string;
let farmB: string;
let publicFarm: string;
let watchA: string;
let publicWatch: string;
let requestSequence = 0;
const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
const request = (path: string, method = 'GET', cookie?: string, body?: unknown, source = origin) => new NextRequest(`${origin}/api/v1/${path}`, {
  method,
  headers: {
    origin: source,
    'content-type': 'application/json',
    'x-forwarded-for': `account-${requestSequence++}`,
    ...(cookie ? { cookie } : {}),
    ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'idempotency-key': `account-test-${requestSequence}` } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  const passwordHash = await hashPassword('a long test password');
  const a = await db.accountUser.create({ data: { email: 'a@example.test', passwordHash, emailVerified: new Date() } });
  const b = await db.accountUser.create({ data: { email: 'b@example.test', passwordHash, emailVerified: new Date() } });
  userA = a.id;
  const tokenA = await encode({ token: { sub: a.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 });
  const tokenB = await encode({ token: { sub: b.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 });
  cookieA = `__Secure-next-auth.session-token=${tokenA}`;
  cookieB = `__Secure-next-auth.session-token=${tokenB}`;
  const farm = { name: 'private test farm', centroidLat: 1, centroidLon: 2 };
  farmA = (await db.farm.create({ data: { ...farm, ownerId: a.id } })).id;
  farmB = (await db.farm.create({ data: { ...farm, ownerId: b.id } })).id;
  publicFarm = (await db.farm.create({ data: { ...farm, name: 'public test farm' } })).id;
  const watch = { name: 'same private name', lat: 1, lon: 2 };
  watchA = (await db.fireWatchlist.create({ data: { ...watch, ownerId: a.id } })).id;
  await db.fireWatchlist.create({ data: { ...watch, ownerId: b.id } });
  publicWatch = (await db.fireWatchlist.create({ data: { ...watch, name: 'public watch' } })).id;
  await db.soilTest.create({ data: { farmId: farmA, source: 'farmer', measuredAt: new Date(), notes: 'private soil note' } });
  await db.rotationScenario.create({ data: { farmId: farmA, name: 'secret scenario', cropKeys: '[]', ruleVersion: 'test', weights: '{}', scoresJson: '{}', overallScore: 0, confidence: 0.5 } });
});

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
}, 30_000);

test('real signed account tokens resolve; anonymous and tampered tokens do not', async () => {
  expect(await accountUserId(request('farms', 'GET', cookieA))).toBe(userA);
  expect(await accountUserId(request('farms'))).toBeNull();
  expect(await accountUserId(request('farms', 'GET', cookieA + 'x'))).toBeNull();
});

test('scrypt salts passwords and rejects wrong, missing and malformed hashes', async () => {
  const one = await hashPassword('a long test password');
  expect(one).not.toContain('a long test password');
  expect(one).not.toBe(await hashPassword('a long test password'));
  expect(await verifyPassword('a long test password', one)).toBe(true);
  expect(await verifyPassword('incorrect', one)).toBe(false);
  expect(await verifyPassword('incorrect', null)).toBe(false);
  expect(await verifyPassword('incorrect', 'bad-hash')).toBe(false);
});

test('login returns the same generic failure for unknown, wrong and unverified accounts', async () => {
  expect(await authenticatePassword('a@example.test', 'wrong password')).toBeNull();
  expect(await authenticatePassword('unknown@example.test', 'wrong password')).toBeNull();
  await db.accountUser.create({ data: { email: 'unverified@example.test', passwordHash: await hashPassword('a long test password') } });
  expect(await authenticatePassword('unverified@example.test', 'a long test password')).toBeNull();
  expect((await authenticatePassword(' A@EXAMPLE.TEST ', 'a long test password'))?.id).toBe(userA);
}, 20_000);

test('durable rate limits enforce capacity', async () => {
  const scope = `test-${crypto.randomUUID()}`;
  expect(await accountRateLimit(scope, 'limit', 2, 60_000)).toBe(true);
  expect(await accountRateLimit(scope, 'limit', 2, 60_000)).toBe(true);
  expect(await accountRateLimit(scope, 'limit', 2, 60_000)).toBe(false);
}, 20_000);

test('incremental migration preserves legacy rows as public and enforces owner foreign keys', async () => {
  const migrationDb = new DatabaseSync(':memory:');
  try {
    migrationDb.exec('CREATE TABLE "Farm" ("id" TEXT NOT NULL PRIMARY KEY)');
    migrationDb.exec('CREATE TABLE "FireWatchlist" ("id" TEXT NOT NULL PRIMARY KEY)');
    migrationDb.exec('INSERT INTO "Farm" ("id") VALUES (\'legacy\')');
    const sql = await readFile(join(process.cwd(), 'prisma', 'sqlite-migrations', '20261119130000_private_accounts', 'migration.sql'), 'utf8');
    migrationDb.exec(sql);
    const farms = migrationDb.prepare('SELECT "ownerId" FROM "Farm" WHERE "id" = \'legacy\'').all() as Array<{ ownerId: string | null }>;
    expect(farms).toEqual([{ ownerId: null }]);
    const foreignKeys = migrationDb.prepare('PRAGMA foreign_key_list("Farm")').all() as Array<{ table: string; from: string }>;
    expect(foreignKeys.some((key) => key.table === 'AccountUser' && key.from === 'ownerId')).toBe(true);
  } finally {
    migrationDb.close();
  }
});

test('farm detail and every soil child reject cross-account and anonymous IDOR', async () => {
  for (const cookie of [undefined, cookieB]) {
    expect((await farmDetail.GET(request(`farms/${farmA}`, 'GET', cookie), ctx({ farmId: farmA }))).status).toBe(404);
    expect((await soilRoutes.GET(request(`farms/${farmA}/soil-tests`, 'GET', cookie), ctx({ farmId: farmA }))).status).toBe(404);
    expect((await soilRoutes.POST(request(`farms/${farmA}/soil-tests`, 'POST', cookie, { measuredAt: '2026-01-01', source: 'farmer' }), ctx({ farmId: farmA }))).status).toBe(cookie ? 404 : 401);
    expect((await soilGridsRoutes.POST(request(`farms/${farmA}/soil-tests/soilgrids`, 'POST', cookie, {}), ctx({ farmId: farmA }))).status).toBe(cookie ? 404 : 401);
    expect((await farmDetail.PATCH(request(`farms/${farmA}`, 'PATCH', cookie, { name: 'stolen' }), ctx({ farmId: farmA }))).status).toBe(cookie ? 404 : 401);
  }
  expect((await soilRoutes.GET(request(`farms/${farmA}/soil-tests`, 'GET', cookieA), ctx({ farmId: farmA }))).status).toBe(200);
  expect((await farmDetail.GET(request(`farms/${publicFarm}`), ctx({ farmId: publicFarm }))).status).toBe(200);
});

test('farm and scenario lists omit other accounts, including unfiltered lists', async () => {
  for (const cookie of [undefined, cookieA, cookieB]) {
    const farms = await (await farmRoutes.GET(request('farms', 'GET', cookie), ctx())).json();
    const ids = farms.farms.map((farm: { id: string }) => farm.id);
    expect(ids).toContain(publicFarm);
    expect(ids.includes(farmA)).toBe(cookie === cookieA);
    expect(ids.includes(farmB)).toBe(cookie === cookieB);
    const scenarios = await (await scenarioRoutes.GET(request('rotation/scenarios', 'GET', cookie), ctx())).json();
    expect(scenarios.scenarios.some((s: { farmId: string }) => s.farmId === farmA)).toBe(cookie === cookieA);
  }
}, 20_000);

test('new farm writes require sign-in, enforce origin, and ignore forged owners', async () => {
  const body = { name: 'created private farm', centroidLat: 1, centroidLon: 2, ownerId: 'forged' };
  expect((await farmRoutes.POST(request('farms', 'POST', undefined, body), ctx())).status).toBe(401);
  expect((await farmRoutes.POST(request('farms', 'POST', cookieA, body, 'https://evil.test'), ctx())).status).toBe(403);
  const result = await farmRoutes.POST(request('farms', 'POST', cookieA, body), ctx());
  expect(result.status).toBe(201);
  expect((await result.json()).farm.ownerId).toBe(userA);
}, 20_000);

test('report, compare and scenario creation deny foreign farm IDs before providers', async () => {
  for (const cookie of [undefined, cookieB]) {
    expect((await reportRoutes.POST(request('reports', 'POST', cookie, { farmId: farmA }), ctx())).status).toBe(404);
    expect((await compareRoutes.POST(request('rotation/compare', 'POST', cookie, { farmId: farmA }), ctx())).status).toBe(cookie ? 404 : 401);
    expect((await scenarioRoutes.POST(request('rotation/scenarios', 'POST', cookie, { farmId: farmA }), ctx())).status).toBe(cookie ? 404 : 401);
  }
});

test('owners can save soil, scenarios and comparisons and read their private report', async () => {
  expect((await soilRoutes.POST(request(`farms/${farmA}/soil-tests`, 'POST', cookieA, { measuredAt: '2026-01-01', source: 'farmer', ph: 6.2 }), ctx({ farmId: farmA }))).status).toBe(201);
  const saved = await scenarioRoutes.POST(request('rotation/scenarios', 'POST', cookieA, { farmId: farmA, name: 'private saved sequence', cropKeys: ['maize', 'sorghum'] }), ctx());
  expect(saved.status).toBe(201);
  const savedId = (await saved.json()).scenarioId;
  expect((await db.rotationScenario.findUniqueOrThrow({ where: { id: savedId } })).farmId).toBe(farmA);
  const comparison = await compareRoutes.POST(request('rotation/compare', 'POST', cookieA, {
    farmId: farmA, scenarios: [{ name: 'one', cropKeys: ['maize'] }, { name: 'two', cropKeys: ['sorghum'] }],
  }), ctx());
  expect(comparison.status).toBe(200);
  const report = await reportRoutes.POST(request('reports', 'POST', cookieA, { farmId: farmA }), ctx());
  expect(report.status).toBe(200);
  const data = await report.json();
  expect(data.farm.id).toBe(farmA);
  expect(data.rotationScenarios.some((s: { name: string }) => s.name === 'private saved sequence')).toBe(true);
  expect(data.provenance).toEqual([]);
  expect(report.headers.get('cache-control')).toContain('no-store');
}, 20_000);

test('watchlist list, detail, digest, runs, evaluate, patch and delete are isolated', async () => {
  for (const cookie of [undefined, cookieB]) {
    const list = await (await watchRoutes.GET(request('fires/watchlists', 'GET', cookie), ctx())).json();
    expect(list.watchlists.some((w: { id: string }) => w.id === watchA)).toBe(false);
    for (const [suffix, handler] of [['', watchDetail.GET], ['/digest', watchDigest.GET], ['/runs', watchRuns.GET]] as const) {
      expect((await handler(request(`fires/watchlists/${watchA}${suffix}`, 'GET', cookie), ctx({ id: watchA }))).status).toBe(404);
    }
    expect((await watchEvaluate.POST(request(`fires/watchlists/${watchA}/evaluate`, 'POST', cookie, {}), ctx({ id: watchA }))).status).toBe(cookie ? 404 : 401);
    expect((await watchDetail.PATCH(request(`fires/watchlists/${watchA}`, 'PATCH', cookie, { name: 'stolen' }), ctx({ id: watchA }))).status).toBe(cookie ? 404 : 401);
    expect((await watchDetail.DELETE(request(`fires/watchlists/${watchA}`, 'DELETE', cookie), ctx({ id: watchA }))).status).toBe(cookie ? 404 : 401);
  }
  expect((await watchDigest.GET(request(`fires/watchlists/${watchA}/digest`, 'GET', cookieA), ctx({ id: watchA }))).status).toBe(200);
});

test('reports exclude orphaned private observations from public and other-farm queries', async () => {
  await db.environmentalObservation.create({ data: {
    ownerId: userA, namespace: 'orphan:test', farmId: null,
    lat: 1, lon: 2, variable: 'T2M', obsDate: new Date('2024-01-01'),
    value: 21, unit: 'C', sourceProvider: 'NASA_POWER', datasetVersion: 'private orphan dataset',
  } });
  const report = await reportRoutes.POST(request('reports', 'POST', undefined, { farmId: publicFarm }), ctx());
  expect(report.status).toBe(200);
  const data = await report.json();
  expect(data.environmentalRecord.observationCount).toBe(0);
  expect(JSON.stringify(data)).not.toContain('private orphan dataset');
  const privateReport = await reportRoutes.POST(request('reports', 'POST', cookieA, { farmId: farmA }), ctx());
  expect((await privateReport.json()).environmentalRecord.observationCount).toBe(0);
});

test('private watchlist creation, scheduling and HTTP evaluation are owner-scoped', async () => {
  const result = await watchRoutes.POST(request('fires/watchlists', 'POST', cookieA, { name: 'new watch', lat: 0, lon: 0 }), ctx());
  expect(result.status).toBe(201);
  const created = (await result.json()).watchlist;
  expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: created.id } })).ownerId).toBe(userA);
  const scheduled = await watchRoutes.POST(request('fires/watchlists', 'POST', cookieA, { name: 'scheduled', lat: 0, lon: 0, reevaluateIntervalMin: 360 }), ctx());
  expect(scheduled.status).toBe(201);
  expect((await scheduled.json()).watchlist.reevaluateIntervalMin).toBe(360);
  const provider = await import('@/lib/adapters/gibsFires');
  const fetch = spyOn(provider, 'fetchFiresForDate').mockImplementation(async (date) => ({ date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false }));
  try {
    const evaluated = await watchEvaluate.POST(request(`fires/watchlists/${watchA}/evaluate`, 'POST', cookieA, {}), ctx({ id: watchA }));
    expect(evaluated.status).toBe(202);
    const accepted = await evaluated.json();
    expect(accepted.duplicate).toBe(false);
    const executed = await executeJob(accepted.jobId, { skipConcurrency: true });
    expect(executed.status).toBe('succeeded');
    const completed = await jobRoutes.GET(request(`analysis/jobs/${accepted.jobId}`, 'GET', cookieA), ctx({ jobId: accepted.jobId }));
    expect(completed.status).toBe(200);
    const completedBody = await completed.json();
    expect(completedBody.result.evaluation.status).toBe('unverified');
    expect(fetch).toHaveBeenCalled();
    expect((await watchDetail.PATCH(request(`fires/watchlists/${watchA}`, 'PATCH', cookieA, { reevaluateIntervalMin: 720 }), ctx({ id: watchA }))).status).toBe(200);
    expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: watchA } })).reevaluateIntervalMin).toBe(720);
  } finally { fetch.mockRestore(); }
}, 20_000);

test('private digest service defaults to denial and never broadcasts to global exits', async () => {
  expect((await computeWatchlistDigest(watchA)).ok).toBe(false);
  expect((await computeWatchlistDigest(watchA, { ownerId: userA })).ok).toBe(true);
  let deliveries = 0;
  let ownerDeliveries = 0;
  digestChannel().register({ clientId: 'account-test-sink', send() { deliveries++; } });
  digestChannel().register({ clientId: 'account-owner-sink', ownerId: userA, authorizePrivate: async () => true, send() { ownerDeliveries++; } });
  try {
    const result = await publishDigestForWatchlist(watchA, 'evaluation', { correlationId: null, triggeredAt: new Date() });
    expect(result.published).toBe(1);
    expect(ownerDeliveries).toBe(1);
    expect(result.webhook).toBeNull();
    expect(result.email).toBeNull();
    expect(deliveries).toBe(0);
    expect((await publishDigestForWatchlist(publicWatch, 'evaluation', { correlationId: null, triggeredAt: new Date() })).published).toBe(2);
  } finally {
    digestChannel().unregister('account-test-sink');
    digestChannel().unregister('account-owner-sink');
  }
});

test('farmId checks cannot be bypassed with supplied coordinates or duplicate query IDs', async () => {
  for (const cookie of [undefined, cookieB]) {
    const path = `fires?farmId=${farmA}&lat=1&lon=2&from=2026-01-01&to=2026-01-02`;
    expect((await fireRoutes.GET(request(path, 'GET', cookie), ctx())).status).toBe(404);
    expect((await observationRoutes.GET(request(`observations?farmId=${publicFarm}&farmId=${farmA}`, 'GET', cookie), ctx())).status).toBe(404);
  }
  await expect(accountApiGuard(request(`observations/ingest`, 'POST', cookieA, { farmId: farmA, lat: 1, lon: 2 }))).resolves.toBeUndefined();
  await expect(accountApiGuard(request('analysis/jobs/guessed-id'), { jobId: 'guessed-id' })).rejects.toMatchObject({ status: 404 });
});

test('job detail preserves public workflows while denying foreign farm/watchlist references', async () => {
  for (const params of [{ farmId: farmA }, { watchlistId: watchA }]) {
    const job = await db.processingJob.create({ data: { type: 'test', ownerId: userA, status: 'succeeded', params: JSON.stringify(params) } });
    for (const cookie of [undefined, cookieB]) {
      expect((await jobRoutes.GET(request(`analysis/jobs/${job.id}`, 'GET', cookie), ctx({ jobId: job.id }))).status).toBe(404);
    }
    expect((await jobRoutes.GET(request(`analysis/jobs/${job.id}`, 'GET', cookieA), ctx({ jobId: job.id }))).status).toBe(200);
  }
  for (const params of [{ farmId: publicFarm }, { lat: 1, lon: 2 }]) {
    const job = await db.processingJob.create({ data: { type: 'test', status: 'succeeded', params: JSON.stringify(params) } });
    expect((await jobRoutes.GET(request(`analysis/jobs/${job.id}`), ctx({ jobId: job.id }))).status).toBe(200);
  }
}, 20_000);

test('provenance withholds unattributed logs/jobs and foreign trend IDs', async () => {
  await db.apiRequestLog.create({ data: { provider: 'TEST', operation: 'private', requestUrl: 'https://provider.test/private-location', status: 200, ok: true, latencyMs: 1 } });
  const data = await (await provenanceRoutes.GET(request('provenance', 'GET', cookieB))).json();
  expect(data.requestLog).toEqual([]);
  expect(data.recentJobs).toEqual([]);
  expect(JSON.stringify(data)).not.toContain('private-location');
});

test('verification tokens are hashed, expiring and single-use; origin is required', async () => {
  const token = verificationToken();
  const user = await db.accountUser.create({ data: { email: 'verify@example.test' } });
  await db.accountVerification.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 60_000) } });
  expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token }, 'https://evil.test'))).status).toBe(403);
  expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token }))).status).toBe(200);
  expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token }))).status).toBe(400);
  const expired = verificationToken();
  await db.accountVerification.create({ data: { userId: user.id, tokenHash: tokenHash(expired), expiresAt: new Date(0) } });
  expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token: expired }))).status).toBe(400);
});

test('registration binds each verification link to the current pending password', async () => {
  process.env.RESEND_API_KEY = 'test-key-not-real';
  process.env.EMAIL_FROM = 'test@example.test';
  const links: string[] = [];
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(createFetchMock(async (_input, options) => {
    const message = JSON.parse(String(options?.body)) as { text: string };
    links.push(new URL(message.text.match(/https:\/\/\S+/)![0]).searchParams.get('verifyAccount')!);
    return Response.json({ id: 'test-message' });
  }));
  try {
    const email = 'register@example.test';
    const original = 'original test password';
    const replacement = 'replacement test password';
    expect((await registerRoutes.POST(request('account/register', 'POST', undefined, { email, password: original }))).status).toBe(202);
    expect(await authenticatePassword(email, original)).toBeNull();
    expect((await registerRoutes.POST(request('account/register', 'POST', undefined, { email, password: replacement }))).status).toBe(202);
    expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token: links[0] }))).status).toBe(400);
    expect((await verifyRoutes.POST(request('account/verify', 'POST', undefined, { token: links[1] }))).status).toBe(200);
    expect(await authenticatePassword(email, original)).toBeNull();
    expect(await authenticatePassword(email, replacement)).not.toBeNull();
    expect((await registerRoutes.POST(request('account/register', 'POST', undefined, { email, password: original }))).status).toBe(202);
    expect(links).toHaveLength(2);
  } finally {
    fetchMock.mockRestore();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
}, 30_000);
}