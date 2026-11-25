import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createEmptyPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.RLS_TEST_WORKER !== '1') {
  test('PostgreSQL RLS tenant isolation (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/rls.integration.ts'], {
      env: { ...process.env, RLS_TEST_WORKER: '1' }, encoding: 'utf8', timeout: 120_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 125_000);
} else {
  const database = await createEmptyPostgresTestDatabase('rls_product');
  process.env.DATABASE_URL = database.url;
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  const { rawDb } = await import('@/lib/db');

  const suffix = crypto.randomUUID().slice(0, 8);
  const [userA, userB, userC] = await Promise.all(
    ['a', 'b', 'c'].map((name) => rawDb.accountUser.create({ data: { email: `rls-${name}-${suffix}@example.test`, emailVerified: new Date() } })),
  );
  const organization = await rawDb.organization.create({ data: { name: 'RLS Cooperative', slug: `rls-cooperative-${suffix}` } });
  await rawDb.membership.create({ data: { organizationId: organization.id, userId: userA.id, role: 'owner' } });
  await rawDb.membership.create({ data: { organizationId: organization.id, userId: userB.id, role: 'analyst' } });
  const publicFarm = await rawDb.farm.create({ data: { name: `RLS public ${suffix}`, centroidLat: 0, centroidLon: 0 } });
  const farmA = await rawDb.farm.create({ data: { ownerId: userA.id, name: `RLS A ${suffix}`, centroidLat: 1, centroidLon: 1 } });
  const farmB = await rawDb.farm.create({ data: { ownerId: userB.id, name: `RLS B ${suffix}`, centroidLat: 2, centroidLon: 2 } });
  const orgFarm = await rawDb.farm.create({ data: { ownerId: userA.id, organizationId: organization.id, name: `RLS org ${suffix}`, centroidLat: 3, centroidLon: 3 } });

  async function visibleFarmIds(userId: string | null, organizationId: string | null): Promise<string[]> {
    // A separate transaction is required because SET LOCAL ends with the
    // transaction that created the scoped client above.
    return rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE terrafield_app`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId ?? ''}, true)`;
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId ?? ''}, true)`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Farm"`;
      return rows.map((row) => row.id);
    });
  }

  afterAll(async () => {
    await rawDb.$disconnect();
    await database.drop();
  }, 30_000);

  test('policies hide private rows from anonymous and foreign tenants', async () => {
    const anonymous = await visibleFarmIds(null, null);
    expect(anonymous).toContain(publicFarm.id);
    expect(anonymous).not.toContain(farmA.id);
    expect(anonymous).not.toContain(farmB.id);
    expect(anonymous).not.toContain(orgFarm.id);

    const a = await visibleFarmIds(userA.id, null);
    expect(a).toContain(publicFarm.id);
    expect(a).toContain(farmA.id);
    expect(a).not.toContain(farmB.id);
    expect(a).not.toContain(orgFarm.id);

    const b = await visibleFarmIds(userB.id, null);
    expect(b).toContain(farmB.id);
    expect(b).not.toContain(farmA.id);
    expect(b).not.toContain(orgFarm.id);

    const c = await visibleFarmIds(userC.id, null);
    expect(c).not.toContain(farmA.id);
    expect(c).not.toContain(farmB.id);
    expect(c).not.toContain(orgFarm.id);
  }, 30_000);

  test('active organization membership unlocks organization rows at the database layer', async () => {
    const member = await visibleFarmIds(userB.id, organization.id);
    expect(member).toContain(orgFarm.id);
    expect(member).toContain(farmB.id);
    expect(member).not.toContain(farmA.id);
  }, 30_000);

  test('cross-tenant writes affect zero rows under RLS', async () => {
    const changed = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE terrafield_app`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userA.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${''}, true)`;
      return tx.$executeRaw`UPDATE "Farm" SET name = 'stolen' WHERE id = ${farmB.id}`;
    });
    expect(changed).toBe(0);
    const stored = await rawDb.farm.findUniqueOrThrow({ where: { id: farmB.id }, select: { name: true } });
    expect(stored.name).toBe(`RLS B ${suffix}`);
  }, 30_000);
}
