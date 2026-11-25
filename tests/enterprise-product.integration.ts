import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.TERRAFIELD_ENTERPRISE_TEST_WORKER !== '1') {
  test('enterprise product integration (isolated PostgreSQL and Redis)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/enterprise-product.integration.ts'], {
      env: { ...process.env, TERRAFIELD_ENTERPRISE_TEST_WORKER: '1' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('enterprise_product');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'enterprise-product-test-secret-only';
  process.env.NEXTAUTH_URL = 'https://enterprise.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.DIGEST_PUSH_OFF = '1';
  process.env.DIGEST_WEBHOOK_OFF = '1';
  process.env.DIGEST_EMAIL_OFF = '1';
  process.env.WEBHOOK_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.REDIS_KEY_PREFIX = `enterprise:${crypto.randomUUID()}:`;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { redisRuntime } = await import('@/lib/redis');
  const organizations = await import('@/app/api/v1/organizations/route');
  const acceptInvitation = await import('@/app/api/v1/organizations/invitations/accept/route');
  const memberDetail = await import('@/app/api/v1/organizations/[id]/members/[membershipId]/route');
  const workspaces = await import('@/app/api/v1/organizations/[id]/workspaces/route');
  const farms = await import('@/app/api/v1/farms/route');
  const farmDetail = await import('@/app/api/v1/farms/[farmId]/route');
  const apiKeys = await import('@/app/api/v1/api-keys/route');
  const revokeApiKey = await import('@/app/api/v1/api-keys/[id]/route');
  const developerFarms = await import('@/app/api/v1/developer/farms/route');
  const webhooks = await import('@/app/api/v1/webhooks/route');
  const billing = await import('@/app/api/v1/billing/route');
  const reports = await import('@/app/api/v1/reports/route');
  const reportCsv = await import('@/app/api/v1/reports/[id]/csv/route');
  const adminOverview = await import('@/app/api/v1/admin/overview/route');
  const featureFlags = await import('@/app/api/v1/admin/feature-flags/route');
  const intelligence = await import('@/app/api/v1/intelligence/plans/route');
  const approveIntelligence = await import('@/app/api/v1/intelligence/runs/[id]/approve/route');
  const stac = await import('@/app/api/v1/stac/search/route');
  const { tokenHash, verificationToken } = await import('@/lib/account-security');
  const { enqueueWebhookDeliveries, dispatchPendingWebhooks } = await import('@/lib/outbox-worker');
  const { verifyWebhookSignature } = await import('@/lib/fires/digest-exit-webhook');

  const origin = process.env.NEXTAUTH_URL!;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  let sequence = 0;
  const request = (
    path: string,
    method = 'GET',
    options: { cookie?: string; body?: unknown; organizationId?: string; headers?: Record<string, string>; idempotencyKey?: string } = {},
  ) => new NextRequest(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      'x-forwarded-for': `enterprise-${sequence++}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': options.idempotencyKey ?? `enterprise-${sequence}` }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.organizationId ? { 'x-terrafield-organization': options.organizationId } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  let cookieA: string;
  let cookieB: string;
  let userA: string;
  let organizationA: string;
  let organizationB: string;
  let workspaceA: string;
  let farmA: string;
  let farmB: string;
  let apiSecret: string;
  let apiKeyId: string;
  let webhookId: string;

  beforeAll(async () => {
    await redisRuntime().ping();
    const a = await db.accountUser.create({ data: { email: 'owner-a@enterprise.test', emailVerified: new Date() } });
    const b = await db.accountUser.create({ data: { email: 'owner-b@enterprise.test', emailVerified: new Date() } });
    userA = a.id;
    const token = async (id: string) => `__Secure-next-auth.session-token=${await encode({ token: { sub: id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    cookieA = await token(a.id);
    cookieB = await token(b.id);

    const createdA = await organizations.POST(request('organizations', 'POST', { cookie: cookieA, body: { name: 'Kampala Cooperative', country: 'Uganda' } }), ctx());
    expect(createdA.status, await createdA.clone().text()).toBe(201);
    const bodyA = await createdA.json();
    organizationA = bodyA.organization.id;
    workspaceA = bodyA.workspace.id;

    const createdB = await organizations.POST(request('organizations', 'POST', { cookie: cookieB, body: { name: 'Nairobi Research Group', country: 'Kenya' } }), ctx());
    expect(createdB.status, await createdB.clone().text()).toBe(201);
    organizationB = (await createdB.json()).organization.id;

    const createdFarmA = await farms.POST(request('farms', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { name: 'Cooperative maize farm', centroidLat: 0.31, centroidLon: 32.58, workspaceId: workspaceA, country: 'Uganda' },
    }), ctx());
    expect(createdFarmA.status, await createdFarmA.clone().text()).toBe(201);
    farmA = (await createdFarmA.json()).farm.id;

    const createdFarmB = await farms.POST(request('farms', 'POST', {
      cookie: cookieB,
      organizationId: organizationB,
      body: { name: 'Foreign research farm', centroidLat: -1.29, centroidLon: 36.82, country: 'Kenya' },
    }), ctx());
    expect(createdFarmB.status, await createdFarmB.clone().text()).toBe(201);
    farmB = (await createdFarmB.json()).farm.id;
  });

  afterAll(async () => {
    await db.$disconnect();
    await redisRuntime().close();
    await database.drop();
  });

  test('organization portfolio and workspace resources are tenant scoped', async () => {
    const list = await organizations.GET(request('organizations', 'GET', { cookie: cookieA }), ctx());
    const body = await list.json();
    expect(body.organizations.map((item: { id: string }) => item.id)).toEqual([organizationA]);

    const foreign = await farmDetail.GET(request(`farms/${farmB}`, 'GET', { cookie: cookieA }), ctx({ farmId: farmB }));
    expect(foreign.status).toBe(404);
    const forged = await farmDetail.GET(request(`farms/${farmA}`, 'GET', { cookie: cookieB, organizationId: organizationA }), ctx({ farmId: farmA }));
    expect(forged.status).toBe(403);

    const workspaceList = await workspaces.GET(request(`organizations/${organizationA}/workspaces`, 'GET', { cookie: cookieA, organizationId: organizationA }), ctx({ id: organizationA }));
    expect(workspaceList.status).toBe(200);
    expect((await workspaceList.json()).workspaces.some((item: { id: string }) => item.id === workspaceA)).toBe(true);
  });

  test('API keys are shown once, scoped, metered, and revocable', async () => {
    const idempotencyKey = `api-key-secret-once-${sequence++}`;
    const options = {
      cookie: cookieA,
      organizationId: organizationA,
      idempotencyKey,
      body: { name: 'Cooperative integration', scopes: ['farms.read'] },
    };
    const created = await apiKeys.POST(request('api-keys', 'POST', options), ctx());
    expect(created.status, await created.clone().text()).toBe(201);
    const body = await created.json();
    apiSecret = body.secret;
    apiKeyId = body.key.id;
    expect(apiSecret).toMatch(/^tf_live_/);
    const stored = await db.apiKey.findUniqueOrThrow({ where: { id: apiKeyId } });
    expect(stored.keyHash).not.toBe(apiSecret);
    expect(JSON.stringify(stored)).not.toContain(apiSecret);
    const replayRecord = await db.idempotencyRecord.findUniqueOrThrow({ where: { ownerId_route_key: { ownerId: userA, route: '/api/v1/api-keys', key: idempotencyKey } } });
    expect(replayRecord.responseRef).not.toContain(apiSecret);
    const replay = await apiKeys.POST(request('api-keys', 'POST', options), ctx());
    expect(replay.status).toBe(201);
    expect(JSON.stringify(await replay.json())).not.toContain(apiSecret);

    const listed = await apiKeys.GET(request('api-keys', 'GET', { cookie: cookieA, organizationId: organizationA }), ctx());
    const listedText = JSON.stringify(await listed.json());
    expect(listedText).not.toContain(apiSecret);
    expect(listedText).not.toContain(stored.keyHash);

    const developer = await developerFarms.GET(request('developer/farms', 'GET', { headers: { authorization: `Bearer ${apiSecret}` } }), ctx());
    expect(developer.status, await developer.clone().text()).toBe(200);
    const farmsBody = await developer.json();
    expect(farmsBody.farms.map((item: { id: string }) => item.id)).toContain(farmA);
    expect(farmsBody.farms.map((item: { id: string }) => item.id)).not.toContain(farmB);
    expect(await db.usageEvent.count({ where: { metric: 'api_requests_per_day', organizationId: organizationA } })).toBe(1);

    const revoked = await revokeApiKey.DELETE(request(`api-keys/${apiKeyId}`, 'DELETE', { cookie: cookieA, organizationId: organizationA }), ctx({ id: apiKeyId }));
    expect(revoked.status).toBe(200);
    const denied = await developerFarms.GET(request('developer/farms', 'GET', { headers: { authorization: `Bearer ${apiSecret}` } }), ctx());
    expect(denied.status).toBe(401);
  });

  test('webhook signing secrets are encrypted and never returned by list APIs', async () => {
    const created = await webhooks.POST(request('webhooks', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { name: 'Farm events', url: 'https://example.com/terrafield-webhook', events: ['farm.created', 'job.succeeded'] },
    }), ctx());
    expect(created.status, await created.clone().text()).toBe(201);
    const body = await created.json();
    webhookId = body.webhook.id;
    expect(body.secret).toHaveLength(43);
    const stored = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: webhookId } });
    expect(stored.secretCiphertext).not.toBe(body.secret);
    expect(stored.secretIv).not.toBe('');
    expect(stored.secretTag).not.toBe('');

    const listed = await webhooks.GET(request('webhooks', 'GET', { cookie: cookieA, organizationId: organizationA }), ctx());
    const text = JSON.stringify(await listed.json());
    expect(text).not.toContain(body.secret);
    expect(text).not.toContain(stored.secretCiphertext);
    expect(text).not.toContain('secretIv');
    expect(text).not.toContain('secretTag');
  });

  test('webhook secret idempotency records are redacted and replay rechecks authorization', async () => {
    const manager = await db.accountUser.create({ data: { email: 'webhook-replay-manager@enterprise.test', emailVerified: new Date() } });
    const membership = await db.membership.create({ data: { organizationId: organizationA, userId: manager.id, role: 'admin', status: 'active' } });
    const managerCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: manager.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const key = `webhook-secret-replay-${sequence++}`;
    const options = {
      cookie: managerCookie,
      organizationId: organizationA,
      idempotencyKey: key,
      body: { name: 'Replay-safe webhook', url: 'https://example.com/replay-safe-webhook', events: ['farm.created'] },
    };
    const created = await webhooks.POST(request('webhooks', 'POST', options), ctx());
    expect(created.status, await created.clone().text()).toBe(201);
    const { secret, webhook } = await created.json();
    const record = await db.idempotencyRecord.findUniqueOrThrow({ where: { ownerId_route_key: { ownerId: manager.id, route: '/api/v1/webhooks', key } } });
    expect(record.responseRef).not.toContain(secret);

    const replay = await webhooks.POST(request('webhooks', 'POST', options), ctx());
    expect(replay.status).toBe(201);
    expect(JSON.stringify(await replay.json())).not.toContain(secret);

    await db.membership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
    const unauthorizedReplay = await webhooks.POST(request('webhooks', 'POST', options), ctx());
    expect(unauthorizedReplay.status).toBe(403);
    await db.webhookEndpoint.update({ where: { id: webhook.id }, data: { status: 'disabled' } });
  });

  test('billing exposes configurable plans, entitlements, usage, and honest payment state', async () => {
    const response = await billing.GET(request('billing', 'GET', { cookie: cookieA, organizationId: organizationA }), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.plans.map((plan: { code: string }) => plan.code)).toEqual(['explorer', 'professional', 'cooperative', 'enterprise', 'institutional']);
    expect(body.subscription.status).toBe('trialing');
    expect(body.entitlements.capabilities.organization).toBe(true);
    expect(body.paymentNote).toContain('No payment provider');
  });

  test('intelligence plans require approval and record audited tool evidence', async () => {
    const created = await intelligence.POST(request('intelligence/plans', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { query: 'Summarize farms in this cooperative portfolio' },
    }), ctx());
    expect(created.status, await created.clone().text()).toBe(201);
    const body = await created.json();
    expect(body.plan.intent).toBe('portfolio.summary');
    expect(body.run.status).toBe('awaiting_approval');
    const approved = await approveIntelligence.POST(request(`intelligence/runs/${body.run.id}/approve`, 'POST', { cookie: cookieA, organizationId: organizationA, body: {} }), ctx({ id: body.run.id }));
    expect(approved.status, await approved.clone().text()).toBe(200);
    const result = await approved.json();
    expect(result.run.status).toBe('succeeded');
    expect(result.result.results['portfolio.summary'].farms.map((farm: { id: string }) => farm.id)).toContain(farmA);
    expect(result.result.results['portfolio.summary'].farms.map((farm: { id: string }) => farm.id)).not.toContain(farmB);
    expect(await db.toolExecution.count({ where: { agentRunId: body.run.id, status: 'succeeded' } })).toBe(1);
    expect(await db.evidenceReference.count({ where: { agentRunId: body.run.id } })).toBe(1);
  });

  test('intelligence run listings require analysis permission and omit prompts and results', async () => {
    const viewer = await db.accountUser.create({ data: { email: 'intelligence-viewer@enterprise.test', emailVerified: new Date() } });
    await db.membership.create({ data: { organizationId: organizationA, userId: viewer.id, role: 'viewer', status: 'active' } });
    const viewerCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: viewer.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const denied = await intelligence.GET(request('intelligence/plans', 'GET', { cookie: viewerCookie, organizationId: organizationA }), ctx());
    expect(denied.status).toBe(403);

    const listed = await intelligence.GET(request('intelligence/plans', 'GET', { cookie: cookieA, organizationId: organizationA }), ctx());
    expect(listed.status).toBe(200);
    const text = JSON.stringify(await listed.json());
    expect(text).not.toContain('planJson');
    expect(text).not.toContain('resultJson');
    expect(text).not.toContain('query');
    expect(text).toContain('intent');
  });

  test('intelligence rejects a farm ID from another tenant before creating a run', async () => {
    const response = await intelligence.POST(request('intelligence/plans', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { query: 'Show soil and crop context for this farm', farmId: farmB },
    }), ctx());
    expect(response.status, await response.clone().text()).toBe(404);
  });

  test('approved fire summaries use evaluation history inside the approved range', async () => {
    const watchlist = await db.fireWatchlist.create({ data: {
      ownerId: userA,
      organizationId: organizationA,
      name: 'Historical fire range',
      lat: 0.4,
      lon: 32.5,
      lastStatus: 'alert',
      lastDetectionCount: 12,
      lastEvaluatedAt: new Date('2023-06-01T00:00:00Z'),
    } });
    const eventData = (status: string, evaluatedAt: string, detectionCount: number) => ({
      watchlistId: watchlist.id,
      evaluatedAt: new Date(evaluatedAt),
      windowStart: new Date('2023-01-01T00:00:00Z'),
      windowEnd: new Date(evaluatedAt),
      status,
      detectionCount,
      highConfidenceCount: detectionCount,
      nominalCount: 0,
      lowCount: 0,
      daysWithDetections: 1,
      daysChecked: 1,
      daysNoData: 0,
      triggeredAlert: status === 'alert',
      detailJson: JSON.stringify({ source: 'test' }),
    });
    await db.fireWatchEvent.createMany({ data: [
      eventData('alert', '2023-06-01T00:00:00Z', 12),
      eventData('clear', '2024-06-01T00:00:00Z', 0),
    ] });
    const plan = {
      intent: 'fire.summary', agent: 'Risk Analyst', geographicScope: { farmId: null, lat: null, lon: null, label: 'Organization portfolio' },
      datasets: ['VIIRS 375 m detections via GIBS', 'Fire watchlist evaluations'], method: 'Authorized watchlist status and detection-count summary',
      tools: ['fire.summary'], dateRange: { from: '2024-01-01', to: '2024-12-31' }, requiresApproval: true, limitations: [],
    };
    const run = await db.agentRun.create({ data: { ownerId: userA, organizationId: organizationA, query: 'Fire summary for 2024', planJson: JSON.stringify(plan), status: 'awaiting_approval', limitationsJson: '[]' } });
    const approved = await approveIntelligence.POST(request(`intelligence/runs/${run.id}/approve`, 'POST', { cookie: cookieA, organizationId: organizationA, body: {} }), ctx({ id: run.id }));
    expect(approved.status, await approved.clone().text()).toBe(200);
    const result = (await approved.json()).result.results['fire.summary'];
    expect(result.dateRange).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(result.byStatus.clear).toBe(1);
    expect(result.alerting).toHaveLength(0);
  });

  test('unsupported intelligence plans cannot be approved', async () => {
    const created = await intelligence.POST(request('intelligence/plans', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { query: 'Execute an autonomous financial trade' },
    }), ctx());
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.plan.intent).toBe('unsupported');
    expect(body.canExecute).toBe(false);
    const approved = await approveIntelligence.POST(request(`intelligence/runs/${body.run.id}/approve`, 'POST', { cookie: cookieA, organizationId: organizationA, body: {} }), ctx({ id: body.run.id }));
    expect(approved.status).toBe(409);
  });

  test('STAC search validates geometry and date bounds before provider access', async () => {
    const invalid = await stac.GET(request('stac/search?geometry=%7B%22type%22%3A%22Point%22%7D'), ctx());
    expect(invalid.status).toBe(400);
    const reversed = await stac.GET(request('stac/search?from=2026-11-25&to=2026-11-24'), ctx());
    expect(reversed.status).toBe(400);
  });

  test('organization invitations bind to the invited email and are single-use', async () => {
    const invited = await db.accountUser.create({ data: { email: 'analyst@enterprise.test', emailVerified: new Date() } });
    const invitedCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: invited.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const token = verificationToken();
    await db.organizationInvitation.create({
      data: {
        organizationId: organizationA,
        email: invited.email,
        role: 'analyst',
        tokenHash: tokenHash(token),
        invitedById: userA,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const accepted = await acceptInvitation.POST(request('organizations/invitations/accept', 'POST', { cookie: invitedCookie, body: { token } }), ctx());
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await db.membership.findUnique({ where: { organizationId_userId: { organizationId: organizationA, userId: invited.id } } })).toMatchObject({ role: 'analyst', status: 'active' });
    const replayed = await acceptInvitation.POST(request('organizations/invitations/accept', 'POST', { cookie: invitedCookie, body: { token } }), ctx());
    expect(replayed.status).toBe(400);
  });

  test('an invitation token can be accepted only once under concurrency', async () => {
    const invited = await db.accountUser.create({ data: { email: 'concurrent-invite@enterprise.test', emailVerified: new Date() } });
    const invitedCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: invited.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const token = verificationToken();
    await db.organizationInvitation.create({
      data: {
        organizationId: organizationA,
        email: invited.email,
        role: 'researcher',
        tokenHash: tokenHash(token),
        invitedById: userA,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const responses = await Promise.all([
      acceptInvitation.POST(request('organizations/invitations/accept', 'POST', { cookie: invitedCookie, body: { token } }), ctx()),
      acceptInvitation.POST(request('organizations/invitations/accept', 'POST', { cookie: invitedCookie, body: { token } }), ctx()),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await db.membership.count({ where: { organizationId: organizationA, userId: invited.id } })).toBe(1);
  });

  test('developer API keys cannot escape their declared scopes', async () => {
    const created = await apiKeys.POST(request('api-keys', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { name: 'Source-only key', scopes: ['sources.read'] },
    }), ctx());
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    const denied = await developerFarms.GET(request('developer/farms', 'GET', { headers: { authorization: `Bearer ${secret}` } }), ctx());
    expect(denied.status).toBe(403);
    expect(await db.usageEvent.count({ where: { metric: 'api_requests_per_day', organizationId: organizationA } })).toBe(1);
  });

  test('organization administrators can revoke organization API keys', async () => {
    const created = await apiKeys.POST(request('api-keys', 'POST', {
      cookie: cookieA,
      organizationId: organizationA,
      body: { name: 'Owner-created key', scopes: ['farms.read'] },
    }), ctx());
    expect(created.status).toBe(201);
    const { key } = await created.json();
    const admin = await db.accountUser.create({ data: { email: 'org-admin@enterprise.test', emailVerified: new Date() } });
    await db.membership.create({ data: { organizationId: organizationA, userId: admin.id, role: 'admin', status: 'active' } });
    const adminCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: admin.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const revoked = await revokeApiKey.DELETE(request(`api-keys/${key.id}`, 'DELETE', { cookie: adminCookie, organizationId: organizationA }), ctx({ id: key.id }));
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).toMatchObject({ revokedAt: expect.any(Date) });
  });

  test('committed outbox events fan out to signed tenant webhooks with durable delivery state', async () => {
    const event = await db.outboxEvent.create({
      data: {
        aggregateType: 'Farm',
        aggregateId: farmA,
        eventType: 'farm.created',
        payload: JSON.stringify({ organizationId: organizationA, farmId: farmA }),
      },
    });
    expect(await enqueueWebhookDeliveries()).toBeGreaterThanOrEqual(1);
    const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { eventId: `${event.id}:${webhookId}` } });
    expect(delivery.status).toBe('pending');

    let receivedBody = '';
    let receivedSignature: string | null = null;
    const deliver = async (_url: string, options: { body?: string | Uint8Array; headers?: HeadersInit } = {}) => {
      receivedBody = String(options.body ?? '');
      receivedSignature = new Headers(options.headers).get('x-terrafield-signature');
      return new Response(null, { status: 200 });
    };
    const result = await dispatchPendingWebhooks(20, deliver);
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    const endpoint = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: webhookId } });
    const { decryptSecret } = await import('@/lib/webhook-crypto');
    expect(verifyWebhookSignature({ header: receivedSignature, rawBody: receivedBody, secrets: [decryptSecret(endpoint)] }).valid).toBe(true);
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: 'delivered', attempts: 1 });
  }, 30_000);

  test('permanent webhook failures are not retried', async () => {
    const event = await db.outboxEvent.create({
      data: {
        aggregateType: 'Farm',
        aggregateId: farmA,
        eventType: 'farm.created',
        payload: JSON.stringify({ organizationId: organizationA, farmId: farmA }),
      },
    });
    await enqueueWebhookDeliveries();
    const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { eventId: `${event.id}:${webhookId}` } });
    let calls = 0;
    const rejectDelivery = async () => { calls += 1; return new Response(null, { status: 400 }); };
    await dispatchPendingWebhooks(20, rejectDelivery);
    expect(calls).toBe(1);
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null });
    await dispatchPendingWebhooks(20, rejectDelivery);
    expect(calls).toBe(1);
  }, 30_000);

  test('persisted reports are tenant scoped, metered, and exportable as CSV', async () => {
    const compiled = await reports.POST(request('reports', 'POST', { cookie: cookieA, organizationId: organizationA, body: { farmId: farmA, persist: true } }), ctx());
    expect(compiled.status, await compiled.clone().text()).toBe(200);
    const body = await compiled.json();
    expect(body.persisted).toBe(true);
    expect(body.reportId).toBeString();
    expect(await db.usageEvent.count({ where: { metric: 'reports_per_month', organizationId: organizationA } })).toBe(1);
    const csv = await reportCsv.GET(request(`reports/${body.reportId}/csv`, 'GET', { cookie: cookieA, organizationId: organizationA }), ctx({ id: body.reportId }));
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('farm,id');
    const foreign = await reportCsv.GET(request(`reports/${body.reportId}/csv`, 'GET', { cookie: cookieB, organizationId: organizationB }), ctx({ id: body.reportId }));
    expect(foreign.status).toBe(404);
  }, 30_000);

  test('persisted report writes require same-origin authentication', async () => {
    const crossOrigin = new NextRequest(`${origin}/api/v1/reports`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.test',
        'content-type': 'application/json',
        cookie: cookieA,
        'x-terrafield-organization': organizationA,
        'idempotency-key': `report-cross-origin-${sequence++}`,
      },
      body: JSON.stringify({ farmId: farmA, persist: true }),
    });
    expect((await reports.POST(crossOrigin, ctx())).status).toBe(403);
    const anonymous = await reports.POST(request('reports', 'POST', { organizationId: organizationA, body: { farmId: farmA, persist: true } }), ctx());
    expect(anonymous.status).toBe(401);
  });

  test('platform administration and feature flags require a verified administrator', async () => {
    const denied = await adminOverview.GET(request('admin/overview', 'GET', { cookie: cookieA }), ctx());
    expect(denied.status).toBe(403);
    const admin = await db.accountUser.create({ data: { email: 'admin@enterprise.test', emailVerified: new Date(), isAdmin: true } });
    const adminCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: admin.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const overview = await adminOverview.GET(request('admin/overview', 'GET', { cookie: adminCookie }), ctx());
    expect(overview.status).toBe(200);
    const changed = await featureFlags.PATCH(request('admin/feature-flags', 'PATCH', { cookie: adminCookie, body: { key: 'enterprise_test', description: 'Integration test flag', enabled: true } }), ctx());
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await db.featureFlag.findUniqueOrThrow({ where: { key: 'enterprise_test' } })).toMatchObject({ enabled: true });
  });

  test('concurrent owner demotions preserve at least one active owner', async () => {
    const actor = await db.accountUser.create({ data: { email: 'owner-race-admin@enterprise.test', emailVerified: new Date() } });
    const actorCookie = `__Secure-next-auth.session-token=${await encode({ token: { sub: actor.id }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })}`;
    const created = await organizations.POST(request('organizations', 'POST', { cookie: actorCookie, body: { name: 'Owner race organization' } }), ctx());
    expect(created.status).toBe(201);
    const organization = (await created.json()).organization;
    const actorMembership = await db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: actor.id } } });
    await db.membership.update({ where: { id: actorMembership.id }, data: { role: 'admin' } });
    const owners = await Promise.all(['first-owner@enterprise.test', 'second-owner@enterprise.test'].map(async (email) => {
      const user = await db.accountUser.create({ data: { email, emailVerified: new Date() } });
      return db.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'owner', status: 'active' } });
    }));
    const responses = await Promise.all(owners.map((owner) => memberDetail.PATCH(
      request(`organizations/${organization.id}/members/${owner.id}`, 'PATCH', { cookie: actorCookie, organizationId: organization.id, body: { role: 'viewer' } }),
      ctx({ id: organization.id, membershipId: owner.id }),
    )));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await db.membership.count({ where: { organizationId: organization.id, role: 'owner', status: 'active' } })).toBe(1);
  });
}
