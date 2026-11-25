import { expect, test } from 'bun:test';
import { buildWebhookHeaders } from '@/lib/fires/digest-exit-webhook';
import { MAX_DIGEST_BYTES, parseSignedDigest, readBoundedBody } from '@/lib/webhook-receiver';

const secret = 'fixture-only-32-byte-signing-secret';
const timestampSec = 1_795_000_000;
const body = JSON.stringify({ type: 'digest', watchlistId: 'fixture', reason: 'evaluation', triggeredAt: '2026-11-19T10:00:00Z', pushedAt: '2026-11-19T10:00:00Z', correlationId: null });
const header = buildWebhookHeaders({ secret, bodyText: body, timestampSec })['x-terrafield-signature'];

test('receiver authenticates exact bytes, freshness and configured secrets', () => {
  expect(parseSignedDigest(body, header, [secret], timestampSec).watchlistId).toBe('fixture');
  for (const [raw, signature, secrets, now] of [
    [body + ' ', header, [secret], timestampSec], [body, null, [secret], timestampSec],
    [body, header, ['wrong'], timestampSec], [body, header, [secret], timestampSec + 301],
    [body, header, [], timestampSec],
  ] as const) expect(() => parseSignedDigest(raw, signature, [...secrets], now)).toThrow('INVALID_SIGNATURE');
});

test('receiver bounds bodies with and without a Content-Length header', async () => {
  const valid = new Request('https://example.test', { method: 'POST', body });
  expect(await readBoundedBody(valid)).toBe(body);
  await expect(readBoundedBody(new Request('https://example.test', { method: 'POST', body: 'x'.repeat(MAX_DIGEST_BYTES + 1) }))).rejects.toThrow('BODY_TOO_LARGE');
  await expect(readBoundedBody(new Request('https://example.test', { method: 'POST', body, headers: { 'content-length': String(MAX_DIGEST_BYTES + 1) } }))).rejects.toThrow('BODY_TOO_LARGE');
});