import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  parseWebhookConfig,
  parseWebhookAllowlist,
  buildWebhookHeaders,
  verifyWebhookSignature,
  signWebhookV1,
  assertWebhookTargetSafe,
  shouldRetryWebhookAttempt,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_TOLERANCE_SEC,
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
// Webhook exit — headers / OWASP signature scheme (t=,v1=)
// ---------------------------------------------------------------------------

describe('webhook exit headers (OWASP signature scheme)', () => {
  const T = 1_700_000_000;

  test('headers carry JSON content type, the project user-agent and the topic', () => {
    const h = buildWebhookHeaders({ secret: null, bodyText: '{"a":1}', timestampSec: T });
    expect(h['content-type']).toBe('application/json');
    expect(h['user-agent']).toContain('terrafield-atlas');
    expect(h['x-terrafield-topic']).toBe('watchlist.digest');
    expect(h['x-terrafield-signature']).toBeUndefined();
  });

  test('signature is timestamp-bound: t=<sec>,v1=hex(HMAC(secret, "<t>.<body>"))', () => {
    const bodyText = JSON.stringify({ type: 'digest', watchlistName: 'Zambia Central — dry-season watch' });
    const h = buildWebhookHeaders({ secret: 'topsecret', bodyText, timestampSec: T });
    expect(h['x-terrafield-signature']).toBe(`t=${T},v1=${signWebhookV1('topsecret', bodyText, T)}`);
    const expected = createHmac('sha256', 'topsecret').update(`${T}.${bodyText}`, 'utf8').digest('hex');
    expect(h['x-terrafield-signature']).toContain(expected);
    // legacy compat header still carries the body-only MAC
    expect(h['x-terrafield-signature-sha256']).toBe(`sha256=${createHmac('sha256', 'topsecret').update(bodyText, 'utf8').digest('hex')}`);
  });

  test('one byte of difference in body or timestamp changes the signature', () => {
    const h1 = buildWebhookHeaders({ secret: 's'.repeat(40), bodyText: '{"a":1}', timestampSec: T });
    const h2 = buildWebhookHeaders({ secret: 's'.repeat(40), bodyText: '{"a":2}', timestampSec: T });
    const h3 = buildWebhookHeaders({ secret: 's'.repeat(40), bodyText: '{"a":1}', timestampSec: T + 1 });
    expect(h1['x-terrafield-signature']).not.toBe(h2['x-terrafield-signature']);
    expect(h1['x-terrafield-signature']).not.toBe(h3['x-terrafield-signature']);
  });
});

// ---------------------------------------------------------------------------
// Webhook exit — receiver-side verification (verifyWebhookSignature)
// ---------------------------------------------------------------------------

describe('webhook signature verification', () => {
  const T = 1_700_000_000;
  const body = JSON.stringify({ type: 'digest', evaluations: 3 });
  const secret = 'k'.repeat(32);
  const header = buildWebhookHeaders({ secret, bodyText: body, timestampSec: T })['x-terrafield-signature'];

  test('a correct signature within the replay window verifies', () => {
    const res = verifyWebhookSignature({ rawBody: body, header, secrets: [secret], nowSec: T + 10 });
    expect(res.valid).toBe(true);
    expect(res.matchedSecretIndex).toBe(0);
  });

  test('a missing header never verifies', () => {
    expect(verifyWebhookSignature({ rawBody: body, header: null, secrets: [secret], nowSec: T }).valid).toBe(false);
  });

  test('malformed headers never verify (old sha256= scheme included)', () => {
    const legacy = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
    expect(verifyWebhookSignature({ rawBody: body, header: legacy, secrets: [secret], nowSec: T }).reason).toBe('malformed');
    expect(verifyWebhookSignature({ rawBody: body, header: 't=abc,v1=zz', secrets: [secret], nowSec: T }).reason).toBe('malformed');
  });

  test('replay outside the ±300 s window is refused even with a valid MAC', () => {
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SEC).toBe(300);
    const late = verifyWebhookSignature({ rawBody: body, header, secrets: [secret], nowSec: T + 301 });
    expect(late.valid).toBe(false);
    expect(late.reason).toBe('replay-window');
    // inside the window (exactly at the edge) it still verifies
    expect(verifyWebhookSignature({ rawBody: body, header, secrets: [secret], nowSec: T + 300 }).valid).toBe(true);
  });

  test('a tampered body fails the MAC check', () => {
    const res = verifyWebhookSignature({ rawBody: body + ' ', header, secrets: [secret], nowSec: T });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('signature-mismatch');
  });

  test('wrong secret fails; rotation accepts the previous secret in order', () => {
    const newSecret = 'n'.repeat(32);
    expect(verifyWebhookSignature({ rawBody: body, header, secrets: [newSecret], nowSec: T }).reason).toBe('signature-mismatch');
    const rotated = verifyWebhookSignature({ rawBody: body, header, secrets: [newSecret, secret], nowSec: T });
    expect(rotated.valid).toBe(true);
    expect(rotated.matchedSecretIndex).toBe(1); // the previous secret matched
  });

  test('no secrets configured → explicit refusal, not a crash', () => {
    expect(verifyWebhookSignature({ rawBody: body, header, secrets: [], nowSec: T }).reason).toBe('no-secrets-configured');
  });
});

