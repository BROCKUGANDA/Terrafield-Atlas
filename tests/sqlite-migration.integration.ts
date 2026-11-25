import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { migrateSqlite, TABLE_MAPS } from '../scripts/migrate-sqlite-to-postgres';
import { validateMigration } from '../scripts/validate-migration';
import { createEmptyPostgresTestDatabase, deployMigrations } from './postgres-test-database';

const shell = Bun.which('sh') ?? 'sh';

const work = mkdtempSync(join(tmpdir(), 'terrafield migration '));
const sourcePath = join(work, 'fixture source.db');
let database: Awaited<ReturnType<typeof createEmptyPostgresTestDatabase>>;
let source: Database;

function posixPathForShell(value: string): string {
  if (process.platform !== 'win32') return value;
  const normalized = value.replaceAll('\\', '/').replace(/^"|"$/g, '');
  return /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized[0].toLowerCase()}${normalized.slice(2)}`
    : normalized;
}

function shellPath(value: string): string {
  if (process.platform !== 'win32') return value;
  return value.split(';').filter(Boolean).map(posixPathForShell).join(':');
}

beforeAll(async () => {
  database = await createEmptyPostgresTestDatabase('sqlite_cutover');
  const deployed = deployMigrations(database.url);
  expect(deployed.status, `${deployed.stdout}\n${deployed.stderr}`).toBe(0);
  source = new Database(sourcePath);
  source.exec('PRAGMA foreign_keys = ON');
  // Historical baseline generated from the pre-account SQLite Prisma schema,
  // then upgraded through the repository's real SQLite migrations. It is not
  // derived from PostgreSQL TABLE_MAPS.
  source.exec(readFileSync(resolve('tests/fixtures/legacy-sqlite-baseline.sql'), 'utf8'));
  for (const migration of ['20261119130000_private_accounts', '20261119140000_private_workflows']) {
    source.exec(readFileSync(resolve(`prisma/sqlite-migrations/${migration}/migration.sql`), 'utf8'));
  }
  expect(source.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('IdempotencyRecord','JobLease','OutboxEvent')").all()).toEqual([]);
  expect((source.query('PRAGMA table_info(AccountUser)').all() as Array<{ name: string }>).some((column) => column.name === 'isAdmin')).toBe(false);
}, 180_000);

afterAll(async () => {
  source?.close();
  await database?.drop();
  rmSync(work, { recursive: true, force: true });
}, 60_000);

function seed(): void {
  source.exec('PRAGMA foreign_keys = OFF');
  const tables = source.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'").all() as Array<{ name: string }>;
  for (const { name } of tables) source.exec(`DELETE FROM "${name}"`);
  const insert = (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    source.query(`INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((key) => row[key] as never));
  };
  const timestamp = '2026-11-24 12:34:56.789';
  insert('AccountUser', { id: 'user-1', email: 'müller@example.test', name: 'Åmina 🌾', passwordHash: null, emailVerified: timestamp, createdAt: timestamp });
  insert('Farm', { id: 'farm-1', ownerId: null, name: 'Shamba ya mboga 🥬', country: 'Kenya', region: 'África', centroidLat: -1.2921, centroidLon: 36.8219, boundaryGeoJson: null, areaHa: 2.5, notes: 'line one\nline two — café', ownerLabel: null, cropHistory: '["maize"]', createdAt: timestamp, updatedAt: timestamp });
  insert('EnvironmentalObservation', { id: 'obs-1', ownerId: 'user-1', namespace: 'private', farmId: 'farm-1', lat: -1.2921, lon: 36.8219, variable: 'T2M', obsDate: timestamp, value: 21.5, unit: '°C', sourceProvider: 'NASA', datasetVersion: 'fixture', retrievedAt: timestamp });
  insert('FireWatchlist', { id: 'watch-1', ownerId: null, name: 'Réserve', label: null, lat: 0, lon: 0, radiusKm: 15, minConfidence: 'nominal', lookbackDays: 7, detectionThreshold: 5, notes: null, lastStatus: 'unverified', lastDetectionCount: null, lastEvaluatedAt: null, reevaluateIntervalMin: null, nextReevaluateAt: null, createdAt: timestamp, updatedAt: timestamp });
  insert('FireWatchEvent', { id: 'event-1', watchlistId: 'watch-1', evaluatedAt: timestamp, windowStart: timestamp, windowEnd: timestamp, status: 'clear', detectionCount: 0, highConfidenceCount: 0, nominalCount: 0, lowCount: 0, maxFrpMW: null, daysWithDetections: 0, daysChecked: 7, daysNoData: 0, triggeredAlert: 0, detailJson: '{"reason":"aucune alerte"}', correlationId: null });
  source.exec('PRAGMA foreign_keys = ON');
  expect(source.query('PRAGMA foreign_key_check').all()).toEqual([]);
}

