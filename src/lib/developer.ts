import { authenticateDeveloperRequest, requireApiScope, type ApiPrincipal, type ApiScope } from '@/lib/api-auth';
import { AccountAccessError } from '@/lib/access-error';
import { rateLimit } from '@/lib/api/helpers';
import { assertCapability, assertEntitlement, recordUsage } from '@/lib/commercial';
import type { TenantContext } from '@/lib/tenancy';
import { withTenantContext } from '@/lib/tenant-db';

export interface DeveloperContext {
  principal: ApiPrincipal;
  tenant: TenantContext;
  remaining: number;
  retryAfterSec: number;
}

export async function developerGuard(req: Request, scope: ApiScope): Promise<DeveloperContext> {
  const principal = await authenticateDeveloperRequest(req);
  requireApiScope(principal, scope);
  const tenant: TenantContext = {
    userId: principal.userId,
    organizationId: principal.organizationId,
    organizationName: null,
    role: 'api_service',
    permissions: [],
    isPlatformAdmin: false,
  };
  await assertCapability(tenant, 'api_access');
  await assertEntitlement(tenant, 'api_requests_per_day');
  const limit = await rateLimit(`developer:${principal.keyId}`, { capacity: 120, refillPerMinute: 120 });
  if (!limit.allowed) throw new AccountAccessError(429, 'RATE_LIMITED', `too many requests; retry after ${limit.retryAfterSec}s`);
  return { principal, tenant, remaining: limit.remaining, retryAfterSec: limit.retryAfterSec };
}

/**
 * Run a developer route body inside the principal's tenant context so every
 * Prisma call resolves under the app role with RLS context set. The request's
 * session context (usually anonymous) must not govern API-key/OAuth reads.
 */
export async function runDeveloper<T>(req: Request, scope: ApiScope, fn: (guard: DeveloperContext) => Promise<T>): Promise<T> {
  const guard = await developerGuard(req, scope);
  return withTenantContext(guard.tenant, () => fn(guard));
}

export async function meterDeveloperRequest(context: DeveloperContext, correlationId: string): Promise<void> {
  await recordUsage({ context: context.tenant, metric: 'api_requests_per_day', operationId: `api:${context.principal.keyId}:${correlationId}` });
}