// ---------------------------------------------------------------------------
// Webhook exit — SSRF guard on outbound targets
// ---------------------------------------------------------------------------

describe('webhook SSRF guard', () => {
  test('public https targets pass', () => {
    expect(assertWebhookTargetSafe('https://hooks.example.org/ingest').ok).toBe(true);
    expect(assertWebhookTargetSafe('http://ops.acme.io:8080/relay?key=1').ok).toBe(true);
  });

  test('loopback, RFC1918, metadata and CGNAT targets are refused', () => {
    for (const url of [
      'http://localhost:3000/digest',
      'http://127.0.0.1:4317/digest',
      'http://10.1.2.3/digest',
      'http://172.16.0.9/digest',
      'http://172.31.255.255/digest',
      'http://192.168.1.1/digest',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://100.100.100.200/digest', // CGNAT (Alibaba DNS range)
      'http://0.0.0.0/digest',
      'http://[::1]/digest',
      'http://svc.internal/digest',
      'http://my-host.local/digest',
      'file:///etc/passwd',
    ]) {
      expect(assertWebhookTargetSafe(url).ok).toBe(false);
    }
    // 172.32+ is public — must pass
    expect(assertWebhookTargetSafe('http://172.32.0.1/digest').ok).toBe(true);
    // 100.128+ is outside CGNAT — must pass
    expect(assertWebhookTargetSafe('http://100.128.0.1/digest').ok).toBe(true);
  });

  test('IPv4-mapped, compatible, NAT64 and non-global IPv6 targets are refused', () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/digest',
      'http://[::ffff:7f00:1]/digest',
      'http://[::ffff:10.0.0.1]/digest',
      'http://[::127.0.0.1]/digest',
      'http://[::7f00:1]/digest',
      'http://[::]/digest',
      'http://[64:ff9b::7f00:1]/digest',
      'http://[64:ff9b:1::a00:1]/digest',
      'http://[2002:7f00:1::]/digest',
      'http://[fe80::1]/digest',
      'http://[fc00::1]/digest',
      'http://[ff02::1]/digest',
    ]) expect(assertWebhookTargetSafe(url).ok, url).toBe(false);
    expect(assertWebhookTargetSafe('http://[2606:4700:4700::1111]/digest').ok).toBe(true);
    expect(assertWebhookTargetSafe('http://[2001:4860:4860::8888]/digest').ok).toBe(true);
  });

  test('configuration reports the guard verdict for the armed URL', () => {
    const bad = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'http://169.254.169.254/x', DIGEST_WEBHOOK_SECRET: 'k'.repeat(32) });
    expect(bad.enabled).toBe(true);
    expect(bad.targetSafe).toBe(false);
    expect(bad.targetUnsafeReason).toContain('metadata');
    const good = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'https://hooks.example.org/x' });
    expect(good.targetSafe).toBe(true);
    expect(good.secretBytes).toBe(0);
  });

  test('secret strength facts are surfaced (≥32 bytes recommended)', () => {
    const strong = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'https://hooks.example.org/x', DIGEST_WEBHOOK_SECRET: 'k'.repeat(32) });
    expect(strong.secretAdequate).toBe(true);
    const weak = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'https://hooks.example.org/x', DIGEST_WEBHOOK_SECRET: 'short' });
    expect(weak.secretAdequate).toBe(false);
    expect(weak.secretBytes).toBe(5);
    const rotating = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'https://hooks.example.org/x', DIGEST_WEBHOOK_SECRET: 'k'.repeat(32), DIGEST_WEBHOOK_SECRET_PREVIOUS: 'old' });
    expect(rotating.rotationSecretPresent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Webhook exit — SSRF allowlist (explicit operator opt-in for private relays)
// ---------------------------------------------------------------------------

describe('webhook SSRF allowlist (DIGEST_WEBHOOK_ALLOWLIST)', () => {
  test('parser: host and host:port entries, brackets, garbage dropped', () => {
    expect(parseWebhookAllowlist(' 127.0.0.1:4317, ops-relay.internal ')).toEqual([
      { host: '127.0.0.1', port: 4317 },
      { host: 'ops-relay.internal', port: null },
    ]);
    expect(parseWebhookAllowlist('[::1]:2525')).toEqual([{ host: '::1', port: 2525 }]);
    // garbage is dropped, never broadened: CIDRs, URLs, bad ports
    expect(parseWebhookAllowlist('10.0.0.0/8, http://x/y, 1.2.3.4:99999, ,,')).toEqual([]);
    expect(parseWebhookAllowlist(undefined)).toEqual([]);
    expect(parseWebhookAllowlist('')).toEqual([]);
  });

  test('an exact host:port entry rescues that target ONLY (deny-by-default otherwise)', () => {
    const list = '127.0.0.1:4317';
    const ok = assertWebhookTargetSafe('http://127.0.0.1:4317/digest', list);
    expect(ok.ok).toBe(true);
    expect(ok.allowlisted).toBe(true); // passed ONLY via the allowlist
    // same host, DIFFERENT port → still refused
    expect(assertWebhookTargetSafe('http://127.0.0.1:9999/digest', list).ok).toBe(false);
    // different private host → still refused
    expect(assertWebhookTargetSafe('http://10.9.9.9/digest', list).ok).toBe(false);
    expect(assertWebhookTargetSafe('http://localhost:4317/digest', list).ok).toBe(false);
  });

  test('a host-only entry matches ANY port on that host', () => {
    expect(assertWebhookTargetSafe('http://10.1.2.3:80/digest', '10.1.2.3').ok).toBe(true);
    expect(assertWebhookTargetSafe('http://10.1.2.3:8443/digest', '10.1.2.3').ok).toBe(true);
    expect(assertWebhookTargetSafe('http://10.1.2.4/digest', '10.1.2.3').ok).toBe(false);
  });

  test('allowlist can NEVER rescue scheme or unparseable refusals', () => {
    expect(assertWebhookTargetSafe('file:///etc/passwd', '127.0.0.1:4317').ok).toBe(false);
    expect(assertWebhookTargetSafe('gopher://127.0.0.1:4317', '127.0.0.1:4317').ok).toBe(false);
    expect(assertWebhookTargetSafe('not a url', '127.0.0.1').ok).toBe(false);
    // the cloud metadata address stays refused unless the operator names it
    expect(assertWebhookTargetSafe('http://169.254.169.254/x', '127.0.0.1:4317').ok).toBe(false);
    expect(assertWebhookTargetSafe('http://169.254.169.254/x', '169.254.169.254').ok).toBe(true);
  });

  test('configuration surfaces allowlist facts alongside the guard verdict', () => {
    const armed = parseWebhookConfig({
      DIGEST_WEBHOOK_URL: 'http://127.0.0.1:4317/digest',
      DIGEST_WEBHOOK_ALLOWLIST: '127.0.0.1:4317',
      DIGEST_WEBHOOK_SECRET: 'k'.repeat(32),
    });
    expect(armed.enabled).toBe(true);
    expect(armed.state).toBe('configured');
    expect(armed.allowlistCount).toBe(1);
    expect(armed.targetSafe).toBe(true);
    expect(armed.targetAllowlisted).toBe(true);
    expect(armed.targetUnsafeReason).toBeNull();
    // no allowlist → the same URL stays refused
    const refused = parseWebhookConfig({ DIGEST_WEBHOOK_URL: 'http://127.0.0.1:4317/digest' });
    expect(refused.targetSafe).toBe(false);
    expect(refused.targetAllowlisted).toBe(false);
    expect(refused.allowlistCount).toBe(0);
    // absent URL → allowlist counted but verdict null
    const noUrl = parseWebhookConfig({ DIGEST_WEBHOOK_ALLOWLIST: 'a.local,b.local' });
    expect(noUrl.allowlistCount).toBe(2);
    expect(noUrl.targetSafe).toBeNull();
    expect(noUrl.targetAllowlisted).toBeNull();
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
    eventId: p.eventId ?? 'event-1',
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