async function resetTarget(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    await db.$executeRawUnsafe('TRUNCATE ' + Object.keys(TABLE_MAPS).map((table) => `"${table}"`).join(', ') + ' CASCADE');
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "_migration_checkpoint"');
  } finally { await db.$disconnect(); }
}

async function wholeTargetDigest(db: PrismaClient): Promise<string> {
  const hash = createHash('sha256');
  const columns = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string }>>(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`);
  for (const column of columns) hash.update(JSON.stringify(column));
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    const key = map.columns.find((column) => column.primaryKey)!.name;
    const rows = await db.$queryRawUnsafe<Array<{ row: string }>>(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY "${key}"`);
    for (const row of rows) hash.update(row.row);
  }
  return hash.digest('hex');
}

function seedMoreThanOneHundredFarms(): void {
  source.query(`INSERT INTO Farm (id, name, centroidLat, centroidLon, createdAt, updatedAt)
    SELECT 'bulk-' || printf('%03d', value), 'Bulk ' || value, -1.0, 36.0, '2026-11-24 12:34:56.789', '2026-11-24 12:34:56.789'
    FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101]')`).run();
}

test('migrates representative rows twice without changing data and dry-run never mutates target', async () => {
  seed();
  const options = { sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 2 };
  const first = await migrateSqlite(options);
  const second = await migrateSqlite(options);
  expect(first.tables).toEqual(second.tables);
  expect(second.resumedTables).toContain('Farm');
  expect(first.tables.find((row) => row.table === 'Farm')).toMatchObject({ sourceCount: 1, targetCount: 1 });
  expect(first.tables.find((row) => row.table === 'Farm')?.sourceHash).toBe(first.tables.find((row) => row.table === 'Farm')?.targetHash);
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    const before = await wholeTargetDigest(db);
    const dryFirst = await migrateSqlite({ ...options, dryRun: true });
    const afterFirst = await wholeTargetDigest(db);
    const drySecond = await migrateSqlite({ ...options, dryRun: true });
    const afterSecond = await wholeTargetDigest(db);
    expect(afterFirst).toEqual(before);
    expect(afterSecond).toEqual(before);
    expect(drySecond.tables).toEqual(dryFirst.tables);
    expect(dryFirst.tables.every((row) => row.sourceCount === row.targetCount)).toBe(true);
    const farm = await db.farm.findUniqueOrThrow({ where: { id: 'farm-1' } });
    expect(farm).toMatchObject({ ownerId: null, name: 'Shamba ya mboga 🥬', createdAt: new Date('2026-11-24T12:34:56.789Z') });
    const account = await db.accountUser.findUniqueOrThrow({ where: { id: 'user-1' } });
    expect(account).toMatchObject({ name: 'Åmina 🌾', isAdmin: false });
    expect(await db.outboxEvent.count()).toBe(0);
  } finally {
    await db.$disconnect();
  }
}, 60_000);

test('validator rejects count and full hash mismatches', async () => {
  seed();
  await migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 2 });
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    await db.farm.update({ where: { id: 'farm-1' }, data: { name: 'tampered' } });
    await expect(validateMigration(`file:${sourcePath}`, database.url)).rejects.toThrow(/Farm.*hash|hash.*Farm/i);
    await db.farm.delete({ where: { id: 'farm-1' } });
    await expect(validateMigration(`file:${sourcePath}`, database.url)).rejects.toThrow(/Farm.*count|count.*Farm/i);
  } finally {
    await db.$disconnect();
  }
}, 60_000);

