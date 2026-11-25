import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, errorResponse, jsonResponse, parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requireOrganization, requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { normalizeEmail, tokenHash, verificationToken } from '@/lib/account-security';
import { sendAccountEmail } from '@/lib/mail';

type InviteCtx = { params: Promise<{ id: string }> };
const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'analyst', 'agronomist', 'researcher', 'field_officer', 'viewer', 'api_service']),
});

export const POST = apiHandler<InviteCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/organizations/${req.nextUrl.pathname.split('/')[4]}/invitations`, async (req, { userId }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requireOrganization(context, id);
  requirePermission(context, 'member.manage');
  const rl = await rateLimit(clientKey(req, 'organization:invite'), { capacity: 10, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, inviteSchema);
  if (!parsed.ok) return parsed.res;
  const email = normalizeEmail(parsed.data.email);
  const token = verificationToken();
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  const organization = await db.organization.findUniqueOrThrow({ where: { id }, select: { name: true } });
  const invitation = await db.$transaction(async (tx) => {
    const created = await tx.organizationInvitation.create({
      data: { organizationId: id, email, role: parsed.data.role, tokenHash: tokenHash(token), invitedById: userId, expiresAt },
    });
    await writeMutationEffects(tx, {
      actor: `account:${userId}`,
      action: 'organization.invitation.create',
      targetId: created.id,
      detail: `${email} as ${parsed.data.role}`,
      organizationId: id,
      aggregateType: 'Organization',
      aggregateId: id,
      eventType: 'organization.invitation.created',
      payload: { invitationId: created.id, email, role: parsed.data.role },
    });
    return created;
  });

  try {
    const link = new URL('/account', process.env.NEXTAUTH_URL);
    link.searchParams.set('organizationInvite', token);
    await sendAccountEmail(email, `Invitation to ${organization.name}`, `You have been invited to join ${organization.name} on TerraField Atlas as ${parsed.data.role}. Accept within seven days: ${link.toString()}`);
  } catch {
    await db.organizationInvitation.delete({ where: { id: invitation.id } }).catch(() => undefined);
    return errorResponse(503, 'EMAIL_UNAVAILABLE', 'invitation email could not be sent; try again later', correlationId);
  }
  return jsonResponse({ invitation: { id: invitation.id, email, role: invitation.role, expiresAt } }, { status: 201, correlationId });
}));
