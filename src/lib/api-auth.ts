import { createHash, randomBytes } from 'node:crypto';
import { rawDb } from '@/lib/db';
import { AccountAccessError } from '@/lib/access-error';
import { OAUTH_ACCESS_TOKEN_PREFIX, authenticateOAuthAccessToken } from '@/lib/oauth';

export const API_SCOPES = ['farms.read', 'observations.read', 'analyses.read', 'reports.read', 'sources.read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiPrincipal {
  keyId: string;
  userId: string;
  organizationId: string | null;
  scopes: readonly ApiScope[];
}

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const random = randomBytes(32).toString('base64url');
  const secret = `tf_live_${random}`;
  const prefix = `tf_live_${random.slice(0, 8)}`;
  return { secret, prefix, hash: createHash('sha256').update(secret).digest('hex') };
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export async function authenticateApiKey(req: Request): Promise<ApiPrincipal> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new AccountAccessError(401, 'API_KEY_REQUIRED', 'Bearer API key is required');
  const secret = header.slice(7).trim();
  if (secret.length < 20 || secret.length > 200) throw new AccountAccessError(401, 'INVALID_API_KEY', 'API key is invalid');
  const key = await rawDb.apiKey.findUnique({ where: { keyHash: hashApiKey(secret) } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) {
    throw new AccountAccessError(401, 'INVALID_API_KEY', 'API key is invalid, expired, or revoked');
  }
  if (key.organizationId) {
    const membership = await rawDb.membership.findUnique({ where: { organizationId_userId: { organizationId: key.organizationId, userId: key.ownerId } }, select: { status: true } });
    if (!membership || membership.status !== 'active') throw new AccountAccessError(403, 'ORGANIZATION_ACCESS_DENIED', 'API key owner is not an active organization member');
  }
  let scopes: ApiScope[];
  try {
    const parsed: unknown = JSON.parse(key.scopesJson);
    scopes = Array.isArray(parsed) ? parsed.filter((scope): scope is ApiScope => (API_SCOPES as readonly unknown[]).includes(scope)) : [];
  } catch { scopes = []; }
  await rawDb.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { keyId: key.id, userId: key.ownerId, organizationId: key.organizationId, scopes };
}

/**
 * Authenticate a developer request with either a hashed API key (`tf_live_...`)
 * or an OAuth 2.0 client-credentials access token (`tf_oauth_at_...`). API key
 * handling is intentionally unchanged; OAuth tokens resolve the owning
 * organization and the scopes frozen at issuance time.
 */
export async function authenticateDeveloperRequest(req: Request): Promise<ApiPrincipal> {
  const header = req.headers.get('authorization');
  const secret = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (secret.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const principal = await authenticateOAuthAccessToken(secret);
    if (!principal) throw new AccountAccessError(401, 'INVALID_OAUTH_TOKEN', 'OAuth access token is invalid, expired, or revoked');
    const scopes = principal.scopes.filter((scope): scope is ApiScope => (API_SCOPES as readonly string[]).includes(scope));
    return { keyId: principal.keyId, userId: principal.userId, organizationId: principal.organizationId, scopes };
  }
  return authenticateApiKey(req);
}

export function requireApiScope(principal: ApiPrincipal, scope: ApiScope): void {
  if (!principal.scopes.includes(scope)) throw new AccountAccessError(403, 'INSUFFICIENT_SCOPE', `scope ${scope} is required`);
}
