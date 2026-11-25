import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { errorResponse, jsonResponse } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';

export const runtime = 'nodejs';
const COOKIE = 'terrafield-demo-session';
const MAX_AGE = 8 * 60 * 60;
const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
const options = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: MAX_AGE };

function expiry(req: NextRequest): number | null {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return null;
  const [id, expires, signature] = token.split('.');
  if (!/^[a-f0-9]{32}$/.test(id ?? '') || !/^\d{13}$/.test(expires ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '')) return null;
  const expected = sign(`${id}.${expires}`);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const value = Number(expires);
  return value > Date.now() ? value : null;
}

function response(req: NextRequest, expiresAt: number | null) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  return jsonResponse({ kind: 'anonymous-demo', authenticated: false, expiresAt, correlationId }, {
    correlationId,
    headers: { Vary: 'Cookie' },
  });
}

export async function GET(req: NextRequest) {
  return response(req, expiry(req));
}

function sameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const publicOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://terrafieldatlas.us').origin;
  return origin === publicOrigin || (process.env.NODE_ENV !== 'production' && origin === req.nextUrl.origin);
}

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameOrigin(req)) return errorResponse(403, 'INVALID_ORIGIN', 'same-origin request required', correlationId);
  const expiresAt = expiry(req) ?? Date.now() + MAX_AGE * 1000;
  const result = response(req, expiresAt);
  const value = `${randomBytes(16).toString('hex')}.${expiresAt}`;
  result.cookies.set(COOKIE, `${value}.${sign(value)}`, { ...options, maxAge: Math.ceil((expiresAt - Date.now()) / 1000) });
  return result;
}

export async function DELETE(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  if (!sameOrigin(req)) return errorResponse(403, 'INVALID_ORIGIN', 'same-origin request required', correlationId);
  const result = response(req, null);
  result.cookies.set(COOKIE, '', { ...options, maxAge: 0 });
  return result;
}
