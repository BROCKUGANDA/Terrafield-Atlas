import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { db } from '@/lib/db';
import { parseSignedDigest, readBoundedBody } from '@/lib/webhook-receiver';
import { errorResponse, jsonResponse } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';

/** Signature-authenticated inbound webhook: the sole verified-write exception. */
export async function POST(request: Request) {
  const correlationId = getCorrelationId(request.headers.get('x-correlation-id'));
  if (!process.env.DIGEST_WEBHOOK_SECRET) {
    return errorResponse(503, 'RECEIVER_UNAVAILABLE', 'signed digest receiver is not configured', correlationId);
  }
  let raw: string;
  let payload: ReturnType<typeof parseSignedDigest>;
  try {
    raw = await readBoundedBody(request);
    payload = parseSignedDigest(raw, request.headers.get('x-terrafield-signature'), [process.env.DIGEST_WEBHOOK_SECRET, process.env.DIGEST_WEBHOOK_SECRET_PREVIOUS]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'BODY_TOO_LARGE') return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'signed digest body is too large', correlationId);
    if (message === 'INVALID_SIGNATURE') return errorResponse(401, 'INVALID_SIGNATURE', 'invalid signed digest', correlationId);
    return errorResponse(400, 'INVALID_DIGEST', 'signed digest payload is invalid', correlationId);
  }
  const hash = createHash('sha256').update(raw).digest('hex');
  try {
    await db.$transaction(async (tx) => {
      await tx.auditEvent.upsert({
        where: { id: `digest-receipt:${hash}` }, update: {},
        create: {
          id: `digest-receipt:${hash}`, actor: 'signed-webhook', action: 'digest.webhook.received',
          targetId: payload.watchlistId,
          detail: JSON.stringify({ bodyHash: hash, bytes: Buffer.byteLength(raw), reason: payload.reason, correlationId }),
        },
      });
      await tx.outboxEvent.create({ data: {
        id: `digest-receipt:${hash}`,
        aggregateType: 'DigestReceipt',
        aggregateId: payload.watchlistId,
        eventType: 'digest.webhook.received',
        payload: JSON.stringify({ receipt: hash, watchlistId: payload.watchlistId, reason: payload.reason, correlationId }),
      } });
    });
    return jsonResponse({ accepted: true, receipt: hash, note: 'Signed digest recorded; no external forwarding configured.', correlationId }, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) return errorResponse(400, 'INVALID_DIGEST', 'signed digest payload is invalid', correlationId);
    return errorResponse(503, 'RECEIPT_UNAVAILABLE', 'receipt persistence unavailable', correlationId);
  }
}
