import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.TERRAFIELD_API_HARDENING_WORKER !== '1') {
  test('API hardening integration tests (isolated PostgreSQL and Redis)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/api-hardening.integration.ts'], {
      env: { ...process.env, TERRAFIELD_API_HARDENING_WORKER: '1' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('api_hardening');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'api-hardening-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://api-hardening.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.DIGEST_PUSH_OFF = '1';
  process.env.DIGEST_WEBHOOK_OFF = '1';
  process.env.DIGEST_EMAIL_OFF = '1';
  process.env.REDIS_KEY_PREFIX = `task5:${crypto.randomUUID()}:`;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { redisRuntime } = await import('@/lib/redis');
  const farms = await import('@/app/api/v1/farms/route');
  const farmDetail = await import('@/app/api/v1/farms/[farmId]/route');
  const soil = await import('@/app/api/v1/farms/[farmId]/soil-tests/route');
  const soilGrids = await import('@/app/api/v1/farms/[farmId]/soil-tests/soilgrids/route');
  const compare = await import('@/app/api/v1/rotation/compare/route');
  const scenarios = await import('@/app/api/v1/rotation/scenarios/route');
  const watchlists = await import('@/app/api/v1/fires/watchlists/route');
  const watchDetail = await import('@/app/api/v1/fires/watchlists/[id]/route');
  const evaluate = await import('@/app/api/v1/fires/watchlists/[id]/evaluate/route');
  const observations = await import('@/app/api/v1/observations/route');
  const fires = await import('@/app/api/v1/fires/route');
  const status = await import('@/app/api/v1/system/status/route');
  const sources = await import('@/app/api/v1/system/sources/route');
  const provenance = await import('@/app/api/v1/provenance/route');
  const register = await import('@/app/api/v1/account/register/route');
  const session = await import('@/app/api/v1/session/route');
  const webhook = await import('@/app/api/v1/webhooks/digests/route');
  const { buildWebhookHeaders } = await import('@/lib/fires/digest-exit-webhook');
  const sourceHealth = await import('@/lib/source-health');
  const eonet = await import('@/lib/adapters/eonet');
  const gibs = await import('@/lib/adapters/gibsFires');
  const soilgridsProvider = await import('@/lib/adapters/soilgrids');

  const origin = process.env.NEXTAUTH_URL!;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  let requestSequence = 0;
  const request = (
    path: string,
    method = 'GET',
    cookie?: string,
    body?: unknown,
    options: { key?: string; source?: string; correlationId?: string; rawBody?: string; headers?: Record<string, string> } = {},
  ) => new NextRequest(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      origin: options.source ?? origin,
      'content-type': 'application/json',
      'x-forwarded-for': `task5-${requestSequence++}`,
      ...(options.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
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
  let userA: string;
  let userB: string;
  let cookiePage: string;
  let userPage: string;
  let farmA: string;
  let publicFarm: string;
  let watchA: string;
  let publicWatch: string;

  beforeAll(async () => {
    await redisRuntime().ping();
    const a = await db.accountUser.create({ data: { email: 'a@api-hardening.test', emailVerified: new Date() } });
    const b = await db.accountUser.create({ data: { email: 'b@api-hardening.test', emailVerified: new Date() } });
    const unverified = await db.accountUser.create({ data: { email: 'unverified@api-hardening.test' } });
    const admin = await db.accountUser.create({ data: { email: 'admin@api-hardening.test', emailVerified: new Date(), isAdmin: true } });
    const page = await db.accountUser.create({ data: { email: 'page@api-hardening.test', emailVerified: new Date() } });
    userA = a.id;
    userB = b.id;
    userPage = page.id;
    const token = async (id: string) => `__Secure-next-auth.session-token=${await encode({ token: { sub: id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    cookieA = await token(a.id);
    cookieB = await token(b.id);
    cookieUnverified = await token(unverified.id);
    cookieAdmin = await token(admin.id);
    cookiePage = await token(page.id);
    const farm = { name: 'API hardening farm', centroidLat: 1, centroidLon: 2 };
    farmA = (await db.farm.create({ data: { ...farm, ownerId: a.id } })).id;
    await db.farm.create({ data: { ...farm, ownerId: b.id } });
    publicFarm = (await db.farm.create({ data: { ...farm, name: 'Seeded public farm' } })).id;
    const watch = { name: 'API hardening watch', lat: 1, lon: 2, lookbackDays: 3 };
    watchA = (await db.fireWatchlist.create({ data: { ...watch, ownerId: a.id } })).id;
    publicWatch = (await db.fireWatchlist.create({ data: { ...watch, name: 'Seeded public watch' } })).id;
  });

  afterAll(async () => {
    await db.$disconnect();
    await redisRuntime().close();
    await database.drop();
  });

  test('anonymous and unverified seeded PATCH/DELETE/evaluate are denied; signed-in users cannot mutate seeded rows', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockImplementation(async (date) => ({
      date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false,
    }));
    try {
      for (const cookie of [undefined, cookieUnverified]) {
        expect((await farmDetail.PATCH(request(`farms/${publicFarm}`, 'PATCH', cookie, { name: 'stolen' }), ctx({ farmId: publicFarm }))).status).toBe(401);
        expect((await watchDetail.DELETE(request(`fires/watchlists/${publicWatch}`, 'DELETE', cookie), ctx({ id: publicWatch }))).status).toBe(401);
        expect((await evaluate.POST(request(`fires/watchlists/${publicWatch}/evaluate`, 'POST', cookie, {}), ctx({ id: publicWatch }))).status).toBe(401);
      }
      expect((await farmDetail.PATCH(request(`farms/${publicFarm}`, 'PATCH', cookieA, { name: 'stolen' }), ctx({ farmId: publicFarm }))).status).toBe(403);
      expect((await watchDetail.DELETE(request(`fires/watchlists/${publicWatch}`, 'DELETE', cookieA), ctx({ id: publicWatch }))).status).toBe(403);
      const publicEvaluation = await evaluate.POST(request(`fires/watchlists/${publicWatch}/evaluate`, 'POST', cookieA, {}), ctx({ id: publicWatch }));
      expect(publicEvaluation.status, await publicEvaluation.clone().text()).toBe(403);
      expect(provider).not.toHaveBeenCalled();
      expect((await db.farm.findUniqueOrThrow({ where: { id: publicFarm } })).name).toBe('Seeded public farm');
      expect(await db.fireWatchlist.findUnique({ where: { id: publicWatch } })).not.toBeNull();
    } finally {
      provider.mockRestore();
    }
  });

  test('cross-tenant farm, soil, scenario, comparison and watchlist writes are denied before provider work', async () => {
    const provider = spyOn(gibs, 'fetchFiresForDate').mockImplementation(async (date) => ({
      date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false,
    }));
    try {
      expect((await farmDetail.PATCH(request(`farms/${farmA}`, 'PATCH', cookieB, { name: 'stolen' }), ctx({ farmId: farmA }))).status).toBe(404);
      expect((await soil.POST(request(`farms/${farmA}/soil-tests`, 'POST', cookieB, { measuredAt: '2026-01-01', source: 'farmer' }), ctx({ farmId: farmA }))).status).toBe(404);
      expect((await scenarios.POST(request('rotation/scenarios', 'POST', cookieB, { farmId: farmA, name: 'stolen', cropKeys: ['maize'] }), ctx())).status).toBe(404);
      expect((await compare.POST(request('rotation/compare', 'POST', cookieB, { farmId: farmA, scenarios: [{ name: 'one', cropKeys: ['maize'] }, { name: 'two', cropKeys: ['sorghum'] }] }), ctx())).status).toBe(404);
      expect((await watchDetail.PATCH(request(`fires/watchlists/${watchA}`, 'PATCH', cookieB, { name: 'stolen' }), ctx({ id: watchA }))).status).toBe(404);
      expect((await watchDetail.DELETE(request(`fires/watchlists/${watchA}`, 'DELETE', cookieB), ctx({ id: watchA }))).status).toBe(404);
      expect((await evaluate.POST(request(`fires/watchlists/${watchA}/evaluate`, 'POST', cookieB, {}), ctx({ id: watchA }))).status).toBe(404);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  test('every domain mutation requires a verified account', async () => {
    const soilProvider = spyOn(soilgridsProvider, 'fetchSoilGridsPoint').mockRejectedValue(new Error('provider must not run'));
    const fireProvider = spyOn(gibs, 'fetchFiresForDate').mockRejectedValue(new Error('provider must not run'));
    try {
      const calls: Array<Promise<Response>> = [
        farms.POST(request('farms', 'POST', undefined, { name: 'anonymous', centroidLat: 1, centroidLon: 2 }), ctx()),
        soil.POST(request(`farms/${publicFarm}/soil-tests`, 'POST', undefined, { measuredAt: '2026-01-01', source: 'farmer' }), ctx({ farmId: publicFarm })),
        soilGrids.POST(request(`farms/${publicFarm}/soil-tests/soilgrids`, 'POST', undefined, {}), ctx({ farmId: publicFarm })),
        scenarios.POST(request('rotation/scenarios', 'POST', undefined, { farmId: publicFarm, name: 'anonymous', cropKeys: ['maize'] }), ctx()),
        compare.POST(request('rotation/compare', 'POST', undefined, { farmId: publicFarm, scenarios: [{ name: 'one', cropKeys: ['maize'] }, { name: 'two', cropKeys: ['sorghum'] }] }), ctx()),
        watchlists.POST(request('fires/watchlists', 'POST', undefined, { name: 'anonymous', lat: 1, lon: 2 }), ctx()),
      ];
      for (const call of calls) expect((await call).status).toBe(401);
      expect(soilProvider).not.toHaveBeenCalled();
      expect(fireProvider).not.toHaveBeenCalled();
    } finally {
      soilProvider.mockRestore();
      fireProvider.mockRestore();
    }
  });

  test('cache invalidation and forced source probes are administrator-only', async () => {
    const signs = spyOn(sourceHealth, 'sourceSigns').mockResolvedValue({
      checkedAt: '2026-11-24T00:00:00.000Z', probeMs: 0, signs: [],
      summary: { live: 0, degraded: 0, unreachable: 0 }, note: 'test',
    });
    const events = spyOn(eonet, 'fetchEonetWildfires').mockResolvedValue({
      ok: true, fresh: true, staleMs: null, days: 10, events: [], note: 'test',
    });
    try {
      expect((await status.POST(request('system/status?action=invalidate-cache', 'POST'), ctx())).status).toBe(401);
      expect((await status.POST(request('system/status?action=invalidate-cache', 'POST', cookieA), ctx())).status).toBe(403);
      expect((await status.POST(request('system/status?action=invalidate-cache', 'POST', cookieAdmin, undefined, { key: 'admin-cache-action-1' }), ctx())).status).toBe(200);
      expect((await sources.GET(request('system/sources?force=1'), ctx())).status).toBe(401);
      expect((await sources.GET(request('system/sources?force=1', 'GET', cookieA), ctx())).status).toBe(403);
      expect((await sources.GET(request('system/sources?force=1', 'GET', cookieAdmin), ctx())).status).toBe(200);
      expect(signs).toHaveBeenCalledWith(true);
      expect(events).toHaveBeenCalled();
    } finally {
      signs.mockRestore();
      events.mockRestore();
    }
  });

  test('parseBody enforces the shared byte cap and strict JSON', async () => {
    const body = { name: 'too large', centroidLat: 1, centroidLon: 2, notes: 'x'.repeat(140 * 1024) };
    const oversized = await farms.POST(request('farms', 'POST', cookieA, body, { key: 'oversized-body-key-1' }), ctx());
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    const malformed = await farms.POST(request('farms', 'POST', cookieA, undefined, { key: 'invalid-json-key-1', rawBody: '{' }), ctx());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });

  test('strict calendar dates and ordered ranges are enforced', async () => {
    expect((await soil.POST(request(`farms/${farmA}/soil-tests`, 'POST', cookieA, { measuredAt: '2026-02-30', source: 'farmer' }, { key: 'invalid-calendar-key-1' }), ctx({ farmId: farmA }))).status).toBe(400);
    expect((await fires.GET(request('fires?lat=1&lon=2&from=2026-02-30&to=2026-03-01'), ctx())).status).toBe(400);
    expect((await fires.GET(request('fires?lat=1&lon=2&from=2026-03-02&to=2026-03-01'), ctx())).status).toBe(400);
    expect((await observations.GET(request('observations?lat=1&lon=2&from=2026-02-30&to=2026-03-01'), ctx())).status).toBe(400);
    expect((await observations.GET(request('observations?lat=1&lon=2&from=2026-03-02&to=2026-03-01'), ctx())).status).toBe(400);
    expect((await evaluate.POST(request(`fires/watchlists/${watchA}/evaluate`, 'POST', cookieA, { end: '2026-02-30' }, { key: 'invalid-eval-date-key-1' }), ctx({ id: watchA }))).status).toBe(400);
  });

  test('cursor pagination is bounded and rejects malformed cursors and limits', async () => {
    expect((await farms.GET(request('farms?limit=0'), ctx())).status).toBe(400);
    expect((await farms.GET(request('farms?limit=101'), ctx())).status).toBe(400);
    expect((await farms.GET(request('farms?cursor=not-a-valid-cursor'), ctx())).status).toBe(400);
    expect((await observations.GET(request('observations?lat=1&lon=2&limit=10001'), ctx())).status).toBe(400);
    const created: string[] = [];
    for (let i = 0; i < 2; i++) {
      const row = await db.farm.create({ data: { ownerId: userPage, name: `Page farm ${i}`, centroidLat: 1, centroidLon: 2, createdAt: new Date(Date.UTC(2026, 0, i + 1)) } });
      created.push(row.id);
    }
    const first = await farms.GET(request('farms?limit=2', 'GET', cookiePage), ctx());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.farms).toHaveLength(2);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const second = await farms.GET(request(`farms?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`, 'GET', cookiePage), ctx());
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.farms).toHaveLength(1);
    expect(new Set([...firstBody.farms, ...secondBody.farms].map((farm: { id: string }) => farm.id)).size).toBe(3);
    expect(secondBody.farms.some((farm: { id: string }) => created.includes(farm.id))).toBe(true);
  });

  test('matching idempotent retries replay one result and conflicting fingerprints are rejected', async () => {
    const key = 'farm-create-idempotency-key-1';
    const body = { name: 'Idempotent farm', centroidLat: 3, centroidLon: 4 };
    const first = await farms.POST(request('farms', 'POST', cookieA, body, { key }), ctx());
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const second = await farms.POST(request('farms', 'POST', cookieA, body, { key }), ctx());
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.json()).toEqual(firstBody);
    expect(await db.farm.count({ where: { name: body.name, ownerId: userA } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'farm.create', targetId: firstBody.farm.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateType: 'Farm', aggregateId: firstBody.farm.id } })).toBe(1);
    expect(await db.idempotencyRecord.count({ where: { ownerId: userA, route: '/api/v1/farms', key } })).toBe(1);
    const conflict = await farms.POST(request('farms', 'POST', cookieA, { ...body, name: 'Conflicting farm' }, { key }), ctx());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const missing = await farms.POST(request('farms', 'POST', cookieA, { name: 'Missing key farm', centroidLat: 3, centroidLon: 4 }), ctx());
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    const otherTenant = await farms.POST(request('farms', 'POST', cookieB, body, { key }), ctx());
    expect(otherTenant.status).toBe(201);
    expect((await otherTenant.json()).farm.ownerId).toBe(userB);
  });

  test('audit failure rolls back farm, outbox and idempotency response reference', async () => {
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "fail_task5_audit"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'task5 audit failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "fail_task5_audit_trigger" BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION "fail_task5_audit"()
    `);
    try {
      const beforeOutbox = await db.outboxEvent.count({ where: { eventType: 'farm.created' } });
      const response = await farms.POST(request('farms', 'POST', cookieA, { name: 'Rollback farm', centroidLat: 5, centroidLon: 6 }, { key: 'audit-rollback-key-1' }), ctx());
      expect(response.status).toBe(500);
      expect(await db.farm.count({ where: { name: 'Rollback farm' } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { eventType: 'farm.created' } })).toBe(beforeOutbox);
      expect(await db.idempotencyRecord.count({ where: { key: 'audit-rollback-key-1' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "fail_task5_audit_trigger" ON "AuditEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "fail_task5_audit"()');
    }
  });

  test('rotation replacement rejects duplicate names, deduplicates crops and atomically upserts a serializable set', async () => {
    const duplicateNames = await compare.POST(request('rotation/compare', 'POST', cookieA, {
      farmId: farmA,
      scenarios: [{ name: 'same', cropKeys: ['maize'] }, { name: 'same', cropKeys: ['sorghum'] }],
    }, { key: 'duplicate-scenario-names-key-1' }), ctx());
    expect(duplicateNames.status).toBe(400);
    expect(await duplicateNames.json()).toMatchObject({ error: { code: 'DUPLICATE_SCENARIO_NAME' } });

    const body = {
      farmId: farmA,
      scenarios: [
        { name: 'Atomic one', cropKeys: ['maize', 'maize', 'common_bean'] },
        { name: 'Atomic two', cropKeys: ['sorghum'] },
      ],
    };
    const first = await compare.POST(request('rotation/compare', 'POST', cookieA, body, { key: 'rotation-atomic-set-key-1' }), ctx());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const rows = await db.rotationScenario.findMany({ where: { farmId: farmA }, orderBy: { name: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].cropKeys)).toEqual(['maize', 'common_bean']);
    const ids = rows.map((row) => row.id).sort();
    const second = await compare.POST(request('rotation/compare', 'POST', cookieA, {
      ...body,
      scenarios: [{ name: 'Atomic one', cropKeys: ['common_bean', 'maize'] }, { name: 'Atomic two', cropKeys: ['maize'] }],
    }, { key: 'rotation-atomic-set-key-2' }), ctx());
    expect(second.status).toBe(200);
    const replaced = await db.rotationScenario.findMany({ where: { farmId: farmA }, orderBy: { name: 'asc' } });
    expect(replaced.map((row) => row.id).sort()).toEqual(ids);
    expect(JSON.parse(replaced[0].cropKeys)).toEqual(['common_bean', 'maize']);
    expect(await db.auditEvent.count({ where: { action: 'scenario.compare', targetId: farmA } })).toBe(2);
    expect(await db.outboxEvent.count({ where: { aggregateType: 'Farm', aggregateId: farmA, eventType: 'scenario.compared' } })).toBe(2);
    expect(firstBody.jobId).toEqual(expect.any(String));
  });

  test('soil and scenario writes persist audit and outbox rows', async () => {
    const soilResponse = await soil.POST(request(`farms/${farmA}/soil-tests`, 'POST', cookieA, { measuredAt: '2026-01-02', source: 'laboratory', ph: 6.4 }, { key: 'soil-outbox-key-1' }), ctx({ farmId: farmA }));
    expect(soilResponse.status).toBe(201);
    const soilBody = await soilResponse.json();
    expect(await db.auditEvent.count({ where: { action: 'soil-test.create', targetId: soilBody.soilTest.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateType: 'SoilTest', aggregateId: soilBody.soilTest.id } })).toBe(1);
    const scenarioResponse = await scenarios.POST(request('rotation/scenarios', 'POST', cookieA, { farmId: farmA, name: 'Outbox scenario', cropKeys: ['maize', 'common_bean'] }, { key: 'scenario-outbox-key-1' }), ctx());
    expect(scenarioResponse.status).toBe(201);
    const scenarioBody = await scenarioResponse.json();
    expect(await db.auditEvent.count({ where: { action: 'scenario.create', targetId: scenarioBody.scenarioId } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateType: 'RotationScenario', aggregateId: scenarioBody.scenarioId } })).toBe(1);
  });

  test('bypass routes use correlation headers and structured errors without weakening origin or HMAC checks', async () => {
    const correlationId = 'bypass-correlation-test';
    const invalidRegistration = await register.POST(request('account/register', 'POST', undefined, undefined, { correlationId, key: 'ignored-auth-key', rawBody: '{' }));
    expect(invalidRegistration.status).toBe(400);
    expect(invalidRegistration.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await invalidRegistration.json()).toMatchObject({ error: { code: 'INVALID_JSON', correlationId } });
    const crossOriginSession = await session.POST(request('session', 'POST', undefined, undefined, { correlationId, source: 'https://evil.example.test' }));
    expect(crossOriginSession.status).toBe(403);
    expect(crossOriginSession.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await crossOriginSession.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN', correlationId } });
    const provenanceResponse = await provenance.GET(request('provenance', 'GET', undefined, undefined, { correlationId }));
    expect(provenanceResponse.status).toBe(200);
    expect(provenanceResponse.headers.get('X-Correlation-Id')).toBe(correlationId);

    process.env.DIGEST_WEBHOOK_SECRET = 'task5-webhook-secret-not-production';
    const rawBody = JSON.stringify({ type: 'digest', watchlistId: publicWatch, reason: 'evaluation', triggeredAt: '2026-11-24T00:00:00Z', pushedAt: '2026-11-24T00:00:00Z', correlationId });
    const signed = buildWebhookHeaders({ secret: process.env.DIGEST_WEBHOOK_SECRET, bodyText: rawBody });
    const invalid = await webhook.POST(new Request(`${origin}/api/v1/webhooks/digests`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId, 'x-terrafield-signature': 't=1,v1=bad' }, body: rawBody,
    }));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE', correlationId } });
    const accepted = await webhook.POST(new Request(`${origin}/api/v1/webhooks/digests`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId, ...signed }, body: rawBody,
    }));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('X-Correlation-Id')).toBe(correlationId);
    expect(await accepted.json()).toMatchObject({ accepted: true, correlationId });
    expect(await db.outboxEvent.count({ where: { eventType: 'digest.webhook.received', aggregateId: publicWatch } })).toBe(1);
    delete process.env.DIGEST_WEBHOOK_SECRET;
  });
}
