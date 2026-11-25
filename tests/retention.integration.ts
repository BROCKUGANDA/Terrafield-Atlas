import { afterAll, expect, test } from 'bun:test';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

const database = await createPostgresTestDatabase('retention');
process.env.DATABASE_URL = database.url;
process.env.WATCH_SCHEDULER_OFF = '1';
const setup = deployMigrations(database.url);
if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);

const { db } = await import('@/lib/db');
const { cleanupRetention } = await import('@/lib/retention');

afterAll(async () => {
  await db.$disconnect();
  await database.drop();
}, 30_000);

test('retention removes only expired or aged operational rows', async () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const user = await db.accountUser.create({ data: { email: 'retention@example.test' } });
  await db.accountVerification.create({ data: { userId: user.id, tokenHash: 'expired-verification', expiresAt: new Date(now.getTime() - 1000) } });
  await db.accountVerification.create({ data: { userId: user.id, tokenHash: 'live-verification', expiresAt: new Date(now.getTime() + 60_000) } });
  await db.passwordReset.create({ data: { userId: user.id, tokenHash: 'expired-reset', expiresAt: new Date(now.getTime() - 1000) } });
  await db.accountRateLimit.create({ data: { key: 'expired-limit', expiresAt: new Date(now.getTime() - 1000) } });
  await db.accountRateLimit.create({ data: { key: 'live-limit', expiresAt: new Date(now.getTime() + 60_000) } });
  await db.idempotencyRecord.create({ data: { ownerId: user.id, route: '/r', key: 'old-key', requestHash: 'h', responseRef: '{}', createdAt: new Date(now.getTime() - 31 * 86_400_000) } });
  await db.idempotencyRecord.create({ data: { ownerId: user.id, route: '/r', key: 'fresh-key', requestHash: 'h', responseRef: '{}' } });
  await db.deliveryReceipt.create({ data: { channel: 'test', destinationKey: 'k', eventId: 'old', deliveredAt: new Date(now.getTime() - 40 * 86_400_000) } });
  await db.usageEvent.create({ data: { ownerId: user.id, metric: 'reports_per_month', quantity: 1, operationId: 'old-usage', occurredAt: new Date(now.getTime() - 800 * 86_400_000) } });
  await db.usageEvent.create({ data: { ownerId: user.id, metric: 'reports_per_month', quantity: 1, operationId: 'fresh-usage' } });
  await db.marketIngestion.create({ data: { datasetId: 'd', resourceUrl: 'u', rowCount: 1, accepted: 1, skipped: 0, startedAt: new Date(now.getTime() - 200 * 86_400_000) } });
  await db.marketIngestion.create({ data: { datasetId: 'd', resourceUrl: 'u', rowCount: 1, accepted: 1, skipped: 0 } });

  const result = await cleanupRetention(now);
  expect(result.accountVerifications).toBe(1);
  expect(result.passwordResets).toBe(1);
  expect(result.rateLimits).toBe(1);
  expect(result.idempotencyRecords).toBe(1);
  expect(result.deliveryReceipts).toBe(1);
  expect(result.usageEvents).toBe(1);
  expect(result.marketIngestions).toBe(1);

  expect(await db.accountVerification.count({ where: { tokenHash: 'live-verification' } })).toBe(1);
  expect(await db.accountRateLimit.count({ where: { key: 'live-limit' } })).toBe(1);
  expect(await db.idempotencyRecord.count({ where: { key: 'fresh-key' } })).toBe(1);
  expect(await db.usageEvent.count({ where: { operationId: 'fresh-usage' } })).toBe(1);
}, 30_000);
