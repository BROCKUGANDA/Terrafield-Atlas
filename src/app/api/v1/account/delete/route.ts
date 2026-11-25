import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { rawDb } from '@/lib/db';
import { errorResponse, jsonResponse, parseBody } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { accountRateLimit, sameAccountOrigin, verifyPassword } from '@/lib/account-security';

export const runtime = 'nodejs';

const schema = z.object({
  password: z.string().min(1).max(1024),
  confirmation: z.literal('DELETE'),
});

interface BlockerCounts {
  organizationsOwned: number;
  farmsOwned: number;
  soleOwnerOrganizations: number;
  watchlistsOwned: number;
  organizationInvitationsCreated: number;
  apiKeysCreated: number;
}

/**
 * Rows whose foreign keys use Restrict would make the cascade fail. Count them
 * first so the caller receives actionable blockers instead of a database error.
 */
async function countBlockers(tx: Prisma.TransactionClient, userId: string): Promise<BlockerCounts> {
  const ownedMemberships = await tx.membership.findMany({
    where: { userId, role: 'owner' },
    select: { organizationId: true },
  });
  const ownedOrganizationIds = ownedMemberships.map((membership) => membership.organizationId);
  const ownerGroups = ownedOrganizationIds.length === 0 ? [] : await tx.membership.groupBy({
    by: ['organizationId'],
    where: { organizationId: { in: ownedOrganizationIds }, role: 'owner', status: 'active' },
    _count: { _all: true },
  });
  const [farmsOwned, watchlistsOwned, organizationInvitationsCreated, apiKeysCreated] = await Promise.all([
    tx.farm.count({ where: { ownerId: userId } }),
    tx.fireWatchlist.count({ where: { ownerId: userId } }),
    tx.organizationInvitation.count({ where: { invitedById: userId } }),
    // Keys the user owns are erased with the account; only keys that would
    // leave another owner's credential behind (createdBy Restrict) block.
    tx.apiKey.count({ where: { createdById: userId, ownerId: { not: userId } } }),
  ]);
  return {
    organizationsOwned: ownedOrganizationIds.length,
    farmsOwned,
    soleOwnerOrganizations: ownerGroups.filter((group) => group._count._all === 1).length,
    watchlistsOwned,
    organizationInvitationsCreated,
    apiKeysCreated,
  };
}

class AccountHasBlockersError extends Error {
  constructor(public readonly counts: BlockerCounts) {
    super('account has blockers');
    this.name = 'AccountHasBlockersError';
  }
}

/**
 * POST /api/v1/account/delete
 *
 * Self-service account erasure. Requires the signed-in account's password and
 * an explicit confirmation phrase. Accounts that still own organizations,
 * farms, watchlists, invitations or API keys are refused with counts so the
 * owner can transfer or remove that data first; the audit event and the delete
 * commit atomically.
 */
export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameAccountOrigin(req) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return errorResponse(403, 'INVALID_ORIGIN', 'same-origin JSON request required', correlationId);
  }
  if (!process.env.NEXTAUTH_SECRET) return errorResponse(503, 'AUTH_UNAVAILABLE', 'account sign-in is not configured', correlationId);

  // No tenant context exists for this route: resolve the verified account on
  // the owner connection, which bypasses RLS for the auth lookup.
  const token = await getToken({ req: req as Parameters<typeof getToken>[0]['req'], secret: process.env.NEXTAUTH_SECRET });
  if (!token?.sub) return errorResponse(401, 'AUTH_REQUIRED', 'a verified account is required', correlationId);
  const user = await rawDb.accountUser.findUnique({
    where: { id: token.sub },
    select: { id: true, passwordHash: true, emailVerified: true },
  });
  if (!user?.emailVerified) return errorResponse(401, 'AUTH_REQUIRED', 'a verified account is required', correlationId);

  if (!await accountRateLimit('account-delete:global', 'all', 30, 60_000)
    || !await accountRateLimit('account-delete', user.id, 5, 15 * 60_000)) {
    return errorResponse(429, 'RATE_LIMITED', 'too many account deletion attempts', correlationId);
  }

  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  if (!await verifyPassword(parsed.data.password, user.passwordHash)) {
    return errorResponse(401, 'INVALID_PASSWORD', 'password is incorrect', correlationId);
  }

  try {
    await rawDb.$transaction(async (tx) => {
      const counts = await countBlockers(tx, user.id);
      if (Object.values(counts).some((count) => count > 0)) throw new AccountHasBlockersError(counts);
      await tx.auditEvent.create({ data: {
        actor: `account:${user.id}`,
        action: 'account.deleted',
        targetId: user.id,
        detail: 'self-service account deletion',
      } });
      // ApiKey.createdBy is Restrict, so erase owned keys explicitly before the
      // account row; the remaining cascades then have nothing to trip over.
      await tx.apiKey.deleteMany({ where: { ownerId: user.id } });
      await tx.accountUser.delete({ where: { id: user.id } });
    });
  } catch (error) {
    if (error instanceof AccountHasBlockersError) {
      return errorResponse(
        409,
        'ACCOUNT_HAS_BLOCKERS',
        'delete or transfer the listed resources before closing this account',
        correlationId,
        error.counts,
      );
    }
    // A concurrent write may attach a restricted row after the counts commit.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return errorResponse(
        409,
        'ACCOUNT_HAS_BLOCKERS',
        'the account still owns resources that must be transferred or removed first',
        correlationId,
      );
    }
    throw error;
  }
  return jsonResponse({ ok: true }, { correlationId });
}
