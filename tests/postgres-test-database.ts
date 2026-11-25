import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,50}$/;
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,50}$/;

export function disposableDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !/^postgres(ql)?:\/\//.test(value)) {
    throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  }
  return value;
}

export function databaseUrlForSchema(baseUrl: string, schema: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Unsafe test schema name: ${schema}`);
  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export async function createPostgresTestDatabase(prefix: string): Promise<{
  url: string;
  schema: string;
  drop: () => Promise<void>;
}> {
  const baseUrl = disposableDatabaseUrl();
  const schema = `${prefix.toLowerCase()}_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Unsafe test schema name: ${schema}`);
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.$disconnect();
  }
  return {
    schema,
    url: databaseUrlForSchema(baseUrl, schema),
    drop: async () => {
      const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
      try {
        await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.$disconnect();
      }
    },
  };
}

export async function createEmptyPostgresTestDatabase(prefix: string): Promise<{
  url: string;
  databaseName: string;
  drop: () => Promise<void>;
}> {
  const baseUrl = disposableDatabaseUrl();
  const databaseName = `${prefix.toLowerCase()}_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
  if (!DATABASE_NAME.test(databaseName)) throw new Error(`Unsafe test database name: ${databaseName}`);
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  } finally {
    await admin.$disconnect();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('schema');
  return {
    databaseName,
    url: url.toString(),
    drop: async () => {
      const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
      try {
        await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await cleanup.$disconnect();
      }
    },
  };
}

export function deployMigrations(databaseUrl: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 300_000,
  });
}
