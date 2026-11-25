import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AccountAccessError } from '@/lib/access-error';

function encryptionKey(): Buffer {
  const raw = process.env.WEBHOOK_ENCRYPTION_KEY?.trim();
  if (!raw) throw new AccountAccessError(503, 'WEBHOOK_ENCRYPTION_UNAVAILABLE', 'webhook secret encryption is not configured');
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64url');
  if (key.length !== 32) throw new AccountAccessError(503, 'WEBHOOK_ENCRYPTION_UNAVAILABLE', 'webhook encryption key must be 32 bytes');
  return key;
}

export function encryptSecret(secret: string): { secretCiphertext: string; secretIv: string; secretTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { secretCiphertext: ciphertext.toString('base64url'), secretIv: iv.toString('base64url'), secretTag: cipher.getAuthTag().toString('base64url') };
}

export function decryptSecret(value: { secretCiphertext: string; secretIv: string; secretTag: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.secretIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.secretTag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(value.secretCiphertext, 'base64url')), decipher.final()]).toString('utf8');
}
