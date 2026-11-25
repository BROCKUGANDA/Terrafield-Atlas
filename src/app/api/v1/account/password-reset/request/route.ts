import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { errorResponse, jsonResponse, parseBody } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { accountRateLimit, normalizeEmail, sameAccountOrigin, tokenHash, verificationToken } from '@/lib/account-security';
import { sendAccountEmail } from '@/lib/mail';

export const runtime = 'nodejs';

const schema = z.object({ email: z.string().email().max(254) });
const GENERIC_MESSAGE = 'If a verified account exists for this address, a password-reset email has been sent.';

/**
 * POST /api/v1/account/password-reset/request
 *
 * Always answers 202 with the same message for known and unknown addresses so
 * the endpoint cannot be used to enumerate accounts. A token is only created
 * for a verified account, is hashed at rest, and replaces any prior token.
 */
export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameAccountOrigin(req) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return errorResponse(403, 'INVALID_ORIGIN', 'same-origin JSON request required', correlationId);
  }
  if (!process.env.NEXTAUTH_SECRET) return errorResponse(503, 'AUTH_UNAVAILABLE', 'account sign-in is not configured', correlationId);
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  const email = normalizeEmail(parsed.data.email);
  if (!await accountRateLimit('password-reset', email, 3, 15 * 60_000)) {
    return errorResponse(429, 'RATE_LIMITED', 'too many password-reset requests', correlationId);
  }
  const user = await db.accountUser.findUnique({ where: { email }, select: { id: true, emailVerified: true } });
  if (!user?.emailVerified) {
    return jsonResponse({ ok: true, message: GENERIC_MESSAGE, correlationId }, { status: 202, correlationId });
  }
  const token = verificationToken();
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  try {
    await db.$transaction(async (tx) => {
      await tx.passwordReset.deleteMany({ where: { userId: user.id } });
      await tx.passwordReset.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt } });
    });
  } catch {
    return errorResponse(503, 'RESET_UNAVAILABLE', 'password reset unavailable; try again later', correlationId);
  }
  try {
    const link = new URL('/', process.env.NEXTAUTH_URL);
    link.searchParams.set('resetAccount', token);
    await sendAccountEmail(email, 'Reset your TerraField Atlas password', `Reset your password within one hour: ${link.toString()}\nIf you did not request a reset, ignore this message; your password has not changed.`);
  } catch {
    await db.passwordReset.deleteMany({ where: { tokenHash: tokenHash(token) } });
    return errorResponse(503, 'EMAIL_UNAVAILABLE', 'password-reset email could not be sent; try again later', correlationId);
  }
  return jsonResponse({ ok: true, message: GENERIC_MESSAGE, correlationId }, { status: 202, correlationId });
}
