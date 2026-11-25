import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TenantContext } from '@/lib/tenancy';

const globalForPrisma = globalThis as unknown as { __terraRawPrisma?: PrismaClient; __terraTenantPrisma?: PrismaClient };
const rawClient = globalForPrisma.__terraRawPrisma ?? new PrismaClient({ log: ['warn', 'error'] });
if (process.env.NODE_ENV !== 'production') globalForPrisma.__terraRawPrisma = rawClient;

/**
 * Tenant operations run on TENANT_DATABASE_URL when it is configured: the
 * production web process points it at the `terrafield_app` role so PostgreSQL
 * RLS is enforced for every request that resolved a tenant context (including
 * anonymous public reads). Auth, migrations and worker work keep DATABASE_URL
 * (the owner role) and bypass RLS by design.
 */
const tenantUrl = process.env.TENANT_DATABASE_URL?.trim();
const scopedClient = tenantUrl
  ? (globalForPrisma.__terraTenantPrisma ?? new PrismaClient({ datasources: { db: { url: tenantUrl } }, log: ['warn', 'error'] }))
  : rawClient;
if (process.env.NODE_ENV !== 'production' && tenantUrl) globalForPrisma.__terraTenantPrisma = scopedClient;

const tenantStorage = new AsyncLocalStorage<TenantContext | null>();

/** Schema of the tenant connection; policies resolve helper tables there. */
const databaseSchema = (() => {
  try {
    const url = new URL(process.env.TENANT_DATABASE_URL?.trim() || process.env.DATABASE_URL || '');
    return url.searchParams.get('schema') || 'public';
  } catch {
    return 'public';
  }
})();

type Delegate = Record<string, unknown>;

async function setTenantContext(client: Prisma.TransactionClient, context: TenantContext | null): Promise<void> {
  await client.$executeRaw`SELECT set_config('app.user_id', ${context?.userId ?? ''}, true)`;
  await client.$executeRaw`SELECT set_config('app.organization_id', ${context?.organizationId ?? ''}, true)`;
  await client.$executeRaw`SELECT set_config('app.schema', ${databaseSchema}, true)`;
}

function isDelegate(value: unknown): value is Delegate {
  return Boolean(value) && typeof value === 'object' &&
    ['findUnique', 'findMany', 'create', 'update', 'delete', 'count', 'aggregate'].some((key) => typeof (value as Delegate)[key] === 'function');
}

/**
 * Prisma client proxy that binds every model operation to transaction-local
 * RLS context when a request has resolved a tenant. Operations without context
 * keep the original behavior (jobs, migrations, fixtures, and public reads).
 */
export const rawDb = rawClient;
const wrappedDelegates = new Map<string, Delegate>();
const clientOverrides = new Map<string, unknown>();

function wrapDelegate(modelName: string, value: Delegate): Delegate {
  const overrides = new Map<string, unknown>();
  return new Proxy(value, {
    get(model, operation, modelReceiver) {
      if (typeof operation === 'string' && overrides.has(operation)) return overrides.get(operation);
      const method = Reflect.get(model, operation, modelReceiver);
      if (typeof method !== 'function' || operation === 'then') return method;
      return (...args: unknown[]) => {
        const context = tenantStorage.getStore() ?? null;
        if (!context) return (method as (...input: unknown[]) => unknown).apply(model, args);
        return scopedClient.$transaction(async (tx) => {
          await setTenantContext(tx, context);
          const txDelegate = (tx as unknown as Record<string, Delegate>)[modelName] as Delegate;
          return (txDelegate[operation as string] as (...input: unknown[]) => unknown)(...args);
        }, { maxWait: 10_000, timeout: 15_000 });
      };
    },
    set(_model, operation, next) {
      if (typeof operation === 'string') overrides.set(operation, next);
      return true;
    },
  });
}

export const db = new Proxy(rawClient, {
  get(target, property, receiver) {
    if (property === '$transaction') {
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: Parameters<PrismaClient['$transaction']>[1]) => {
        const context = tenantStorage.getStore() ?? null;
        // No request tenant means worker/auth/migration work: use the owner
        // connection so background jobs and bootstrap paths keep full access.
        if (!context) return target.$transaction(fn, options);
        return scopedClient.$transaction(async (tx) => {
          await setTenantContext(tx, context);
          return fn(tx);
        }, options);
      };
    }
    if (typeof property !== 'string') return Reflect.get(target, property, receiver);
    if (clientOverrides.has(property)) return clientOverrides.get(property);
    const value = Reflect.get(target, property, receiver);
    if (!isDelegate(value)) return value;
    let wrapped = wrappedDelegates.get(property);
    if (!wrapped) {
      wrapped = wrapDelegate(property, value);
      wrappedDelegates.set(property, wrapped);
    }
    return wrapped;
  },
  set(_target, property, next) {
    if (typeof property === 'string') clientOverrides.set(property, next);
    return true;
  },
}) as PrismaClient;

export function withTenantContext<T>(context: TenantContext | null, fn: () => T | Promise<T>): T | Promise<T> {
  return tenantStorage.run(context, fn);
}

export function currentTenantContext(): TenantContext | null {
  return tenantStorage.getStore() ?? null;
}

/**
 * Replace the tenant context for the remainder of the current async chain.
 * Developer routes authenticate after apiHandler resolved an anonymous
 * session context; the API principal then becomes the authoritative tenant.
 * `enterWith` is scoped to this request chain, not to sibling requests.
 */
export function enterTenantContext(context: TenantContext): void {
  tenantStorage.enterWith(context);
}
