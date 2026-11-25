import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { errorResponse, jsonResponse, parseBody } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { allowAccountAttempt, hashPassword, normalizeEmail, sameAccountOrigin, tokenHash, verificationToken } from '@/lib/account-security';
import { sendAccountEmail } from '@/lib/mail';

export const runtime = 'nodejs';
const schema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128), name: z.string().trim().min(1).max(120).optional() });

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameAccountOrigin(req) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return errorResponse(403, 'INVALID_ORIGIN', 'same-origin JSON request required', correlationId);
  }
  if (!process.env.NEXTAUTH_SECRET) return errorResponse(503, 'AUTH_UNAVAILABLE', 'account sign-in is not configured', correlationId);
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  const email = normalizeEmail(parsed.data.email);
  if (!await allowAccountAttempt('register', email)) return errorResponse(429, 'RATE_LIMITED', 'too many registration attempts', correlationId);
  const passwordHash = await hashPassword(parsed.data.password);
  const token = verificationToken();
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  try {
    const existing = await db.accountUser.findUnique({ where: { email } });
    if (!existing?.emailVerified) {
      const user = await db.$transaction(async (tx) => {
        if (!existing) return tx.accountUser.create({ data: {
          email, name: parsed.data.name, passwordHash,
          verifications: { create: { tokenHash: tokenHash(token), expiresAt } },
        } });
        const updated = await tx.accountUser.updateMany({ where: { id: existing.id, emailVerified: null }, data: { passwordHash, name: parsed.data.name } });
        if (updated.count !== 1) return null;
        await tx.accountVerification.deleteMany({ where: { userId: existing.id } });
        await tx.accountVerification.create({ data: { userId: existing.id, tokenHash: tokenHash(token), expiresAt } });
        return existing;
      });
      if (!user) return jsonResponse({ ok: true, message: 'If registration is available for this address, a verification email has been sent.', correlationId }, { status: 202, correlationId });
      try {
        const link = new URL('/', process.env.NEXTAUTH_URL);
        link.searchParams.set('verifyAccount', token);
        await sendAccountEmail(email, 'Verify your TerraField Atlas account', `Verify your account within one hour: ${link.toString()}\nIf you did not register, ignore this message.`);
      } catch {
        await db.accountVerification.deleteMany({ where: { tokenHash: tokenHash(token) } });
        return errorResponse(503, 'EMAIL_UNAVAILABLE', 'verification email could not be sent; try again later', correlationId);
      }
    }
    return jsonResponse({ ok: true, message: 'If registration is available for this address, a verification email has been sent.', correlationId }, { status: 202, correlationId });
  } catch {
    return errorResponse(503, 'REGISTRATION_UNAVAILABLE', 'registration unavailable; try again later', correlationId);
  }
}
