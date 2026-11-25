import { z } from 'zod';
import { verifyWebhookSignature } from '@/lib/fires/digest-exit-webhook';

export const MAX_DIGEST_BYTES = 128 * 1024;
const digestSchema = z.object({
  type: z.literal('digest'),
  watchlistId: z.string().min(1).max(200),
  reason: z.enum(['evaluation', 'scheduled-failure']),
  triggeredAt: z.iso.datetime(), pushedAt: z.iso.datetime(),
  correlationId: z.string().max(200).nullable(),
});

export async function readBoundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > MAX_DIGEST_BYTES) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DIGEST_BYTES) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export function parseSignedDigest(rawBody: string, header: string | null, secrets: (string | undefined)[], nowSec?: number) {
  if (!verifyWebhookSignature({ rawBody, header, secrets, nowSec }).valid) throw new Error('INVALID_SIGNATURE');
  return digestSchema.parse(JSON.parse(rawBody));
}