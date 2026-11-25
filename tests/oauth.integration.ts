import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, deployMigrations, enableTenantRlsTest } from './postgres-test-database';

if (process.env.OAUTH_TEST_WORKER !== '1') {
  test('oauth client-credentials integration (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/oauth.integration.ts'], {
      env: { ...process.env, OAUTH_TEST_WORKER: '1' }, encoding: 'utf8', timeout: 180_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 185_000);
} else {
  const database = await createPostgresTestDatabase('oauth_credentials');
  process.env.DATABASE_URL = database.url;
    process.env.NEXTAUTH_SECRET = 'oauth-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://oauth.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  await enableTenantRlsTest(database.url);

  // Dynamic imports: DATABASE_URL and NEXTAUTH_SECRET must be set before the
  // Prisma and NextAuth modules initialize, so static imports cannot work here.
  const { db } = await import('@/lib/db');
  const { NextRequest } = await import('next/server');
  const { encode } = await import('next-auth/jwt');
  const orgRoutes = await import('@/app/api/v1/organizations/route');
  const farmRoutes = await import('@/app/api/v1/farms/route');
  const apiKeyRoutes = await import('@/app/api/v1/api-keys/route');
  const developerFarmRoutes = await import('@/app/api/v1/developer/farms/route');
  const developerSourceRoutes = await import('@/app/api/v1/developer/sources/route');
  const tokenRoutes = await import('@/app/api/v1/oauth/token/route');
  const clientRoutes = await import('@/app/api/v1/organizations/[id]/oauth-clients/route');
  const revokeRoutes = await import('@/app/api/v1/organizations/[id]/oauth-clients/[clientId]/route');

  const [owner, outsider] = await Promise.all([
    db.accountUser.create({ data: { email: 'owner@oauth.test', emailVerified: new Date() } }),
    db.accountUser.create({ data: { email: 'outsider@oauth.test', emailVerified: new Date() } }),
  ]);
  const cookie = async (userId: string) => `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: userId }, maxAge: 3600 })}`;
  const ownerCookie = await cookie(owner.id);
  const outsiderCookie = await cookie(outsider.id);

  let sequence = 0;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  const request = (path: string, method = 'GET', session?: string, body?: unknown, organizationId?: string, headers: Record<string, string> = {}) => new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/${path}`, {
    method,
    headers: {
      origin: process.env.NEXTAUTH_URL!,
      'content-type': 'application/json',
      'x-forwarded-for': `oauth-${sequence++}`,
      ...(session ? { cookie: session } : {}),
      ...(organizationId ? { 'x-terrafield-organization': organizationId } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'idempotency-key': `oauth-test-${sequence}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const formRequest = (fields: Record<string, string>, contentType = 'application/x-www-form-urlencoded') => new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-forwarded-for': `oauth-form-${sequence++}` },
    body: new URLSearchParams(fields).toString(),
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  afterAll(async () => {
    await db.$disconnect();
    await database.drop();
  });

  const createOrganization = async (name: string, session: string) => {
    const response = await orgRoutes.POST(request('organizations', 'POST', session, { name }), ctx());
    expect(response.status).toBe(201);
    return (await response.json()).organization as { id: string };
  };

  const organizationA = await createOrganization('OAuth Alpha Cooperative', ownerCookie);
  const organizationB = await createOrganization('OAuth Beta Cooperative', outsiderCookie);
  await db.membership.create({ data: { organizationId: organizationB.id, userId: owner.id, role: 'viewer' } });

  let clientA: { id: string; clientId: string; name: string };
  let secretA = '';
  let farmAId = '';

  test('client creation requires org.manage, hashes the secret, and never lists it', async () => {
    const denied = await clientRoutes.POST(request(`organizations/${organizationA.id}/oauth-clients`, 'POST', ownerCookie, { name: 'Denied', scopes: ['farms.read'] }, organizationB.id), ctx({ id: organizationA.id }));
    expect(denied.status).toBe(404);
    const viewerDenied = await clientRoutes.POST(request(`organizations/${organizationB.id}/oauth-clients`, 'POST', ownerCookie, { name: 'Denied', scopes: ['farms.read'] }, organizationB.id), ctx({ id: organizationB.id }));
    expect(viewerDenied.status).toBe(403);
    const outsiderDenied = await clientRoutes.POST(request(`organizations/${organizationA.id}/oauth-clients`, 'POST', outsiderCookie, { name: 'Denied', scopes: ['farms.read'] }, organizationA.id), ctx({ id: organizationA.id }));
    expect(outsiderDenied.status).toBe(403);

    const created = await clientRoutes.POST(request(`organizations/${organizationA.id}/oauth-clients`, 'POST', ownerCookie, { name: 'Field integration', scopes: ['farms.read'] }, organizationA.id), ctx({ id: organizationA.id }));
    expect(created.status).toBe(201);
    const payload = await created.json();
    clientA = payload.client;
    secretA = payload.client_secret;
    expect(payload.client.name).toBe('Field integration');
    expect(payload.client.scopes).toEqual(['farms.read']);
    expect(clientA.clientId.startsWith('tf_oauth_')).toBe(true);
    expect(secretA.startsWith('tf_secret_')).toBe(true);
    expect(payload.client.secretHash).toBeUndefined();

    const stored = await db.oAuthClient.findUniqueOrThrow({ where: { id: clientA.id } });
    expect(stored.secretHash).not.toBe(secretA);
    expect(stored.secretHash).toBe(createHash('sha256').update(secretA).digest('hex'));
    expect(stored.organizationId).toBe(organizationA.id);
    expect(stored.ownerId).toBe(owner.id);

    const list = await clientRoutes.GET(request(`organizations/${organizationA.id}/oauth-clients`, 'GET', ownerCookie, undefined, organizationA.id), ctx({ id: organizationA.id }));
    expect(list.status).toBe(200);
    const clients = (await list.json()).clients as Array<Record<string, unknown>>;
    expect(clients).toHaveLength(1);
    expect(clients[0].clientId).toBe(clientA.clientId);
    expect(clients[0].scopes).toEqual(['farms.read']);
    expect(JSON.stringify(clients)).not.toContain(secretA);
    expect(JSON.stringify(clients)).not.toContain('secretHash');
  });

  test('rejects malformed token requests with OAuth-shaped errors', async () => {
    const wrongSecret = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: 'tf_secret_wrong' }));
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toMatchObject({ error: 'invalid_client' });

    const unknownClient = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: 'tf_oauth_unknown', client_secret: secretA }));
    expect(unknownClient.status).toBe(401);
    expect((await unknownClient.json()).error).toBe('invalid_client');

    const wrongGrant = await tokenRoutes.POST(formRequest({ grant_type: 'authorization_code', client_id: clientA.clientId, client_secret: secretA }));
    expect(wrongGrant.status).toBe(400);
    expect((await wrongGrant.json()).error).toBe('unsupported_grant_type');

    const missingGrant = await tokenRoutes.POST(formRequest({ client_id: clientA.clientId, client_secret: secretA }));
    expect(missingGrant.status).toBe(400);
    expect((await missingGrant.json()).error).toBe('invalid_request');

    const wrongContentType = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA }, 'application/json'));
    expect(wrongContentType.status).toBe(400);
    expect((await wrongContentType.json()).error).toBe('invalid_request');

    const escalatedScope = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA, scope: 'farms.read sources.read' }));
    expect(escalatedScope.status).toBe(400);
    expect((await escalatedScope.json()).error).toBe('invalid_scope');
  });

  let accessTokenA = '';

  test('issues an opaque hashed token that authorizes the developer API by scope', async () => {
    const farm = await farmRoutes.POST(request('farms', 'POST', ownerCookie, { name: 'OAuth farm', centroidLat: 1.25, centroidLon: 32.5 }, organizationA.id), ctx());
    expect(farm.status).toBe(201);
    farmAId = (await farm.json()).farm.id;

    const response = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    accessTokenA = payload.access_token;
    expect(accessTokenA.startsWith('tf_oauth_at_')).toBe(true);
    expect(payload.token_type).toBe('Bearer');
    expect(payload.expires_in).toBe(3600);
    expect(payload.scope).toBe('farms.read');
    expect(payload.access_token).not.toContain(secretA);

    const stored = await db.oAuthToken.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(accessTokenA).digest('hex') } });
    expect(stored.clientId).toBe(clientA.id);
    expect(stored.scopesJson).toBe(JSON.stringify(['farms.read']));
    const ttlSeconds = (stored.expiresAt.getTime() - Date.now()) / 1000;
    expect(ttlSeconds).toBeGreaterThan(3_500);
    expect(ttlSeconds).toBeLessThanOrEqual(3_600);
    expect(await db.oAuthToken.count({ where: { tokenHash: accessTokenA } })).toBe(0);

    const farms = await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(accessTokenA)), ctx());
    expect(farms.status).toBe(200);
    const farmList = (await farms.json()).farms as Array<{ id: string }>;
    expect(farmList.some((row) => row.id === farmAId)).toBe(true);

    const sources = await developerSourceRoutes.GET(request('developer/sources', 'GET', undefined, undefined, undefined, bearer(accessTokenA)), ctx());
    expect(sources.status).toBe(403);
    expect((await sources.json()).error.code).toBe('INSUFFICIENT_SCOPE');
  });

  test('rejects expired tokens and revoked clients', async () => {
    const expiredToken = (await (await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA }))).json()).access_token as string;
    await db.oAuthToken.update({
      where: { tokenHash: createHash('sha256').update(expiredToken).digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(expiredToken)), ctx());
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.code).toBe('INVALID_OAUTH_TOKEN');

    const liveToken = (await (await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA }))).json()).access_token as string;
    expect((await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(liveToken)), ctx())).status).toBe(200);

    const revoke = await revokeRoutes.DELETE(request(`organizations/${organizationA.id}/oauth-clients/${clientA.id}`, 'DELETE', ownerCookie, undefined, organizationA.id), ctx({ id: organizationA.id, clientId: clientA.id }));
    expect(revoke.status).toBe(200);
    expect((await revoke.json()).revoked).toBe(true);
    expect(await db.oAuthToken.count({ where: { clientId: clientA.id } })).toBe(0);
    expect((await db.oAuthClient.findUniqueOrThrow({ where: { id: clientA.id } })).active).toBe(false);

    const afterRevoke = await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(liveToken)), ctx());
    expect(afterRevoke.status).toBe(401);
    expect((await afterRevoke.json()).error.code).toBe('INVALID_OAUTH_TOKEN');
    const reissue = await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: clientA.clientId, client_secret: secretA }));
    expect(reissue.status).toBe(401);
    expect((await reissue.json()).error).toBe('invalid_client');
  });

  test('tokens are scoped to the owning organization', async () => {
    const farmB = await farmRoutes.POST(request('farms', 'POST', outsiderCookie, { name: 'Beta farm', centroidLat: -1.5, centroidLon: 36.8 }, organizationB.id), ctx());
    expect(farmB.status).toBe(201);
    const farmBId = (await farmB.json()).farm.id as string;

    const betaClient = await clientRoutes.POST(request(`organizations/${organizationB.id}/oauth-clients`, 'POST', outsiderCookie, { name: 'Beta integration', scopes: ['farms.read'] }, organizationB.id), ctx({ id: organizationB.id }));
    expect(betaClient.status).toBe(201);
    const betaPayload = await betaClient.json();

    const betaToken = (await (await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: betaPayload.client.clientId, client_secret: betaPayload.client_secret }))).json()).access_token as string;
    const betaFarms = (await (await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(betaToken)), ctx())).json()).farms as Array<{ id: string }>;
    expect(betaFarms.some((row) => row.id === farmBId)).toBe(true);
    expect(betaFarms.some((row) => row.id === farmAId)).toBe(false);

    const badSecretStatus = (await (await tokenRoutes.POST(formRequest({ grant_type: 'client_credentials', client_id: betaPayload.client.clientId, client_secret: 'tf_secret_wrong' }))).status);
    expect(badSecretStatus).toBe(401);

    const crossTenantList = await clientRoutes.GET(request(`organizations/${organizationA.id}/oauth-clients`, 'GET', outsiderCookie, undefined, organizationA.id), ctx({ id: organizationA.id }));
    expect(crossTenantList.status).toBe(403);
    const mismatchedTenant = await clientRoutes.GET(request(`organizations/${organizationA.id}/oauth-clients`, 'GET', ownerCookie, undefined, organizationB.id), ctx({ id: organizationA.id }));
    expect(mismatchedTenant.status).toBe(404);
    const crossTenantRevoke = await revokeRoutes.DELETE(request(`organizations/${organizationA.id}/oauth-clients/${betaPayload.client.id}`, 'DELETE', outsiderCookie, undefined, organizationA.id), ctx({ id: organizationA.id, clientId: betaPayload.client.id }));
    expect(crossTenantRevoke.status).toBe(403);
  });

  test('API key authentication is unchanged', async () => {
    const created = await apiKeyRoutes.POST(request('api-keys', 'POST', ownerCookie, { name: 'Regression key', scopes: ['farms.read'] }, organizationA.id), ctx());
    expect(created.status).toBe(201);
    const key = await created.json();
    expect((await developerFarmRoutes.GET(request('developer/farms', 'GET', undefined, undefined, undefined, bearer(key.secret)), ctx())).status).toBe(200);
  });
}
