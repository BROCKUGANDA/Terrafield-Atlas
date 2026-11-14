import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  parseWebhookConfig,
  buildWebhookHeaders,
  shouldRetryWebhookAttempt,
  WEBHOOK_MAX_ATTEMPTS,
} from '@/lib/fires/digest-exit-webhook';
import {
  parseEmailConfig,
  renderDigestEmail,
  shouldEmailDigest,
} from '@/lib/fires/digest-exit-email';
import type { DigestPushPayload } from '@/lib/fires/digest-push';

/**
 * Delivery-exit unit tests — the PURE halves only (config parsing/gating,
 * header/HMAC building, retry decision, email rendering and firing
 * predicate). No DB, no network, no nodemailer transport: these fixtures
 * exercise exactly the logic the runtime senders compose with.
 */

// ---------------------------------------------------------------------------
// Webhook exit — configuration
// ---------------------------------------------------------------------------

describe('webhook exit configuration', () => {
  test('absent URL → not configured, disabled, zero outbound work implied', () => {
    const cfg = parseWebhookConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.state).toBe('not-configured');
    expect(cfg.url).toBeNull();
  });

  test('DIGEST_WEBHOOK_OFF=1 disables even with a URL present', () => {
    const cfg = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'http://127.0.0.1:4317/digest', DIGEST_WEBHOOK_OFF: '1' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.state).toBe('disabled');
    expect(cfg.url).toBe('http://127.0.0.1:4317/digest'); // still shown for diagnostics
  });

  test('a valid http(s) URL arms the exit with host + secret facts', () => {
    const cfg = parseWebhookConfig({
      DIGEST_WEBHOOK_URL: 'https://hooks.example.org/ingest?key=1',
      DIGEST_WEBHOOK_SECRET: 'topsecret',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.state).toBe('configured');
    expect(cfg.host).toBe('hooks.example.org');
    expect(cfg.secretPresent).toBe(true);
  });

  test('non-http(s) schemes are rejected — never POSTed to', () => {
    expect(parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'file:///etc/passwd' }).enabled).toBe(false);
    expect(parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'gopher://x' }).state).toBe('not-configured');
  });

  test('an unparseable URL is rejected, not silently best-efforted', () => {
    expect(parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'not a url' }).enabled).toBe(false);
    expect(parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'http://' }).enabled).toBe(false);
  });

  test('whitespace-only URL counts as unset', () => {
    expect(parseWebhookConfig({ DIGEST_WEBHOOK_URL: '   ' }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook exit — headers / signature
// ---------------------------------------------------------------------------

describe('webhook exit headers', () => {
  test('headers carry JSON content type and the project user-agent', () => {
    const h = buildWebhookHeaders({ secret: null, bodyText: '{"a":1}' });
    expect(h['content-type']).toBe('application/json');
    expect(h['user-agent']).toContain('terrafield-atlas');
    expect(h['x-terrafield-signature']).toBeUndefined();
  });

  test('the signature is the HMAC-SHA256 of the EXACT body bytes, sha256= prefixed', () => {
    const bodyText = JSON.stringify({ type: 'digest', watchlistName: 'Zambia Central — dry-season watch' });
    const h = buildWebhookHeaders({ secret: 'topsecret', bodyText });
    const expected = createHmac('sha256', 'topsecret').update(bodyText, 'utf8').digest('hex');
    expect(h['x-terrafield-signature']).toBe(`sha256=${expected}`);
    // A receiver recomputing the MAC over the same bytes gets the same value.
    const recomputed = createHmac('sha256', 'topsecret').update(bodyText, 'utf8').digest('hex');
    expect(h['x-terrafield-signature']).toBe(`sha256=${recomputed}`);
  });

  test('one byte of difference changes the signature', () => {
    const h1 = buildWebhookHeaders({ secret: 's', bodyText: '{"a":1}' });
    const h2 = buildWebhookHeaders({ secret: 's', bodyText: '{"a":2}' });
    expect(h1['x-terrafield-signature']).not.toBe(h2['x-terrafield-signature']);
  });
});

// ---------------------------------------------------------------------------
// Webhook exit — retry decision
// ---------------------------------------------------------------------------

describe('webhook exit retry decision', () => {
  test('transient outcomes retry: network error (0), 429, 5xx', () => {
    expect(shouldRetryWebhookAttempt({ ok: false, status: 0 })).toBe(true);
    expect(shouldRetryWebhookAttempt({ ok: false, status: 429 })).toBe(true);
    expect(shouldRetryWebhookAttempt({ ok: false, status: 503 })).toBe(true);
  });

  test('permanent client errors fail fast: 400, 404, 410', () => {
    expect(shouldRetryWebhookAttempt({ ok: false, status: 400 })).toBe(false);
    expect(shouldRetryWebhookAttempt({ ok: false, status: 404 })).toBe(false);
    expect(shouldRetryWebhookAttempt({ ok: false, status: 410 })).toBe(false);
  });

  test('a delivered response never retries; attempt budget is 3', () => {
    expect(shouldRetryWebhookAttempt({ ok: true, status: 204 })).toBe(false);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Email exit — configuration
// ---------------------------------------------------------------------------

describe('email exit configuration', () => {
  test('no SMTP variables → credentials not configured (FIRMS-style honest state)', () => {
    const cfg = parseEmailConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.state).toBe('not-configured');
    expect(cfg.missing).toContain('DIGEST_SMTP_HOST');
    expect(cfg.missing).toContain('DIGEST_SMTP_FROM');
    expect(cfg.missing).toContain('DIGEST_SMTP_TO');
  });

  test('DIGEST_EMAIL_OFF=1 disables even with full credentials present', () => {
    const cfg = parseEmailConfig({
      DIGEST_SMTP_HOST: 'smtp.example.org',
      DIGEST_SMTP_FROM: 'alerts@example.org',
      DIGEST_SMTP_TO: 'ops@example.org',
      DIGEST_EMAIL_OFF: '1',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.state).toBe('disabled');
  });

  test('full configuration arms the exit with parsed recipients', () => {
    const cfg = parseEmailConfig({
      DIGEST_SMTP_HOST: 'smtp.example.org',
      DIGEST_SMTP_PORT: '465',
      DIGEST_SMTP_FROM: 'TerraField Atlas <alerts@example.org>',
      DIGEST_SMTP_TO: 'ops@example.org, rural@example.org , not-an-address',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.state).toBe('configured');
    expect(cfg.port).toBe(465);
    expect(cfg.recipients).toEqual(['ops@example.org', 'rural@example.org']); // invalid entry dropped
  });

  test('port falls back to 587 when unset or garbage', () => {
    expect(parseEmailConfig({}).port).toBe(587);
    expect(parseEmailConfig({ DIGEST_SMTP_PORT: 'banana' }).port).toBe(587);
    expect(parseEmailConfig({ DIGEST_SMTP_PORT: '-5' }).port).toBe(587);
  });

  test('a TO list with zero valid addresses never arms the exit', () => {
    const cfg = parseEmailConfig({
      DIGEST_SMTP_HOST: 'smtp.example.org',
      DIGEST_SMTP_FROM: 'alerts@example.org',
      DIGEST_SMTP_TO: 'not-an-address',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.missing.join(' ')).toContain('no valid address parsed');
  });
});

// ---------------------------------------------------------------------------
// Email exit — firing predicate + rendering
// ---------------------------------------------------------------------------

function fakePayload(p: Partial<DigestPushPayload>): DigestPushPayload {
  return {
    type: 'digest',
    reason: 'evaluation',
    trigger: 'manual',
    correlationId: null,
    triggeredAt: '2026-11-14T10:38:36.000Z',
    pushedAt: '2026-11-14T10:38:36.000Z',
    watchlistId: 'w1',
    watchlistName: 'Zambia Central — dry-season watch',
    watchlist: { id: 'w1', lastStatus: 'clear' } as unknown as DigestPushPayload['watchlist'],
    digest: {
      hours: 6,
      digest: ['LINE 1', 'LINE 2', 'LINE 3', 'LINE 4', 'LINE 5'],
      failures: [],
      current: { evaluations: 1, last: { status: 'clear' } },
    } as unknown as DigestPushPayload['digest'],
    ...p,
  };
}

describe('email exit firing predicate', () => {
  test('scheduled evaluation facts fire', () => {
    expect(shouldEmailDigest(fakePayload({ reason: 'evaluation', trigger: 'scheduled' }))).toBe(true);
  });
  test('failed scheduled runs fire (they wrote no status — email is the notice)', () => {
    expect(shouldEmailDigest(fakePayload({ reason: 'scheduled-failure', trigger: null }))).toBe(true);
  });
  test('manual and backtest facts do NOT fire — console feedback already exists', () => {
    expect(shouldEmailDigest(fakePayload({ reason: 'evaluation', trigger: 'manual' }))).toBe(false);
    expect(shouldEmailDigest(fakePayload({ reason: 'evaluation', trigger: 'backtest' }))).toBe(false);
  });
});

describe('email exit rendering', () => {
  test('subject carries the watchlist name and last status', () => {
    const r = renderDigestEmail(fakePayload({}));
    expect(r.subject).toBe('TerraField fire digest — Zambia Central — dry-season watch — CLEAR');
  });

  test('body carries the digest lines, the fact, and the provenance pointer', () => {
    const r = renderDigestEmail(fakePayload({ reason: 'scheduled-failure', trigger: null, correlationId: 'sched-abc' }));
    expect(r.text).toContain('LINE 1');
    expect(r.text).toContain('LINE 4');
    expect(r.text).not.toContain('LINE 5'); // bounded preview, not the whole digest blob
    expect(r.text).toContain('a FAILED scheduled run');
    expect(r.text).toContain('sched-abc');
    expect(r.text).toContain('GET /api/v1/fires/watchlists/{id}/digest');
    expect(r.text).toContain('never as zero fires');
  });

  test('rendering never throws on a digest with no evaluation in window', () => {
    const r = renderDigestEmail(
      fakePayload({ digest: { hours: 6, digest: [], failures: [], current: { evaluations: 0, last: null } } as unknown as DigestPushPayload['digest'] }),
    );
    expect(r.subject).toContain('digest'); // no status to append
    expect(r.text).toContain('No evaluation'); // honest line for an empty window
  });
});
