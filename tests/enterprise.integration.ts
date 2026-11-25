import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.ENTERPRISE_TEST_WORKER !== '1') {
  test('enterprise tenancy, commercial, developer, webhook, and intelligence integration (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/enterprise.integration.ts'], {
      env: { ...process.env, ENTERPRISE_TEST_WORKER: '1' }, encoding: 'utf8', timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('enterprise_product');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'enterprise-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://enterprise.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

  const { db } = await import('@/lib/db');
  const { NextRequest } = await import('next/server');
  const { encode } = await import('next-auth/jwt');
  const orgRoutes = await import('@/app/api/v1/organizations/route');
  const farmRoutes = await import('@/app/api/v1/farms/route');
  const billingRoutes = await import('@/app/api/v1/billing/route');
  const apiKeyRoutes = await import('@/app/api/v1/api-keys/route');
  const developerFarmRoutes = await import('@/app/api/v1/developer/farms/route');
  const webhookRoutes = await import('@/app/api/v1/webhooks/route');
  const { enqueueWebhookDeliveries, dispatchPendingWebhooks } = await import('@/lib/outbox-worker');
  const intelligenceRoutes = await import('@/app/api/v1/intelligence/plans/route');
  const approveRoutes = await import('@/app/api/v1/intelligence/runs/[id]/approve/route');
  const { ensurePlans } = await import('@/lib/commercial');

  const users = await Promise.all(['a', 'b', 'c'].map((name) => db.accountUser.create({ data: { email: `${name}@enterprise.test`, emailVerified: new Date() } })));
  const cookies = await Promise.all(users.map(async (user) => `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: user.id }, maxAge: 3600 })}`));
  let sequence = 0;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  const request = (path: string, method = 'GET', cookie?: string, body?: unknown, organizationId?: string, headers: Record<string, string> = {}) => new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/${path}`, {
    method,
    headers: {
      origin: process.env.NEXTAUTH_URL!,
      'content-type': 'application/json',
      'x-forwarded-for': `enterprise-${sequence++}`,
      ...(cookie ? { cookie } : {}),
      ...(organizationId ? { 'x-terrafield-organization': organizationId } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'idempotency-key': `enterprise-test-${sequence}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  afterAll(async () => {
    await db.$disconnect();
    await database.drop();
  });

  test('organization creation is atomic and forged/cross-tenant headers are denied', async () => {
    const created = await orgRoutes.POST(request('organizations', 'POST', cookies[0], { name: 'Test Cooperative', country: 'Uganda' }), ctx());
    expect(created.status).toBe(201);
    const payload = await created.json();
    expect(payload.organization.name).toBe('Test Cooperative');
    expect(payload.workspace.organizationId).toBe(payload.organization.id);
    expect(await db.membership.count({ where: { organizationId: payload.organization.id, userId: users[0].id, role: 'owner' } })).toBe(1);
    expect(await db.subscription.count({ where: { organizationId: payload.organization.id, status: 'trialing' } })).toBe(1);
    expect((await orgRoutes.GET(request('organizations', 'GET', cookies[1], undefined, payload.organization.id), ctx())).status).toBe(403);
    expect((await farmRoutes.GET(request('farms', 'GET', undefined, undefined, payload.organization.id), ctx())).status).toBe(401);
  });

  test('organization farms are shared by role and inaccessible to another tenant', async () => {
    const organization = await db.organization.findFirstOrThrow({ where: { name: 'Test Cooperative' } });
    const workspace = await db.workspace.findFirstOrThrow({ where: { organizationId: organization.id } });
    await db.membership.create({ data: { organizationId: organization.id, userId: users[1].id, role: 'analyst' } });
    await db.membership.create({ data: { organizationId: organization.id, userId: users[2].id, role: 'agronomist' } });
    const created = await farmRoutes.POST(request('farms', 'POST', cookies[0], { name: 'Shared farm', centroidLat: 1, centroidLon: 2, workspaceId: workspace.id }, organization.id), ctx());
    expect(created.status).toBe(201);
    const farm = (await created.json()).farm;
    expect(farm.organizationId).toBe(organization.id);
    const analystList = await (await farmRoutes.GET(request('farms', 'GET', cookies[1], undefined, organization.id), ctx())).json();
    expect(analystList.farms.some((row: { id: string }) => row.id === farm.id)).toBe(true);
    expect((await farmRoutes.POST(request('farms', 'POST', cookies[1], { name: 'Denied farm', centroidLat: 1, centroidLon: 2 }, organization.id), ctx())).status).toBe(403);
    expect((await farmRoutes.POST(request('farms', 'POST', cookies[2], { name: 'Allowed farm', centroidLat: 1, centroidLon: 2, workspaceId: workspace.id }, organization.id), ctx())).status).toBe(201);
    const other = await db.organization.create({ data: { name: 'Other Cooperative', slug: 'other-cooperative' } });
    await db.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } });
    const otherList = await (await farmRoutes.GET(request('farms', 'GET', cookies[0], undefined, other.id), ctx())).json();
    expect(otherList.farms.some((row: { id: string }) => row.id === farm.id)).toBe(false);
  });

  test('plan limits are enforced server-side and successful jobs are metered once', async () => {
    await ensurePlans();
    const explorer = await db.plan.findUniqueOrThrow({ where: { code: 'explorer' } });
    await db.plan.update({ where: { id: explorer.id }, data: { entitlementsJson: JSON.stringify({ limits: { farms: 0, processing_jobs_per_month: 0, api_requests_per_day: 0, reports_per_month: 0, ai_runs_per_month: 0, storage_mb: 0 }, capabilities: { organization: false, api_access: false, webhooks: false, advanced_analytics: false } }) } });
    expect((await farmRoutes.POST(request('farms', 'POST', cookies[0], { name: 'Quota farm', centroidLat: 1, centroidLon: 2 }), ctx())).status).toBe(402);
    const professional = await db.plan.findUniqueOrThrow({ where: { code: 'professional' } });
    await db.subscription.create({ data: { ownerId: users[0].id, planId: professional.id, status: 'active' } });
    const billing = await billingRoutes.GET(request('billing', 'GET', cookies[0]), ctx());
    expect(billing.status).toBe(200);
    expect((await billing.json()).entitlements.capabilities.api_access).toBe(true);
  });

  test('API keys are hashed, scoped, revocable, and tenant-aware', async () => {
    const created = await apiKeyRoutes.POST(request('api-keys', 'POST', cookies[0], { name: 'Test key', scopes: ['farms.read'] }), ctx());
    expect(created.status).toBe(201);
    const payload = await created.json();
    expect(payload.secret.startsWith('tf_live_')).toBe(true);
    const stored = await db.apiKey.findUniqueOrThrow({ where: { id: payload.key.id } });
    expect(stored.keyHash).not.toBe(payload.secret);
    const ok = await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, { authorization: `Bearer ${payload.secret}` }), ctx());
    expect(ok.status).toBe(200);
    expect((await ok.json()).farms.length).toBeGreaterThan(0);
    const sources = await import('@/app/api/v1/developer/sources/route');
    expect((await sources.GET(request('developer/sources', 'GET', undefined, undefined, undefined, { authorization: `Bearer ${payload.secret}` }), ctx())).status).toBe(403);
    const revoke = await import('@/app/api/v1/api-keys/[id]/route');
    expect((await revoke.DELETE(request(`api-keys/${payload.key.id}`, 'DELETE', cookies[0]), ctx({ id: payload.key.id }))).status).toBe(200);
    expect((await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, { authorization: `Bearer ${payload.secret}` }), ctx())).status).toBe(401);
  });

  test('webhook secrets are encrypted and outbox deliveries are signed and durable', async () => {
    const organization = await db.organization.findFirstOrThrow({ where: { name: 'Test Cooperative' } });
    const created = await webhookRoutes.POST(request('webhooks', 'POST', cookies[0], { name: 'Test hook', url: 'https://93.184.216.34/hook', events: ['subscription.updated'] }, organization.id), ctx());
    expect(created.status).toBe(201);
    const payload = await created.json();
    const stored = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: payload.webhook.id } });
    expect(stored.secretCiphertext).not.toBe(payload.secret);
    await db.outboxEvent.create({ data: { aggregateType: 'Farm', aggregateId: 'farm-1', eventType: 'subscription.updated', payload: JSON.stringify({ organizationId: organization.id, subscriptionId: 'sub-1' }) } });
    expect(await enqueueWebhookDeliveries()).toBeGreaterThan(0);
    let signature = '';
    const deliver = async (_url: string, options: { headers?: HeadersInit } = {}) => {
      signature = String(new Headers(options.headers).get('x-terrafield-signature') ?? '');
      return new Response(null, { status: 200 });
    };
    const result = await dispatchPendingWebhooks(20, deliver);
    expect(result.delivered).toBe(1);
    expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(await db.webhookDelivery.count({ where: { endpointId: stored.id, status: 'delivered' } })).toBe(1);
  });

  test('verified report snapshots persist provenance and export as CSV', async () => {
    const reportRoutes = await import('@/app/api/v1/reports/route');
    const csvRoutes = await import('@/app/api/v1/reports/[id]/csv/route');
    const farm = await db.farm.create({ data: { ownerId: users[0].id, name: 'Report farm', centroidLat: 1, centroidLon: 2 } });
    const generated = await reportRoutes.POST(request('reports', 'POST', cookies[0], { farmId: farm.id, persist: true }), ctx());
    expect(generated.status).toBe(200);
    const payload = await generated.json();
    expect(payload.persisted).toBe(true);
    expect(payload.reportId).toBeTruthy();
    const pdfRoutes = await import('@/app/api/v1/reports/[id]/pdf/route');
    const csv = await csvRoutes.GET(request(`reports/${payload.reportId}/csv`, 'GET', cookies[0]), ctx({ id: payload.reportId }));
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('section,item,value');
    const pdf = await pdfRoutes.GET(request(`reports/${payload.reportId}/pdf`, 'GET', cookies[0]), ctx({ id: payload.reportId }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    const pdfMagic = new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 4));
    expect(pdfMagic).toBe('%PDF');
  });

  test('platform administration and feature flags require the server administrator role', async () => {
    const adminRoutes = await import('@/app/api/v1/admin/overview/route');
    const flagRoutes = await import('@/app/api/v1/admin/feature-flags/route');
    expect((await adminRoutes.GET(request('admin/overview', 'GET', cookies[0]), ctx())).status).toBe(403);
    await db.accountUser.update({ where: { id: users[2].id }, data: { isAdmin: true } });
    const overview = await adminRoutes.GET(request('admin/overview', 'GET', cookies[2]), ctx());
    expect(overview.status).toBe(200);
    expect((await overview.json()).organizations.length).toBeGreaterThan(0);
    const updated = await flagRoutes.PATCH(request('admin/feature-flags', 'PATCH', cookies[2], { key: 'markets.enabled', description: 'Approved market feeds', enabled: false }), ctx());
    expect(updated.status).toBe(200);
    expect((await updated.json()).flag.enabled).toBe(false);
  });

  test('intelligence plans require approval and execute only allowlisted tenant tools', async () => {
    const organization = await db.organization.findFirstOrThrow({ where: {name: 'Test Cooperative'} });
    const planned = await intelligenceRoutes.POST(request('intelligence/plans', 'POST', cookies[1], { query: 'Summarize farms in this cooperative portfolio' }, organization.id), ctx());
    expect(planned.status).toBe(201);
    const planPayload = await planned.json();
    expect(planPayload.plan.intent).toBe('portfolio.summary');
    expect(planPayload.run.status).toBe('awaiting_approval');
    const approved = await approveRoutes.POST(request(`intelligence/runs/${planPayload.run.id}/approve`, 'POST', cookies[1], {}, organization.id), ctx({ id: planPayload.run.id }));
    expect(approved.status).toBe(200);
    const result = await approved.json();
    expect(result.run.status).toBe('succeeded');
    expect(result.result.results['portfolio.summary'].farmCount).toBeGreaterThan(0);
    const unsupported = await intelligenceRoutes.POST(request('intelligence/plans', 'POST', cookies[1], { query: 'Delete every farm and email the president' }, organization.id), ctx());
    expect((await unsupported.json()).canExecute).toBe(false);
  });
}
