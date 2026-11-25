import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const verificationToken = () => randomBytes(32).toString('base64url');
export const MAX_REQUEST_BYTES = 128 * 1024;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Read a request as strict UTF-8 without ever buffering more than the shared cap. */
export async function readBoundedText(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new BodyTooLargeError(maxBytes);
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const match = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(stored ?? '');
  // Unknown accounts still pay the full KDF cost.
  const actual = await derive(password, match?.[1] ?? '00000000000000000000000000000000');
  const expected = match ? Buffer.from(match[2], 'hex') : Buffer.alloc(64);
  return timingSafeEqual(actual, expected) && match !== null;
}

export function sameAccountOrigin(req: Request): boolean {
  const configured = process.env.NEXTAUTH_URL;
  if (!configured) return false;
  try {
    const expected = new URL(configured).origin;
    const origin = req.headers.get('origin');
    const fetchSite = req.headers.get('sec-fetch-site');
    if (origin !== null) return origin === expected && fetchSite !== 'cross-site';
    // Browsers may omit Origin on same-origin GET. Fetch Metadata still gives
    // a reliable CSRF signal; non-browser clients must send Origin explicitly.
    return req.method === 'GET' && fetchSite === 'same-origin';
  } catch { return false; }
}

/** Durable, atomic fixed-window limits; keys contain hashes, never raw email/IP. */
export async function accountRateLimit(scope: string, identifier: string, capacity: number, windowMs: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = tokenHash(`${scope}:${identifier}:${bucket}`);
  const row = await db.accountRateLimit.upsert({
    where: { key },
    create: { key, expiresAt: new Date((bucket + 1) * windowMs) },
    update: { count: { increment: 1 } },
  });
  if (randomBytes(1)[0] === 0) await db.accountRateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return row.count <= capacity;
}

export async function allowAccountAttempt(scope: string, email: string): Promise<boolean> {
  const global = await accountRateLimit(`${scope}:global`, 'all', 200, 60_000);
  const account = await accountRateLimit(scope, normalizeEmail(email), 8, 15 * 60_000);
  return global && account;
}