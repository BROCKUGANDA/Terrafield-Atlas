#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { PrismaClient } from '@prisma/client';

export type ColumnType = 'text' | 'int' | 'float' | 'boolean' | 'date';
export interface ColumnMap { name: string; type: ColumnType; primaryKey?: boolean; targetDefault?: unknown }
export interface TableMap { columns: ColumnMap[]; foreignKeys: Array<[column: string, table: string, target: string]>; targetOnly?: boolean }
const c = (name: string, type: ColumnType = 'text', primaryKey = false): ColumnMap => ({ name, type, primaryKey });
const date = (name: string) => c(name, 'date');
const int = (name: string) => c(name, 'int');
const float = (name: string) => c(name, 'float');
const bool = (name: string) => c(name, 'boolean');

/** Explicit allow-list: schema drift must fail rather than silently lose columns. */
export const TABLE_MAPS: Record<string, TableMap> = {
  AccountUser: { columns: [c('id', 'text', true), c('email'), c('name'), c('passwordHash'), date('emailVerified'), { ...bool('isAdmin'), targetDefault: false }, date('createdAt')], foreignKeys: [] },
  AccountIdentity: { columns: [c('id', 'text', true), c('provider'), c('providerAccountId'), c('userId')], foreignKeys: [['userId', 'AccountUser', 'id']] },
  AccountVerification: { columns: [c('tokenHash', 'text', true), c('userId'), date('expiresAt')], foreignKeys: [['userId', 'AccountUser', 'id']] },
  AccountRateLimit: { columns: [c('key', 'text', true), int('count'), date('expiresAt')], foreignKeys: [] },
  IdempotencyRecord: { columns: [c('id', 'text', true), c('ownerId'), c('route'), c('key'), c('requestHash'), c('responseRef'), date('createdAt')], foreignKeys: [['ownerId', 'AccountUser', 'id']], targetOnly: true },
  JobLease: { columns: [c('id', 'text', true), c('key'), c('holder'), date('expiresAt'), date('heartbeatAt'), date('createdAt'), date('updatedAt')], foreignKeys: [], targetOnly: true },
  OutboxEvent: { columns: [c('id', 'text', true), c('aggregateType'), c('aggregateId'), c('eventType'), c('payload'), date('availableAt'), date('publishedAt'), int('attempts'), c('lastError'), date('createdAt')], foreignKeys: [], targetOnly: true },
  Farm: { columns: [c('id', 'text', true), c('ownerId'), c('name'), c('country'), c('region'), float('centroidLat'), float('centroidLon'), c('boundaryGeoJson'), float('areaHa'), c('notes'), c('ownerLabel'), c('cropHistory'), date('createdAt'), date('updatedAt')], foreignKeys: [['ownerId', 'AccountUser', 'id']] },
  SoilTest: { columns: [c('id', 'text', true), c('farmId'), date('measuredAt'), c('source'), c('sourceDetail'), float('depthCm'), c('texture'), float('sandPct'), float('siltPct'), float('clayPct'), float('ph'), float('organicCarbonPct'), float('nitrogenMgKg'), float('phosphorusMgKg'), float('potassiumCmolKg'), c('notes'), date('createdAt')], foreignKeys: [['farmId', 'Farm', 'id']] },
  DataSource: { columns: [c('id', 'text', true), c('provider'), c('datasetName'), c('productId'), c('endpointTemplate'), c('dataFormat'), c('temporalCoverage'), c('spatialResolution'), c('units'), bool('authRequired'), c('rateLimit'), c('license'), c('attribution'), c('limitations'), c('status'), date('lastCheckedAt'), date('createdAt')], foreignKeys: [] },
  ApiRequestLog: { columns: [c('id', 'text', true), c('provider'), c('datasetId'), c('operation'), c('requestUrl'), c('paramsHash'), int('status'), int('latencyMs'), int('responseBytes'), bool('ok'), c('errorDetail'), c('correlationId'), date('retrievedAt')], foreignKeys: [] },
  EnvironmentalObservation: { columns: [c('id', 'text', true), { ...c('ownerId'), targetDefault: null }, { ...c('namespace'), targetDefault: 'public' }, c('farmId'), float('lat'), float('lon'), c('variable'), date('obsDate'), float('value'), c('unit'), c('sourceProvider'), c('datasetVersion'), date('retrievedAt')], foreignKeys: [['ownerId', 'AccountUser', 'id'], ['farmId', 'Farm', 'id']] },
  CropCharacteristic: { columns: [c('id', 'text', true), c('catalogueVersion'), c('cropKey'), c('name'), c('scientificName'), c('family'), c('familyGroup'), int('growthDaysMin'), int('growthDaysMax'), int('waterReqMmMin'), int('waterReqMmMax'), c('waterUseClass'), bool('nFixation'), c('nutrientDemand'), c('thermalClass'), bool('calorieStaple'), float('soilPhMin'), float('soilPhMax'), c('textureSuitability'), c('notes'), c('sources'), bool('active')], foreignKeys: [] },
  FarmerPreferenceProfile: { columns: [c('id', 'text', true), c('farmId'), float('soilHealth'), float('waterEfficiency'), float('seasonalAdaptability'), float('nutrientManagement'), float('cropDiversity'), float('economics'), float('foodSecurity'), bool('rainfedOnly'), date('updatedAt')], foreignKeys: [['farmId', 'Farm', 'id']] },
  RotationScenario: { columns: [c('id', 'text', true), c('farmId'), c('name'), c('cropKeys'), c('ruleVersion'), c('weights'), c('scoresJson'), float('overallScore'), float('confidence'), c('incompatibleJson'), date('createdAt')], foreignKeys: [['farmId', 'Farm', 'id']] },
  TrendAnalysis: { columns: [c('id', 'text', true), { ...c('ownerId'), targetDefault: null }, c('farmId'), float('lat'), float('lon'), c('variable'), date('periodStart'), date('periodEnd'), int('sampleCount'), c('method'), float('slopePerYear'), float('pValue'), float('zValue'), c('direction'), bool('significant'), float('ciLower'), float('ciUpper'), c('resultJson'), c('ruleVersion'), date('createdAt')], foreignKeys: [['ownerId', 'AccountUser', 'id'], ['farmId', 'Farm', 'id']] },
  ProcessingJob: { columns: [c('id', 'text', true), { ...c('ownerId'), targetDefault: null }, c('type'), c('status'), c('params'), c('progressNote'), c('resultRef'), c('error'), c('correlationId'), date('startedAt'), date('finishedAt')], foreignKeys: [['ownerId', 'AccountUser', 'id']] },
  FireObservation: { columns: [c('id', 'text', true), c('regionKey'), date('obsDate'), float('latitude'), float('longitude'), c('confidence'), c('satellite'), c('sensor'), c('dayNight'), c('acqTime'), float('brightTi4'), float('brightTi5'), float('frp'), c('uid'), c('sourceProvider'), date('retrievedAt')], foreignKeys: [] },
  FireCoverageDay: { columns: [c('id', 'text', true), c('regionKey'), date('obsDate'), bool('dataAvailable'), int('detectionCount'), float('bboxWest'), float('bboxSouth'), float('bboxEast'), float('bboxNorth'), c('sourceProvider'), date('checkedAt')], foreignKeys: [] },
  FireWatchlist: { columns: [c('id', 'text', true), c('ownerId'), c('name'), c('label'), float('lat'), float('lon'), float('radiusKm'), c('minConfidence'), int('lookbackDays'), int('detectionThreshold'), c('notes'), c('lastStatus'), int('lastDetectionCount'), date('lastEvaluatedAt'), int('reevaluateIntervalMin'), date('nextReevaluateAt'), date('createdAt'), date('updatedAt')], foreignKeys: [['ownerId', 'AccountUser', 'id']] },
  FireWatchEvent: { columns: [c('id', 'text', true), c('watchlistId'), date('evaluatedAt'), date('windowStart'), date('windowEnd'), c('status'), int('detectionCount'), int('highConfidenceCount'), int('nominalCount'), int('lowCount'), float('maxFrpMW'), int('daysWithDetections'), int('daysChecked'), int('daysNoData'), bool('triggeredAlert'), c('detailJson'), c('correlationId')], foreignKeys: [['watchlistId', 'FireWatchlist', 'id']] },
  AuditEvent: { columns: [c('id', 'text', true), c('actor'), c('action'), c('targetId'), c('detail'), date('createdAt')], foreignKeys: [] },
};

