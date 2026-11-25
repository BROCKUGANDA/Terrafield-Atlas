import { expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { createEmptyPostgresTestDatabase, deployMigrations } from './postgres-test-database';

async function expectUniqueViolation(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'P2002' });
}

test('an empty PostgreSQL database migrates idempotently with PostGIS and the production constraints', async () => {
  const database = await createEmptyPostgresTestDatabase('schema_baseline');
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: database.url });
    const initialTables = await db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const initialExtensions = await db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM pg_extension WHERE extname = 'postgis'
    `;
    expect(initialTables).toEqual([{ count: 0 }]);
    expect(initialExtensions).toEqual([{ count: 0 }]);
    await db.$disconnect();
    db = undefined;

    const firstDeploy = deployMigrations(database.url);
    expect(firstDeploy.status, `${firstDeploy.stdout}\n${firstDeploy.stderr}`).toBe(0);
    const secondDeploy = deployMigrations(database.url);
    expect(secondDeploy.status, `${secondDeploy.stdout}\n${secondDeploy.stderr}`).toBe(0);

    db = new PrismaClient({ datasourceUrl: database.url });
    const extensions = await db.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname = 'postgis'`;
    expect(extensions).toEqual([{ extname: 'postgis' }]);
    const migrations = await db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name
    `;
    expect(migrations.map((row) => row.migration_name)).toEqual([
      '20261124000000_init_postgres',
      '20261125000000_replica_safety',
      '20261125000000_task6_durable_jobs',
      '20261125120000_enterprise_product',
      '20261126000000_rls_foundations',
      '20261126010000_redact_secret_idempotency',
    ]);
    expect(migrations.every((row) => row.finished_at instanceof Date)).toBe(true);

    const owner = await db.accountUser.create({ data: { email: 'schema-owner@example.test', isAdmin: true } });
    const otherOwner = await db.accountUser.create({ data: { email: 'schema-other@example.test' } });
    expect((await db.accountUser.findUniqueOrThrow({ where: { id: owner.id } })).isAdmin).toBe(true);

    const farm = await db.farm.create({ data: {
      ownerId: owner.id, name: 'Schema baseline farm', centroidLat: -1.2921, centroidLon: 36.8219,
    } });
    const observedAt = new Date('2026-11-24T12:00:00.000Z');
    const observation = await db.environmentalObservation.create({ data: {
      ownerId: owner.id, namespace: `farm:${farm.id}`, farmId: farm.id,
      lat: -1.2921, lon: 36.8219, variable: 'T2M', obsDate: observedAt,
      value: 21.5, unit: 'C', sourceProvider: 'TEST', datasetVersion: 'schema-baseline',
    } });
    const readBack = await db.farm.findUniqueOrThrow({
      where: { id: farm.id }, include: { observations: { where: { id: observation.id } } },
    });
    expect(readBack.name).toBe('Schema baseline farm');
    expect(readBack.observations).toEqual([expect.objectContaining({
      id: observation.id, ownerId: owner.id, farmId: farm.id, value: 21.5, obsDate: observedAt,
    })]);

    const scenarioData = {
      farmId: farm.id, name: 'Maize and beans', cropKeys: '["maize","common_bean"]',
      ruleVersion: 'test', weights: '{}', scoresJson: '{}', overallScore: 0.8, confidence: 0.9,
    };
    await db.rotationScenario.create({ data: scenarioData });
    await expectUniqueViolation(db.rotationScenario.create({ data: scenarioData }));

    const idempotencyData = {
      ownerId: owner.id, route: '/api/v1/farms', key: 'request-1', requestHash: 'sha256:fixture', responseRef: 'farm:schema-fixture',
    };
    await db.idempotencyRecord.create({ data: idempotencyData });
    await expectUniqueViolation(db.idempotencyRecord.create({ data: idempotencyData }));
    const otherTenantReplay = await db.idempotencyRecord.create({ data: { ...idempotencyData, ownerId: otherOwner.id } });
    expect(otherTenantReplay).toMatchObject({ key: 'request-1' });

    const expiresAt = new Date(Date.now() + 60_000);
    const lease = await db.jobLease.create({ data: { key: 'scheduler:leader', holder: 'worker-1', expiresAt } });
    expect(lease).toMatchObject({ key: 'scheduler:leader', holder: 'worker-1', expiresAt });
    await expectUniqueViolation(db.jobLease.create({ data: { key: 'scheduler:leader', holder: 'worker-2', expiresAt } }));
    const outbox = await db.outboxEvent.create({ data: {
      aggregateType: 'Farm', aggregateId: farm.id, eventType: 'farm.created', payload: '{"farmId":"fixture"}', availableAt: observedAt,
    } });
    expect(outbox).toMatchObject({ aggregateId: farm.id, eventType: 'farm.created', publishedAt: null, attempts: 0 });

    const indexes = await db.$queryRaw<Array<{ tablename: string; indexname: string; indexdef: string }>>`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
    `;
    const hasIndex = (table: string, columns: string[], unique = false) => indexes.some((index) => {
      if (index.tablename !== table || (unique && !index.indexdef.startsWith('CREATE UNIQUE INDEX'))) return false;
      const indexedColumns = (index.indexdef.match(/\(([^)]+)\)/)?.[1] ?? '')
        .split(',').map((column) => column.replaceAll('"', '').trim());
      return columns.every((column, position) => indexedColumns[position] === column);
    });
    expect(hasIndex('Farm', ['ownerId'])).toBe(true);
    expect(hasIndex('EnvironmentalObservation', ['farmId', 'variable', 'obsDate'])).toBe(true);
    expect(hasIndex('TrendAnalysis', ['ownerId'])).toBe(true);
    expect(hasIndex('TrendAnalysis', ['farmId', 'variable'])).toBe(true);
    expect(hasIndex('ProcessingJob', ['ownerId'])).toBe(true);
    expect(hasIndex('FireWatchlist', ['ownerId'])).toBe(true);
    expect(hasIndex('RotationScenario', ['farmId', 'name'], true)).toBe(true);
    expect(hasIndex('IdempotencyRecord', ['ownerId', 'route', 'key'], true)).toBe(true);
    expect(hasIndex('JobLease', ['expiresAt'])).toBe(true);
    expect(hasIndex('OutboxEvent', ['availableAt', 'publishedAt'])).toBe(true);
  } finally {
    await db?.$disconnect();
    await database.drop();
  }
}, 180_000);
