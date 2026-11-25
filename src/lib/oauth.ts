import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { rawDb } from '@/lib/db';

/**
 * OAuth 2.0 client-credentials support for the developer API.
 *
 * Clients are owned by an organization. The secret and every issued access
 * token are retained only as SHA-256 hashes, so a leaked database row cannot
 * be replayed. Secrets are compared in constant time.
 */

export const OAUTH_CLIENT_ID_PREFIX = 'tf_oauth_';
export const OAUTH_SECRET_PREFIX = 'tf_secret_';
export const OAUTH_ACCESS_TOKEN_PREFIX = 'tf_oauth_at_';
export const OAUTH_TOKEN_TTL_SECONDS = 3_600;

export interface OAuthPrincipal {
  keyId: string;
  userId: string;
  organizationId: string | null;
  scopes: string[];
}

export interface OAuthClientInput {
  organizationId: string;
  ownerId: string;
  name: string;
  scopes: readonly string[];
}

export type OAuthExchangeResult =
  | { ok: true; accessToken: string; expiresIn: number; scope: string }
  | { ok: false; status: 400 | 401; error: 'invalid_request' | 'invalid_client' | 'invalid_scope'; description: string };

export function hashOAuthSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function randomValue(prefix: string, bytes: number): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function generateOAuthClient(): { clientId: string; clientSecret: string } {
  return {
    clientId: randomValue(OAUTH_CLIENT_ID_PREFIX, 16),
    clientSecret: randomValue(OAUTH_SECRET_PREFIX, 32),
  };
}

/** Constant-time comparison of two SHA-256 hex digests. */
function hashesMatch(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function parseOAuthScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

export async function createOAuthClient(
  tx: Prisma.TransactionClient,
  input: OAuthClientInput,
): Promise<{ client: { id: string; name: string; clientId: string; scopes: string[]; active: boolean; createdAt: Date }; clientSecret: string }> {
  const generated = generateOAuthClient();
  const scopes = [...new Set(input.scopes)];
  const client = await tx.oAuthClient.create({
    data: {
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      name: input.name,
      clientId: generated.clientId,
      secretHash: hashOAuthSecret(generated.clientSecret),
      scopesJson: JSON.stringify(scopes),
    },
    select: { id: true, name: true, clientId: true, active: true, createdAt: true },
  });
  return { client: { ...client, scopes }, clientSecret: generated.clientSecret };
}

/** Disable a client and invalidate all of its issued access tokens. */
export async function revokeOAuthClient(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.oAuthClient.update({ where: { id }, data: { active: false } });
  await tx.oAuthToken.deleteMany({ where: { clientId: id } });
}

async function clientOwnerIsActiveMember(client: { organizationId: string; ownerId: string }): Promise<boolean> {
  const membership = await rawDb.membership.findUnique({
    where: { organizationId_userId: { organizationId: client.organizationId, userId: client.ownerId } },
    select: { status: true },
  });
  return membership?.status === 'active';
}

/**
 * Exchange client credentials for an opaque access token. Runs on the owner
 * connection because no tenant context exists before authentication.
 */
export async function exchangeClientCredentials(input: {
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
}): Promise<OAuthExchangeResult> {
  if (!input.clientId || !input.clientSecret) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'client_id and client_secret are required' };
  }
  const client = await rawDb.oAuthClient.findUnique({ where: { clientId: input.clientId } });
  const authenticated = client !== null && hashesMatch(hashOAuthSecret(input.clientSecret), client.secretHash);
  if (!client || !authenticated || !client.active) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' };
  }
  if (!await clientOwnerIsActiveMember(client)) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' };
  }
  const granted = parseOAuthScopes(client.scopesJson);
  const requested = input.scopes && input.scopes.length > 0 ? [...new Set(input.scopes)] : granted;
  if (requested.some((scope) => !granted.includes(scope))) {
    return { ok: false, status: 400, error: 'invalid_scope', description: 'requested scope exceeds the client scope' };
  }
  const accessToken = randomValue(OAUTH_ACCESS_TOKEN_PREFIX, 32);
  const expiresIn = OAUTH_TOKEN_TTL_SECONDS;
  await rawDb.oAuthToken.create({
    data: {
      clientId: client.id,
      tokenHash: hashOAuthSecret(accessToken),
      scopesJson: JSON.stringify(requested),
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    },
  });
  await rawDb.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { ok: true, accessToken, expiresIn, scope: requested.join(' ') };
}

/**
 * Resolve an opaque `tf_oauth_at_...` bearer token. Returns null for unknown,
 * expired, or revoked tokens so callers can emit a 401 without leaking which
 * condition failed.
 */
export async function authenticateOAuthAccessToken(secret: string): Promise<OAuthPrincipal | null> {
  const token = await rawDb.oAuthToken.findUnique({
    where: { tokenHash: hashOAuthSecret(secret) },
    include: { client: { select: { id: true, organizationId: true, ownerId: true, active: true } } },
  });
  if (!token || token.expiresAt <= new Date() || !token.client.active) return null;
  if (!await clientOwnerIsActiveMember(token.client)) return null;
  await rawDb.oAuthClient.update({ where: { id: token.client.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return {
    keyId: token.id,
    userId: token.client.ownerId,
    organizationId: token.client.organizationId,
    scopes: parseOAuthScopes(token.scopesJson),
  };
}