export interface TableResult { table: string; sourceCount: number; targetCount: number; sourceHash: string; targetHash: string }
export interface MigrationResult { dryRun: boolean; tables: TableResult[]; resumedTables: string[] }

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }
function sqlitePath(sourceUrl: string): string {
  if (!sourceUrl.startsWith('file:')) throw new Error('sourceUrl must be an explicit file: SQLite URL');
  const path = resolve(decodeURIComponent(sourceUrl.slice(5)));
  if (path === resolve('db/custom.db')) throw new Error('Refusing to use db/custom.db; supply a disposable fixture source');
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`SQLite source not found: ${path}`);
  return path;
}
function normalizeDate(value: unknown, table: string, column: string): Date {
  if (value === null || value === undefined || value === '') throw new Error(`Invalid date in ${table}.${column}: null/empty`);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`Invalid date in ${table}.${column}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid date in ${table}.${column}: non-finite`);
    const fromNumber = new Date(value);
    if (Number.isNaN(fromNumber.getTime())) throw new Error(`Invalid date in ${table}.${column}`);
    return fromNumber;
  }
  if (typeof value !== 'string') throw new Error(`Invalid date type in ${table}.${column}: expected text or finite epoch number`);
  const text = value;
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(text);
  const iso = sqlite ? `${sqlite[1]}T${sqlite[2]}${(sqlite[3] ?? '.000').padEnd(4, '0')}Z` : text;
  const parsed = new Date(iso);
  const calendar = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (calendar) {
    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error(`Invalid date in ${table}.${column}: ${text}`);
  }
  if (!calendar || Number.isNaN(parsed.getTime())) throw new Error(`Invalid date in ${table}.${column}: ${text}`);
  return parsed;
}
function convertValue(table: string, column: ColumnMap, value: unknown): unknown {
  if (value === null) return null;
  const label = `${table}.${column.name}`;
  if (column.type === 'date') return normalizeDate(value, table, column.name);
  if (column.type === 'text') {
    if (typeof value !== 'string') throw new Error(`Invalid text type in ${label}: expected string`);
    return value;
  }
  if (column.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'number' || !Number.isFinite(value) || (value !== 0 && value !== 1)) throw new Error(`Invalid boolean in ${label}: expected integer 0 or 1`);
    return value === 1;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${column.type === 'int' ? 'integer' : 'float'} in ${label}: expected a finite number`);
  if (column.type === 'int') {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) throw new Error(`Invalid integer in ${label}: expected a signed 32-bit integer`);
    return value;
  }
  return value;
}
function convertRow(table: string, map: TableMap, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(map.columns.map((column) => [column.name, convertValue(table, column, row[column.name] === undefined && column.targetDefault !== undefined ? column.targetDefault : row[column.name])]));
}
function inspectSource(source: Database): Map<string, Set<string>> {
  const tables = source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'").all() as Array<{ name: string }>;
  const present = new Map<string, Set<string>>();
  for (const row of tables) present.set(row.name, new Set());
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    if (!present.has(table) && !map.targetOnly) throw new Error(`Missing source table ${table}`);
  }
  const extra = tables.filter((row) => !TABLE_MAPS[row.name]).map((row) => row.name);
  if (extra.length) throw new Error(`Unknown source table(s): ${extra.join(', ')}`);
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    if (!present.has(table)) continue;
    const actual = (source.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => row.name).sort();
    present.set(table, new Set(actual));
    const expected = map.columns.filter((column) => column.targetDefault === undefined).map((column) => column.name).sort();
    const optional = map.columns.filter((column) => column.targetDefault !== undefined).map((column) => column.name);
    const unknown = actual.filter((name) => !expected.includes(name) && !optional.includes(name));
    const missing = expected.filter((name) => !actual.includes(name));
    if (unknown.length || missing.length) throw new Error(`Unknown column(s) in ${table}: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`);
  }
  return present;
}
function sourceColumns(schema: ReadonlyMap<string, ReadonlySet<string>>, table: string, map: TableMap): ColumnMap[] {
  return map.columns.filter((column) => schema.get(table)?.has(column.name));
}
async function inspectTarget(target: PrismaClient): Promise<void> {
  const rows = await target.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> '_migration_checkpoint'`);
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    const actual = rows.filter((row) => row.table_name === table).map((row) => row.column_name).sort();
    const expected = map.columns.map((column) => column.name).sort();
    const missing = expected.filter((column) => !actual.includes(column));
    if (missing.length) throw new Error(`Target schema mismatch for ${table}; missing ${missing.join(', ')}`);
  }
}
function checkSqliteForeignKeys(source: Database, present: ReadonlyMap<string, ReadonlySet<string>>): void {
  const violations = source.query('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | null; parent: string; fkid: number }>;
  if (violations.length) throw new Error(`Orphaned foreign keys in SQLite: ${JSON.stringify(violations.slice(0, 5))}`);
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    if (!present.has(table)) continue;
    const primaryKey = map.columns.find((column) => column.primaryKey)!.name;
    for (const [column, parent, parentColumn] of map.foreignKeys) {
      if (!present.get(table)?.has(column)) continue;
      const row = source.query(`SELECT t.${quote(primaryKey)} AS id FROM ${quote(table)} t LEFT JOIN ${quote(parent)} p ON t.${quote(column)} = p.${quote(parentColumn)} WHERE t.${quote(column)} IS NOT NULL AND p.${quote(parentColumn)} IS NULL LIMIT 1`).get() as { id: unknown } | null;
      if (row) throw new Error(`Orphaned foreign key in ${table}.${column}: ${String(row.id)}`);
    }
  }
}
async function checkTargetForeignKeys(target: PrismaClient): Promise<void> {
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    for (const [column, parent, parentColumn] of map.foreignKeys) {
      const rows = await target.$queryRawUnsafe<Array<{ id: unknown }>>(`SELECT t.${quote(map.columns.find((item) => item.primaryKey)!.name)} AS id FROM ${quote(table)} t LEFT JOIN ${quote(parent)} p ON t.${quote(column)} = p.${quote(parentColumn)} WHERE t.${quote(column)} IS NOT NULL AND p.${quote(parentColumn)} IS NULL LIMIT 1`);
      if (rows.length) throw new Error(`Orphaned foreign key in ${table}.${column}: ${String(rows[0].id)}`);
    }
  }
}
function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonicalValue(row[key])]));
  }
  return value;
}
function canonicalRow(table: string, map: TableMap, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(map.columns.map((column) => [column.name, canonicalValue(convertValue(table, column, row[column.name] === undefined && column.targetDefault !== undefined ? column.targetDefault : row[column.name]))]));
}
function updateTableHash(hash: ReturnType<typeof createHash>, table: string, map: TableMap, rows: Record<string, unknown>[]): void {
  hash.update(table).update('\n');
  for (const row of rows) hash.update(JSON.stringify(canonicalRow(table, map, row))).update('\n');
}
function finishTableHash(hash: ReturnType<typeof createHash>): string {
  return hash.digest('hex');
}
function sourceFingerprint(source: Database, schema: ReadonlyMap<string, ReadonlySet<string>>): string {
  const hash = createHash('sha256');
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    if (!schema.has(table)) {
      updateTableHash(hash, table, map, []);
      continue;
    }
    const primaryKey = map.columns.find((column) => column.primaryKey)!.name;
    const columns = sourceColumns(schema, table, map).map((column) => quote(column.name)).join(',');
    let lastKey: string | null = null;
    while (true) {
      const rows = (lastKey
        ? source.query(`SELECT ${columns} FROM ${quote(table)} WHERE ${quote(primaryKey)} > ? ORDER BY ${quote(primaryKey)} LIMIT 1000`).all(lastKey)
        : source.query(`SELECT ${columns} FROM ${quote(table)} ORDER BY ${quote(primaryKey)} LIMIT 1000`).all()) as Record<string, unknown>[];
      if (!rows.length) break;
      updateTableHash(hash, table, map, rows);
      lastKey = String(rows.at(-1)![primaryKey]);
    }
    if (lastKey === null) updateTableHash(hash, table, map, []);
  }
  return hash.digest('hex');
}
async function targetTableHash(target: PrismaClient, table: string, map: TableMap): Promise<string> {
  const hash = createHash('sha256');
  const primaryKey = map.columns.find((column) => column.primaryKey)!.name;
  const columns = map.columns.map((column) => quote(column.name)).join(',');
  let lastKey: string | null = null;
  let sawRow = false;
  while (true) {
    const rows = lastKey
      ? await target.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${columns} FROM ${quote(table)} WHERE ${quote(primaryKey)} > $1 ORDER BY ${quote(primaryKey)} LIMIT 1000`, lastKey)
      : await target.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${columns} FROM ${quote(table)} ORDER BY ${quote(primaryKey)} LIMIT 1000`);
    if (!rows.length) break;
    sawRow = true;
    updateTableHash(hash, table, map, rows);
    lastKey = String(rows.at(-1)![primaryKey]);
  }
  if (!sawRow) updateTableHash(hash, table, map, []);
  return finishTableHash(hash);
}
async function validateMigrationInternal(source: Database, target: PrismaClient, schema: ReadonlyMap<string, ReadonlySet<string>>): Promise<TableResult[]> {
  checkSqliteForeignKeys(source, schema);
  await inspectTarget(target);
  await checkTargetForeignKeys(target);
  const results: TableResult[] = [];
  for (const [table, map] of Object.entries(TABLE_MAPS)) {
    const sourceHash = createHash('sha256');
    let sourceCount = 0;
    if (schema.has(table)) {
      const primaryKey = map.columns.find((column) => column.primaryKey)!.name;
      const columns = sourceColumns(schema, table, map).map((column) => quote(column.name)).join(',');
      sourceCount = Number((source.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number | bigint }).count);
      let lastKey: string | null = null;
      while (true) {
        const rows = (lastKey
          ? source.query(`SELECT ${columns} FROM ${quote(table)} WHERE ${quote(primaryKey)} > ? ORDER BY ${quote(primaryKey)} LIMIT 1000`).all(lastKey)
          : source.query(`SELECT ${columns} FROM ${quote(table)} ORDER BY ${quote(primaryKey)} LIMIT 1000`).all()) as Record<string, unknown>[];
        if (!rows.length) break;
        updateTableHash(sourceHash, table, map, rows);
        lastKey = String(rows.at(-1)![primaryKey]);
      }
    }
    if (sourceCount === 0) updateTableHash(sourceHash, table, map, []);
    const targetCount = Number((await target.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) AS count FROM ${quote(table)}`))[0].count);
    const result = { table, sourceCount, targetCount, sourceHash: finishTableHash(sourceHash), targetHash: await targetTableHash(target, table, map) };
    if (sourceCount !== targetCount) throw new Error(`${table} count mismatch: source=${sourceCount}, target=${targetCount}`);
    if (result.sourceHash !== result.targetHash) throw new Error(`${table} full hash mismatch: source=${result.sourceHash}, target=${result.targetHash}`);
    results.push(result);
  }
  return results;
}

export async function validateMigration(sourceUrl: string, targetUrl: string): Promise<TableResult[]> {
  const source = new Database(sqlitePath(sourceUrl), { readonly: true });
  const target = new PrismaClient({ datasourceUrl: targetUrl });
  try {
    const schema = inspectSource(source);
    return await validateMigrationInternal(source, target, schema);
  } finally {
    source.close();
    await target.$disconnect();
  }
}

export async function migrateSqlite({ sourceUrl, targetUrl, dryRun, batchSize = 500 }: { sourceUrl: string; targetUrl: string; dryRun: boolean; batchSize?: number }): Promise<MigrationResult> {
  if (!targetUrl.startsWith('postgresql://') && !targetUrl.startsWith('postgres://')) throw new Error('targetUrl must be an explicit PostgreSQL URL');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('batchSize must be between 1 and 10000');
  const source = new Database(sqlitePath(sourceUrl), { readonly: true });
  const target = new PrismaClient({ datasourceUrl: targetUrl });
  const resumedTables: string[] = [];
  try {
    const schema = inspectSource(source);
    checkSqliteForeignKeys(source, schema);
    await inspectTarget(target);
    await checkTargetForeignKeys(target);
    const fingerprint = sourceFingerprint(source, schema);
    if (!dryRun) {
      const checkpointTable = await target.$queryRawUnsafe<Array<{ exists: boolean }>>(`SELECT to_regclass('"_migration_checkpoint"') IS NOT NULL AS exists`);
      if (checkpointTable[0]?.exists) {
        const previous = await target.$queryRaw<Array<{ migrationKey: string }>>`SELECT DISTINCT "migrationKey" FROM "_migration_checkpoint" WHERE "migrationKey" <> ${fingerprint}`;
        if (previous.length) throw new Error('Source fingerprint changed since the previous migration; restore the frozen source or use a fresh target database');
      }
      await target.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_migration_checkpoint" ("migrationKey" TEXT NOT NULL, "tableName" TEXT NOT NULL, "lastKey" TEXT NOT NULL, PRIMARY KEY ("migrationKey", "tableName"))');
    }
    for (const [table, map] of Object.entries(TABLE_MAPS)) {
      if (!schema.has(table)) continue;
      const primaryKey = map.columns.find((column) => column.primaryKey)!.name;
      const columns = map.columns.map((column) => quote(column.name)).join(',');
      const selectedColumns = sourceColumns(schema, table, map).map((column) => quote(column.name)).join(',');
      let lastKey: string | null = null;
      if (!dryRun) {
        const checkpoint = await target.$queryRawUnsafe<Array<{ lastKey: string }>>('SELECT "lastKey" FROM "_migration_checkpoint" WHERE "migrationKey" = $1 AND "tableName" = $2', fingerprint, table);
        if (checkpoint.length) {
          if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid checkpoint fingerprint');
          lastKey = checkpoint[0].lastKey;
          const exists = await target.$queryRawUnsafe<Array<{ id: unknown }>>(`SELECT ${quote(primaryKey)} AS id FROM ${quote(table)} WHERE ${quote(primaryKey)} = $1`, lastKey);
          if (exists.length) resumedTables.push(table);
          else {
            await target.$executeRawUnsafe('DELETE FROM "_migration_checkpoint" WHERE "migrationKey" = $1 AND "tableName" = $2', fingerprint, table);
            lastKey = null;
          }
        }
      }
      while (true) {
        const rows = (lastKey
          ? source.query(`SELECT ${selectedColumns} FROM ${quote(table)} WHERE ${quote(primaryKey)} > ? ORDER BY ${quote(primaryKey)} LIMIT ?`).all(lastKey, batchSize)
          : source.query(`SELECT ${selectedColumns} FROM ${quote(table)} ORDER BY ${quote(primaryKey)} LIMIT ?`).all(batchSize)) as Record<string, unknown>[];
        if (!rows.length) break;
        const converted = rows.map((row) => convertRow(table, map, row));
        if (!dryRun) {
          let parameter = 0;
          const placeholders = converted.map(() => `(${map.columns.map(() => `$${++parameter}`).join(',')})`).join(',');
          const values = converted.flatMap((row) => map.columns.map((column) => row[column.name]));
          await target.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`INSERT INTO ${quote(table)} (${columns}) VALUES ${placeholders} ON CONFLICT (${quote(primaryKey)}) DO NOTHING`, ...values);
            await tx.$executeRawUnsafe('INSERT INTO "_migration_checkpoint" ("migrationKey", "tableName", "lastKey") VALUES ($1, $2, $3) ON CONFLICT ("migrationKey", "tableName") DO UPDATE SET "lastKey" = EXCLUDED."lastKey"', fingerprint, table, String(converted.at(-1)![primaryKey]));
          });
        }
        lastKey = String(converted.at(-1)![primaryKey]);
      }
    }
    const tables = await validateMigrationInternal(source, target, schema);
    return { dryRun, tables, resumedTables };
  } finally {
    source.close();
    await target.$disconnect();
  }
}

async function main(): Promise<void> {
  const [sourceUrl, targetUrl, ...rest] = process.argv.slice(2);
  if (!sourceUrl || !targetUrl || rest.some((arg) => !['--dry-run'].includes(arg))) {
    console.error('Usage: bun scripts/migrate-sqlite-to-postgres.ts <file:source.db> <postgresql://target> [--dry-run]');
    process.exit(2);
  }
  const result = await migrateSqlite({ sourceUrl, targetUrl, dryRun: rest.includes('--dry-run') });
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
