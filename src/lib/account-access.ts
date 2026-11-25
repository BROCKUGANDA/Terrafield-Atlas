import { db } from '@/lib/db';
import { accountUserId } from '@/lib/auth';
import { BodyTooLargeError, readBoundedText, sameAccountOrigin } from '@/lib/account-security';
import { AccountAccessError } from '@/lib/access-error';
import { canReadResource, canWriteResource, hasPermission, resolveTenantContext } from '@/lib/tenancy';

export { AccountAccessError } from '@/lib/access-error';

export const visibleOwner = (userId: string | null) => userId ? { OR: [{ ownerId: null }, { ownerId: userId }] } : { ownerId: null };
export const canReadOwner = (ownerId: string | null, userId: string | null) => ownerId === null || (userId !== null && ownerId === userId);

/** accountUserId only resolves verified accounts; keep the write policy explicit here. */
export async function requireVerifiedWriter(req: Request): Promise<string> {
  const userId = await accountUserId(req);
  if (!userId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for this mutation');
  return userId;
}

export async function requireAdministrator(req: Request): Promise<string> {
  const userId = await requireVerifiedWriter(req);
  if (!sameAccountOrigin(req)) throw new AccountAccessError(403, 'INVALID_ORIGIN', 'same-origin request required');
  const user = await db.accountUser.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (!user?.isAdmin) throw new AccountAccessError(403, 'ADMIN_REQUIRED', 'administrator access is required');
  return userId;
}

/** Resolve all resource references before any provider call or child-table access. */
export async function accountApiGuard(req: Request, params: Record<string, unknown> = {}): Promise<void> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/api/v1/')) return;
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const unsafeMethod = !safeMethod;
  let body: Record<string, unknown> = {};
  if ((unsafeMethod || path === '/api/v1/reports') && path !== '/api/v1/raster/stats') {
    try {
      const raw: unknown = JSON.parse(await readBoundedText(req.clone()));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw as Record<string, unknown>;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw new AccountAccessError(413, 'PAYLOAD_TOO_LARGE', err.message);
      /* route validates malformed JSON */
    }
  }
  // Report compilation is a public read action expressed as POST. Persisting a
  // report is a real mutation and must pass authentication and origin checks.
  const mutation = unsafeMethod && !(path === '/api/v1/reports' && body.persist !== true);
  const context = await resolveTenantContext(req);
  const userId = context.userId;
  if (mutation && !userId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for this mutation');
  if (mutation && !sameAccountOrigin(req)) throw new AccountAccessError(403, 'INVALID_ORIGIN', 'same-origin request required');
  const farmIds = new Set<unknown>([params.farmId, body.farmId, ...url.searchParams.getAll('farmId')]);
  for (const id of farmIds) {
    if (id === undefined || id === null) continue;
    if (typeof id !== 'string' || !id) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
    const farm = await db.farm.findUnique({ where: { id }, select: { ownerId: true, organizationId: true } });
    if (!farm || !canReadResource(context, farm)) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
    if (mutation && !canWriteResource(context, farm)) {
      const analysisMutation = path === '/api/v1/observations/ingest' || path === '/api/v1/analysis/trends';
      if (!analysisMutation || farm.ownerId === null || !hasPermission(context, 'analysis.run')) {
        throw new AccountAccessError(403, 'READ_ONLY_DEMO', 'seeded and other accounts records are read-only');
      }
    }
  }
  if (path.startsWith('/api/v1/fires/watchlists/') && typeof params.id === 'string') {
    const watchlist = await db.fireWatchlist.findUnique({ where: { id: params.id }, select: { ownerId: true, organizationId: true } });
    if (!watchlist || !canReadResource(context, watchlist)) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
    if (mutation && !canWriteResource(context, watchlist)) {
      const evaluationMutation = path.endsWith('/evaluate');
      if (!evaluationMutation || watchlist.ownerId === null || !hasPermission(context, 'analysis.run')) {
        throw new AccountAccessError(403, 'READ_ONLY_DEMO', 'seeded and other accounts watchlists are read-only');
      }
    }
  }
  if (path.startsWith('/api/v1/analysis/jobs/')) {
    const jobId = params.jobId;
    if (typeof jobId !== 'string') throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
    const job = await db.processingJob.findUnique({ where: { id: jobId }, select: { ownerId: true, organizationId: true } });
    if (!job || !canReadResource(context, job)) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
  }
}
