import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { MAIL_TIMEOUT_MS, sendAccountEmail } from '@/lib/mail';
import { deliverDigestEmail, emailExitStatus, parseEmailConfig } from '@/lib/fires/digest-exit-email';
import { db } from '@/lib/db';
import type { DigestPushPayload } from '@/lib/fires/digest-push';
import { createFetchMock } from './fetch-mock';

const keys = ['RESEND_API_KEY', 'EMAIL_FROM', 'DIGEST_EMAIL_FROM', 'DIGEST_EMAIL_TO', 'DIGEST_EMAIL_OFF', 'DIGEST_SMTP_HOST', 'DIGEST_SMTP_FROM', 'DIGEST_SMTP_TO'];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function configure() {
  for (const key of keys) delete process.env[key];
  process.env.RESEND_API_KEY = 'test-secret-never-log';
  process.env.EMAIL_FROM = 'Atlas <alerts@example.org>';
  process.env.DIGEST_EMAIL_TO = 'delivered@resend.dev';
}

describe('shared Resend mail', () => {
  test('account helper sends expected HTTPS message', async () => {
    configure();
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' })));
    await sendAccountEmail('delivered@resend.dev', 'Verify', 'One-time link');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(options.body)).toEqual({ from: process.env.EMAIL_FROM, to: ['delivered@resend.dev'], subject: 'Verify', text: 'One-time link' });
  });

  for (const status of [401, 429, 500]) {
    test(`provider ${status} is rejected without echoing provider content`, async () => {
      configure();
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('test-secret-never-log', { status }));
      await expect(sendAccountEmail('delivered@resend.dev', 'Verify', 'link')).rejects.toThrow('Resend email delivery failed');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  }

  test('network failure is sanitized', async () => {
    configure();
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('test-secret-never-log'));
    await expect(sendAccountEmail('delivered@resend.dev', 'Verify', 'link')).rejects.toThrow('Resend email delivery failed');
  });

  test('timeout aborts stalled request', async () => {
    configure();
    let signal: AbortSignal | undefined;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(createFetchMock((_, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }));
    await expect(sendAccountEmail('delivered@resend.dev', 'Verify', 'link')).rejects.toThrow('Resend email delivery failed');
    expect(signal?.aborted).toBe(true);
  }, MAIL_TIMEOUT_MS + 2_000);

  test('incomplete account configuration makes zero requests', async () => {
    configure();
    delete process.env.EMAIL_FROM;
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    await expect(sendAccountEmail('delivered@resend.dev', 'Verify', 'link')).rejects.toThrow('not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('digest Resend configuration', () => {
  test('digest success and failure preserve counters and audit records; manual facts do not send', async () => {
    configure();
    const originalAudit = db.auditEvent;
    const audit = mock(async (_args: { data: { action: string } }) => ({}));
    Reflect.set(db, 'auditEvent', { create: audit });
    const payload = {
      watchlistId: 'w1', watchlistName: 'Test', reason: 'evaluation', trigger: 'scheduled', digest: {},
    } as DigestPushPayload;
    const context = { correlationId: null, now: new Date('2026-11-19T00:00:00Z') };
    try {
      const before = emailExitStatus();
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'digest-1' })));
      expect((await deliverDigestEmail(payload, context)).sent).toBe(true);
      expect(emailExitStatus().sent).toBe(before.sent + 1);
      expect(audit.mock.calls[0][0].data.action).toBe('digest.email.deliver');
      fetchSpy.mockRejectedValue(new Error('test-secret-never-log'));
      expect((await deliverDigestEmail(payload, context)).sent).toBe(false);
      expect(emailExitStatus().failed).toBe(before.failed + 1);
      expect(audit.mock.calls[1][0].data.action).toBe('digest.email.fail');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('test-secret-never-log');
      expect(JSON.stringify(emailExitStatus())).not.toContain('test-secret-never-log');
      expect((await deliverDigestEmail({ ...payload, trigger: 'manual' }, context)).sent).toBe(false);
      process.env.DIGEST_EMAIL_OFF = '1';
      expect((await deliverDigestEmail(payload, context)).sent).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.set(db, 'auditEvent', originalAudit);
    }
  });
  test('exact new names configure Resend and explicit test semantics', () => {
    configure();
    const status = emailExitStatus();
    expect(status.transport).toBe('resend');
    expect(status.recipientMode).toBe('test-only');
    expect(status.host).toBe('api.resend.com');
    expect(JSON.stringify(status)).not.toContain('test-secret-never-log');
  });

  test('digest sender overrides account sender; SMTP fallback remains', () => {
    const cfg = parseEmailConfig({ RESEND_API_KEY: 'test', EMAIL_FROM: 'a@example.org', DIGEST_EMAIL_FROM: 'b@example.org', DIGEST_EMAIL_TO: 'delivered@resend.dev' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.from).toBe('b@example.org');
    expect(parseEmailConfig({ DIGEST_SMTP_HOST: 'smtp.example.org', DIGEST_SMTP_FROM: 'a@example.org', DIGEST_SMTP_TO: 'b@example.org' }).enabled).toBe(true);
  });

  test('missing sender, missing recipients, and hard disable cannot arm Resend', () => {
    expect(parseEmailConfig({ RESEND_API_KEY: 'test' }).enabled).toBe(false);
    expect(parseEmailConfig({ RESEND_API_KEY: 'test', EMAIL_FROM: 'a@example.org' }).enabled).toBe(false);
    expect(parseEmailConfig({ RESEND_API_KEY: 'test', EMAIL_FROM: 'a@example.org', DIGEST_EMAIL_TO: 'delivered@resend.dev', DIGEST_EMAIL_OFF: '1' }).state).toBe('disabled');
  });
});