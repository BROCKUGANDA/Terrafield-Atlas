import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createPostgresTestDatabase, deployMigrations, enableTenantRlsTest } from './postgres-test-database';

if (process.env.BILLING_INVOICE_TEST_WORKER !== '1') {
  test('billing invoice and manual settlement integration (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/billing-invoices.integration.ts'], {
      env: { ...process.env, BILLING_INVOICE_TEST_WORKER: '1' }, encoding: 'utf8', timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('billing_invoices');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'billing-invoice-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://billing.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  await enableTenantRlsTest(database.url);

  // DATABASE_URL/NEXTAUTH_* must be set before the Prisma client and route
  // modules load, so these imports cannot be hoisted to the module top.
  const { db } = await import('@/lib/db');
  const { NextRequest } = await import('next/server');
  const { encode } = await import('next-auth/jwt');
  const invoiceRoutes = await import('@/app/api/v1/billing/invoices/route');
  const settleRoutes = await import('@/app/api/v1/billing/invoices/[invoiceId]/settle/route');
  const voidRoutes = await import('@/app/api/v1/billing/invoices/[invoiceId]/void/route');
  const { ensurePlans } = await import('@/lib/commercial');

  await ensurePlans();
  const plan = await db.plan.findUniqueOrThrow({ where: { code: 'professional' } });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const addMonths = (date: Date, months: number) => new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));

  const [owner, analyst, outsider, orgAdmin, secondOwner] = await Promise.all(['owner', 'analyst', 'outsider', 'orgadmin', 'secondowner'].map((name) => db.accountUser.create({
    data: { email: `${name}@billing.example.test`, emailVerified: new Date(), isAdmin: name === 'owner' },
  })));
  const organization = await db.organization.create({ data: { name: 'Billing Cooperative', slug: 'billing-cooperative' } });
  await db.membership.create({ data: { organizationId: organization.id, userId: owner.id, role: 'owner' } });
  await db.membership.create({ data: { organizationId: organization.id, userId: analyst.id, role: 'analyst' } });
  await db.membership.create({ data: { organizationId: organization.id, userId: orgAdmin.id, role: 'admin' } });
  await db.membership.create({ data: { organizationId: organization.id, userId: secondOwner.id, role: 'owner' } });
  const subscription = await db.subscription.create({
    data: { organizationId: organization.id, planId: plan.id, status: 'active', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
  });

  const cookieFor = async (user: { id: string }) => `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: user.id }, maxAge: 3600 })}`;
  const [ownerCookie, analystCookie, outsiderCookie, _orgAdminCookie, secondOwnerCookie] = await Promise.all([owner, analyst, outsider, orgAdmin, secondOwner].map(cookieFor));

  let sequence = 0;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  const request = (path: string, method = 'GET', cookie?: string, body?: unknown, organizationId?: string) => new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/${path}`, {
    method,
    headers: {
      origin: process.env.NEXTAUTH_URL!,
      'content-type': 'application/json',
      'x-forwarded-for': `billing-invoice-${sequence++}`,
      ...(cookie ? { cookie } : {}),
      ...(organizationId ? { 'x-terrafield-organization': organizationId } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'idempotency-key': `billing-invoice-test-${sequence}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let invoiceId = '';

  afterAll(async () => {
    await db.$disconnect();
    await database.drop();
  });

  test('invoice issue is idempotent per subscription period', async () => {
    const first = await invoiceRoutes.POST(request('billing/invoices', 'POST', ownerCookie, {}, organization.id), ctx());
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.created).toBe(true);
    expect(firstBody.invoice.status).toBe('open');
    expect(firstBody.invoice.number).toMatch(/^TF-\d{6}-[0-9a-f]{6}$/);
    expect(firstBody.invoice.amountMinor).toBe(plan.monthlyPriceMinor);
    expect(firstBody.invoice.currency).toBe(plan.currency);
    expect(new Date(firstBody.invoice.periodStart).getTime()).toBe(periodStart.getTime());
    expect(new Date(firstBody.invoice.periodEnd).getTime()).toBe(periodEnd.getTime());
    expect(new Date(firstBody.invoice.dueAt).getTime() - new Date(firstBody.invoice.issuedAt).getTime()).toBe(14 * 86_400_000);
    invoiceId = firstBody.invoice.id;

    const second = await invoiceRoutes.POST(request('billing/invoices', 'POST', ownerCookie, {}, organization.id), ctx());
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.created).toBe(false);
    expect(secondBody.invoice.id).toBe(invoiceId);
    expect(await db.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  test('non-managers cannot issue or settle invoices', async () => {
    const deniedCreate = await invoiceRoutes.POST(request('billing/invoices', 'POST', analystCookie, {}, organization.id), ctx());
    expect(deniedCreate.status).toBe(403);
    const deniedSettle = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', analystCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_bank' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(deniedSettle.status).toBe(403);
    const selfAttested = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', secondOwnerCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_bank' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(selfAttested.status).toBe(403);
    expect((await selfAttested.json()).error.code).toBe('MANUAL_SETTLEMENT_ADMIN_ONLY');
    expect(await db.payment.count({ where: { invoiceId } })).toBe(0);
  });

  test('amount mismatches and provider methods are rejected', async () => {
    const mismatch = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', ownerCookie, { amountMinor: plan.monthlyPriceMinor + 1, method: 'manual_bank', reference: 'BANK-1' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.code).toBe('AMOUNT_MISMATCH');

    const provider = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', ownerCookie, { amountMinor: plan.monthlyPriceMinor, method: 'provider' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(provider.status).toBe(409);
    expect((await provider.json()).error.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    const stored = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } });
    expect(stored.status).toBe('open');
    expect(await db.payment.count({ where: { invoiceId } })).toBe(0);
  });

  test('manual settlement pays the invoice and activates the subscription', async () => {
    await db.subscription.update({ where: { id: subscription.id }, data: { status: 'past_due' } });
    const settled = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', ownerCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_bank', reference: 'BANK-2026-001' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(settled.status).toBe(200);
    const body = await settled.json();
    expect(body.invoice.status).toBe('paid');
    expect(body.invoice.paidAt).toBeTruthy();
    expect(body.payment.status).toBe('succeeded');
    expect(body.payment.method).toBe('manual_bank');
    expect(body.payment.reference).toBe('BANK-2026-001');
    expect(body.payment.amountMinor).toBe(plan.monthlyPriceMinor);
    expect(body.payment.recordedByUserId).toBe(owner.id);
    expect(body.subscription.status).toBe('active');
    expect(new Date(body.subscription.currentPeriodStart).getTime()).toBe(addMonths(periodStart, 1).getTime());
    expect(new Date(body.subscription.currentPeriodEnd).getTime()).toBe(addMonths(periodEnd, 1).getTime());
    expect(await db.payment.count({ where: { invoiceId } })).toBe(1);

    const replayWithoutSameKey = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', ownerCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_bank' }, organization.id),
      ctx({ invoiceId }),
    );
    expect(replayWithoutSameKey.status).toBe(409);
    expect((await replayWithoutSameKey.json()).error.code).toBe('INVOICE_NOT_OPEN');
  });

  test('void invoices cannot be settled', async () => {
    const issued = await invoiceRoutes.POST(request('billing/invoices', 'POST', ownerCookie, {}, organization.id), ctx());
    expect(issued.status).toBe(201);
    const issuedBody = await issued.json();
    const voidedId = issuedBody.invoice.id;
    expect(voidedId).not.toBe(invoiceId);
    expect(new Date(issuedBody.invoice.periodStart).getTime()).toBe(addMonths(periodStart, 1).getTime());

    const voided = await voidRoutes.POST(
      request(`billing/invoices/${voidedId}/void`, 'POST', ownerCookie, { reason: 'Duplicate manual receipt' }, organization.id),
      ctx({ invoiceId: voidedId }),
    );
    expect(voided.status).toBe(200);
    expect((await voided.json()).invoice.status).toBe('void');

    const denied = await settleRoutes.POST(
      request(`billing/invoices/${voidedId}/settle`, 'POST', ownerCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_cash' }, organization.id),
      ctx({ invoiceId: voidedId }),
    );
    expect(denied.status).toBe(409);
    expect((await denied.json()).error.code).toBe('INVOICE_NOT_OPEN');
    expect(await db.payment.count({ where: { invoiceId: voidedId } })).toBe(0);
  });

  test('invoice listing is scoped by organization or owner', async () => {
    const listed = await invoiceRoutes.GET(request('billing/invoices', 'GET', ownerCookie, undefined, organization.id), ctx());
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.invoices.length).toBe(2);
    expect(body.invoices.every((invoice: { organizationId: string | null }) => invoice.organizationId === organization.id)).toBe(true);
    expect(body.paymentNote).toContain('No card processor');

    const analystList = await invoiceRoutes.GET(request('billing/invoices', 'GET', analystCookie, undefined, organization.id), ctx());
    expect(analystList.status).toBe(403);

    const personalList = await invoiceRoutes.GET(request('billing/invoices', 'GET', outsiderCookie), ctx());
    expect(personalList.status).toBe(200);
    expect((await personalList.json()).invoices.length).toBe(0);

    const crossTenant = await settleRoutes.POST(
      request(`billing/invoices/${invoiceId}/settle`, 'POST', outsiderCookie, { amountMinor: plan.monthlyPriceMinor, method: 'manual_bank' }),
      ctx({ invoiceId }),
    );
    expect(crossTenant.status).toBe(403);
  });
}
