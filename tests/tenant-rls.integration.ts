import { afterAll, expect, test } from 'bun:test';
import { createEmptyPostgresTestDatabase, deployMigrations } from './postgres-test-database';

/**
 * Verifies the production wiring: the tenant Prisma proxy (TENANT_DATABASE_URL)
 * switches request-scoped queries to the terrafield_app role, where PostgreSQL
 * RLS policies apply. `db` calls made without a tenant context (auth,
 * migrations, workers) keep the owner connection.
 */
const database = await createEmptyPostgresTestDatabase('tenant_proxy');
process.env.DATABASE_URL = database.url;
process.env.TENANT_DATABASE_URL = `${database.url}${database.url.includes("?") ? "&" : "?"}options=-c%20role%3Dterrafield_app`;
const setup = deployMigrations(database.url);
if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

const { db, rawDb, withTenantContext } = await import('@/lib/db');
const suffix = crypto.randomUUID().slice(0, 8);

const owner = await rawDb.accountUser.create({ data: { email: `proxy-owner-${suffix}@example.test`, emailVerified: new Date() } });
const other = await rawDb.accountUser.create({ data: { email: `proxy-other-${suffix}@example.test`, emailVerified: new Date() } });
const organization = await rawDb.organization.create({ data: { name: 'Proxy Cooperative', slug: `proxy-${suffix}` } });
await rawDb.membership.create({ data: { organizationId: organization.id, userId: owner.id, role: 'owner' } });
const publicFarm = await rawDb.farm.create({ data: { name: `Public ${suffix}`, centroidLat: 0, centroidLon: 0 } });
const ownFarm = await rawDb.farm.create({ data: { ownerId: owner.id, name: `Own ${suffix}`, centroidLat: 1, centroidLon: 1 } });
const otherFarm = await rawDb.farm.create({ data: { ownerId: other.id, name: `Other ${suffix}`, centroidLat: 2, centroidLon: 2 } });
const orgFarm = await rawDb.farm.create({ data: { ownerId: owner.id, organizationId: organization.id, name: `Org ${suffix}`, centroidLat: 3, centroidLon: 3 } });

const scopedContext = (userId: string | null, organizationId: string | null) => ({
  userId, organizationId, organizationName: null,
  role: organizationId ? 'owner' as const : 'personal' as const,
  permissions: organizationId ? ['farm.read', 'farm.write'] as const : ['farm.read', 'farm.write'] as const,
  isPlatformAdmin: false,
});

afterAll(async () => {
  await rawDb.$disconnect();
  await db.$disconnect().catch(() => undefined);
  await database.drop();
}, 30_000);

test('request-scoped reads run under RLS through the tenant proxy', async () => {
  const anonymous = await withTenantContext(scopedContext(null, null), async () => db.farm.findMany({ select: { id: true } }));
  const anonymousIds = anonymous.map((row) => row.id);
  expect(anonymousIds).toContain(publicFarm.id);
  expect(anonymousIds).not.toContain(ownFarm.id);
  expect(anonymousIds).not.toContain(otherFarm.id);
  expect(anonymousIds).not.toContain(orgFarm.id);

  const mine = await withTenantContext(scopedContext(owner.id, null), async () => db.farm.findMany({ select: { id: true } }));
  const mineIds = mine.map((row) => row.id);
  expect(mineIds).toContain(publicFarm.id);
  expect(mineIds).toContain(ownFarm.id);
  expect(mineIds).not.toContain(otherFarm.id);
  expect(mineIds).not.toContain(orgFarm.id);

  const orgRead = await withTenantContext(scopedContext(owner.id, organization.id), async () => db.farm.findMany({ select: { id: true } }));
  const orgIds = orgRead.map((row) => row.id);
  expect(orgIds).toContain(orgFarm.id);
  expect(orgIds).toContain(ownFarm.id);
  expect(orgIds).not.toContain(otherFarm.id);
}, 30_000);

test('cross-tenant writes affect zero rows through the tenant proxy', async () => {
  const result = await withTenantContext(scopedContext(owner.id, null), async () =>
    db.farm.updateMany({ where: { id: otherFarm.id }, data: { name: 'hijacked' } }));
  expect(result.count).toBe(0);
  const untouched = await rawDb.farm.findUniqueOrThrow({ where: { id: otherFarm.id } });
  expect(untouched.name).toBe(`Other ${suffix}`);
}, 30_000);

test('owner-path calls without context keep full access for workers and auth', async () => {
  const all = await db.farm.findMany({ select: { id: true } });
  const ids = all.map((row) => row.id);
  expect(ids).toContain(publicFarm.id);
  expect(ids).toContain(ownFarm.id);
  expect(ids).toContain(otherFarm.id);
  expect(ids).toContain(orgFarm.id);
});