test('standalone validation checks rows and dates beyond the first 100', async () => {
  seed();
  seedMoreThanOneHundredFarms();
  await resetTarget();
  await migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 1000 });
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    await db.farm.update({ where: { id: 'bulk-101' }, data: { name: 'late target corruption' } });
    const validation = spawnSync(process.execPath, [resolve('scripts/validate-migration.ts'), `file:${sourcePath}`, database.url], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
    expect(validation.status).not.toBe(0);
    expect(`${validation.stdout}\n${validation.stderr}`).toMatch(/Farm.*hash|hash.*Farm/i);
  } finally { await db.$disconnect(); }
  source.query("UPDATE Farm SET updatedAt = '2026-02-30 12:00:00' WHERE id = 'bulk-101'").run();
  await expect(validateMigration(`file:${sourcePath}`, database.url)).rejects.toThrow(/invalid date/i);
}, 90_000);

test('migration rejects drifted booleans, integers, floats, and non-finite numbers', async () => {
  seed();
  const cases: Array<[string, unknown, RegExp]> = [
    ["UPDATE FireWatchEvent SET triggeredAlert = 'false' WHERE id = 'event-1'", 'event-1', /invalid boolean/i],
    ['UPDATE FireWatchlist SET lookbackDays = 1.5 WHERE id = ?', 'watch-1', /invalid integer/i],
    ["UPDATE Farm SET centroidLat = '' WHERE id = 'farm-1'", '', /invalid float/i],
    ["UPDATE Farm SET areaHa = 'Infinity' WHERE id = 'farm-1'", 'Infinity', /finite/i],
  ];
  for (const [sql, value, error] of cases) {
    if (sql.includes('?')) source.query(sql).run(value as never);
    else source.query(sql).run();
    await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).rejects.toThrow(error);
    seed();
  }
}, 60_000);

test('resumes after a committed batch when a later batch fails', async () => {
  seed();
  source.query(`INSERT INTO Farm (id, ownerId, name, centroidLat, centroidLon, createdAt, updatedAt)
    SELECT 'farm-2', ownerId, 'Second farm', centroidLat, centroidLon, createdAt, updatedAt FROM Farm WHERE id = 'farm-1'`).run();
  source.query(`INSERT INTO Farm (id, ownerId, name, centroidLat, centroidLon, createdAt, updatedAt)
    SELECT 'farm-3', ownerId, 'Third farm', centroidLat, centroidLon, createdAt, updatedAt FROM Farm WHERE id = 'farm-1'`).run();
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    await db.$executeRawUnsafe('TRUNCATE ' + Object.keys(TABLE_MAPS).map((table) => `"${table}"`).join(', ') + ' CASCADE');
    await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_migration_checkpoint" ("migrationKey" TEXT NOT NULL, "tableName" TEXT NOT NULL, "lastKey" TEXT NOT NULL, PRIMARY KEY ("migrationKey", "tableName"))');
    await db.$executeRawUnsafe('TRUNCATE "_migration_checkpoint"');
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_second_farm() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Second farm' THEN RAISE EXCEPTION 'simulated interruption'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_second_farm BEFORE INSERT ON "Farm" FOR EACH ROW EXECUTE FUNCTION fail_second_farm()');
    await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 1 })).rejects.toThrow(/simulated interruption/);
    expect(await db.farm.count()).toBe(1);
    await db.$executeRawUnsafe('DROP TRIGGER fail_second_farm ON "Farm"');
    await db.$executeRawUnsafe('DROP FUNCTION fail_second_farm()');
    source.query("UPDATE Farm SET name = 'Changed after checkpoint' WHERE id = 'farm-1'").run();
    await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 1 })).rejects.toThrow(/source fingerprint changed/i);
    source.query("UPDATE Farm SET name = 'Shamba ya mboga 🥬' WHERE id = 'farm-1'").run();
    const resumed = await migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 1 });
    expect(resumed.resumedTables).toContain('Farm');
    expect(await db.farm.count()).toBe(3);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_second_farm ON "Farm"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_second_farm()');
    await db.$disconnect();
  }
}, 60_000);

function replaceArgument(args: string[], name: string, value: string): string[] {
  const result = [...args];
  result[result.indexOf(name) + 1] = value;
  return result;
}

