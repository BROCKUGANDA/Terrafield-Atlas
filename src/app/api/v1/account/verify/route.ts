import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { errorResponse, jsonResponse, parseBody } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { accountRateLimit, sameAccountOrigin, tokenHash } from '@/lib/account-security';

export const runtime = 'nodejs';
const schema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameAccountOrigin(req) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return errorResponse(403, 'INVALID_ORIGIN', 'same-origin JSON request required', correlationId);
  }
  if (!await accountRateLimit('verify', 'global', 100, 60_000)) return errorResponse(429, 'RATE_LIMITED', 'too many verification attempts', correlationId);
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  const hash = tokenHash(parsed.data.token);
  const verified = await db.$transaction(async (tx) => {
    const row = await tx.accountVerification.findUnique({ where: { tokenHash: hash } });
    if (!row || row.expiresAt <= new Date()) return false;
    const consumed = await tx.accountVerification.deleteMany({ where: { tokenHash: hash, expiresAt: { gt: new Date() } } });
    if (consumed.count !== 1) return false;
    await tx.accountUser.update({ where: { id: row.userId }, data: { emailVerified: new Date() } });
    await tx.accountVerification.deleteMany({ where: { userId: row.userId } });
    return true;
  });
  return verified
    ? jsonResponse({ ok: true, correlationId }, { correlationId })
    : errorResponse(400, 'INVALID_TOKEN', 'verification link is invalid or expired', correlationId);
}
