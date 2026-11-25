import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, errorResponse, jsonResponse, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { normalizeEmail, tokenHash } from '@/lib/account-security';

const schema = z.object({ token: z.string().min(32).max(256) });

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/organizations/invitations/accept', async (req, { userId }) => {
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  const user = await db.accountUser.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return {
    commit: async (tx) => {
      const claimedAt = new Date();
      const claimed = await tx.organizationInvitation.updateMany({
        where: { tokenHash: tokenHash(parsed.data.token), acceptedAt: null, expiresAt: { gt: claimedAt } },
        data: { acceptedAt: claimedAt },
      });
      if (claimed.count !== 1) return errorResponse(400, 'INVALID_INVITATION', 'invitation is invalid, expired, or belongs to another account', correlationId);
      const invitation = await tx.organizationInvitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(parsed.data.token) } });
      if (normalizeEmail(invitation.email) !== normalizeEmail(user.email)) {
        return errorResponse(400, 'INVALID_INVITATION', 'invitation is invalid, expired, or belongs to another account', correlationId);
      }
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
        create: { organizationId: invitation.organizationId, userId, role: invitation.role },
        update: { role: invitation.role, status: 'active' },
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'organization.invitation.accept',
        targetId: invitation.id,
        organizationId: invitation.organizationId,
        aggregateType: 'Organization',
        aggregateId: invitation.organizationId,
        eventType: 'organization.member.joined',
        payload: { userId, role: invitation.role },
      });
      return jsonResponse({ accepted: true, organizationId: invitation.organizationId, role: invitation.role }, { correlationId });
    },
  };
}));
