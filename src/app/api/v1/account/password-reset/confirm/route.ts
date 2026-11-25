import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { errorResponse, jsonResponse, parseBody } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { accountRateLimit, hashPassword, sameAccountOrigin, tokenHash } from '@/lib/account-security';

export const runtime = 'nodejs';

const schema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12).max(128),
});

/**
 * POST /api/v1/account/password-reset/confirm
 *
 * Consumes the reset token exactly once inside a transaction, replaces the
 * password hash, and clears every outstanding reset and verification token for
 * the account. Unknown, expired and already-used tokens all return one error.
 */
export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameAccountOrigin(req) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return errorResponse(403, 'INVALID_ORIGIN', 'same-origin JSON request required', correlationId);
  }
  if (!process.env.NEXTAUTH_SECRET) return errorResponse(503, 'AUTH_UNAVAILABLE', 'account sign-in is not configured', correlationId);
  if (!await accountRateLimit('password-reset-confirm', 'global', 60, 60_000)) {
    return errorResponse(429, 'RATE_LIMITED', 'too many password-reset attempts', correlationId);
  }
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  if (parsed.data.password.length < 12) {
    return errorResponse(400, 'WEAK_PASSWORD', 'password must be at least 12 characters', correlationId);
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const hash = tokenHash(parsed.data.token);
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.passwordReset.findUnique({ where: { tokenHash: hash }, select: { userId: true, expiresAt: true } });
    if (!row || row.expiresAt <= new Date()) return false;
    const consumed = await tx.passwordReset.deleteMany({ where: { tokenHash: hash, expiresAt: { gt: new Date() } } });
    if (consumed.count !== 1) return false;
    await tx.accountUser.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.passwordReset.deleteMany({ where: { userId: row.userId } });
    await tx.accountVerification.deleteMany({ where: { userId: row.userId } });
    return true;
  });
  return updated
    ? jsonResponse({ ok: true, correlationId }, { correlationId })
    : errorResponse(400, 'INVALID_TOKEN', 'password-reset link is invalid or expired', correlationId);
}