test('cutover verifies backup, freezes writes, migrates, activates, and becomes ready; rollback restores both snapshots without deleting source', async () => {
  const cleanup = new PrismaClient({ datasourceUrl: database.url });
  await cleanup.$executeRawUnsafe('TRUNCATE ' + Object.keys(TABLE_MAPS).map((table) => `"${table}"`).join(', ') + ' CASCADE');
  await cleanup.$executeRawUnsafe('DROP TABLE IF EXISTS "_migration_checkpoint"');
  await cleanup.$disconnect();
  seed();
  const backup = join(work, 'verified backup.db');
  const snapshot = join(work, 'target before.dump');
  const envFile = join(work, 'runtime.env');
  const artifact = join(work, 'new release');
  const previousArtifact = join(work, 'previous release');
  const marker = join(work, 'hooks.log');
  const restoreLog = join(work, 'pg-restore.log');
  const commandBin = join(work, 'bin');
  mkdirSync(commandBin);
  const inheritedShellPath = shellPath(process.env.PATH ?? '');
  const restoreCommand = spawnSync(shell, ['-c', 'command -v pg_restore'], { env: { ...process.env, PATH: inheritedShellPath }, encoding: 'utf8' });
  expect(restoreCommand.status, restoreCommand.stderr).toBe(0);
  const realPgRestore = restoreCommand.stdout.trim();
  expect(realPgRestore).not.toBe('');
  const pgRestoreWrapper = join(commandBin, 'pg_restore');
  writeFileSync(pgRestoreWrapper, `#!/bin/sh
set -eu
printf "%s\\n" "$*" >> "$RESTORE_LOG"
case "$*" in
  *--clean*) grep -q '^freeze$' "$MARKER" || { echo 'restore attempted before freeze' >&2; exit 90; } ;;
esac
exec "$REAL_PG_RESTORE" "$@"
`);
  chmodSync(pgRestoreWrapper, 0o755);
  const freeze = join(work, 'freeze hook.sh');
  const activate = join(work, 'activate hook.sh');
  const restart = join(work, 'restart hook.sh');
  const rollbackActivate = join(work, 'rollback activate hook.sh');
  mkdirSync(artifact);
  mkdirSync(previousArtifact);
  writeFileSync(envFile, 'DATABASE_URL=file:previous.db\nOTHER=preserve\n');
  writeFileSync(freeze, `#!/bin/sh
set -eu
psql --dbname="$TEST_DATABASE_URL" --set=ON_ERROR_STOP=1 --command="CREATE OR REPLACE FUNCTION reject_rollback_test_write() RETURNS trigger LANGUAGE plpgsql AS \\$\\$ BEGIN RAISE EXCEPTION 'writes rejected'; END \\$\\$" >/dev/null
psql --dbname="$TEST_DATABASE_URL" --set=ON_ERROR_STOP=1 --command='DROP TRIGGER IF EXISTS reject_rollback_test_write ON "AuditEvent"; CREATE TRIGGER reject_rollback_test_write BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION reject_rollback_test_write()' >/dev/null
if psql --dbname="$TEST_DATABASE_URL" --set=ON_ERROR_STOP=1 --command='INSERT INTO "AuditEvent" (id, actor, action) VALUES (''write-probe'', ''test'', ''probe'')' >/dev/null 2>&1; then
  echo 'write guard failed' >&2
  exit 1
fi
psql --dbname="$TEST_DATABASE_URL" --set=ON_ERROR_STOP=1 --command='DROP TRIGGER reject_rollback_test_write ON "AuditEvent"; DROP FUNCTION reject_rollback_test_write()' >/dev/null
printf "freeze\\n" >> "$MARKER"
`);
  writeFileSync(activate, '#!/bin/sh\nset -eu\n[ -d "$RELEASE_ARTIFACT" ]\nprintf "activate:%s\\n" "$RELEASE_ARTIFACT" >> "$MARKER"\n');
  writeFileSync(restart, '#!/bin/sh\nset -eu\nprintf "restart\\n" >> "$MARKER"\n');
  writeFileSync(rollbackActivate, '#!/bin/sh\nset -eu\n[ -d "$PREVIOUS_ARTIFACT" ]\nprintf "rollback-activate:%s\\n" "$PREVIOUS_ARTIFACT" >> "$MARKER"\n');
  const readiness = Bun.spawn([process.execPath, '-e', 'const server = Bun.serve({ port: 0, fetch: () => new Response("ready") }); console.log(server.port);'], { stdout: 'pipe', stderr: 'inherit' });
  let readinessUrl = '';
  try {
    const reader = readiness.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('readiness fixture exited before publishing its port');
      output += decoder.decode(chunk.value, { stream: true });
    }
    readinessUrl = `http://127.0.0.1:${output.trim()}/readyz`;
  } catch (error) {
    readiness.kill();
    throw error;
  }
  const env = { ...process.env, MARKER: marker, RESTORE_LOG: restoreLog, REAL_PG_RESTORE: realPgRestore, TEST_DATABASE_URL: database.url, PATH: `${posixPathForShell(commandBin)}:${inheritedShellPath}` };
  const base = [shell, resolve('deploy/scripts/cutover.sh'), '--source', sourcePath, '--target-url', database.url, '--backup', backup, '--target-snapshot', snapshot, '--artifact', artifact, '--env-file', envFile, '--freeze-hook', freeze, '--activate-hook', activate, '--restart-hook', restart, '--readiness-url', readinessUrl];
  try {
    const cutover = spawnSync(base[0], base.slice(1), { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000 });
    expect(cutover.status, `${cutover.stdout}\n${cutover.stderr}`).toBe(0);
    expect(readFileSync(marker, 'utf8')).toContain('freeze');
    expect(readFileSync(marker, 'utf8')).toContain(`activate:${artifact}`);
    expect(readFileSync(envFile, 'utf8')).toContain(`DATABASE_URL=${database.url}`);
    expect(readFileSync(envFile, 'utf8')).toContain('OTHER=preserve');
    expect(readFileSync(`${backup}.sha256`, 'utf8').trim()).toMatch(/^[a-f0-9]{64}  verified backup\.db$/);
    const sourceBefore = readFileSync(sourcePath);
    writeFileSync(marker, '');
    writeFileSync(restoreLog, '');
    const restored = join(work, 'restored source.db');
    const rollback = spawnSync(shell, [resolve('deploy/scripts/rollback.sh'), '--confirm', 'ROLLBACK', '--sqlite-backup', backup, '--restore-source-to', restored, '--target-url', database.url, '--target-snapshot', snapshot, '--freeze-hook', freeze, '--artifact', previousArtifact, '--activate-hook', rollbackActivate, '--env-file', envFile, '--database-url', `file:${restored}`, '--restart-hook', restart, '--readiness-url', readinessUrl], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000 });
    expect(rollback.status, `${rollback.stdout}\n${rollback.stderr}`).toBe(0);
    const restoreCommands = readFileSync(restoreLog, 'utf8').trim().split('\n');
    const listIndex = restoreCommands.findIndex((command) => command.includes('--list'));
    const cleanIndex = restoreCommands.findIndex((command) => command.includes('--clean'));
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(cleanIndex).toBeGreaterThan(listIndex);
    expect(readFileSync(marker, 'utf8')).toMatch(/^freeze\n/);
    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(readFileSync(marker, 'utf8')).toContain(`rollback-activate:${previousArtifact}`);
    const restoredDb = new Database(restored, { readonly: true });
    try {
      expect(restoredDb.query('SELECT name FROM Farm').all()).toEqual([{ name: 'Shamba ya mboga 🥬' }]);
      expect(restoredDb.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    } finally { restoredDb.close(); }
    const db = new PrismaClient({ datasourceUrl: database.url });
    try {
      expect(await db.farm.count()).toBe(0);
      expect(await db.$queryRaw<Array<{ checkpoint: string | null }>>`SELECT to_regclass('"_migration_checkpoint"')::text AS checkpoint`).toEqual([{ checkpoint: null }]);
    } finally { await db.$disconnect(); }
    expect(readFileSync(envFile, 'utf8')).toContain(`DATABASE_URL=file:${restored}`);
    const markerBeforeUnsafe = readFileSync(marker, 'utf8');
    const unsafe = spawnSync(base[0], base.slice(1), { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(unsafe.status).not.toBe(0);
    expect(`${unsafe.stdout}\n${unsafe.stderr}`).toMatch(/backup.*exist|refus|overwrite/i);
    expect(readFileSync(marker, 'utf8')).toBe(markerBeforeUnsafe);

    const unsafeBackup = join(work, "unsafe ' backup.db");
    const unsafeArgs = replaceArgument(replaceArgument(base, '--backup', unsafeBackup), '--target-snapshot', join(work, 'unused-apostrophe.dump'));
    const rejectedPath = spawnSync(unsafeArgs[0], unsafeArgs.slice(1), { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(rejectedPath.status).not.toBe(0);
    expect(`${rejectedPath.stdout}\n${rejectedPath.stderr}`).toMatch(/unsupported.*backup|backup.*unsupported/i);
    expect(readFileSync(marker, 'utf8')).toBe(markerBeforeUnsafe);
    const sidecarSnapshot = join(work, 'sidecar snapshot.dump');
    writeFileSync(`${sidecarSnapshot}.sha256`, `${'0'.repeat(64)}  sidecar snapshot.dump\n`);
    const sidecarArgs = replaceArgument(replaceArgument(base, '--backup', join(work, 'sidecar backup.db')), '--target-snapshot', sidecarSnapshot);
    const rejectedSidecar = spawnSync(sidecarArgs[0], sidecarArgs.slice(1), { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(rejectedSidecar.status).not.toBe(0);
    expect(`${rejectedSidecar.stdout}\n${rejectedSidecar.stderr}`).toMatch(/checksum.*exist|refus|overwrite/i);
    expect(readFileSync(marker, 'utf8')).toBe(markerBeforeUnsafe);

    const snapshotChecksum = `${snapshot}.sha256`;
    const validChecksum = readFileSync(snapshotChecksum, 'utf8');
    writeFileSync(snapshotChecksum, `${validChecksum[0] === '0' ? '1' : '0'}${validChecksum.slice(1)}`);
    const rejectedRestore = join(work, 'must not restore.db');
    const badSnapshot = spawnSync(shell, [resolve('deploy/scripts/rollback.sh'), '--confirm', 'ROLLBACK', '--sqlite-backup', backup, '--restore-source-to', rejectedRestore, '--target-url', database.url, '--target-snapshot', snapshot, '--freeze-hook', freeze, '--artifact', previousArtifact, '--activate-hook', rollbackActivate, '--env-file', envFile, '--database-url', `file:${rejectedRestore}`, '--restart-hook', restart, '--readiness-url', readinessUrl], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(badSnapshot.status).not.toBe(0);
    expect(`${badSnapshot.stdout}\n${badSnapshot.stderr}`).toMatch(/checksum mismatch/i);
    expect(() => readFileSync(rejectedRestore)).toThrow();
    expect(readFileSync(sourcePath)).toEqual(sourceBefore);

    writeFileSync(snapshotChecksum, validChecksum);
    const corruptSnapshot = join(work, 'corrupt snapshot.dump');
    writeFileSync(corruptSnapshot, 'not a PostgreSQL archive');
    const corruptHash = createHash('sha256').update(readFileSync(corruptSnapshot)).digest('hex');
    writeFileSync(`${corruptSnapshot}.sha256`, `${corruptHash}  corrupt snapshot.dump\n`);
    writeFileSync(restoreLog, '');
    writeFileSync(marker, '');
    const preflightRestore = join(work, 'preflight must not restore.db');
    const rejectedPreflight = spawnSync(shell, [resolve('deploy/scripts/rollback.sh'), '--confirm', 'ROLLBACK', '--sqlite-backup', backup, '--restore-source-to', preflightRestore, '--target-url', database.url, '--target-snapshot', corruptSnapshot, '--freeze-hook', freeze, '--artifact', previousArtifact, '--activate-hook', rollbackActivate, '--env-file', envFile, '--database-url', `file:${preflightRestore}`, '--restart-hook', restart, '--readiness-url', readinessUrl], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(rejectedPreflight.status).not.toBe(0);
    expect(`${rejectedPreflight.stdout}\n${rejectedPreflight.stderr}`).toMatch(/inspect.*snapshot|snapshot.*contents/i);
    expect(readFileSync(restoreLog, 'utf8')).toContain('--list');
    expect(readFileSync(restoreLog, 'utf8')).not.toContain('--clean');
    expect(existsSync(preflightRestore)).toBe(false);

    const validBackupChecksum = readFileSync(`${backup}.sha256`, 'utf8');
    writeFileSync(`${backup}.sha256`, 'abc  short\n');
    const invalidChecksumRestore = join(work, 'invalid checksum must not restore.db');
    const rejectedChecksumFormat = spawnSync(shell, [resolve('deploy/scripts/rollback.sh'), '--confirm', 'ROLLBACK', '--sqlite-backup', backup, '--restore-source-to', invalidChecksumRestore, '--target-url', database.url, '--target-snapshot', snapshot, '--freeze-hook', freeze, '--artifact', previousArtifact, '--activate-hook', rollbackActivate, '--env-file', envFile, '--database-url', `file:${invalidChecksumRestore}`, '--restart-hook', restart, '--readiness-url', readinessUrl], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(rejectedChecksumFormat.status).not.toBe(0);
    expect(`${rejectedChecksumFormat.stdout}\n${rejectedChecksumFormat.stderr}`).toMatch(/invalid checksum/i);
    expect(existsSync(invalidChecksumRestore)).toBe(false);
    writeFileSync(`${backup}.sha256`, `${validBackupChecksum.slice(0, 64)}  wrong-name.db\n`);
    const rejectedFilename = spawnSync(shell, [resolve('deploy/scripts/rollback.sh'), '--confirm', 'ROLLBACK', '--sqlite-backup', backup, '--restore-source-to', invalidChecksumRestore, '--target-url', database.url, '--target-snapshot', snapshot, '--freeze-hook', freeze, '--artifact', previousArtifact, '--activate-hook', rollbackActivate, '--env-file', envFile, '--database-url', `file:${invalidChecksumRestore}`, '--restart-hook', restart, '--readiness-url', readinessUrl], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
    expect(rejectedFilename.status).not.toBe(0);
    expect(`${rejectedFilename.stdout}\n${rejectedFilename.stderr}`).toMatch(/invalid checksum file format/i);
    expect(existsSync(invalidChecksumRestore)).toBe(false);
    writeFileSync(`${backup}.sha256`, validBackupChecksum);
  } finally { readiness.kill(); }
}, 180_000);

test('migration refuses a missing source without creating a database', async () => {
  const missing = join(work, 'missing source.db');
  await expect(migrateSqlite({ sourceUrl: `file:${missing}`, targetUrl: database.url, dryRun: false })).rejects.toThrow(/source.*not found/i);
  expect(existsSync(missing)).toBe(false);
}, 30_000);

test('migration rejects orphaned foreign keys', async () => {
  seed();
  source.exec('PRAGMA foreign_keys = OFF');
  source.query('UPDATE EnvironmentalObservation SET farmId = ? WHERE id = ?').run('missing-farm', 'obs-1');
  await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).rejects.toThrow(/orphaned foreign key/i);
  source.query('UPDATE EnvironmentalObservation SET farmId = ? WHERE id = ?').run('farm-1', 'obs-1');
  source.exec('PRAGMA foreign_keys = ON');
}, 60_000);

test('migration rejects unknown source columns and invalid dates', async () => {
  seed();
  await resetTarget();
  await migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: false, batchSize: 2 });
  source.exec('CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY, "checksum" TEXT)');
  await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).resolves.toBeDefined();
  source.exec('DROP TABLE "_prisma_migrations"');
  source.exec('ALTER TABLE Farm ADD COLUMN surprise TEXT');
  await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).rejects.toThrow(/unknown column.*surprise/i);
  source.exec('ALTER TABLE Farm DROP COLUMN surprise');
  source.query('UPDATE EnvironmentalObservation SET obsDate = ? WHERE id = ?').run('not-a-date', 'obs-1');
  await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).rejects.toThrow(/invalid date/i);
  source.query('UPDATE EnvironmentalObservation SET obsDate = ? WHERE id = ?').run('2026-02-30 12:00:00', 'obs-1');
  await expect(migrateSqlite({ sourceUrl: `file:${sourcePath}`, targetUrl: database.url, dryRun: true })).rejects.toThrow(/invalid date/i);
}, 60_000);
