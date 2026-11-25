import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.TERRAFIELD_TASK5A_AUTH_WORKER !== '1') {
  test('Task 5a authorization integration tests (isolated PostgreSQL and Redis)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/task-5a-authorization.integration.ts'], {
      env: { ...process.env, TERRAFIELD_TASK5A_AUTH_WORKER: '1' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('task5a_auth');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'task5a-authorization-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://task5a.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.DIGEST_PUSH_OFF = '1';
  process.env.DIGEST_WEBHOOK_OFF = '1';
  process.env.DIGEST_EMAIL_OFF = '1';
  process.env.REDIS_KEY_PREFIX = `task5a:${crypto.randomUUID()}:`;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { redisRuntime } = await import('@/lib/redis');
  const { hashPassword } = await import('@/lib/account-security');
  const farms = await import('@/app/api/v1/farms/route');
  const farmDetail = await import('@/app/api/v1/farms/[farmId]/route');
  const watchDetail = await import('@/app/api/v1/fires/watchlists/[id]/route');
  const evaluate = await import('@/app/api/v1/fires/watchlists/[id]/evaluate/route');
  const reports = await import('@/app/api/v1/reports/route');
  const status = await import('@/app/api/v1/system/status/route');
  const experiments = await import('@/app/api/v1/experiments/route');
  const sources = await import('@/app/api/v1/system/sources/route');
  const webhook = await import('@/app/api/v1/webhooks/digests/route');
  // NextAuth v4 does not export its core entry point; load the installed module
  // directly so this exercises the real CSRF implementation without a server.
  const require = createRequire(import.meta.url);
  const { AuthHandler } = require(resolve(process.cwd(), 'node_modules/next-auth/core/index.js'));
  const { authOptions } = await import('@/lib/auth');
  const sourceHealth = await import('@/lib/source-health');
  const eonet = await import('@/lib/adapters/eonet');
  const gibs = await import('@/lib/adapters/gibsFires');
  const { buildWebhookHeaders } = await import('@/lib/fires/digest-exit-webhook');

  const origin = process.env.NEXTAUTH_URL!;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  let sequence = 0;
  const request = (
    path: string,
    method = 'GET',
    cookie?: string,
    body?: unknown,
    options: { key?: string; source?: string; headers?: Record<string, string>; rawBody?: string } = {},
  ) => new NextRequest(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      origin: options.source ?? origin,
      'content-type': 'application/json',
      'x-forwarded-for': `task5a-${sequence++}`,
      ...(cookie ? { cookie } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...options.headers,
    },
    ...(options.rawBody !== undefined ? { body: options.rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let cookieA: string;
  let cookieB: string;
  let cookieUnverified: string;
  let cookieAdmin: string;
  let adminId: string;
  let farmA: string;
  let farmB: string;
  let publicFarm: string;
  let watchA: string;
  let watchB: string;
  let publicWatch: string;

  beforeAll(async () => {
    await redisRuntime().ping();
    const a = await db.accountUser.create({ data: { email: 'a@task5a.test', emailVerified: new Date() } });
    const b = await db.accountUser.create({ data: { email: 'b@task5a.test', emailVerified: new Date() } });
    const unverified = await db.accountUser.create({ data: { email: 'unverified@task5a.test' } });
    const admin = await db.accountUser.create({ data: { email: 'admin@task5a.test', emailVerified: new Date(), isAdmin: true } });
    adminId = admin.id;
    const token = async (id: string) => `__Secure-next-auth.session-token=${await encode({ token: { sub: id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    cookieA = await token(a.id);
    cookieB = await token(b.id);
    cookieUnverified = await token(unverified.id);
    cookieAdmin = await token(admin.id);
    const farm = { name: 'Task 5a farm', centroidLat: 1, centroidLon: 2 };
    farmA = (await db.farm.create({ data: { ...farm, ownerId: a.id } })).id;
    farmB = (await db.farm.create({ data: { ...farm, ownerId: b.id } })).id;
    publicFarm = (await db.farm.create({ data: { ...farm, name: 'Task 5a seeded farm' } })).id;
    const watch = { name: 'Task 5a watch', lat: 1, lon: 2, lookbackDays: 3 };
    watchA = (await db.fireWatchlist.create({ data: { ...watch, ownerId: a.id } })).id;
    watchB = (await db.fireWatchlist.create({ data: { ...watch, ownerId: b.id } })).id;
    publicWatch = (await db.fireWatchlist.create({ data: { ...watch, name: 'Task 5a seeded watch' } })).id;
  });

  afterAll(async () => {
    await db.$disconnect();
    await redisRuntime().close();
    await database.drop();
  });

  test('anonymous and unverified seeded PATCH/DELETE/evaluate are denied before provider work', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockRejectedValue(new Error('provider must not run'));
    try {
      for (const cookie of [undefined, cookieUnverified]) {
        expect((await farmDetail.PATCH(request(`farms/${publicFarm}`, 'PATCH', cookie, { name: 'stolen' }), ctx({ farmId: publicFarm }))).status).toBe(401);
        expect((await watchDetail.DELETE(request(`fires/watchlists/${publicWatch}`, 'DELETE', cookie), ctx({ id: publicWatch }))).status).toBe(401);
        expect((await evaluate.POST(request(`fires/watchlists/${publicWatch}/evaluate`, 'POST', cookie, {}), ctx({ id: publicWatch }))).status).toBe(401);
      }
      expect(provider).not.toHaveBeenCalled();
      expect((await db.farm.findUniqueOrThrow({ where: { id: publicFarm } })).name).toBe('Task 5a seeded farm');
      expect(await db.fireWatchlist.findUnique({ where: { id: publicWatch } })).not.toBeNull();
    } finally {
      provider.mockRestore();
    }
  });

  test('seeded ownerId-null records stay immutable even for an administrator', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockRejectedValue(new Error('provider must not run'));
    try {
      expect((await farmDetail.PATCH(request(`farms/${publicFarm}`, 'PATCH', cookieAdmin, { name: 'admin overwrite' }), ctx({ farmId: publicFarm }))).status).toBe(403);
      expect((await watchDetail.DELETE(request(`fires/watchlists/${publicWatch}`, 'DELETE', cookieAdmin), ctx({ id: publicWatch }))).status).toBe(403);
      expect((await evaluate.POST(request(`fires/watchlists/${publicWatch}/evaluate`, 'POST', cookieAdmin, {}), ctx({ id: publicWatch }))).status).toBe(403);
      expect(provider).not.toHaveBeenCalled();
      expect((await db.farm.findUniqueOrThrow({ where: { id: publicFarm } })).name).toBe('Task 5a seeded farm');
      expect(await db.fireWatchlist.findUnique({ where: { id: publicWatch } })).not.toBeNull();
    } finally {
      provider.mockRestore();
    }
  });

  test('a verified owner can mutate owned records', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockRejectedValue(new Error('provider work must be queued'));
    try {
      const patchedFarm = await farmDetail.PATCH(request(`farms/${farmA}`, 'PATCH', cookieA, { name: 'Owner updated farm' }, { key: 'task5a-owner-farm-key' }), ctx({ farmId: farmA }));
      expect(patchedFarm.status).toBe(200);
      expect((await db.farm.findUniqueOrThrow({ where: { id: farmA } })).name).toBe('Owner updated farm');

      const patchedWatch = await watchDetail.PATCH(request(`fires/watchlists/${watchA}`, 'PATCH', cookieA, { notes: 'owner note' }, { key: 'task5a-owner-watch-key' }), ctx({ id: watchA }));
      expect(patchedWatch.status).toBe(200);
      expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: watchA } })).notes).toBe('owner note');

      const evaluated = await evaluate.POST(request(`fires/watchlists/${watchA}/evaluate`, 'POST', cookieA, {}, { key: 'task5a-owner-eval-key' }), ctx({ id: watchA }));
      expect(evaluated.status).toBe(202);
      const body = await evaluated.json();
      expect(body).toMatchObject({
        type: 'fires-watch-eval',
        status: 'queued',
        trigger: 'manual',
      });
      expect(body.jobId).toEqual(expect.any(String));
      expect(body.jobUrl).toMatch(/^\/api\/v1\/analysis\/jobs\//);
      expect(evaluated.headers.get('Location')).toBe(body.jobUrl);
      expect(await db.processingJob.findUniqueOrThrow({ where: { id: body.jobId } })).toMatchObject({
        type: 'fires-watch-eval', status: 'queued',
      });
      expect(await db.outboxEvent.count({ where: { aggregateType: 'ProcessingJob', aggregateId: body.jobId, eventType: 'job.enqueued' } })).toBe(1);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  test('cross-tenant reads and writes are denied without leaking record contents', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockRejectedValue(new Error('provider must not run'));
    try {
      for (const handler of [farmDetail.GET, farmDetail.PATCH] as const) {
        const response = await handler(request(`farms/${farmB}`, handler === farmDetail.GET ? 'GET' : 'PATCH', cookieA, handler === farmDetail.GET ? undefined : { name: 'stolen' }), ctx({ farmId: farmB }));
        expect(response.status).toBe(404);
        expect(JSON.stringify(await response.json())).not.toContain('Task 5a farm');
      }
      expect((await watchDetail.DELETE(request(`fires/watchlists/${watchB}`, 'DELETE', cookieA), ctx({ id: watchB }))).status).toBe(404);
      expect((await evaluate.POST(request(`fires/watchlists/${watchB}/evaluate`, 'POST', cookieA, {}), ctx({ id: watchB }))).status).toBe(404);
      expect(provider).not.toHaveBeenCalled();
      expect(await db.fireWatchlist.findUnique({ where: { id: watchB } })).not.toBeNull();
    } finally {
      provider.mockRestore();
    }
  });

  test('public reads remain public while private ownership checks remain enforced', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockResolvedValue({
      checkedAt: '2026-11-24T00:00:00.000Z', probeMs: 0, signs: [],
      summary: { live: 0, degraded: 0, unreachable: 0 }, note: 'test',
    });
    const events = spyOn(eonet, 'fetchEonetWildfires').mockResolvedValue({
      ok: true, fresh: true, staleMs: null, days: 10, events: [], note: 'test',
    });
    try {
      const list = await farms.GET(request('farms'), ctx());
      expect(list.status).toBe(200);
      const ids = (await list.json()).farms.map((farm: { id: string }) => farm.id);
      expect(ids).toContain(publicFarm);
      expect(ids).not.toContain(farmA);
      expect(ids).not.toContain(farmB);
      expect((await farmDetail.GET(request(`farms/${publicFarm}`), ctx({ farmId: publicFarm }))).status).toBe(200);
      expect((await watchDetail.GET(request(`fires/watchlists/${publicWatch}`), ctx({ id: publicWatch }))).status).toBe(200);
      expect((await reports.POST(request('reports', 'POST', undefined, { farmId: publicFarm }), ctx())).status).toBe(200);
      expect((await reports.POST(request('reports', 'POST', cookieB, { farmId: farmA }), ctx())).status).toBe(404);
      expect((await status.GET(request('system/status'), ctx())).status).toBe(200);
      expect((await sources.GET(request('system/sources'), ctx())).status).toBe(200);
      expect(signs).toHaveBeenCalledWith(false);
    } finally {
      signs.mockRestore();
      events.mockRestore();
    }
  });

  test('experiment assignment is public and read-only while persistence requires verified same-origin writes', async () => {
    const unit = 'task5a-experiment-unit';
    const auditWhere = { targetId: unit };
    const auditCount = async () => db.auditEvent.count({ where: auditWhere });

    const assignment = await experiments.GET(request(`experiments?exp=landing-hero-v1&unit=${unit}`));
    expect(assignment.status).toBe(200);
    expect(await assignment.json()).toMatchObject({ experiment: 'landing-hero-v1', unitHashedBucket: expect.any(Number) });
    expect(await auditCount()).toBe(0);

    for (const cookie of [undefined, cookieUnverified]) {
      const denied = await experiments.POST(request('experiments', 'POST', cookie, {
        exp: 'landing-hero-v1', unit, outcome: 'experiment.cta_enter_console',
      }, { key: 'task5a-denied-experiment-key' }));
      expect(denied.status).toBe(401);
      expect(await auditCount()).toBe(0);
    }

    const crossOrigin = await experiments.POST(request('experiments', 'POST', cookieA, {
      exp: 'landing-hero-v1', unit, outcome: 'experiment.cta_enter_console',
    }, { key: 'task5a-cross-origin-experiment-key', source: 'https://evil.example.test' }));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });
    expect(await auditCount()).toBe(0);

    const body = { exp: 'landing-hero-v1', unit, outcome: 'experiment.cta_enter_console' };
    const accepted = await experiments.POST(request('experiments', 'POST', cookieA, body, { key: 'task5a-verified-experiment-key' }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ recorded: true, experiment: 'landing-hero-v1' });
    expect(await auditCount()).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: auditWhere });
    expect(audit.actor).toMatch(/^account:/);

    const replay = await experiments.POST(request('experiments', 'POST', cookieA, body, { key: 'task5a-verified-experiment-key' }));
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await auditCount()).toBe(1);
  });

  test('verified experiment persistence cannot bypass the shared Redis rate limit', async () => {
    const unit = 'task5a-rate-limited-unit';
    const where = { targetId: unit };
    const limitedUser = await db.accountUser.create({ data: { email: `rate-${crypto.randomUUID()}@task5a.test`, emailVerified: new Date() } });
    const limitedCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: limitedUser.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    for (let i = 0; i < 13; i++) {
      const response = await experiments.POST(request('experiments', 'POST', limitedCookie, {
        exp: 'landing-hero-v1', unit, outcome: 'experiment.exposure',
      }, { key: `task5a-experiment-rate-${i}` }));
      expect(response.status).toBe(i < 12 ? 200 : 429);
      if (response.status === 429) expect(response.headers.get('Retry-After')).not.toBeNull();
    }
    expect(await db.auditEvent.count({ where })).toBe(12);
  });

  test('anonymous status diagnostics redact destinations, configuration names, and raw errors', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockResolvedValue({
      checkedAt: '2026-11-24T00:00:00.000Z', probeMs: 1,
      signs: [{ key: 'NASA_POWER', label: 'NASA POWER', state: 'live', latencyMs: 1, checkedAt: '2026-11-24T00:00:00.000Z', detail: 'secret upstream error' }],
      summary: { live: 1, degraded: 0, unreachable: 0 }, note: 'test',
    });
    const previousEnv = {
      DIGEST_WEBHOOK_URL: process.env.DIGEST_WEBHOOK_URL,
      DIGEST_WEBHOOK_SECRET: process.env.DIGEST_WEBHOOK_SECRET,
      DIGEST_SMTP_HOST: process.env.DIGEST_SMTP_HOST,
      DIGEST_SMTP_PORT: process.env.DIGEST_SMTP_PORT,
      DIGEST_SMTP_FROM: process.env.DIGEST_SMTP_FROM,
      DIGEST_SMTP_TO: process.env.DIGEST_SMTP_TO,
      DIGEST_EMAIL_OFF: process.env.DIGEST_EMAIL_OFF,
      DIGEST_WEBHOOK_OFF: process.env.DIGEST_WEBHOOK_OFF,
    };
    process.env.DIGEST_WEBHOOK_URL = 'https://hooks.private.example.test:8443/secret-path';
    process.env.DIGEST_WEBHOOK_SECRET = 'private-webhook-signing-secret';
    process.env.DIGEST_SMTP_HOST = 'smtp.private.example.test';
    process.env.DIGEST_SMTP_PORT = '2525';
    process.env.DIGEST_SMTP_FROM = 'alerts@private.example.test';
    process.env.DIGEST_SMTP_TO = 'operator@private.example.test';
    delete process.env.DIGEST_EMAIL_OFF;
    delete process.env.DIGEST_WEBHOOK_OFF;
    try {
      const response = await status.GET(request('system/status'));
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const leaked of [
        'hooks.private.example.test', 'smtp.private.example.test', ':8443', ':2525',
        'operator@private.example.test', 'DIGEST_', 'FIRMS_MAP_KEY', 'secret-path',
        'private-webhook-signing-secret', 'lastError', 'targetUnsafeReason', 'secret upstream error',
      ]) expect(text).not.toContain(leaked);
      const body = JSON.parse(text);
      expect(body.digestChannel.exits.webhook).toEqual({ state: 'configured', attempts: 0, delivered: 0, failed: 0 });
      expect(body.digestChannel.exits.email).toEqual({ state: 'configured', attempts: 0, delivered: 0, failed: 0 });
      expect(body.digestEmail).toEqual({ state: 'configured', sent: 0, failed: 0 });
      expect(body.circuitBreakers).toEqual({ total: expect.any(Number), open: 0, withFailures: expect.any(Number) });
      expect(body.experiments[0]).toEqual({
        key: 'landing-hero-v1', active: true,
        variants: [
          { variant: 'control', exposures: expect.any(Number), outcomes: expect.any(Number) },
          { variant: 'fire-first', exposures: expect.any(Number), outcomes: expect.any(Number) },
        ],
      });
    } finally {
      signs.mockRestore();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('cache invalidation and forced probes require a verified administrator', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockResolvedValue({
      checkedAt: '2026-11-24T00:00:00.000Z', probeMs: 0, signs: [],
      summary: { live: 0, degraded: 0, unreachable: 0 }, note: 'test',
    });
    const events = spyOn(eonet, 'fetchEonetWildfires').mockResolvedValue({
      ok: true, fresh: true, staleMs: null, days: 10, events: [], note: 'test',
    });
    try {
      for (const cookie of [undefined, cookieUnverified, cookieA]) {
        expect((await status.POST(request('system/status?action=invalidate-cache', 'POST', cookie), ctx())).status).toBe(cookie === cookieA ? 403 : 401);
        expect((await sources.GET(request('system/sources?force=1', 'GET', cookie), ctx())).status).toBe(cookie === cookieA ? 403 : 401);
      }
      expect(signs).not.toHaveBeenCalled();

      await redisRuntime().setJson('task5a-cache-entry', { value: true }, { ttlMs: 60_000 });
      const invalidated = await status.POST(request('system/status?action=invalidate-cache', 'POST', cookieAdmin, undefined, { key: 'task5a-admin-cache-key' }), ctx());
      expect(invalidated.status).toBe(200);
      expect(await redisRuntime().getJson('task5a-cache-entry')).toBeUndefined();
      expect(await db.auditEvent.findFirst({ where: { actor: `account:${adminId}`, action: 'system.cache.invalidate' } })).not.toBeNull();

      const forced = await sources.GET(request('system/sources?force=1', 'GET', cookieAdmin), ctx());
      expect(forced.status).toBe(200);
      expect(signs).toHaveBeenCalledWith(true);
      expect(events).toHaveBeenCalled();
    } finally {
      signs.mockRestore();
      events.mockRestore();
    }
  });

  test('same-origin mutation checks also protect forced provider probes', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockRejectedValue(new Error('provider must not run'));
    const events = spyOn(eonet, 'fetchEonetWildfires').mockRejectedValue(new Error('provider must not run'));
    try {
      const crossOriginPatch = await farmDetail.PATCH(request(`farms/${farmA}`, 'PATCH', cookieA, { name: 'cross-site' }, { key: 'task5a-cross-origin-key', source: 'https://evil.example.test' }), ctx({ farmId: farmA }));
      expect(crossOriginPatch.status).toBe(403);
      expect(await crossOriginPatch.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });

      const crossOriginInvalidate = await status.POST(request('system/status?action=invalidate-cache', 'POST', cookieAdmin, undefined, { key: 'task5a-cross-origin-admin-key', source: 'https://evil.example.test' }), ctx());
      expect(crossOriginInvalidate.status).toBe(403);
      expect(await crossOriginInvalidate.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });

      const crossOriginProbe = await sources.GET(request('system/sources?force=1', 'GET', cookieAdmin, undefined, { source: 'https://evil.example.test' }), ctx());
      expect(crossOriginProbe.status).toBe(403);
      expect(await crossOriginProbe.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });
      expect(signs).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      signs.mockRestore();
      events.mockRestore();
    }
  });

  test('same-origin Fetch Metadata protects forced probes without requiring an Origin header on GET', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockResolvedValue({
      checkedAt: '2026-11-24T00:00:00.000Z', probeMs: 0, signs: [],
      summary: { live: 0, degraded: 0, unreachable: 0 }, note: 'test',
    });
    const events = spyOn(eonet, 'fetchEonetWildfires').mockResolvedValue({
      ok: true, fresh: true, staleMs: null, days: 10, events: [], note: 'test',
    });
    try {
      const sameOrigin = await sources.GET(new NextRequest(`${origin}/api/v1/system/sources?force=1`, {
        headers: { cookie: cookieAdmin, 'sec-fetch-site': 'same-origin' },
      }), ctx());
      expect(sameOrigin.status).toBe(200);
      expect(signs).toHaveBeenCalledTimes(1);

      signs.mockClear();
      const crossSite = await sources.GET(new NextRequest(`${origin}/api/v1/system/sources?force=1`, {
        headers: { cookie: cookieAdmin, 'sec-fetch-site': 'cross-site' },
      }), ctx());
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });
      expect(signs).not.toHaveBeenCalled();
      expect(events).toHaveBeenCalledTimes(1);
    } finally {
      signs.mockRestore();
      events.mockRestore();
    }
  });

  test('NextAuth credentials callbacks retain CSRF token enforcement', async () => {
    const password = 'a long task5a test password';
    await db.accountUser.create({ data: { email: 'csrf@task5a.test', emailVerified: new Date(), passwordHash: await hashPassword(password) } });
    const csrfResponse = await AuthHandler({
      req: { action: 'csrf', method: 'GET', headers: {}, cookies: {}, query: {}, body: {} },
      options: authOptions,
    });
    expect(csrfResponse.status ?? 200).toBe(200);
    const { csrfToken } = csrfResponse.body;
    expect(csrfToken).toEqual(expect.any(String));
    const csrfCookie = csrfResponse.cookies?.find((cookie: { name: string }) => cookie.name.endsWith('next-auth.csrf-token'));
    expect(csrfCookie).toBeDefined();
    const cookieHeader = `${csrfCookie!.name}=${csrfCookie!.value}`;

    const callback = (withToken: boolean) => AuthHandler({
      req: {
        action: 'callback', providerId: 'credentials', method: 'POST', headers: {}, query: {},
        cookies: { [csrfCookie!.name]: csrfCookie!.value },
        body: { email: 'csrf@task5a.test', password, callbackUrl: origin, ...(withToken ? { csrfToken } : {}) },
      },
      options: authOptions,
    });
    const missingToken = await callback(false);
    expect(missingToken.redirect).toContain('csrf=true');
    expect(missingToken.cookies?.some((cookie: { name: string }) => cookie.name.includes('next-auth.session-token'))).toBe(false);

    const validToken = await callback(true);
    expect(validToken.status ?? 302).toBe(302);
    expect(validToken.cookies?.some((cookie: { name: string }) => cookie.name.includes('next-auth.session-token'))).toBe(true);
    expect(cookieHeader).toContain('next-auth.csrf-token=');
  });

  test('the signed inbound webhook remains the sole unauthenticated domain-write exception', async () => {
    process.env.DIGEST_WEBHOOK_SECRET = 'task5a-webhook-test-secret-not-production';
    const rawBody = JSON.stringify({
      type: 'digest', watchlistId: publicWatch, reason: 'evaluation',
      triggeredAt: '2026-11-24T00:00:00Z', pushedAt: '2026-11-24T00:00:00Z', correlationId: 'task5a-webhook',
    });
    try {
      const invalid = await webhook.POST(new Request(`${origin}/api/v1/webhooks/digests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-terrafield-signature': 't=1,v1=bad' }, body: rawBody,
      }));
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
      expect(await db.outboxEvent.count({ where: { eventType: 'digest.webhook.received', aggregateId: publicWatch } })).toBe(0);

      const signed = buildWebhookHeaders({ secret: process.env.DIGEST_WEBHOOK_SECRET, bodyText: rawBody });
      const accepted = await webhook.POST(new Request(`${origin}/api/v1/webhooks/digests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'task5a-webhook', ...signed }, body: rawBody,
      }));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ accepted: true, correlationId: 'task5a-webhook' });
      expect(await db.outboxEvent.count({ where: { eventType: 'digest.webhook.received', aggregateId: publicWatch } })).toBe(1);
    } finally {
      delete process.env.DIGEST_WEBHOOK_SECRET;
    }
  });
}
