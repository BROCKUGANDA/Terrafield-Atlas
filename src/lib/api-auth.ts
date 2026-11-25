import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { AccountAccessError } from '@/lib/access-error';

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
  const key = await db.apiKey.findUnique({ where: { keyHash: hashApiKey(secret) } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) {
    throw new AccountAccessError(401, 'INVALID_API_KEY', 'API key is invalid, expired, or revoked');
  }
  if (key.organizationId) {
    const membership = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: key.organizationId, userId: key.ownerId } }, select: { status: true } });
    if (!membership || membership.status !== 'active') throw new AccountAccessError(403, 'ORGANIZATION_ACCESS_DENIED', 'API key owner is not an active organization member');
  }
  let scopes: ApiScope[];
  try {
    const parsed: unknown = JSON.parse(key.scopesJson);
    scopes = Array.isArray(parsed) ? parsed.filter((scope): scope is ApiScope => (API_SCOPES as readonly unknown[]).includes(scope)) : [];
  } catch { scopes = []; }
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { keyId: key.id, userId: key.ownerId, organizationId: key.organizationId, scopes };
}

export function requireApiScope(principal: ApiPrincipal, scope: ApiScope): void {
  if (!principal.scopes.includes(scope)) throw new AccountAccessError(403, 'INSUFFICIENT_SCOPE', `scope ${scope} is required`);
}
